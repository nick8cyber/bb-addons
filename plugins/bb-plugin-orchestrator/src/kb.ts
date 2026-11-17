/**
 * bb-plugin-orchestrator — knowledge base (KB) subsystem (spec §26, ADR-0028).
 * Provides single service core for CLI commands (`bb orchestrator kb ...`),
 * agent tool (`orchestrator_kb`), and release pipeline integration.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { OrchestratorError } from "./errors.js";
import { scanAddedLinesCore, type AddedLine } from "../hooks/leak-scan.js";
import type { CmdRunner } from "./cmd.js";
import { T_RU, type T } from "./i18n/index.js";

export interface KbConfig {
  enabled: boolean;
  path: string;
  autoSync: boolean;
  requireCleanOnRelease: boolean;
}

export interface KbConfigLoad {
  config: KbConfig;
  errors: { path: string; message: string }[];
}

export interface KbCommitResult {
  ok: true;
  path: string;
  file: string;
  sha: string;
  committed: boolean;
  synced: boolean;
  autoSynced?: boolean;
  syncError?: string;
}

export const KB_LOCK_NAME = "orchestrator-kb.lock";
export const KB_LOCK_TIMEOUT_MS = 30_000;

export function defaultKbPath(home: string = homedir()): string {
  const custom = join(home, "kb");
  if (existsSync(custom)) return custom;
  return join(home, ".bb", "kb");
}

export function parseKbConfig(
  raw: string | undefined,
  t: T = T_RU,
  home: string = homedir(),
): KbConfigLoad {
  const errors: { path: string; message: string }[] = [];
  const cfg: KbConfig = {
    enabled: true,
    path: defaultKbPath(home),
    autoSync: true,
    requireCleanOnRelease: true,
  };
  const trimmed = raw?.trim();
  if (!trimmed) return { config: cfg, errors };

  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch (e) {
    errors.push({
      path: "kb",
      message: e instanceof Error ? e.message : String(e),
    });
    return { config: cfg, errors };
  }

  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    errors.push({ path: "kb", message: "kb must be a JSON object" });
    return { config: cfg, errors };
  }

  const o = doc as Record<string, unknown>;
  if (o.enabled !== undefined) {
    if (typeof o.enabled === "boolean") {
      cfg.enabled = o.enabled;
    } else {
      errors.push({ path: "kb.enabled", message: "enabled must be a boolean" });
    }
  }

  if (o.path !== undefined) {
    if (typeof o.path === "string" && o.path.trim().length > 0) {
      let p = o.path.trim();
      if (p === "~") {
        p = home;
      } else if (p.startsWith("~/") || p.startsWith("~\\")) {
        p = join(home, p.slice(2));
      }
      cfg.path = resolve(p);
    } else {
      errors.push({ path: "kb.path", message: "path must be a non-empty string" });
    }
  }

  if (o.autoSync !== undefined) {
    if (typeof o.autoSync === "boolean") {
      cfg.autoSync = o.autoSync;
    } else {
      errors.push({ path: "kb.autoSync", message: "autoSync must be a boolean" });
    }
  }

  if (o.requireCleanOnRelease !== undefined) {
    if (typeof o.requireCleanOnRelease === "boolean") {
      cfg.requireCleanOnRelease = o.requireCleanOnRelease;
    } else {
      errors.push({
        path: "kb.requireCleanOnRelease",
        message: "requireCleanOnRelease must be a boolean",
      });
    }
  }

  return { config: cfg, errors };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function resolveT(t?: T): T {
  return t ?? T_RU;
}

/**
 * Validates that subPath resolves strictly inside kbPath without
 * path traversal (..), forbidden directories (.git), or escaping symlinks.
 */
