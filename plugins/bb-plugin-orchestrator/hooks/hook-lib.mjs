/**
 * Shared helpers of the orchestrator git hooks (spec orchestrator §24,
 * §24.1). Installed next to the hooks into `~/.bb/git-hooks/` by both
 * install routes (`bb orchestrator hooks install` and `install.mjs`);
 * every hook imports it with a relative path, so the copy in the hooks
 * directory is the one that runs.
 *
 * - `chainTarget(name, self)` — the previous hook to call after our own
 *   checks: a migrated local `core.hooksPath` of THIS copy
 *   (`chain.json` → `localHooks`, keyed by the copy's real top-level
 *   path), then the repository's own `$GIT_DIR/hooks/<name>` and
 *   `<common dir>/hooks/<name>`, then the previous global
 *   `core.hooksPath`. The repository's hook keeps priority over the old
 *   global one (§24.1 п.1). A relative previous global path is resolved
 *   from the directory the hook runs in, like git itself does.
 * - `isLiveCopy()` — the service live copy (§24 п.1) is recognised by
 *   its marker `<common dir>/orchestrator-live.json`, written by
 *   `live-checkout setup`, or by its real path in
 *   `<hooks dir>/live-copies.json`, written by the plugin from the
 *   accepted `postPublish.checkout` — never by a path substring.
 * - `liveTokenValid(top)` — the one-shot postPublish token (§24.1 п.3):
 *   `~/.bb/plugin-live/.token` holds `{ "<real copy path>": { token,
 *   expiresAt } }`; valid when it equals `ORCH_LIVE_TOKEN`, is not
 *   expired and names exactly this copy.
 */
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const LIVE_MARKER = "orchestrator-live.json";

