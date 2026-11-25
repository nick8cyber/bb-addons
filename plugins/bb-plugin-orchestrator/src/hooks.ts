/**
 * orchestrator §24.1 п.1 (PLUG-410): границы для агентов кодом —
 * единый список имён HOOK_NAMES, установка хуков и hooks doctor.
 *
 * Один список имён: файл `hooks/hook-names` — его читают и этот модуль
 * (`HOOK_NAMES`), и установщик `hooks/install.mjs`, и проверка свежести
 * в release; второго списка нет.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OrchestratorError } from "./errors.js";
import type { DelegationStore } from "./store.js";

const PLUGIN_HOOKS_SRC = fileURLToPath(new URL("../hooks", import.meta.url));

/** §24.1 п.1: имена из `hooks/hook-names` (все стандартные хуки
 * githooks(5) без `push-to-checkout`, §17.3). */
export function readHookNames(src: string = PLUGIN_HOOKS_SRC): readonly string[] {
  return readFileSync(join(src, "hook-names"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export const HOOK_NAMES: readonly string[] = Object.freeze(readHookNames());

export const SPECIALIZED_HOOK_NAMES = [
  "pre-commit",
  "post-checkout",
  "pre-push",
  "reference-transaction",
] as const;

/** Не хуки, а модули рядом с ними: общий код хуков и сканер утечек. */
export const HOOK_SUPPORT_FILES = ["hook-lib.mjs", "leak-scan.ts"] as const;

export const PASSTHROUGH_HOOK_NAMES = HOOK_NAMES.filter(
  (n) => !(SPECIALIZED_HOOK_NAMES as readonly string[]).includes(n),
);

/** `~/.bb/git-hooks`; `ORCHESTRATOR_HOOKS_DIR` — только для тестов
 * (процесс плагина, не агента: окружение задаёт BB). */
export function defaultHooksDir(): string {
  return process.env.ORCHESTRATOR_HOOKS_DIR || join(homedir(), ".bb", "git-hooks");
}

export function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export interface ChainConfig {
  /** Как прочитано из git: абсолютный путь, либо относительный (git
   * отсчитывает его от каталога запуска хука — так же `hook-lib.mjs`). */
  previousGlobalHooksPath?: string | null;
  /** Реальный путь копии (top level) → прежний действующий каталог хуков. */
  localHooks?: Record<string, string>;
}

export function readChainConfig(hooksDir: string): ChainConfig {
  const file = join(hooksDir, "chain.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ChainConfig;
  } catch {
    return {};
  }
}

export function writeChainConfig(hooksDir: string, cfg: ChainConfig): void {
  const file = join(hooksDir, "chain.json");
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, file);
}

export type RunCmd = (cmd: string, args: string[]) => string;

const defaultExec: RunCmd = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function tryExec(exec: RunCmd, cmd: string, args: string[]): string {
  try {
    return exec(cmd, args);
  } catch {
    return "";
  }
}

export interface InstallHooksOptions {
  hooksDir?: string;
  fixLocalCopy?: string;
  confirmed?: boolean;
  /** Вызов из терминала владельца (нет BB_THREAD_ID) — проверяет сервер. */
  owner?: boolean;
  hooksSrcDir?: string;
  runCmd?: RunCmd;
}

export interface InstallHooksResult {
  ok: boolean;
  hooksDir: string;
  message: string;
  fixedLocalCopy?: string;
  moved?: Array<{ copy: string; scope: string; value: string }>;
}

/** Значения core.hooksPath копии по областям (`--show-scope`). */
export function hooksPathScopes(
  exec: RunCmd,
  copy: string,
): Array<{ scope: string; value: string }> {
  const out = tryExec(exec, "git", [
    "-C",
    copy,
    "config",
    "--show-scope",
    "--get-all",
    "core.hooksPath",
  ]);
  const res: Array<{ scope: string; value: string }> = [];
  for (const line of out.split("\n")) {
    const m = /^(\w+)\t(.*)$/.exec(line);
    if (m) res.push({ scope: m[1]!, value: m[2]! });
  }
  return res;
}

/** Действующий каталог хуков копии (`rev-parse --git-path hooks`). */
export function effectiveHooksPath(exec: RunCmd, copy: string): string | null {
  const out = tryExec(exec, "git", ["-C", copy, "rev-parse", "--git-path", "hooks"]);
  if (!out) return null;
  let p = out;
  if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  const top = tryExec(exec, "git", ["-C", copy, "rev-parse", "--show-toplevel"]) || copy;
  return realPath(isAbsolute(p) ? p : resolve(top, p));
}

function listWorktrees(exec: RunCmd, copy: string): string[] {
  const out = tryExec(exec, "git", ["-C", copy, "worktree", "list", "--porcelain"]);
  const res: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      const p = line.slice("worktree ".length).trim();
      if (p && existsSync(p)) res.push(realPath(p));
    }
  }
  return res;
}