export function assertValidKbPath(
  kbPath: string,
  subPath: string,
  t?: T,
): { absPath: string; relPath: string } {
  const tr = resolveT(t);
  if (!subPath || typeof subPath !== "string") {
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.forbiddenPath", { path: String(subPath) }),
    );
  }
  if (subPath.includes("\0")) {
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.forbiddenPath", { path: subPath }),
    );
  }

  const normalized = subPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((s) => s === ".." || s === ".git")) {
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.forbiddenPath", { path: subPath }),
    );
  }

  const absPath = resolve(kbPath, subPath);
  const relPath = relative(kbPath, absPath);
  if (
    relPath === "" ||
    relPath.startsWith("..") ||
    isAbsolute(relPath) ||
    relPath === ".git" ||
    relPath.startsWith(`.git/`) ||
    relPath.startsWith(`.git\\`)
  ) {
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.forbiddenPath", { path: subPath }),
    );
  }

  try {
    const realKb = existsSync(kbPath) ? realpathSync(kbPath) : kbPath;
    if (existsSync(absPath)) {
      const real = realpathSync(absPath);
      if (real !== realKb && !real.startsWith(realKb + sep)) {
        throw new OrchestratorError(
          "kb-refused",
          tr("kb.forbiddenPath", { path: subPath }),
        );
      }
    } else {
      let cur = dirname(absPath);
      while (cur !== kbPath && cur !== dirname(cur)) {
        if (existsSync(cur)) {
          const realCur = realpathSync(cur);
          if (realCur !== realKb && !realCur.startsWith(realKb + sep)) {
            throw new OrchestratorError(
              "kb-refused",
              tr("kb.forbiddenPath", { path: subPath }),
            );
          }
          break;
        }
        cur = dirname(cur);
      }
    }
  } catch (e) {
    if (e instanceof OrchestratorError) throw e;
  }

  return { absPath, relPath: relPath.replace(/\\/g, "/") };
}

/**
 * Scans content against secret leak patterns (§22, leak-scan).
 */
export function assertNoSecrets(relPath: string, content: string, t?: T): void {
  const tr = resolveT(t);
  const lines = content.split("\n");
  const added: AddedLine[] = lines.map((text, idx) => ({
    file: relPath,
    line: idx + 1,
    text,
  }));
  const findings = scanAddedLinesCore(added);
  const secret = findings.find((f) => f.category === 1);
  if (secret) {
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.secretLeak", { rule: secret.rule }),
    );
  }
}

/**
 * Exclusive file lock inside `<kbPath>/.git/orchestrator-kb.lock`.
 */
export async function withKbLock<R>(
  kbPath: string,
  fn: () => Promise<R>,
  opts?: {
    timeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    t?: T;
  },
): Promise<R> {
  const tr = resolveT(opts?.t);
  const timeoutMs = opts?.timeoutMs ?? KB_LOCK_TIMEOUT_MS;
  const now = opts?.now ?? Date.now;
  const sleep =
    opts?.sleep ??
    ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const gitDir = join(kbPath, ".git");
  if (!existsSync(gitDir)) {
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.notARepoGitDir", { path: kbPath }),
    );
  }
  const lockPath = join(gitDir, KB_LOCK_NAME);
  const start = now();

  while (true) {
    try {
      writeFileSync(
        lockPath,
        `${process.pid}\n${new Date(now()).toISOString()}\n`,
        { flag: "wx" },
      );
      break;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const content = readFileSync(lockPath, "utf-8");
          let pid = NaN;
          if (content.trim().startsWith("{")) {
            try {
              pid = Number(JSON.parse(content).pid);
            } catch {
              // ignore
            }
          }
          if (Number.isNaN(pid)) {
            const firstLine = content.split("\n")[0]?.trim();
            pid = firstLine ? parseInt(firstLine, 10) : NaN;
          }
          if (!Number.isNaN(pid) && !pidAlive(pid)) {
            rmSync(lockPath, { force: true });
            continue;
          }
        } catch {
          // Lock may have been released concurrently
        }
        if (now() - start >= timeoutMs) {
          throw new OrchestratorError(
            "kb-refused",
            tr("kb.lockTimeout"),
          );
        }
        await sleep(100);
      } else {
        throw e;
      }
    }
  }

  try {
    return await fn();
  } finally {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function ensureKbRepo(
  kbPath: string,
  cmd: CmdRunner,
  t?: T,
): Promise<void> {
  const tr = resolveT(t);
  if (!existsSync(kbPath)) {
    try {
      mkdirSync(kbPath, { recursive: true });
    } catch (e) {
      throw new OrchestratorError(
        "kb-refused",
        tr("kb.initFailed", {
          error: describeError(e),
        }),
      );
    }
  }
  const gitDir = join(kbPath, ".git");
  const isRealRepo = existsSync(gitDir) && existsSync(join(gitDir, "HEAD"));
  if (!isRealRepo) {
    const initRes = await cmd.run("git", ["init"], { cwd: kbPath });
    if (initRes.exitCode !== 0) {
      if (existsSync(gitDir) && !existsSync(join(gitDir, "HEAD"))) {
        try {
          rmSync(gitDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      throw new OrchestratorError(
        "kb-refused",
        tr("kb.initFailed", {
          error: initRes.stderr.trim() || initRes.stdout.trim(),
        }),
      );
    }
  }
}

export function listKbFiles(kbPath: string): string[] {
  if (!existsSync(kbPath)) return [];
  const results: string[] = [];
  function walk(dir: string, base: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(rel);
      }
    }
  }
  walk(kbPath, "");
  return results.sort();
}

export interface KbSearchMatch {
  file: string;
  line: number;
  text: string;
}

export function searchKbFiles(
  kbPath: string,
  query: string,
  limit: number = 50,
): KbSearchMatch[] {
  if (!query || !existsSync(kbPath)) return [];
  const files = listKbFiles(kbPath);
  const matches: KbSearchMatch[] = [];
  const qLower = query.toLowerCase();

  for (const file of files) {
    const absPath = join(kbPath, file);
    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]!;
      if (lineText.toLowerCase().includes(qLower)) {
        matches.push({
          file,
          line: i + 1,
          text: lineText.trim(),
        });
        if (matches.length >= limit) return matches;
      }
    }
  }
  return matches;
}

