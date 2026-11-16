/**
 * Shared lifecycle guard for the harnesses (spec §12.4): every harness's own
 * child processes die with it and its mkdtemp roots are removed on
 * exit/SIGINT/SIGTERM. The reaper (§12.3) is only the backstop for a hard
 * death — this is the primary cleanup.
 *
 * Children are SIGTERM'd, not killed: the acp-shim's own shutdown is what
 * takes the detached `agy acp` group down, and a SIGKILL'd shim would orphan
 * exactly the tree this contract exists to remove. Whatever survives a TERM
 * still gets stdin EOF when the harness dies.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";

const roots = [];
let installed = false;
let tearingDown = false;

export function registerTmpRoot(dir) {
  roots.push(dir);
  return dir;
}

export function trackedMkdtemp(prefix) {
  return registerTmpRoot(mkdtempSync(prefix));
}

function ownChildPids() {
  const out = [];
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const ppid = Number(
          stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ")[1],
        );
        if (ppid === process.pid) out.push(Number(entry));
      } catch {
        // Raced exit or a foreign proc — either way not ours to kill.
      }
    }
  } catch {
    // No /proc (non-Linux): children still get stdin EOF at exit.
  }
  return out;
}

export function teardown() {
  if (tearingDown) return;
  tearingDown = true;
  for (const pid of ownChildPids()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

export function installTeardown() {
  if (installed) return;
  installed = true;
  process.on("exit", teardown);
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.on(signal, () => {
      teardown();
      process.exit(code);
    });
  }
}
