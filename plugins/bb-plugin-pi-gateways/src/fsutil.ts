/**
 * Crash-safe file primitives. Every config file this plugin writes belongs to
 * a larger ecosystem (pi reads models.json, other tools hold copies), so a
 * half-written file here is the worst possible failure mode: write to a temp
 * sibling in the same directory and rename atomically instead.
 *
 * models.json in particular has other writers — a key-generator script, other
 * bb sessions, the user's editor — so every mutation goes through
 * `updateModelsJson`, which serialises in-process, detects concurrent external
 * writes by content hash, and keeps a timestamped copy of the exact bytes it
 * replaced.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

let counter = 0;

export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${counter++}`;
  try {
    writeFileSync(tmp, data, { mode });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the original error matters more than the cleanup one */
    }
    throw error;
  }
}

/**
 * JSON with every object key sorted, at every depth. Used for fingerprints:
 * two blocks that differ only in key order are the same block, and a
 * fingerprint that says otherwise would report drift on every reformat.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Fingerprint of a provider block as written or adopted, order-insensitive. */
export function fingerprintValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export interface ModelsJsonFile {
  providers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UpdateModelsJsonHooks {
  /** Test seam: runs after the pre-image was read, before the backup is written. */
  afterRead?: (attempt: number) => void;
  /** Test seam: runs after the backup was written, before the re-hash check. */
  afterBackup?: (attempt: number) => void;
}

export interface UpdateModelsJsonOptions {
  path: string;
  /** Filename infix identifying our backups, e.g. "bak-pi-gateways". */
  backupPrefix: string;
  retain: number;
  mutate: (file: ModelsJsonFile | null) => { next: ModelsJsonFile; changed: boolean };
  attempts?: number;
  hooks?: UpdateModelsJsonHooks;
}

export interface UpdateModelsJsonResult {
  backupPath?: string;
  wrote: boolean;
}

/** In-process serialisation: concurrent RPC calls in one worker must not interleave. */
let queue: Promise<unknown> = Promise.resolve();

export function updateModelsJson(opts: UpdateModelsJsonOptions): Promise<UpdateModelsJsonResult> {
  const run = queue.then(
    () => updateModelsJsonUnlocked(opts),
    () => updateModelsJsonUnlocked(opts),
  );
  // Keep the chain alive regardless of this call's outcome.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function updateModelsJsonUnlocked(opts: UpdateModelsJsonOptions): UpdateModelsJsonResult {
  const attempts = opts.attempts ?? 5;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pre = readSnapshot(opts.path);
    opts.hooks?.afterRead?.(attempt);

    const { next, changed } = opts.mutate(pre.parsed);
    if (!changed) return { wrote: false };

    // The backup is the exact pre-image we based the mutation on, not a
    // re-read of the path: re-reading could capture somebody else's write and
    // silently produce a "backup" that never existed as a whole file.
    let backupPath: string | undefined;
    if (pre.raw !== undefined) {
      backupPath = allocateBackupPath(opts.path, opts.backupPrefix);
      writeFileAtomic(backupPath, pre.raw);
    }
    opts.hooks?.afterBackup?.(attempt);

    const now = readSnapshot(opts.path);
    if (now.hash !== pre.hash) {
      // Somebody wrote between our read and our write. Every mutation here is
      // a per-id block replacement or drop, so re-running it against the
      // fresher content is always semantically safe.
      continue;
    }

    writeFileAtomic(opts.path, `${JSON.stringify(next, null, 2)}\n`);
    pruneBackups(opts.path, opts.backupPrefix, opts.retain);
    return { backupPath, wrote: true };
  }
  throw new Error(
    `${opts.path} is being rewritten concurrently by another writer — try again`,
  );
}

function readSnapshot(path: string): { raw?: string; hash: string; parsed: ModelsJsonFile | null } {
  if (!existsSync(path)) return { hash: "absent", parsed: null };
  const raw = readFileSync(path, "utf8");
  let parsed: ModelsJsonFile;
  try {
    parsed = JSON.parse(raw) as ModelsJsonFile;
  } catch (cause) {
    throw new Error(`${path} is not valid JSON, refusing to touch it`, { cause });
  }
  return { raw, hash: sha256Hex(raw), parsed };
}

function backupStamp(date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`
  );
}

function allocateBackupPath(path: string, prefix: string): string {
  const base = `${path}.${prefix}-${backupStamp()}`;
  if (!existsSync(base)) return base;
  // Same-millisecond retry: never overwrite a pre-image we already kept.
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`could not allocate a backup filename next to ${path}`);
}

function backupPattern(path: string, prefix: string): RegExp {
  const escaped = `${basename(path)}.${prefix}-`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\d{8}-\\d{9}(?:-\\d+)?$`);
}

/**
 * Keep the newest `retain` of *our* backups. The live directory is full of
 * other tools' `.bak-*` files; the pattern is exact so we never delete one.
 */
export function pruneBackups(path: string, prefix: string, retain: number): string[] {
  const dir = dirname(path);
  const pattern = backupPattern(path, prefix);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const ours = entries.filter((name) => pattern.test(name)).sort();
  const doomed = ours.slice(0, Math.max(0, ours.length - retain));
  const deleted: string[] = [];
  for (const name of doomed) {
    try {
      unlinkSync(join(dir, name));
      deleted.push(name);
    } catch {
      /* a backup we cannot delete is not a reason to fail the write */
    }
  }
  return deleted;
}