const OVERRIDE_SCOPES = new Set(["local", "worktree", "command"]);

/**
 * `hooks install --fix-local <копия>` (§24.1 п.1): только по
 * подтверждению владельца. Переносит действующий локальный путь хуков
 * (области `local` и `worktree`) в chain.json — для этой копии и для
 * каждой копии того же репозитория, которая жила на общей `local`
 * настройке, — снимает настройку и проверяет, что действующий путь
 * каждой затронутой копии стал общим каталогом. Не стал — настройка
 * возвращается, chain.json прежний, отказ.
 */
function fixLocal(
  opts: InstallHooksOptions,
  hooksDir: string,
  exec: RunCmd,
): InstallHooksResult {
  if (!opts.owner) {
    throw new OrchestratorError(
      "permission-denied",
      "owner-only: перенос локального core.hooksPath делает только владелец из своего терминала",
    );
  }
  if (!opts.confirmed) {
    throw new OrchestratorError(
      "fix-local-needs-confirmation",
      "fix-local-needs-confirmation: перенос локального core.hooksPath требует подтверждения владельца (--confirm)",
    );
  }
  const copyArg = resolve(opts.fixLocalCopy!);
  const top = tryExec(exec, "git", ["-C", copyArg, "rev-parse", "--show-toplevel"]);
  if (!top) {
    throw new OrchestratorError("invalid-arguments", `${copyArg} — не рабочая копия git`);
  }
  const copy = realPath(top);
  const own = hooksPathScopes(exec, copy).filter((s) => OVERRIDE_SCOPES.has(s.scope));
  const local = own.filter((s) => s.scope === "local").at(-1);
  const wt = own.filter((s) => s.scope === "worktree").at(-1);
  if (!local && !wt) {
    return { ok: true, hooksDir, message: `копия ${copy} не имеет локального core.hooksPath` };
  }
  // Копии, чей действующий путь сейчас задан локальной областью: эта
  // копия и (если снимается `local`) все worktree без своей настройки.
  const affected = new Map<string, string>(); // копия → прежний путь
  const before = effectiveHooksPath(exec, copy);
  if (before) affected.set(copy, before);
  if (local) {
    for (const w of listWorktrees(exec, copy)) {
      if (w === copy) continue;
      const scopes = hooksPathScopes(exec, w).filter((s) => OVERRIDE_SCOPES.has(s.scope));
      if (scopes.at(-1)?.scope === "local") {
        const p = effectiveHooksPath(exec, w);
        if (p) affected.set(w, p);
      }
    }
  }
  mkdirSync(hooksDir, { recursive: true, mode: 0o755 });
  const chainBefore = readChainConfig(hooksDir);
  const chain: ChainConfig = JSON.parse(JSON.stringify(chainBefore));
  chain.localHooks = chain.localHooks ?? {};
  for (const [c, p] of affected) {
    if (p !== realPath(hooksDir)) chain.localHooks[c] = p;
  }
  writeChainConfig(hooksDir, chain);

  const restore = () => {
    if (wt) tryExec(exec, "git", ["-C", copy, "config", "--worktree", "core.hooksPath", wt.value]);
    if (local) tryExec(exec, "git", ["-C", copy, "config", "--local", "core.hooksPath", local.value]);
    writeChainConfig(hooksDir, chainBefore);
  };
  try {
    if (wt) exec("git", ["-C", copy, "config", "--worktree", "--unset-all", "core.hooksPath"]);
    if (local) exec("git", ["-C", copy, "config", "--local", "--unset-all", "core.hooksPath"]);
  } catch (err) {
    restore();
    throw new OrchestratorError(
      "git-failed",
      `не удалось снять локальную настройку core.hooksPath в ${copy}: ${(err as Error).message ?? String(err)}`,
    );
  }
  const want = realPath(hooksDir);
  const wrong: string[] = [];
  for (const c of affected.keys()) {
    const now = effectiveHooksPath(exec, c);
    if (now !== want) wrong.push(`${c} → ${now ?? "?"}`);
  }
  if (wrong.length) {
    restore();
    throw new OrchestratorError(
      "git-failed",
      `после переноса действующий путь хуков не равен ${want}: ${wrong.join("; ")} — настройка возвращена`,
    );
  }
  const moved = [
    ...(local ? [{ copy, scope: "local", value: local.value }] : []),
    ...(wt ? [{ copy, scope: "worktree", value: wt.value }] : []),
  ];
  return {
    ok: true,
    hooksDir,
    fixedLocalCopy: copy,
    moved,
    message:
      `локальный core.hooksPath копии ${copy} (${moved.map((m) => `${m.scope}=${m.value}`).join(", ")}) ` +
      `перенесён в chain.json (${affected.size} копий), действующий путь — ${want}`,
  };
}

