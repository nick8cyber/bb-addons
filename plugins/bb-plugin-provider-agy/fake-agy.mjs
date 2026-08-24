#!/usr/bin/env node
/**
 * A stand-in for the agy binary, replaying the dialect confirmed against agy
 * 1.1.19. Point `AGY_PATH` at it to test the bridge's translation with no
 * network, no account, and no quota: it streams three ACTIVE `agent_response`
 * deltas before the DONE one, so a single-chunk real answer cannot hide a
 * bridge that only forwards the last piece.
 */
import { createInterface } from "node:readline";

const conversationId =
  process.argv.includes("--conversation")
    ? process.argv[process.argv.indexOf("--conversation") + 1]
    : "fake-conv-0001";
const model = process.argv.includes("--model")
  ? process.argv[process.argv.indexOf("--model") + 1]
  : "fake-model";

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

out({
  event: "init",
  conversation_id: conversationId,
  init: { model, cwd: process.cwd(), tools: ["view_file"], permission_mode: "always-proceed" },
});

let step = 0;
let turns = 0;
let total = 0;
const chunks = ["alpha ", "beta ", "gamma ", "delta"];

createInterface({ input: process.stdin }).on("line", (line) => {
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
  turns += 1;
  const scope = { conversation_id: conversationId };
  out({ event: "step_update", step_update: { ...scope, step_index: step++, state: "DONE", step_type: "user_input" } });
  out({ event: "step_update", step_update: { ...scope, step_index: step++, state: "DONE", step_type: "checkpoint" } });
  const messageStep = step++;
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
});
