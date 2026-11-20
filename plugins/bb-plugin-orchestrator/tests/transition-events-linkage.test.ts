// plugins/bb-plugin-orchestrator/tests/transition-events-linkage.test.ts
// Verifies that every event type handled by TRANSITION_TABLE has at least one
// callsite in the orchestrator codebase (outside transition-matrix.ts) that creates/emits it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRANSITION_TABLE } from "../src/transition-matrix.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const srcDir = path.join(pluginRoot, "src");

export interface EventCallsite {
  file: string;
  line: number;
  text: string;
}

export function findEventCallsites(
  events: readonly string[],
  options?: { srcDir?: string; serverTsPath?: string },
): { callsites: Record<string, EventCallsite[]>; missing: string[] } {
  const targetSrc = options?.srcDir ?? srcDir;
  const targetServerTs = options?.serverTsPath ?? path.join(pluginRoot, "server.ts");

  const filesToScan: string[] = [];
  if (fs.existsSync(targetSrc)) {
    for (const entry of fs.readdirSync(targetSrc)) {
      if (entry.endsWith(".ts") && entry !== "transition-matrix.ts" && entry !== "transition-matrix.d.ts") {
        filesToScan.push(path.join(targetSrc, entry));
      }
    }
  }
  if (fs.existsSync(targetServerTs)) {
    filesToScan.push(targetServerTs);
  }

  const callsites: Record<string, EventCallsite[]> = {};
  const missing: string[] = [];

  for (const evt of events) {
    const hits: EventCallsite[] = [];
    // Match type: "foo" or type: 'foo'
    const pattern = new RegExp(`type:\\s*["\x27]${evt}["\x27]`);

    for (const filePath of filesToScan) {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      lines.forEach((lineText, idx) => {
        if (pattern.test(lineText)) {
          hits.push({
            file: path.relative(pluginRoot, filePath),
            line: idx + 1,
            text: lineText.trim(),
          });
        }
      });
    }

    callsites[evt] = hits;
    if (hits.length === 0) {
      missing.push(evt);
    }
  }

  return { callsites, missing };
}

test("§28.1 / Acceptance: every transition event in TRANSITION_TABLE must have a live creator/source outside transition-matrix.ts", () => {
  const allEvents = new Set<string>();
  for (const rule of TRANSITION_TABLE) {
    if (Array.isArray(rule.eventType)) {
      for (const e of rule.eventType) allEvents.add(e);
    } else {
      allEvents.add(rule.eventType);
    }
  }

  const sortedEvents = Array.from(allEvents).sort();
  assert.ok(sortedEvents.length > 0, "TRANSITION_TABLE must have events");

  const { callsites, missing } = findEventCallsites(sortedEvents);

  if (missing.length > 0) {
    const details = missing
      .map((evt) => {
        const rules = TRANSITION_TABLE.filter((r) =>
          Array.isArray(r.eventType) ? r.eventType.includes(evt) : r.eventType === evt,
        ).map((r) => `${r.id} (row ${r.rowNumber})`);
        return `  - "${evt}" used by rules: ${rules.join(", ")}`;
      })
      .join("\n");

    assert.fail(
      `Found ${missing.length} transition events without any creator/source in src/ or server.ts:\n${details}\n` +
      `Each rule in TRANSITION_TABLE must be backed by live code emitting the event.`,
    );
  }

  // Report statistics
  console.log(`Linkage test passed: all ${sortedEvents.length} transition events have active callsites.`);
});
