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
import { isAbsolute, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OrchestratorError } from "./errors.js";
import type { DelegationStore } from "./store.js";
import type { BbProjectListItem } from "./delegate-base.js";

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
  /** Реальный путь копии (top level) → прежний действующий каталог хуков
   * (область `worktree` — касается только этой копии). */
  localHooks?: Record<string, string>;
  /** Реальный путь общего каталога git репозитория → исходное значение
   * `local` core.hooksPath как его записал владелец. Относительное значение
   * хук разрешает от корня ТЕКУЩЕЙ копии (как git), поэтому оно работает и
   * в worktree, созданных после `--fix-local` (§24.1 п.1, п.6). */
  repoHooks?: Record<string, string>;
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
  exclude?: string[];
  releaseConfig?: any;
  bbCli?: { run: (args: string[], opts?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }> };
  localHostId?: () => Promise<string | null>;
  asyncGit?: (repo: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  projectsList?: BbProjectListItem[];
}

export interface InstallHooksResult {
  ok: boolean;
  hooksDir: string;
  message: string;
  fixedLocalCopy?: string;
  moved?: Array<{ copy: string; scope: string; value: string }>;
  projectsRegistry?: string[];
}

/**
 * Check if exclusion entry covers a target root path (§24.4 п.4–5).
 * Raw entry is compared as written and after realpath (preserving trailing /).
 * Trailing / is directory prefix match; without trailing / is exact match.
 */
export function covers(entry: string, target: string): boolean {
  if (!entry || !target) return false;
  const raw = entry.trim();
  if (!raw || raw.startsWith("#")) return false;
  const variants = [raw];
  const hasSlash = raw.endsWith("/");
  const toResolve = hasSlash ? raw.slice(0, -1) : raw;
  try {
    const resolved = realpathSync(toResolve);
    const norm = hasSlash ? (resolved.endsWith("/") ? resolved : resolved + "/") : resolved;
    if (norm !== raw) variants.push(norm);
  } catch {}
  for (const v of variants) {
    if (v.endsWith("/")) {
      if (target.startsWith(v) || (v.length > 1 && target === v.slice(0, -1))) return true;
    } else {
      if (target === v) return true;
    }
  }
  return false;
}

export function writeJsonAtomic(file: string, value: unknown, mode = 0o644): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  renameSync(tmp, file);
}

function writeContentAtomic(file: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, file);
}

export function mainPathOf(p: BbProjectListItem, localHost: string): string | null {
  for (const s of p.sources ?? []) {
    if (s.type !== "local_path" || !s.path || s.isDefault !== true) continue;
    if (s.hostId && s.hostId !== localHost) continue;
    return s.path;
  }
  return null;
}

export interface CollectProjectsDeps {
  bbCli?: { run: (args: string[], opts?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }> };
  localHostId?: () => Promise<string | null>;
  runCmd?: RunCmd;
  asyncGit?: (repo: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  projectsList?: BbProjectListItem[];
}

export interface CollectProjectsResult {
  ok: boolean;
  registry: string[];
  failures: Array<{ project: string; reason: string }>;
}

/**
 * Сбор реестра projects.json (§24.4 п.2).
 * local_path -> git rev-parse --git-common-dir -> realpath.
 */
export async function collectProjectsRegistry(
  releaseConfig: any,
  deps: CollectProjectsDeps = {},
): Promise<CollectProjectsResult> {
  if (!releaseConfig || !releaseConfig.projects || Object.keys(releaseConfig.projects).length === 0) {
    return { ok: true, registry: [], failures: [] };
  }

  const failures: Array<{ project: string; reason: string }> = [];
  const localHost = deps.localHostId ? String((await deps.localHostId()) ?? "") : "";

  let bbProjects: BbProjectListItem[] = [];
  if (deps.projectsList) {
    bbProjects = deps.projectsList;
  } else if (deps.bbCli) {
    try {
      const res = await deps.bbCli.run(["project", "list", "--json"], { timeoutMs: 30_000 });
      if (res.exitCode !== 0) {
        return {
          ok: false,
          registry: [],
          failures: [{ project: "*", reason: `bb project list завершился с кодом ${res.exitCode}: ${res.stderr}` }],
        };
      }
      const parsed = JSON.parse(res.stdout);
      if (!Array.isArray(parsed)) {
        return {
          ok: false,
          registry: [],
          failures: [{ project: "*", reason: "bb project list вернул не массив" }],
        };
      }
      bbProjects = parsed as BbProjectListItem[];
    } catch (e) {
      return {
        ok: false,
        registry: [],
        failures: [{ project: "*", reason: `сбой bb project list: ${(e as Error).message ?? String(e)}` }],
      };
    }
  } else {
    try {
      const exec = deps.runCmd ?? defaultExec;
      const raw = exec(process.env.BB_CLI ?? "bb", ["project", "list", "--json"]);
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return {
          ok: false,
          registry: [],
          failures: [{ project: "*", reason: "bb project list вернул не массив" }],
        };
      }
      bbProjects = parsed as BbProjectListItem[];
    } catch (e) {
      return {
        ok: false,
        registry: [],
        failures: [{ project: "*", reason: `сбой bb project list: ${(e as Error).message ?? String(e)}` }],
      };
    }
  }

