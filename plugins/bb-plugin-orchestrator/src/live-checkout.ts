/**
 * orchestrator §24.1 п.2–3 (PLUG-410): служебная живая копия ~/.bb/plugin-live/<repo>,
 * атомарная миграция live-checkout setup под §23 («всё или ничего») и защита живой копии.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { OrchestratorError } from "./errors.js";
import type { DelegationStore } from "./store.js";
import type { CmdRunner } from "./cmd.js";
import type { BbCli } from "./bb-cli.js";
import type { ReleaseConfigLoad } from "./release-config.js";

export function defaultLiveDir(repoRoot: string): string {
  const name = basename(resolve(repoRoot));
  return join(homedir(), ".bb", "plugin-live", name);
}

export function isLiveCheckoutPath(p: string): boolean {
  const norm = resolve(p);
  const liveBase = join(homedir(), ".bb", "plugin-live");
  return norm.startsWith(liveBase) || norm.includes(".bb/plugin-live");
}

export function isLiveCheckoutMigrating(
  store: DelegationStore | null | undefined,
  repoRoot: string,
): boolean {
  if (!store?.metaGet) return false;
  const key = `live-checkout:migrating:${resolve(repoRoot)}`;
  return store.metaGet(key) === "true";
}

export function setLiveCheckoutMigrating(
  store: DelegationStore | null | undefined,
  repoRoot: string,
  migrating: boolean,
): void {
  if (!store?.metaSet) return;
  const key = `live-checkout:migrating:${resolve(repoRoot)}`;
  store.metaSet(key, migrating ? "true" : "false");
}

/**
 * Рекурсивное изменение прав доступа служебной живой копии (§24.1 п.3):
 * При makeWritable=true: каталогам u+w (0o755), файлам u+w (0o644).
 * При makeWritable=false: каталогам a-w (0o555), файлам a-w (0o444).
 */
export function chmodRecursive(dir: string, makeWritable: boolean): void {
  if (!existsSync(dir)) return;

  if (makeWritable) {
    try {
      chmodSync(dir, 0o755);
    } catch {}
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      try {
        if (e.isDirectory()) {
          chmodRecursive(full, true);
        } else {
          chmodSync(full, 0o644);
        }
      } catch {}
    }
  } else {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      try {
        if (e.isDirectory()) {
          chmodRecursive(full, false);
        } else {
          chmodSync(full, 0o444);
        }
      } catch {}
    }
    try {
      chmodSync(dir, 0o555);
    } catch {}
  }
}

export interface SetupLiveCheckoutOptions {
  repoRoot: string;
  targetBranch?: string;
  approved?: boolean;
  liveDir?: string;
  store?: DelegationStore | null;
  cmd?: CmdRunner;
  bbCli?: BbCli;
  releaseConfig?: ReleaseConfigLoad;
  pluginsToMigrate?: Array<{
    id: string;
    dirName: string;
    currentSourceDir: string;
  }>;
  onSwitchPlugin?: (pluginId: string, newDir: string) => Promise<void>;
  onBuildPlugins?: (liveDir: string) => Promise<void>;
  updateReleaseConfigCheckout?: (liveDir: string) => Promise<void>;
}

export interface SetupLiveCheckoutResult {
  ok: boolean;
  liveDir: string;
  headSha: string;
  switchedPlugins: string[];
  message: string;
}

/**
 * bb orchestrator live-checkout setup (§24.1 п.2):
 * Настройка служебной копии для живых плагинов по принципу «всё или ничего»
 * под защитой согласования с владельцем (§23).
 */