/**
 * bb orchestrator hooks install: идемпотентно кладёт файл на каждое имя
 * HOOK_NAMES и общие модули в каталог хуков, записывает прежний
 * глобальный core.hooksPath в chain.json и выставляет глобальный путь.
 */
export async function installHooks(
  opts: InstallHooksOptions = {},
): Promise<InstallHooksResult> {
  const hooksDir = opts.hooksDir ? resolve(opts.hooksDir) : defaultHooksDir();
  const hooksSrc = opts.hooksSrcDir ? resolve(opts.hooksSrcDir) : PLUGIN_HOOKS_SRC;
  const exec = opts.runCmd ?? defaultExec;

  if (opts.fixLocalCopy) return fixLocal(opts, hooksDir, exec);

  mkdirSync(hooksDir, { recursive: true, mode: 0o755 });

  // 1. Прежний глобальный core.hooksPath — как его читает git.
  const raw = tryExec(exec, "git", ["config", "--global", "core.hooksPath"]);
  const chain = readChainConfig(hooksDir);
  if (raw) {
    const abs = raw.startsWith("~/")
      ? join(homedir(), raw.slice(2))
      : isAbsolute(raw)
        ? resolve(raw)
        : null;
    const ours = abs !== null && realPath(abs) === realPath(hooksDir);
    if (!ours && !chain.previousGlobalHooksPath) {
      chain.previousGlobalHooksPath = abs ?? raw;
    }
  }
  writeChainConfig(hooksDir, chain);

  // 2. Файл на каждое имя из HOOK_NAMES + общие модули.
  const names = readHookNames(hooksSrc);
  for (const name of names) {
    const special = (SPECIALIZED_HOOK_NAMES as readonly string[]).includes(name);
    const srcFile = join(hooksSrc, special ? name : "chain");
    const dstFile = join(hooksDir, name);
    const tmp = `${dstFile}.tmp-${process.pid}`;
    copyFileSync(srcFile, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, dstFile);
  }
  for (const f of HOOK_SUPPORT_FILES) {
    copyFileSync(join(hooksSrc, f), join(hooksDir, f));
  }
  const exclusions = join(hooksDir, "exclusions");
  if (!existsSync(exclusions)) writeFileSync(exclusions, "");
  // push-to-checkout НЕ входит в HOOK_NAMES (§17.3) — убираем старую обёртку.
  rmSync(join(hooksDir, "push-to-checkout"), { force: true });

  // 3. Глобальный core.hooksPath и проверка записи.
  exec("git", ["config", "--global", "core.hooksPath", hooksDir]);
  const after = tryExec(exec, "git", ["config", "--global", "core.hooksPath"]);
  if (opts.runCmd === undefined && realPath(after || "/nonexistent") !== realPath(hooksDir)) {
    throw new OrchestratorError(
      "git-failed",
      `глобальный core.hooksPath не выставлен (${after || "пусто"})`,
    );
  }

  return {
    ok: true,
    hooksDir,
    message: `хуки оркестратора установлены в ${hooksDir} (${names.length} хуков)`,
  };
}

export interface DoctorOptions {
  hooksDir?: string;
  repo?: string;
  copy?: string;
  store?: DelegationStore | null;
  /** Служебные живые копии проекта из принятой настройки
   * (`postPublish.checkout`), §24.1 п.1. */
  liveCheckouts?: string[];
  /** Строка владельцу; true — доставлена. */
  notifyOwner?: (line: string) => Promise<boolean>;
  runCmd?: RunCmd;
}

export interface DoctorIssue {
  copy?: string;
  type:
    | "local-hooks-path"
    | "effective-path-mismatch"
    | "missing-hook"
    | "non-executable-hook";
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  code: 0 | 2;
  issues: DoctorIssue[];
  copies?: string[];
  ownerNotified?: boolean;
  message: string;
}