export function real(p) {
  if (!p) return p;
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function gitOut(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
}

/** Real paths of the current copy: top level (empty for a bare repo),
 * absolute common git dir and the per-worktree git dir. */
export function repoPaths() {
  const top = gitOut(["rev-parse", "--show-toplevel"]);
  const common = gitOut(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDir = gitOut(["rev-parse", "--absolute-git-dir"]);
  return {
    top: top ? real(top) : "",
    common: common ? real(common) : "",
    gitDir: gitDir ? real(gitDir) : "",
  };
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function executable(p) {
  if (!p || !existsSync(p)) return false;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** The previous hook for `name`, or null. `self` is this hook's file. */
export function chainTarget(hooksDir, name, self) {
  const chain = readJson(join(hooksDir, "chain.json")) ?? {};
  const { top, common, gitDir } = repoPaths();
  const candidates = [];
  const local = chain.localHooks && typeof chain.localHooks === "object" ? chain.localHooks : {};
  for (const key of [top, gitDir, common]) {
    if (key && typeof local[key] === "string") {
      candidates.push(join(local[key], name));
    }
  }
  if (process.env.GIT_DIR) {
    candidates.push(join(resolve(process.env.GIT_DIR), "hooks", name));
  }
  if (gitDir) candidates.push(join(gitDir, "hooks", name));
  if (common) candidates.push(join(common, "hooks", name));
  if (typeof chain.previousGlobalHooksPath === "string" && chain.previousGlobalHooksPath) {
    const raw = expandHome(chain.previousGlobalHooksPath);
    // git resolves a relative core.hooksPath from the directory the hook
    // runs in (the top level of a non-bare copy).
    const base = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
    candidates.push(join(base, name));
  }
  const me = real(self);
  const myDir = real(hooksDir);
  for (const c of candidates) {
    if (!executable(c)) continue;
    const rc = real(c);
    if (rc === me || dirname(rc) === myDir) continue;
    return c;
  }
  return null;
}

/** Run the chained hook with our argv and stdin; returns its exit code. */
export function runChain(hooksDir, name, self, input) {
  const target = chainTarget(hooksDir, name, self);
  if (!target) return 0;
  const res = spawnSync(target, process.argv.slice(2), {
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    input,
  });
  if (res.error) return 1;
  return res.status ?? 1;
}

/** Real paths of the configured live copies (plugin-written registry). */
export function registeredLiveCopies(hooksDir) {
  const list = readJson(join(hooksDir, "live-copies.json"));
  const out = new Set();
  if (Array.isArray(list)) {
    for (const p of list) if (typeof p === "string" && p) out.add(real(p));
  }
  return out;
}

export function isLiveCopy(hooksDir, paths = repoPaths()) {
  if (paths.common && existsSync(join(paths.common, LIVE_MARKER))) return true;
  const reg = registeredLiveCopies(hooksDir);
  return Boolean(paths.top && reg.has(paths.top));
}

export function liveTokenFile() {
  return join(homedir(), ".bb", "plugin-live", ".token");
}

export function liveTokenValid(top) {
  const env = process.env.ORCH_LIVE_TOKEN;
  if (!env || !top) return false;
  const map = readJson(liveTokenFile());
  if (!map || typeof map !== "object") return false;
  const entry = map[top];
  return Boolean(
    entry &&
      typeof entry === "object" &&
      entry.token === env &&
      typeof entry.expiresAt === "number" &&
      entry.expiresAt > Date.now(),
  );
}

/** Target branches: built-in, the copy's snapshot and every project's
 * target from the accepted settings (`<hooks dir>/targets.json`). */
export function targetBranches(hooksDir, common) {
  const set = new Set(["main", "master", "dev"]);
  if (common) {
    const snap = readJson(join(common, "orchestrator-leaks.json"));
    if (snap && typeof snap.targetBranch === "string" && snap.targetBranch) {
      set.add(snap.targetBranch);
    }
  }
  const all = readJson(join(hooksDir, "targets.json"));
  if (Array.isArray(all)) {
    for (const b of all) if (typeof b === "string" && b) set.add(b);
  }
  return set;
}

/** Read-only SQLite handle (node:sqlite, then better-sqlite3), or null. */
export async function openDbReadOnly(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return null;
  const wrap = (db) => ({
    get(sql, ...args) {
      return db.prepare(sql).get(...args);
    },
    all(sql, ...args) {
      return db.prepare(sql).all(...args);
    },
    close() {
      try {
        db.close();
      } catch {}
    },
  });
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return wrap(new DatabaseSync(dbPath, { readOnly: true }));
  } catch {
    try {
      const Database = (await import("better-sqlite3")).default;
      return wrap(new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 2000 }));
    } catch {
      return null;
    }
  }
}

export function pluginDbPath() {
  return (
    process.env.ORCHESTRATOR_DB_PATH ??
    join(homedir(), ".bb", "plugins", "orchestrator", "data.db")
  );
}

export function bbDbPath() {
  return process.env.ORCHESTRATOR_BB_DB_PATH ?? join(homedir(), ".bb", "bb.db");
}

/**
 * The thread's role (§24 п.2 б): `{ role, error }`. `role` is null when
 * the thread has no role; `error` is set when the database could not be
 * opened or read — the caller warns and applies rule (а) only.
 */
export async function readThreadRole(threadId) {
  const db = await openDbReadOnly(pluginDbPath());
  if (!db) return { role: null, error: "db-unavailable", db: null };
  try {
    if (db.get("SELECT 1 AS x FROM helpers WHERE thread_id = ?", threadId)) {
      return { role: "helper", error: null, db };
    }
    const row = db.get("SELECT role FROM thread_roles WHERE thread_id = ?", threadId);
    let role = row && row.role ? String(row.role) : null;
    if (!role || role === "none") {
      const del = db.get("SELECT 1 AS x FROM delegations WHERE thread_id = ? LIMIT 1", threadId);
      role = del ? "executor" : role;
    }
    return { role, error: null, db };
  } catch (e) {
    db.close();
    return { role: null, error: String(e?.message ?? e), db: null };
  }
}

/** Real path of a BB environment by id, or of a thread's environment. */
export async function envPaths(threadId, envIds) {
  const out = { byEnv: new Map(), thread: null, error: null };
  const bb = await openDbReadOnly(bbDbPath());
  if (!bb) {
    out.error = "bb-db-unavailable";
    return out;
  }
  try {
    for (const id of envIds) {
      if (!id) continue;
      const r = bb.get("SELECT path FROM environments WHERE id = ?", id);
      if (r && r.path) out.byEnv.set(id, real(String(r.path)));
    }
    if (threadId) {
      const r = bb.get(
        "SELECT e.path AS path FROM threads t JOIN environments e ON t.environment_id = e.id WHERE t.id = ?",
        threadId,
      );
      if (r && r.path) out.thread = real(String(r.path));
    }
  } catch (e) {
    out.error = String(e?.message ?? e);
  } finally {
    bb.close();
  }
  return out;
}

export function inside(p, root) {
  return Boolean(p && root && (p === root || p.startsWith(root + "/")));
}