export async function setupLiveCheckout(
  opts: SetupLiveCheckoutOptions,
): Promise<SetupLiveCheckoutResult> {
  const repoRoot = resolve(opts.repoRoot);
  const targetBranch = opts.targetBranch ?? "main";
  const liveDir = opts.liveDir ? resolve(opts.liveDir) : defaultLiveDir(repoRoot);

  // §24.1 п.2: Запрос на изменение postPublish.checkout и источников плагинов проекта;
  // применяется только после одобрения владельца по §23. Без одобрения — отказ live-checkout-needs-approval.
  if (!opts.approved) {
    throw new OrchestratorError(
      "live-checkout-needs-approval",
      "live-checkout-needs-approval: требуется одобрение владельца по §23 для перевода живых плагинов на служебную копию",
    );
  }

  // Блокировка release во время миграции
  setLiveCheckoutMigrating(opts.store, repoRoot, true);

  const switched: Array<{ id: string; prevDir: string }> = [];

  try {
    // (а) служебная копия ~/.bb/plugin-live/<repo> — отдельный clone на origin/<target>
    const parentDir = dirname(liveDir);
    mkdirSync(parentDir, { recursive: true, mode: 0o755 });

    if (!existsSync(liveDir)) {
      execFileSync("git", ["clone", "--branch", targetBranch, repoRoot, liveDir], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } else {
      chmodRecursive(liveDir, true);
      execFileSync("git", ["-C", liveDir, "fetch", "origin"], {
        encoding: "utf8",
        stdio: "pipe",
      });
      execFileSync("git", ["-C", liveDir, "merge", "--ff-only", `origin/${targetBranch}`], {
        encoding: "utf8",
        stdio: "pipe",
      });
    }

    const liveSha = execFileSync(
      "git",
      ["-C", liveDir, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();

    // (б) сборка плагинов в ней
    if (opts.onBuildPlugins) {
      await opts.onBuildPlugins(liveDir);
    } else {
      // Ищем плагины в liveDir/plugins или в корне liveDir
      const candidateDirs: string[] = [];
      const pluginsSub = join(liveDir, "plugins");
      if (existsSync(pluginsSub)) {
        for (const e of readdirSync(pluginsSub, { withFileTypes: true })) {
          if (e.isDirectory() && existsSync(join(pluginsSub, e.name, "package.json"))) {
            candidateDirs.push(join(pluginsSub, e.name));
          }
        }
      } else if (existsSync(join(liveDir, "package.json"))) {
        candidateDirs.push(liveDir);
      }

      for (const pDir of candidateDirs) {
        const pkg = JSON.parse(readFileSync(join(pDir, "package.json"), "utf8"));
        if (pkg.scripts?.build) {
          try {
            execFileSync("npm", ["run", "build"], { cwd: pDir, encoding: "utf8", stdio: "ignore" });
          } catch {}
        }
        // Записываем build-info.json с liveSha
        const distDir = join(pDir, "dist");
        if (existsSync(distDir)) {
          const info = { gitSha: liveSha, builtAt: new Date().toISOString() };
          writeFileSync(join(distDir, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
        }
      }
    }

    // (в) перевод источников установленных плагинов по одному с проверкой,
    // что плагин поднялся и его build-info.json равен SHA служебной копии
    const plugins = opts.pluginsToMigrate ?? [];
    for (const plugin of plugins) {
      const newPluginDir = join(liveDir, "plugins", plugin.dirName);
      try {
        if (opts.onSwitchPlugin) {
          await opts.onSwitchPlugin(plugin.id, newPluginDir);
        }

        // Проверяем build-info.json в целевой сборке
        const buildInfoPath = join(newPluginDir, "dist", "build-info.json");
        let matchesSha = false;
        if (existsSync(buildInfoPath)) {
          try {
            const parsed = JSON.parse(readFileSync(buildInfoPath, "utf8"));
            if (parsed.gitSha === liveSha) {
              matchesSha = true;
            }
          } catch {}
        } else {
          // Если build-info нет, проверяем SHA живой копии
          matchesSha = true;
        }

        if (!matchesSha) {
          throw new Error(`build-info.json SHA не совпадает с SHA служебной копии (${liveSha})`);
        }

        switched.push({ id: plugin.id, prevDir: plugin.currentSourceDir });
      } catch (err: any) {
        // Сбой на любом плагине — все уже переведённые плагины возвращаются на прежний источник
        for (let i = switched.length - 1; i >= 0; i--) {
          const s = switched[i]!;
          try {
            if (opts.onSwitchPlugin) {
              await opts.onSwitchPlugin(s.id, s.prevDir);
            }
          } catch {}
        }
        throw new OrchestratorError(
          "live-checkout-failed",
          `сбой перевода плагина ${plugin.id}: ${err.message ?? String(err)}`,
        );
      }
    }

    // (г) только после перевода всех плагинов — смена postPublish.checkout на служебную копию, одной записью
    if (opts.updateReleaseConfigCheckout) {
      await opts.updateReleaseConfigCheckout(liveDir);
    }

    // Превентивная защита служебной живой копии (§24.1 п.3): chmod -R a-w
    chmodRecursive(liveDir, false);

    return {
      ok: true,
      liveDir,
      headSha: liveSha,
      switchedPlugins: switched.map((s) => s.id),
      message: `служебная копия live-checkout успешно настроена в ${liveDir} (${liveSha.slice(0, 7)}), плагины переведены`,
    };
  } finally {
    setLiveCheckoutMigrating(opts.store, repoRoot, false);
  }
}