/**
 * bb orchestrator hooks doctor: полный набор в каталоге хуков и каждая
 * копия проекта (основная, worktree задач, копии координаторов,
 * служебная живая из принятой настройки). Код 2 при любом нарушении;
 * копия с локальным core.hooksPath — строка владельцу.
 */
export async function runHooksDoctor(
  opts: DoctorOptions = {},
): Promise<DoctorResult> {
  const hooksDir = opts.hooksDir ? resolve(opts.hooksDir) : defaultHooksDir();
  const want = realPath(hooksDir);
  const exec = opts.runCmd ?? defaultExec;
  const issues: DoctorIssue[] = [];

  // 1. Полнота и исполняемость набора.
  const missing: string[] = [];
  const nonExec: string[] = [];
  for (const name of HOOK_NAMES) {
    const file = join(hooksDir, name);
    try {
      const st = statSync(file);
      if (!st.isFile()) missing.push(name);
      else if (!(st.mode & 0o111)) nonExec.push(name);
    } catch {
      missing.push(name);
    }
  }
  for (const f of HOOK_SUPPORT_FILES) {
    if (!existsSync(join(hooksDir, f))) missing.push(f);
  }
  if (missing.length) {
    issues.push({
      type: "missing-hook",
      detail: `каталог ${hooksDir} не содержит: ${missing.join(", ")}`,
    });
  }
  if (nonExec.length) {
    issues.push({
      type: "non-executable-hook",
      detail: `хуки в ${hooksDir} не исполняемые (+x): ${nonExec.join(", ")}`,
    });
  }

  // 2. Копии.
  const copies = new Set<string>();
  const add = (p: string | null | undefined) => {
    if (p && existsSync(p)) copies.add(realPath(p));
  };
  if (opts.copy) {
    add(opts.copy);
  } else {
    const repo = opts.repo ? resolve(opts.repo) : process.cwd();
    add(repo);
    const common = tryExec(exec, "git", [
      "-C",
      repo,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const commonReal = common ? realPath(common) : "";
    for (const w of listWorktrees(exec, repo)) add(w);
    for (const live of opts.liveCheckouts ?? []) add(live);
    if (opts.store) {
      try {
        for (const row of opts.store.activeCoordinatorWorktrees?.() ?? []) {
          const p = row.worktree_path;
          if (!p || !existsSync(p)) continue;
          const c = tryExec(exec, "git", [
            "-C",
            p,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ]);
          if (c && commonReal && realPath(c) === commonReal) add(p);
        }
      } catch {
        /* база без таблицы — копии координаторов не добавляются */
      }
    }
  }

  // 3. Каждая копия.
  const ownerLines: string[] = [];
  for (const copy of copies) {
    const override = hooksPathScopes(exec, copy)
      .filter((s) => OVERRIDE_SCOPES.has(s.scope))
      .at(-1);
    if (override) {
      const detail =
        `копия ${copy} имеет ${override.scope} core.hooksPath=${override.value}; ` +
        `перенос — владельцем: bb orchestrator hooks install --fix-local ${copy} --confirm`;
      issues.push({ copy, type: "local-hooks-path", detail });
      ownerLines.push(detail);
      continue;
    }
    const eff = effectiveHooksPath(exec, copy);
    if (eff !== want) {
      issues.push({
        copy,
        type: "effective-path-mismatch",
        detail: `копия ${copy}: действующий путь хуков (${eff ?? "не определён"}) не равен ${want}`,
      });
    }
  }

  let ownerNotified: boolean | undefined;
  if (ownerLines.length) {
    ownerNotified = false;
    if (opts.notifyOwner) {
      try {
        ownerNotified = await opts.notifyOwner(
          `hooks doctor: ${ownerLines.join("\n")}`,
        );
      } catch {
        ownerNotified = false;
      }
    }
  }

  const copyList = [...copies];
  if (issues.length) {
    const lines = issues.map((i) => i.detail);
    if (ownerNotified === false) lines.push("строка владельцу не доставлена");
    return {
      ok: false,
      code: 2,
      issues,
      copies: copyList,
      ...(ownerNotified !== undefined ? { ownerNotified } : {}),
      message: lines.join("\n"),
    };
  }
  return {
    ok: true,
    code: 0,
    issues: [],
    copies: copyList,
    message: `OK: в ${copyList.length} копиях действующий путь хуков равен ${want}, все ${HOOK_NAMES.length} хуков на месте`,
  };
}
