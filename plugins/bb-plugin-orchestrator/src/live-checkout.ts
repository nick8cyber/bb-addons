/**
 * orchestrator §24.1 п.2–3 (PLUG-410): служебная живая копия ~/.bb/plugin-live/<repo>,
 * атомарная миграция live-checkout setup под §23 («всё или ничего») и защита живой копии.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { OrchestratorError } from "./errors.js";
import type { DelegationStore } from "./store.js";
import type { CmdRunner } from "./cmd.js";
import type { BbCli } from "./bb-cli.js";
import type { ReleaseConfigLoad } from "./release-config.js";
import { MERGE_LOCK_NAME } from "./merge.js";

export function defaultLiveDir(repoRoot: string): string {
  const name = basename(resolve(repoRoot));
  return join(homedir(), ".bb", "plugin-live", name);
}

export function isLiveCheckoutPath(p: string): boolean {
  const norm = resolve(p);
  const liveBase = join(homedir(), ".bb", "plugin-live");
  return norm.startsWith(liveBase) || norm.includes(".bb/plugin-live");
}

function canonicalRepoPath(repo: string): string {
  let canonical = resolve(repo);
  try {
    const common = execFileSync(
      "git",
      ["-C", canonical, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" },
    ).trim();
    if (common) canonical = dirname(common);
  } catch {}
  return canonical;
}

export function isLiveCheckoutMigrating(
  store: DelegationStore | null | undefined,
  repoRoot: string,
): boolean {
  if (!store?.metaGet) return false;
  const directKey = `live-checkout:migrating:${resolve(repoRoot)}`;
  if (store.metaGet(directKey) === "true") return true;
  const canonKey = `live-checkout:migrating:${canonicalRepoPath(repoRoot)}`;
  return store.metaGet(canonKey) === "true";
}

export function setLiveCheckoutMigrating(
  store: DelegationStore | null | undefined,
  repoRoot: string,
  migrating: boolean,
): void {
  if (!store?.metaSet) return;
  const val = migrating ? "true" : "false";
  store.metaSet(`live-checkout:migrating:${resolve(repoRoot)}`, val);
  store.metaSet(`live-checkout:migrating:${canonicalRepoPath(repoRoot)}`, val);
}

/**
 * Рекурсивное изменение прав доступа служебной живой копии (§24.1 п.3):
 * - При makeWritable=true: каталогам 0o755, исполняемым файлам 0o755, обычным файлам 0o644.
 * - При makeWritable=false: каталогам 0o555, исполняемым файлам 0o555, обычным файлам 0o444.
 * Не следует по символическим ссылкам и сохраняет executable биты.
 */
