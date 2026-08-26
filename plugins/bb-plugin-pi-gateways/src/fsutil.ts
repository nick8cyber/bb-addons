/**
 * Crash-safe file primitives. Every config file this plugin writes belongs to
 * a larger ecosystem (pi reads models.json, other tools hold copies), so a
 * half-written file here is the worst possible failure mode: write to a temp
 * sibling in the same directory and rename atomically instead.
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