export function readKbFile(kbPath: string, subPath: string, t?: T): string {
  const tr = resolveT(t);
  const { absPath } = assertValidKbPath(kbPath, subPath, tr);
  if (!existsSync(absPath)) {
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.fileNotFound", { path: subPath }),
    );
  }
  return readFileSync(absPath, "utf-8");
}

export async function writeKbFile(
  kbPath: string,
  subPath: string,
  content: string,
  cmd: CmdRunner,
  opts?: {
    message?: string;
    taskKey?: string;
    threadId?: string;
    autoSync?: boolean;
    now?: () => number;
    t?: T;
  },
): Promise<KbCommitResult> {
  const tr = resolveT(opts?.t);
  const { absPath, relPath } = assertValidKbPath(kbPath, subPath, tr);
  assertNoSecrets(relPath, content, tr);
  const ctx = opts?.taskKey ?? opts?.threadId ?? "cli";
  const msg = opts?.message ?? `kb(${ctx}): ${relPath}`;
  if (/^\s*co-authored-by\s*:/im.test(msg)) {
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.forbiddenTrailer"),
    );
  }
  await ensureKbRepo(kbPath, cmd, tr);

  return withKbLock(
    kbPath,
    async () => {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, content, "utf-8");

      const addRes = await cmd.run("git", ["-C", kbPath, "add", "--", relPath]);
      if (addRes.exitCode !== 0) {
        throw new OrchestratorError(
          "kb-refused",
          tr("kb.addFailed", {
            error: addRes.stderr.trim() || addRes.stdout.trim(),
          }),
        );
      }
      const statusRes = await cmd.run("git", [
        "-C",
        kbPath,
        "status",
        "--porcelain",
        "--",
        relPath,
      ]);
      if (statusRes.exitCode !== 0) {
        throw new OrchestratorError(
          "kb-refused",
          tr("kb.statusFailed", {
            error: statusRes.stderr.trim() || statusRes.stdout.trim(),
          }),
        );
      }
      let committed = false;
      if (statusRes.stdout.trim() !== "") {
        const commitRes = await cmd.run("git", [
          "-C",
          kbPath,
          "commit",
          "-m",
          msg,
          "--",
          relPath,
        ]);
        if (commitRes.exitCode !== 0) {
          throw new OrchestratorError(
            "kb-refused",
            tr("kb.commitFailed", {
              error: commitRes.stderr.trim() || commitRes.stdout.trim(),
            }),
          );
        }
        committed = true;
      }

      let sha = "";
      if (committed) {
        const rev = await cmd.run("git", ["-C", kbPath, "rev-parse", "HEAD"]);
        if (rev.exitCode !== 0) {
          throw new OrchestratorError(
            "kb-refused",
            tr("kb.revParseFailed", {
              error: rev.stderr.trim() || rev.stdout.trim(),
            }),
          );
        }
        sha = rev.stdout.trim();
      }

      let synced = false;
      let syncError: string | undefined;
      if (opts?.autoSync) {
        try {
          const syncRes = await syncKbCore(kbPath, cmd, tr);
          synced = syncRes.synced;
          if (!synced) {
            syncError = syncRes.message ?? "no remotes configured";
          }
        } catch (e) {
          synced = false;
          syncError = e instanceof Error ? e.message : String(e);
        }
      }

      return {
        ok: true,
        path: relPath,
        file: relPath,
        sha,
        committed,
        synced,
        autoSynced: synced,
        syncError,
      };
    },
    { now: opts?.now, t: tr },
  );
}

