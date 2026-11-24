/**
 * orchestrator §24.1 (PLUG-410): границы для агентов кодом —
 * единый список имён HOOK_NAMES, установка хуков и hooks doctor.
 */
import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DelegationStore } from "./store.js";

/**
 * §24.1 п.1: Единый список имён хуков — все 23 стандартных хука git из githooks(5).
 * push-to-checkout ИСКЛЮЧЁН по §17.3 (при updateInstead обёртка с кодом 0
 * оставила бы индекс и файлы старыми после сдвига ветки).
 */
export const HOOK_NAMES = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "post-index-change",
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

export const SPECIALIZED_HOOK_NAMES = [
  "pre-commit",
  "post-checkout",
  "pre-push",
  "reference-transaction",
] as const;

export const PASSTHROUGH_HOOK_NAMES = HOOK_NAMES.filter(
  (n) => !(SPECIALIZED_HOOK_NAMES as readonly string[]).includes(n),
);

export function defaultHooksDir(): string {
  return join(homedir(), ".bb", "git-hooks");
}

export interface ChainConfig {
  previousGlobalHooksPath?: string | null;
  localHooks?: Record<string, string>;
}

export function readChainConfig(hooksDir: string): ChainConfig {
  const file = join(hooksDir, "chain.json");
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, "utf8");
    return JSON.parse(raw) as ChainConfig;
  } catch {
    return {};
  }
}

export function writeChainConfig(hooksDir: string, cfg: ChainConfig): void {
  const file = join(hooksDir, "chain.json");
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o644 });
}

export interface InstallHooksOptions {
  hooksDir?: string;
  fixLocalCopy?: string;
  hooksSrcDir?: string;
  runCmd?: (cmd: string, args: string[]) => string;
}

export interface InstallHooksResult {
  ok: boolean;
  hooksDir: string;
  message: string;
  fixedLocalCopy?: string;
}

const PLUGIN_HOOKS_SRC = fileURLToPath(new URL("../hooks", import.meta.url));

/**
 * bb orchestrator hooks install: идемпотентно устанавливает 23 хука в ~/.bb/git-hooks,
 * сохраняет chain.json и настраивает core.hooksPath.
 */
