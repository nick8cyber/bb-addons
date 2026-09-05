#!/usr/bin/env node
/**
 * A stand-in for agy that replays every channel a backend failure can travel
 * through, driven by AGY_FAKE_ERROR_MODE:
 *
 *   tool     the rejection arrives as a failed `tool` step, twice per turn,
 *            inside turns that then SUCCEED — the error must reach the thread
 *            and the same text must not be reported twice in one turn, but
 *            must be reported again on the next turn
 *   stderr   the ⚠ quota banner is written to stderr while the turn itself
 *            succeeds — the banner must reach the thread, a `warning:` line
 *            next to it must not
 *   noinit-error           an ERROR result with an empty conversation id and
 *            NO init at all — the session must fail and thread/start must
 *            name the message
 *   noinit-error-null-status  the same, with `status` absent entirely — the
 *            shape the bridge used to drop as noise
 *   residue  the agy 1.1.27 quota-residue defect, reproduced live on real
 *            conversation 44069b14: turn 1 is the genuine quota hit (ERROR
 *            result, no answer); turns 2-3 then answer normally yet get the
 *            SAME verbatim error re-attached; turn 4 answers normally and gets
 *            a DIFFERENT verbatim error — the bridge must surface the first
 *            error once, settle the residue turns completed, and surface turn
 *            4's new text like the fresh failure it is
 *
 * Every stdin line is echoed to AGY_FAKE_TRANSCRIPT so the harness can prove
 * WHAT the bridge sent.
 */
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const mode = process.env.AGY_FAKE_ERROR_MODE ?? "stderr";
const conversationId =
  process.argv.includes("--conversation")
    ? process.argv[process.argv.indexOf("--conversation") + 1]
    : "fake-conv-errors";
const model = process.argv.includes("--model")
  ? process.argv[process.argv.indexOf("--model") + 1]
  : "fake-model";
const transcript = process.env.AGY_FAKE_TRANSCRIPT ?? "/dev/null";

const QUOTA =
  "⚠ Individual quota reached. Please upgrade your subscription to " +
  "increase your limits. Resets in 8m11s.";
const FRESH_QUOTA =
  "⚠ Individual quota reached. Please upgrade your subscription to " +
  "increase your limits. Resets in 4m2s.";
const REJECTED =
  "shots fired: the backend refused this session while quota is exhausted";

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode.startsWith("noinit")) {
  out({
    event: "result",
    result: {
      conversation_id: "",
      status: mode === "noinit-error-null-status" ? null : "ERROR",
      response: "",
      num_turns: 0,
      error: REJECTED,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 0,
      },
    },
  });
  await sleep(30);
  process.exit(1);
}

out({
  event: "init",
  conversation_id: conversationId,
  init: { model, cwd: process.cwd(), tools: ["write_to_file"], permission_mode: "always-proceed" },
});

let step = 0;
let turns = 0;
let bannerSent = false;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on(
  "line",
  (line) => {
    if (line.trim().length === 0) return;
    appendFileSync(transcript, `${line}\n`);
    turns += 1;
    const scope = { conversation_id: conversationId };
    const usage = {
      input_tokens: 10 * turns,
      output_tokens: 2,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 10 * turns + 2,
    };
    if (mode === "stderr" && !bannerSent) {
      // The banner arrives mid-turn, after the session asked real work: that
      // is when agy's model call actually fails, and it guarantees identity
      // has been announced before the line reaches the bridge's stderr sink.
      bannerSent = true;
      process.stderr.write(`${QUOTA}\n`);
      process.stderr.write("warning: the model is behind and may be slow\n");
    }
    if (mode === "tool") {
      // Twice, verbatim: the bridge must report the message once per turn.
      for (let i = 0; i < 2; i += 1) {
        out({
          event: "step_update",
          step_update: {
            ...scope,
            step_index: step++,
            state: "ERROR",
            step_type: "tool",
            tool_name: "write_to_file",
            tool_info: { name: "write_to_file", error: { message: QUOTA } },
          },
        });
      }
    }
    if (mode === "residue") {
      // Turn 1 is the genuine quota hit: a failed tool call, no answer, and
      // the ERROR result that ends it. Turns 2-3 answer normally but agy
      // re-attaches the SAME frozen text to their result; turn 4 answers
      // normally and carries a DIFFERENT frozen text.
      if (turns === 1) {
        out({
          event: "step_update",
          step_update: {
            ...scope,
            step_index: step++,
            state: "ERROR",
            step_type: "tool",
            tool_name: "write_to_file",
            tool_info: { name: "write_to_file", error: { message: QUOTA } },
          },
        });
        out({
          event: "result",
          result: {
            ...scope,
            status: "ERROR",
            response: "",
            num_turns: turns,
            error: QUOTA,
            usage,
          },
        });
      } else {
        out({
          event: "step_update",
          step_update: {
            ...scope,
            step_index: step++,
            state: "DONE",
            step_type: "agent_response",
            text_delta: `answered ${turns}`,
            usage,
          },
        });
        out({
          event: "result",
          result: {
            ...scope,
            status: "ERROR",
            response: `answered ${turns}`,
            num_turns: turns,
            error: turns === 4 ? FRESH_QUOTA : QUOTA,
            usage,
          },
        });
      }
      return;
    }
    out({
      event: "step_update",
      step_update: {
        ...scope,
        step_index: step++,
        state: "DONE",
        step_type: "agent_response",
        text_delta: `answered ${turns}`,
        usage,
      },
    });
    out({
      event: "result",
      result: {
        ...scope,
        status: "SUCCESS",
        response: `answered ${turns}`,
        num_turns: turns,
        usage,
      },
    });
  },
);