export async function appendKbFile(
  kbPath: string,
  subPath: string,
  content: string,
  cmd: CmdRunner,
  opts?: {
    message?: string;
    taskKey?: string;
    threadId?: string;
    autoSync?: boolean;
    now?: () => number;
    t?: T;
  },
): Promise<KbCommitResult> {
  const tr = resolveT(opts?.t);
  const { absPath, relPath } = assertValidKbPath(kbPath, subPath, tr);
  const ctx = opts?.taskKey ?? opts?.threadId ?? "cli";
  const msg = opts?.message ?? `kb(${ctx}): ${relPath}`;
  if (/^\s*co-authored-by\s*:/im.test(msg)) {
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.forbiddenTrailer"),
    );
  }
  await ensureKbRepo(kbPath, cmd, tr);

  return withKbLock(
    kbPath,
    async () => {
      let existing = "";
      if (existsSync(absPath)) {
        existing = readFileSync(absPath, "utf-8");
      }
      const newContent = existing
        ? existing.endsWith("\n")
          ? existing + content
          : existing + "\n" + content
        : content;
      assertNoSecrets(relPath, newContent, tr);

      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, newContent, "utf-8");

      const addRes = await cmd.run("git", ["-C", kbPath, "add", "--", relPath]);
      if (addRes.exitCode !== 0) {
        throw new OrchestratorError(
          "kb-refused",
          tr("kb.addFailed", {
            error: addRes.stderr.trim() || addRes.stdout.trim(),
          }),
        );
      }
      const statusRes = await cmd.run("git", [
        "-C",
        kbPath,
        "status",
        "--porcelain",
        "--",
        relPath,
      ]);
      if (statusRes.exitCode !== 0) {
        throw new OrchestratorError(
          "kb-refused",
          tr("kb.statusFailed", {
            error: statusRes.stderr.trim() || statusRes.stdout.trim(),
          }),
        );
      }
      let committed = false;
      if (statusRes.stdout.trim() !== "") {
        const commitRes = await cmd.run("git", [
          "-C",
          kbPath,
          "commit",
          "-m",
          msg,
          "--",
          relPath,
        ]);
        if (commitRes.exitCode !== 0) {
          throw new OrchestratorError(
            "kb-refused",
            tr("kb.commitFailed", {
              error: commitRes.stderr.trim() || commitRes.stdout.trim(),
            }),
          );
        }
        committed = true;
      }

      let sha = "";
      if (committed) {
        const rev = await cmd.run("git", ["-C", kbPath, "rev-parse", "HEAD"]);
        if (rev.exitCode !== 0) {
          throw new OrchestratorError(
            "kb-refused",
            tr("kb.revParseFailed", {
              error: rev.stderr.trim() || rev.stdout.trim(),
            }),
          );
        }
        sha = rev.stdout.trim();
      }

      let synced = false;
      let syncError: string | undefined;
      if (opts?.autoSync) {
        try {
          const syncRes = await syncKbCore(kbPath, cmd, tr);
          synced = syncRes.synced;
          if (!synced) {
            syncError = syncRes.message ?? "no remotes configured";
          }
        } catch (e) {
          synced = false;
          syncError = e instanceof Error ? e.message : String(e);
        }
      }

      return {
        ok: true,
        path: relPath,
        file: relPath,
        sha,
        committed,
        synced,
        autoSynced: synced,
        syncError,
      };
    },
    { now: opts?.now, t: tr },
  );
}