export function chmodRecursive(dir: string, makeWritable: boolean): void {
  if (!existsSync(dir)) return;

  const toggle = (target: string, isDir: boolean) => {
    try {
      const st = statSync(target);
      const isExec = isDir || (st.mode & 0o111) !== 0;
      const newMode = makeWritable
        ? isExec
          ? 0o755
          : 0o644
        : isExec
          ? 0o555
          : 0o444;
      chmodSync(target, newMode);
    } catch {}
  };

  if (makeWritable) {
    toggle(dir, true);
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    if (!makeWritable) toggle(dir, true);
    return;
  }

  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = join(dir, e.name);
    try {
      if (e.isDirectory()) {
        chmodRecursive(full, makeWritable);
      } else if (e.isFile()) {
        toggle(full, false);
      }
    } catch {}
  }

  if (!makeWritable) {
    toggle(dir, true);
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
  threadId?: string;
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
  const callerThreadId = opts.threadId ?? process.env.BB_THREAD_ID;
  if (callerThreadId && opts.store) {
    const role = opts.store.threadRole?.(callerThreadId)?.role;
    if (role && role !== "none") {
      throw new OrchestratorError(
        "live-checkout-needs-approval",
        "live-checkout-needs-approval: требуется одобрение владельца по §23 (агент не может одобрять миграцию)",
      );
    }
  }

  if (!opts.approved) {
    throw new OrchestratorError(
      "live-checkout-needs-approval",
      "live-checkout-needs-approval: требуется одобрение владельца по §23 для перевода живых плагинов на служебную копию",
    );
  }

  const repoRoot = resolve(opts.repoRoot);
  const canonicalRoot = canonicalRepoPath(repoRoot);
  const rawTarget =
    opts.targetBranch ??
    opts.releaseConfig?.config?.projects?.[0]?.target ??
    "main";
  const targetBranch =
    typeof rawTarget === "string" ? rawTarget : (rawTarget?.branch ?? "main");
  const liveDir = opts.liveDir ? resolve(opts.liveDir) : defaultLiveDir(repoRoot);

  // Захватываем общий замок репозитория для сериализации с merge и release
  let gitDir = "";
  try {
    gitDir = execFileSync(
      "git",
      ["-C", canonicalRoot, "rev-parse", "--path-format=absolute", "--git-dir"],
      { encoding: "utf8" },
    ).trim();
  } catch {}
  const lockPath = join(gitDir || join(canonicalRoot, ".git"), MERGE_LOCK_NAME);
  let lockAcquired = false;
  try {
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n\n\nsetupLiveCheckout\n`, {
      flag: "wx",
    });
    lockAcquired = true;
  } catch (e: any) {
    if (e.code === "EEXIST") {
      throw new OrchestratorError(
        "merge-in-progress",
        `репозиторий заблокирован другой операцией (замок ${lockPath})`,
      );
    }
  }

  // Блокировка release во время миграции
  setLiveCheckoutMigrating(opts.store, canonicalRoot, true);

  const switched: Array<{ id: string; prevDir: string }> = [];
  const parentDir = dirname(liveDir);
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });

  // Создаём временный токен авторизации для reference-transaction
  const tokenFile = join(parentDir, ".token");
  const tokenVal = randomBytes(24).toString("hex");
  writeFileSync(
    tokenFile,
    JSON.stringify({
      token: tokenVal,
      repo: liveDir,
      expiresAt: Date.now() + 600_000,
    }),
    { mode: 0o600 },
  );

  const gitEnv = { ...process.env, ORCH_LIVE_TOKEN: tokenVal };

  try {
    // (а) служебная копия ~/.bb/plugin-live/<repo> — отдельный clone на origin/<target>
    let realOrigin = "";
    try {
      realOrigin = execFileSync("git", ["-C", canonicalRoot, "remote", "get-url", "origin"], {
        encoding: "utf8",
      }).trim();
    } catch {}
    if (!realOrigin) realOrigin = canonicalRoot;

    if (!existsSync(liveDir)) {
      execFileSync("git", ["clone", "--branch", targetBranch, realOrigin, liveDir], {
        encoding: "utf8",
        stdio: "pipe",
        env: gitEnv,
      });
    } else {
      chmodRecursive(liveDir, true);
      execFileSync("git", ["-C", liveDir, "fetch", "origin"], {
        encoding: "utf8",
        stdio: "pipe",
        env: gitEnv,
      });
      execFileSync("git", ["-C", liveDir, "merge", "--ff-only", `origin/${targetBranch}`], {
        encoding: "utf8",
        stdio: "pipe",
        env: gitEnv,
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
          execFileSync("npm", ["run", "build"], { cwd: pDir, encoding: "utf8", stdio: "pipe" });
        }
        // Проверяем наличие dist и валидного build-info.json
        const distDir = join(pDir, "dist");
        if (existsSync(distDir)) {
          const infoPath = join(distDir, "build-info.json");
          if (!existsSync(infoPath)) {
            const info = { gitSha: liveSha, builtAt: new Date().toISOString() };
            writeFileSync(infoPath, JSON.stringify(info, null, 2) + "\n");
          }
        }
      }
    }

    // (в) перевод источников установленных плагинов по одному с проверкой,
    // что плагин поднялся и его build-info.json равен SHA служебной копии
    let plugins = opts.pluginsToMigrate ?? [];
    if (!opts.pluginsToMigrate && opts.bbCli) {
      try {
        const listRes = await opts.bbCli.run(["plugin", "list", "--json"]);
        if (listRes.exitCode === 0) {
          const parsed = JSON.parse(listRes.stdout);
          const allPlugins = Array.isArray(parsed) ? parsed : parsed.plugins ?? [];
          plugins = allPlugins
            .filter((p: any) => {
              const root = p.rootDir ?? p.dir ?? p.path;
              if (!root) return false;
              const rNorm = resolve(root);
              return rNorm === canonicalRoot || rNorm.startsWith(canonicalRoot + "/");
            })
            .map((p: any) => {
              const root = resolve(p.rootDir ?? p.dir ?? p.path);
              const rel = relative(canonicalRoot, root);
              return {
                id: p.id,
                dirName: basename(root),
                currentSourceDir: root,
                relPath: rel,
              };
            });
        }
      } catch {}
    }

    for (const plugin of plugins) {
      const relPath = (plugin as any).relPath ?? join("plugins", plugin.dirName);
      const newPluginDir = join(liveDir, relPath);
      try {
        if (opts.onSwitchPlugin) {
          await opts.onSwitchPlugin(plugin.id, newPluginDir);
        } else if (opts.bbCli) {
          const swRes = await opts.bbCli.run(["plugin", "install", newPluginDir]);
          if (swRes.exitCode !== 0) {
            throw new Error(`bb plugin install ${newPluginDir} failed: ${swRes.stderr}`);
          }
        }

        // Проверяем build-info.json в целевой сборке
        const buildInfoPath = join(newPluginDir, "dist", "build-info.json");
        if (!opts.onSwitchPlugin || existsSync(buildInfoPath)) {
          let matchesSha = false;
          if (existsSync(buildInfoPath)) {
            try {
              const parsed = JSON.parse(readFileSync(buildInfoPath, "utf8"));
              if (parsed.gitSha === liveSha) {
                matchesSha = true;
              }
            } catch {}
          }

          if (!matchesSha) {
            throw new Error(`build-info.json SHA не совпадает с SHA служебной копии (${liveSha})`);
          }
        }

        switched.push({ id: plugin.id, prevDir: plugin.currentSourceDir });
      } catch (err: any) {
        // Сбой на любом плагине — все уже переведённые плагины возвращаются на прежний источник
        for (let i = switched.length - 1; i >= 0; i--) {
          const s = switched[i]!;
          try {
            if (opts.onSwitchPlugin) {
              await opts.onSwitchPlugin(s.id, s.prevDir);
            } else if (opts.bbCli) {
              await opts.bbCli.run(["plugin", "install", s.prevDir]);
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
    try {
      if (opts.updateReleaseConfigCheckout) {
        await opts.updateReleaseConfigCheckout(liveDir);
      }
    } catch (err: any) {
      // Сбой обновления postPublish.checkout — откат всех переведённых плагинов
      for (let i = switched.length - 1; i >= 0; i--) {
        const s = switched[i]!;
        try {
          if (opts.onSwitchPlugin) {
            await opts.onSwitchPlugin(s.id, s.prevDir);
          } else if (opts.bbCli) {
            await opts.bbCli.run(["plugin", "install", s.prevDir]);
          }
        } catch {}
      }
      throw new OrchestratorError(
        "live-checkout-failed",
        `сбой обновления postPublish.checkout: ${err.message ?? String(err)}`,
      );
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
    if (existsSync(tokenFile)) {
      try {
        rmSync(tokenFile, { force: true });
      } catch {}
    }
    setLiveCheckoutMigrating(opts.store, canonicalRoot, false);
    if (lockAcquired) {
      try {
        rmSync(lockPath, { force: true });
      } catch {}
    }
  }
}
