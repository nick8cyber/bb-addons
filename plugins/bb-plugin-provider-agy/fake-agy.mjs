#!/usr/bin/env node
/**
 * A stand-in for the agy binary, replaying the dialect confirmed against agy
 * 1.1.19. Point `AGY_PATH` at it to test the bridge's translation with no
 * network, no account, and no quota: it streams three ACTIVE `agent_response`
 * deltas before the DONE one, so a single-chunk real answer cannot hide a
 * bridge that only forwards the last piece.
 *
 * Three things it models on purpose, because the steer and rebuild paths
 * need them:
 *
 * - **One turn at a time.** Input lines are queued and answered strictly in
 *   order, the way agy's stream-json does; a line that arrives mid-turn is not
 *   started early.
 * - **A turn that stays active.** A prompt containing `[[hold]]` streams its
 *   first chunk and then hangs until `AGY_FAKE_RELEASE` exists on disk, so a
 *   harness can steer a turn that is provably still running instead of racing
 *   one that may already have settled.
 * - **A child that dies between turns.** A prompt containing `[[die]]` is
 *   answered in full and the process then exits, the way a crashed or
 *   timed-out agy leaves a live conversation behind — which is what makes the
 *   bridge's rebuild path reachable without killing anything by hand.
 *
 * Every stdin line is echoed to `AGY_FAKE_TRANSCRIPT` (when set) so a harness
 * can prove WHAT the bridge sent and, just as important, WHEN.
 */
import { createInterface } from "node:readline";
import { appendFileSync, existsSync } from "node:fs";

const conversationId =
  process.argv.includes("--conversation")
    ? process.argv[process.argv.indexOf("--conversation") + 1]
    : "fake-conv-0001";
const model = process.argv.includes("--model")
  ? process.argv[process.argv.indexOf("--model") + 1]
  : "fake-model";
const transcript = process.env.AGY_FAKE_TRANSCRIPT ?? null;
const releaseFile = process.env.AGY_FAKE_RELEASE ?? null;
/** A held turn cannot hang forever: a stuck harness must not leave a child. */
const HOLD_TIMEOUT_MS = 30_000;

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

out({
  event: "init",
  conversation_id: conversationId,
  init: { model, cwd: process.cwd(), tools: ["view_file"], permission_mode: "always-proceed" },
});

let step = 0;
let turns = 0;
let total = 0;
const chunks = ["alpha ", "beta ", "gamma ", "delta"];

/** Wait for the harness to let a `[[hold]]` turn finish. */
async function awaitRelease() {
  const deadline = Date.now() + HOLD_TIMEOUT_MS;
  for (;;) {
    if (releaseFile !== null && existsSync(releaseFile)) return;
    if (Date.now() > deadline) return;
    await sleep(20);
  }
}

/** How a real agy leaves: the answer lands, then the process is gone. */
async function dieAfterFlush() {
  await sleep(50);
  process.exit(0);
}

async function runTurn(text) {
  turns += 1;
  const scope = { conversation_id: conversationId };
  out({ event: "step_update", step_update: { ...scope, step_index: step++, state: "DONE", step_type: "user_input" } });
  out({ event: "step_update", step_update: { ...scope, step_index: step++, state: "DONE", step_type: "checkpoint" } });
  const messageStep = step++;
  const hold = text.includes("[[hold]]");
  for (let i = 0; i < chunks.length; i += 1) {
    const last = i === chunks.length - 1;
    total += 10;
    out({
      event: "step_update",
      step_update: {
        ...scope,
        step_index: messageStep,
        state: last ? "DONE" : "ACTIVE",
        step_type: "agent_response",
        text_delta: chunks[i],
        ...(last
          ? {
              usage: {
                input_tokens: total,
                output_tokens: 4,
                thinking_tokens: 0,
                cache_read_tokens: 0,
                total_tokens: total + 4,
              },
            }
          : {}),
      },
    });
    if (hold && i === 0) {
      // The turn is unmistakably live now: it has streamed text and has not
      // settled. Everything a harness steers here is steering a running turn.
      await awaitRelease();
    }
  }
  out({
    event: "result",
    result: {
      ...scope,
      status: "SUCCESS",
      response: chunks.join(""),
      num_turns: turns,
      usage: {
        input_tokens: total,
        output_tokens: 4 * turns,
        thinking_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: total + 4 * turns,
      },
    },
  });
  if (text.includes("[[die]]")) {
    await dieAfterFlush();
  }
}

// One turn at a time, in arrival order: a line that lands mid-turn waits.
const queue = [];
let draining = false;

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length > 0) {
    await runTurn(queue.shift());
  }
  draining = false;
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (parsed?.event !== "user") {
    process.stderr.write('warning: ignoring unsupported stream input message event\n');
    return;
  }
  if (transcript !== null) {
    appendFileSync(transcript, `${line}\n`);
  }
  queue.push(String(parsed.message?.content ?? ""));
  void drain();
});