async function syncKbCore(
  kbPath: string,
  cmd: CmdRunner,
  t?: T,
): Promise<{ ok: true; synced: boolean; message?: string }> {
  const tr = resolveT(t);
  const remoteRes = await cmd.run("git", ["-C", kbPath, "remote"]);
  if (remoteRes.exitCode !== 0) {
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.remoteFailed", {
        error: remoteRes.stderr.trim() || remoteRes.stdout.trim(),
      }),
    );
  }
  if (!remoteRes.stdout.trim()) {
    return { ok: true, synced: false, message: "no remotes configured" };
  }

  const pullRes = await cmd.run("git", [
    "-C",
    kbPath,
    "pull",
    "--rebase",
  ]);
  if (pullRes.exitCode !== 0) {
    const errText = (pullRes.stderr + "\n" + pullRes.stdout).trim();
    const isConflict =
      /conflict/i.test(errText) ||
      existsSync(join(kbPath, ".git", "rebase-merge")) ||
      existsSync(join(kbPath, ".git", "rebase-apply"));
    await cmd.run("git", ["-C", kbPath, "rebase", "--abort"]).catch(() => {});
    if (isConflict) {
      throw new OrchestratorError(
        "kb-refused",
        tr("kb.syncConflict", {
          error: pullRes.stderr.trim() || pullRes.stdout.trim(),
        }),
      );
    }
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.syncFailed", {
        error: pullRes.stderr.trim() || pullRes.stdout.trim(),
      }),
    );
  }

  const pushRes = await cmd.run("git", ["-C", kbPath, "push"]);
  if (pushRes.exitCode !== 0) {
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.syncFailed", {
        error: pushRes.stderr.trim() || pushRes.stdout.trim(),
      }),
    );
  }

  return { ok: true, synced: true };
}

export async function syncKb(
  kbPath: string,
  cmd: CmdRunner,
  opts?: {
    now?: () => number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    t?: T;
  },
): Promise<{ ok: true; synced: boolean; message?: string }> {
  const tr = resolveT(opts?.t);
  await ensureKbRepo(kbPath, cmd, tr);

  return withKbLock(
    kbPath,
    () => syncKbCore(kbPath, cmd, tr),
    { ...opts, t: tr },
  );
}

export interface KbStatus {
  ok: true;
  path: string;
  clean: boolean;
  uncommitted: string[];
  dirtyFiles: string[];
  ahead: number;
  behind: number;
  upstream?: string;
}