export async function installHooks(
  opts: InstallHooksOptions = {},
): Promise<InstallHooksResult> {
  const hooksDir = opts.hooksDir ? resolve(opts.hooksDir) : defaultHooksDir();
  const hooksSrc = opts.hooksSrcDir ? resolve(opts.hooksSrcDir) : PLUGIN_HOOKS_SRC;
  const exec = opts.runCmd ?? ((cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim());

  if (opts.fixLocalCopy) {
    const copyPath = resolve(opts.fixLocalCopy);
    let localHooksPath = "";
    try {
      localHooksPath = exec("git", ["-C", copyPath, "config", "--local", "core.hooksPath"]);
    } catch {}
    if (!localHooksPath) {
      return {
        ok: true,
        hooksDir,
        message: `копия ${copyPath} не имеет локального core.hooksPath`,
      };
    }
    mkdirSync(hooksDir, { recursive: true, mode: 0o755 });
    const chain = readChainConfig(hooksDir);
    chain.localHooks = chain.localHooks ?? {};
    chain.localHooks[copyPath] = localHooksPath;
    writeChainConfig(hooksDir, chain);

    try {
      exec("git", ["-C", copyPath, "config", "--local", "--unset", "core.hooksPath"]);
    } catch {}

    return {
      ok: true,
      hooksDir,
      fixedLocalCopy: copyPath,
      message: `локальный core.hooksPath для ${copyPath} (${localHooksPath}) перенесён в chain.json и снят`,
    };
  }

  mkdirSync(hooksDir, { recursive: true, mode: 0o755 });

  // 1. Проверяем действующий глобальный core.hooksPath
  let existingGlobal: string | null = null;
  try {
    const raw = exec("git", ["config", "--global", "core.hooksPath"]);
    if (raw) existingGlobal = resolve(raw);
  } catch {}

  const chain = readChainConfig(hooksDir);
  if (existingGlobal && existingGlobal !== hooksDir && !chain.previousGlobalHooksPath) {
    chain.previousGlobalHooksPath = existingGlobal;
  }
  writeChainConfig(hooksDir, chain);

  // 2. Раскладываем исполняемые файлы на каждое имя из HOOK_NAMES
  for (const name of HOOK_NAMES) {
    let srcFile: string;
    if ((SPECIALIZED_HOOK_NAMES as readonly string[]).includes(name)) {
      srcFile = join(hooksSrc, name);
    } else {
      srcFile = join(hooksSrc, "chain");
    }

    const dstFile = join(hooksDir, name);
    if (existsSync(srcFile)) {
      copyFileSync(srcFile, dstFile);
    } else {
      // Запасной fallback для обёрток
      const fallback = join(hooksSrc, "chain");
      copyFileSync(fallback, dstFile);
    }
    chmodSync(dstFile, 0o755);
  }

  // Вспомогательные файлы сканера и исключений
  const leakScanSrc = join(hooksSrc, "leak-scan.ts");
  if (existsSync(leakScanSrc)) {
    copyFileSync(leakScanSrc, join(hooksDir, "leak-scan.ts"));
  }
  const exclusionsSrc = join(hooksSrc, "exclusions");
  if (existsSync(exclusionsSrc)) {
    copyFileSync(exclusionsSrc, join(hooksDir, "exclusions"));
  }

  // push-to-checkout НЕ входит в HOOK_NAMES и удаляется при наличии
  const ptc = join(hooksDir, "push-to-checkout");
  if (existsSync(ptc)) {
    rmSync(ptc, { force: true });
  }

  // 3. Выставляем глобальный core.hooksPath
  exec("git", ["config", "--global", "core.hooksPath", hooksDir]);

  return {
    ok: true,
    hooksDir,
    message: `хуки оркестратора успешно установлены в ${hooksDir} (${HOOK_NAMES.length} хуков)`,
  };
}

export interface DoctorOptions {
  hooksDir?: string;
  repo?: string;
  copy?: string;
  store?: DelegationStore | null;
  runCmd?: (cmd: string, args: string[]) => string;
}

export interface DoctorIssue {
  copy?: string;
  type: "local-hooks-path" | "effective-path-mismatch" | "missing-hook" | "non-executable-hook";
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  code: 0 | 2;
  issues: DoctorIssue[];
  message: string;
}

/**
 * bb orchestrator hooks doctor: проверяет каждую копию проекта
 * (основную, worktree задач, копии координаторов, служебную живую).
 * Код 2 при любых нарушениях целостности.
 */
export async function runHooksDoctor(
  opts: DoctorOptions = {},
): Promise<DoctorResult> {
  const hooksDir = opts.hooksDir ? resolve(opts.hooksDir) : defaultHooksDir();
  const exec = opts.runCmd ?? ((cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim());
  const issues: DoctorIssue[] = [];

  // 1. Проверяем полноту и исполняемость набора в hooksDir
  const missingHooks: string[] = [];
  const nonExecHooks: string[] = [];

  for (const name of HOOK_NAMES) {
    const file = join(hooksDir, name);
    if (!existsSync(file)) {
      missingHooks.push(name);
    } else {
      try {
        const mode = statSync(file).mode;
        if (!(mode & 0o111)) {
          nonExecHooks.push(name);
        }
      } catch {
        missingHooks.push(name);
      }
    }
  }

  if (missingHooks.length > 0) {
    issues.push({
      type: "missing-hook",
      detail: `каталог ${hooksDir} не содержит хуков: ${missingHooks.join(", ")}`,
    });
  }
  if (nonExecHooks.length > 0) {
    issues.push({
      type: "non-executable-hook",
      detail: `хуки в ${hooksDir} не имеют флага исполнения (+x): ${nonExecHooks.join(", ")}`,
    });
  }

  // 2. Собираем копии для проверки
  const copiesToCheck = new Set<string>();
  if (opts.copy) {
    copiesToCheck.add(resolve(opts.copy));
  } else {
    const targetRepo = opts.repo ? resolve(opts.repo) : process.cwd();
    copiesToCheck.add(targetRepo);

    // Ищем основной репозиторий и его linked worktrees
    let rootRepo = targetRepo;
    try {
      const common = exec("git", ["-C", targetRepo, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (common) {
        rootRepo = dirname(common);
        copiesToCheck.add(rootRepo);
      }
    } catch {}

    try {
      const wtOut = exec("git", ["-C", rootRepo, "worktree", "list", "--porcelain"]);
      for (const line of wtOut.split("\n")) {
        if (line.startsWith("worktree ")) {
          const wtPath = line.slice("worktree ".length).trim();
          if (existsSync(wtPath)) {
            copiesToCheck.add(resolve(wtPath));
          }
        }
      }
    } catch {}

    // Служебная живая копия
    const repoName = basename(rootRepo);
    const liveCandidate = join(homedir(), ".bb", "plugin-live", repoName);
    if (existsSync(liveCandidate)) {
      copiesToCheck.add(resolve(liveCandidate));
    }

    // Копии координаторов из базы
    if (opts.store) {
      try {
        const list = opts.store.activeCoordinatorWorktrees?.() ?? [];
        for (const row of list) {
          if (row.worktree_path && existsSync(row.worktree_path)) {
            copiesToCheck.add(resolve(row.worktree_path));
          }
        }
      } catch {}
    }
  }

  // 3. Проверяем каждую копию
  for (const copy of copiesToCheck) {
    if (!existsSync(copy)) continue;

    // Проверяем локальный core.hooksPath
    let localHooksPath: string | null = null;
    try {
      const out = exec("git", ["-C", copy, "config", "--local", "core.hooksPath"]);
      if (out) localHooksPath = out;
    } catch {}

    if (localHooksPath) {
      issues.push({
        copy,
        type: "local-hooks-path",
        detail: `копия ${copy} имеет локальный core.hooksPath=${localHooksPath}; запустите hooks install --fix-local ${copy}`,
      });
      continue;
    }

    // Проверяем действующий путь хуков
    let effectivePath: string | null = null;
    try {
      const out = exec("git", ["-C", copy, "rev-parse", "--git-path", "hooks"]);
      if (out) effectivePath = resolve(isAbsolute(out) ? out : join(copy, out));
    } catch {}

    if (effectivePath !== hooksDir) {
      issues.push({
        copy,
        type: "effective-path-mismatch",
        detail: `копия ${copy}: действующий путь хуков (${effectivePath ?? "не определён"}) не равен ${hooksDir}`,
      });
    }
  }

  if (issues.length > 0) {
    const lines = issues.map((i) => i.detail);
    return {
      ok: false,
      code: 2,
      issues,
      message: lines.join("\n"),
    };
  }

  return {
    ok: true,
    code: 0,
    issues: [],
    message: `OK: действующий путь хуков во всех проверенных копиях равен ${hooksDir}, все ${HOOK_NAMES.length} хуков активны`,
  };
}
