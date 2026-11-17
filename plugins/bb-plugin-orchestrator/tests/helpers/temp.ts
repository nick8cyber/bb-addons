/**
 * Temp-dir tracking for the test suite (PLUG-296). Every test temp dir is
 * created through makeTempDir so register-hooks.ts can rm it in a global
 * afterEach and on process exit/signals; cleanStaleTempDirs reaps dirs a
 * crashed run left behind so they stop piling up in /tmp.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Marks a dir as suite-created so stale cleanup never touches foreign
 * dirs that happen to share a prefix on a shared machine. */
const MARKER = ".orch-test-tmpdir";

/** Prefixes makeTempDir callers use across the suite; makeTempDir also
 * registers its prefix here at call time. */
const KNOWN_PREFIXES = new Set([
  "cmd-",
  "d22-",
  "exec-",
  "hookenv-",
  "hooks-",
  "install-",
  "inv-",
  "jan-",
  "merge-",
  "orch-cli-",
  "orch-hook-",
  "orch-i18n-",
  "orch-scan-",
  "pcenv-",
  "pkt-",
  "projdir-",
  "prtool-",
  "rel-",
  "round-",
  "snaprepo-",
  "tok-",
]);

const trackedDirs = new Set<string>();

/** mkdtemp under os.tmpdir(), registered for automatic cleanup. */
export function makeTempDir(prefix: string): string {
  KNOWN_PREFIXES.add(prefix);
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trackedDirs.add(dir);
  writeFileSync(join(dir, MARKER), "");
  return dir;
}

/** Remove every dir makeTempDir created in this process. */
export function cleanupTrackedTempDirs(): void {
  for (const dir of trackedDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* already gone — nothing to do */
    }
  }
  trackedDirs.clear();
}

/** Remove suite-created temp dirs (marker + known prefix) untouched for
 * longer than maxAgeMs — leftovers of killed or crashed runs. */
export function cleanStaleTempDirs(maxAgeMs = 30 * 60 * 1000): void {
  const cutoff = Date.now() - maxAgeMs;
  let entries;
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (![...KNOWN_PREFIXES].some((p) => e.name.startsWith(p))) continue;
    const dir = join(tmpdir(), e.name);
    try {
      if (!existsSync(join(dir, MARKER))) continue;
      const st = statSync(dir);
      // mtime stays fresh while a run still writes into the dir;
      // birthtime covers dirs whose mtime a scanner touched since.
      if (Math.max(st.birthtimeMs, st.mtimeMs) >= cutoff) continue;
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* vanished or unreadable — skip */
    }
  }
}