export async function statusKb(
  kbPath: string,
  cmd: CmdRunner,
  t?: T,
): Promise<KbStatus> {
  const tr = resolveT(t);
  const gitDir = join(kbPath, ".git");
  if (
    !existsSync(kbPath) ||
    !existsSync(gitDir) ||
    !existsSync(join(gitDir, "HEAD"))
  ) {
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.notARepo", { path: kbPath }),
    );
  }

  const porcelainRes = await cmd.run("git", [
    "-C",
    kbPath,
    "status",
    "--porcelain",
  ]);
  if (porcelainRes.exitCode !== 0) {
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.statusRepoFailed", {
        error: porcelainRes.stderr.trim() || porcelainRes.stdout.trim(),
      }),
    );
  }
  const dirty = porcelainRes.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const dirtyFiles = dirty.map((l) => l.replace(/^[MADRCU?! ]+\s+/, ""));

  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;

  const upRes = await cmd.run("git", [
    "-C",
    kbPath,
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  if (upRes.exitCode === 0 && upRes.stdout.trim()) {
    upstream = upRes.stdout.trim();
    const countRes = await cmd.run("git", [
      "-C",
      kbPath,
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{u}",
    ]);
    if (countRes.exitCode !== 0) {
      throw new OrchestratorError(
        "kb-refused",
        tr("kb.statusUpstreamFailed", {
          error: countRes.stderr.trim() || countRes.stdout.trim(),
        }),
      );
    }
    const parts = countRes.stdout.trim().split(/\s+/);
    ahead = parseInt(parts[0] ?? "0", 10) || 0;
    behind = parseInt(parts[1] ?? "0", 10) || 0;
  }

  return {
    ok: true,
    path: kbPath,
    clean: dirty.length === 0,
    uncommitted: dirty,
    dirtyFiles,
    ahead,
    behind,
    upstream,
  };
}

export async function recordReleaseNote(
  kbPath: string,
  cmd: CmdRunner,
  opts: {
    taskKey: string;
    sha7: string;
    targetBranch: string;
    note: string;
    dateUtc?: string;
    now?: () => number;
    t?: T;
  },
): Promise<{ ok: true; file: string; synced: boolean; syncError?: string }> {
  const tr = resolveT(opts.t);
  const dateUtc =
    opts.dateUtc ??
    new Date(opts.now ? opts.now() : Date.now()).toISOString().slice(0, 10);
  const relFile = `releases/${dateUtc}-${opts.taskKey}.md`;
  const { absPath } = assertValidKbPath(kbPath, relFile, tr);

  const content =
    `# Релиз ${opts.taskKey}\n\n` +
    `- Дата: ${dateUtc}\n` +
    `- Коммит: ${opts.sha7}\n` +
    `- Ветка: ${opts.targetBranch}\n` +
    `- Задача: ${opts.taskKey}\n\n` +
    `## Заметки\n\n` +
    `${opts.note}\n`;

  assertNoSecrets(relFile, content, tr);
  const commitMsg = `rel(${opts.taskKey}): ${opts.note}`;
  if (/^\s*co-authored-by\s*:/im.test(commitMsg)) {
    throw new OrchestratorError(
      "kb-refused",
      tr("kb.forbiddenTrailer"),
    );
  }
  await ensureKbRepo(kbPath, cmd, tr);

  return withKbLock(
    kbPath,
    async () => {
      let fileMatches = false;
      if (existsSync(absPath)) {
        const existing = readFileSync(absPath, "utf-8");
        if (existing === content) {
          fileMatches = true;
        }
      }
      if (!fileMatches) {
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, content, "utf-8");
      }

      const statusRes = await cmd.run("git", [
        "-C",
        kbPath,
        "status",
        "--porcelain",
        "--",
        relFile,
      ]);
      if (statusRes.exitCode !== 0) {
        const errText = statusRes.stderr.trim() || statusRes.stdout.trim();
        throw new OrchestratorError(
          "kb-refused",
          tr("kb.statusFailed", { error: errText }),
        );
      }
      const isFileClean = statusRes.stdout.trim() === "";

      let hasRelCommit = false;
      const logRes = await cmd.run("git", [
        "-C",
        kbPath,
        "log",
        "--basic-regexp",
        `--grep=^rel(${opts.taskKey}):`,
        "--oneline",
      ]);
      if (logRes.exitCode === 0) {
        if (logRes.stdout.trim()) {
          hasRelCommit = true;
        }
      } else {
        const errText = logRes.stderr.trim() || logRes.stdout.trim();
        const isFreshRepo =
          /does not have any commits yet|bad default revision 'HEAD'/i.test(
            errText,
          );
        if (!isFreshRepo) {
          throw new OrchestratorError(
            "kb-refused",
            tr("kb.logFailed", { error: errText }),
          );
        }
      }

      const needsCommit = !(isFileClean && (fileMatches || hasRelCommit));

      if (needsCommit) {
        const addRes = await cmd.run("git", ["-C", kbPath, "add", "--", relFile]);
        if (addRes.exitCode !== 0) {
          throw new OrchestratorError(
            "kb-refused",
            tr("kb.addFailed", {
              error: addRes.stderr.trim() || addRes.stdout.trim(),
            }),
          );
        }
        const commitRes = await cmd.run("git", [
          "-C",
          kbPath,
          "commit",
          "-m",
          commitMsg,
          "--",
          relFile,
        ]);
        if (commitRes.exitCode !== 0) {
          throw new OrchestratorError(
            "kb-refused",
            tr("kb.commitFailed", {
              error: commitRes.stderr.trim() || commitRes.stdout.trim(),
            }),
          );
        }
      }

      let synced = false;
      let syncError: string | undefined;
      try {
        const syncRes = await syncKbCore(kbPath, cmd, tr);
        synced = syncRes.synced;
        if (!synced) {
          syncError = syncRes.message ?? "no remotes configured";
        }
      } catch (e) {
        synced = false;
        syncError = e instanceof Error ? e.message : String(e);
      }

      return {
        ok: true,
        file: relFile,
        synced,
        syncError,
      };
    },
    { now: opts.now, t: tr },
  );
}