  const registry: string[] = [];
  for (const [pid, pcfg] of Object.entries(releaseConfig.projects)) {
    if (pcfg && (pcfg as any).excluded === true) {
      continue;
    }
    const item = bbProjects.find((p) => p.id === pid || (p as any).name === pid);
    const mainPath = item ? mainPathOf(item, localHost) : null;
    if (!mainPath || !existsSync(mainPath)) {
      continue;
    }

    try {
      let commonRaw = "";
      if (deps.asyncGit) {
        const r = await deps.asyncGit(mainPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        if (r.exitCode !== 0) {
          failures.push({ project: pid, reason: `${mainPath} — не git-репозиторий` });
          continue;
        }
        commonRaw = r.stdout.trim();
      } else {
        const exec = deps.runCmd ?? defaultExec;
        commonRaw = exec("git", ["-C", mainPath, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      }
      if (!commonRaw) {
        failures.push({ project: pid, reason: `${mainPath} — не git-репозиторий` });
        continue;
      }
      const commonReal = realpathSync(commonRaw);
      registry.push(commonReal);
    } catch (err) {
      failures.push({ project: pid, reason: `${mainPath} — не git-репозиторий` });
    }
  }

  if (failures.length > 0) {
    return { ok: false, registry: [], failures };
  }

  return { ok: true, registry: [...new Set(registry)].sort(), failures: [] };
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

/** Значение core.hooksPath, разрешённое как git (от корня копии,
 * `~/` — от домашнего), указывает на каталог `target`. */
function pointsAt(value: string, copy: string, target: string): boolean {
  const v = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return realPath(isAbsolute(v) ? v : resolve(copy, v)) === target;
}

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
  const commonRaw = tryExec(exec, "git", [
    "-C",
    copy,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (local && !commonRaw) {
    throw new OrchestratorError("git-failed", `не удалось определить общий каталог git копии ${copy}`);
  }
  const common = commonRaw ? realPath(commonRaw) : "";
  mkdirSync(hooksDir, { recursive: true, mode: 0o755 });
  const chainBefore = readChainConfig(hooksDir);
  const chain: ChainConfig = JSON.parse(JSON.stringify(chainBefore));
  const want0 = realPath(hooksDir);
  // `local` — значение репозитория: хранится как записано, по общему
  // каталогу (действует во всех копиях, в т.ч. будущих worktree).
  if (local && !pointsAt(local.value, copy, want0)) {
    chain.repoHooks = chain.repoHooks ?? {};
    chain.repoHooks[common] = local.value;
  }
  // `worktree` — только эта копия: её прежний действующий путь.
  if (wt) {
    const p = affected.get(copy);
    if (p && p !== want0) {
      chain.localHooks = chain.localHooks ?? {};
      chain.localHooks[copy] = p;
    }
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

  // 1. Сбор и запись projects.json (п.2; сбой — projects-registry-failed, ничего не записано).
  let projRegistry: string[] | undefined;
  if (opts.releaseConfig !== undefined || opts.projectsList !== undefined) {
    const projRes = await collectProjectsRegistry(opts.releaseConfig, {
      bbCli: opts.bbCli,
      localHostId: opts.localHostId,
      runCmd: exec,
      asyncGit: opts.asyncGit,
      projectsList: opts.projectsList,
    });
    if (!projRes.ok) {
      throw new OrchestratorError(
        "projects-registry-failed",
        `projects-registry-failed: ${projRes.failures.map((f) => `${f.project}: ${f.reason}`).join("; ")}`,
      );
    }
    mkdirSync(hooksDir, { recursive: true, mode: 0o755 });
    writeJsonAtomic(join(hooksDir, "projects.json"), projRes.registry);
    projRegistry = projRes.registry;
  } else if (!existsSync(join(hooksDir, "projects.json"))) {
    mkdirSync(hooksDir, { recursive: true, mode: 0o755 });
    writeJsonAtomic(join(hooksDir, "projects.json"), []);
    projRegistry = [];
  } else {
    try {
      const p = JSON.parse(readFileSync(join(hooksDir, "projects.json"), "utf8"));
      if (Array.isArray(p)) projRegistry = p;
    } catch {}
  }

  // 2. Проверка новых --exclude по свежему реестру и live-copies.json
  // (сбой — exclusion-covers-project, ничего не записано, кроме реестра шага 1).
  const normalizedExcludes = (opts.exclude ?? []).map((arg) => {
    const hasSlash = arg.endsWith("/");
    const abs = resolve(arg);
    return hasSlash ? (abs.endsWith("/") ? abs : abs + "/") : abs;
  });

  if (normalizedExcludes.length > 0) {
    const targets: string[] = [];
    for (const p of projRegistry ?? []) targets.push(dirname(p));
    const liveFile = join(hooksDir, "live-copies.json");
    if (existsSync(liveFile)) {
      try {
        const liveList = JSON.parse(readFileSync(liveFile, "utf8"));
        if (Array.isArray(liveList)) {
          for (const l of liveList) targets.push(l);
        }
      } catch {}
    }

    const coversList: string[] = [];
    for (const entry of normalizedExcludes) {
      for (const t of targets) {
        if (covers(entry, t)) {
          coversList.push(`${entry} → ${t}`);
        }
      }
    }
    if (coversList.length > 0) {
      throw new OrchestratorError(
        "exclusion-covers-project",
        `exclusion-covers-project: ${coversList.join(", ")}`,
      );
    }
  }

  mkdirSync(hooksDir, { recursive: true, mode: 0o755 });

  // 3. Слияние и запись exclusions.
  const exclusionsFile = join(hooksDir, "exclusions");
  let existingContent = "";
  if (existsSync(exclusionsFile)) {
    existingContent = readFileSync(exclusionsFile, "utf8");
  }
  let newContent = existingContent;
  if (normalizedExcludes.length > 0) {
    const existingLines = existingContent.split("\n");
    const existingSet = new Set(existingLines.map((l) => l.trim()).filter(Boolean));
    const toAppend: string[] = [];
    for (const entry of normalizedExcludes) {
      if (!existingSet.has(entry)) {
        toAppend.push(entry);
        existingSet.add(entry);
      }
    }
    if (toAppend.length > 0) {
      if (newContent && !newContent.endsWith("\n")) newContent += "\n";
      newContent += toAppend.join("\n") + "\n";
    }
  }
  if (!existsSync(exclusionsFile) || normalizedExcludes.length > 0) {
    writeContentAtomic(exclusionsFile, newContent);
  }

  // 4. Файлы хуков и core.hooksPath
  // Прежний глобальный core.hooksPath — как его читает git.
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
  // push-to-checkout НЕ входит в HOOK_NAMES (§17.3) — убираем старую обёртку.
  rmSync(join(hooksDir, "push-to-checkout"), { force: true });

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
    projectsRegistry: projRegistry,
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
    | "non-executable-hook"
    | "missing-projects-registry"
    | "exclusion-covers-project";
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

  // 1b. Реестр projects.json (§24.4 п.2).
  const projFile = join(hooksDir, "projects.json");
  let projectsList: string[] | null = null;
  if (!existsSync(projFile)) {
    issues.push({
      type: "missing-projects-registry",
      detail: `реестр проектов не найден: ${projFile}; запусти bb orchestrator hooks install`,
    });
  } else {
    try {
      const parsed = JSON.parse(readFileSync(projFile, "utf8"));
      if (Array.isArray(parsed)) {
        projectsList = parsed;
      } else {
        issues.push({
          type: "missing-projects-registry",
          detail: `реестр проектов ${projFile} повреждён; запусти bb orchestrator hooks install`,
        });
      }
    } catch {
      issues.push({
        type: "missing-projects-registry",
        detail: `реестр проектов ${projFile} не читается; запусти bb orchestrator hooks install`,
      });
    }
  }

  // 1c. Проверка exclusions на покрытие проектов (§24.4 п.5).
  const exclusionsFile = join(hooksDir, "exclusions");
  if (existsSync(exclusionsFile)) {
    let liveList: string[] = [];
    const liveFile = join(hooksDir, "live-copies.json");
    if (existsSync(liveFile)) {
      try {
        const p = JSON.parse(readFileSync(liveFile, "utf8"));
        if (Array.isArray(p)) liveList = p;
      } catch {}
    }
    const targets: string[] = [];
    if (projectsList) {
      for (const p of projectsList) targets.push(dirname(p));
    }
    for (const l of liveList) targets.push(l);

    const lines = readFileSync(exclusionsFile, "utf8").split("\n");
    const covered: string[] = [];
    for (const line of lines) {
      const raw = line.trim();
      if (!raw || raw.startsWith("#")) continue;
      for (const t of targets) {
        if (covers(raw, t)) {
          covered.push(`${raw} → ${t}`);
        }
      }
    }
    if (covered.length > 0) {
      issues.push({
        type: "exclusion-covers-project",
        detail: `запись exclusions покрывает управляемый проект: ${covered.join(", ")}`,
      });
    }
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