export class KbService {
  private readonly deps: {
    cmd: CmdRunner;
    config: () => KbConfig;
    t?: T;
    now?: () => number;
  };

  constructor(deps: {
    cmd: CmdRunner;
    config: () => KbConfig;
    t?: T;
    now?: () => number;
  }) {
    this.deps = deps;
  }

  get kbPath(): string {
    return this.deps.config().path;
  }

  assertEnabled(): void {
    if (!this.deps.config().enabled) {
      const tr = resolveT(this.deps.t);
      throw new OrchestratorError(
        "kb-disabled",
        tr("kb.disabled"),
      );
    }
  }

  list(): string[] {
    this.assertEnabled();
    return listKbFiles(this.kbPath);
  }

  search(query: string, limit?: number): KbSearchMatch[] {
    this.assertEnabled();
    return searchKbFiles(this.kbPath, query, limit);
  }

  read(subPath: string): string {
    this.assertEnabled();
    return readKbFile(this.kbPath, subPath, this.deps.t);
  }

  async write(
    subPathOrOpts:
      | string
      | {
          path: string;
          content: string;
          message?: string;
          taskKey?: string;
          threadId?: string;
          actor?: string;
        },
    contentOrNone?: string,
    opts?: { message?: string; taskKey?: string; threadId?: string; actor?: string },
  ) {
    this.assertEnabled();
    const subPath =
      typeof subPathOrOpts === "string" ? subPathOrOpts : subPathOrOpts.path;
    const content =
      typeof subPathOrOpts === "string" ? (contentOrNone ?? "") : subPathOrOpts.content;
    const finalOpts =
      typeof subPathOrOpts === "string"
        ? opts
        : {
            message: subPathOrOpts.message,
            taskKey: subPathOrOpts.taskKey,
            threadId: subPathOrOpts.threadId ?? subPathOrOpts.actor,
          };
    return writeKbFile(this.kbPath, subPath, content, this.deps.cmd, {
      ...finalOpts,
      autoSync: this.deps.config().autoSync,
      now: this.deps.now,
      t: this.deps.t,
    });
  }

  async append(
    subPathOrOpts:
      | string
      | {
          path: string;
          content: string;
          message?: string;
          taskKey?: string;
          threadId?: string;
          actor?: string;
        },
    contentOrNone?: string,
    opts?: { message?: string; taskKey?: string; threadId?: string; actor?: string },
  ) {
    this.assertEnabled();
    const subPath =
      typeof subPathOrOpts === "string" ? subPathOrOpts : subPathOrOpts.path;
    const content =
      typeof subPathOrOpts === "string" ? (contentOrNone ?? "") : subPathOrOpts.content;
    const finalOpts =
      typeof subPathOrOpts === "string"
        ? opts
        : {
            message: subPathOrOpts.message,
            taskKey: subPathOrOpts.taskKey,
            threadId: subPathOrOpts.threadId ?? subPathOrOpts.actor,
          };
    return appendKbFile(this.kbPath, subPath, content, this.deps.cmd, {
      ...finalOpts,
      autoSync: this.deps.config().autoSync,
      now: this.deps.now,
      t: this.deps.t,
    });
  }

  async sync() {
    this.assertEnabled();
    return syncKb(this.kbPath, this.deps.cmd, {
      now: this.deps.now,
      t: this.deps.t,
    });
  }

  async status(): Promise<KbStatus> {
    this.assertEnabled();
    return statusKb(this.kbPath, this.deps.cmd, this.deps.t);
  }

  async recordRelease(opts: {
    taskKey: string;
    sha7: string;
    targetBranch: string;
    note: string;
    dateUtc?: string;
  }) {
    this.assertEnabled();
    return recordReleaseNote(this.kbPath, this.deps.cmd, {
      ...opts,
      now: this.deps.now,
      t: this.deps.t,
    });
  }
}
