#!/usr/bin/env node
/**
 * A stand-in for agy that reproduces the artifact-path refusal, replayed from
 * the real failures on conversations 693cd8c3 and c1c61bae (see
 * ARTIFACT_PATH_REFUSAL in src/provider-bridge.ts): the turn dies on `result`
 * with status ERROR and no tool step at all, because agy refuses the call
 * while declaring permissions.
 *
 * The workspace basename picks the behaviour, so one harness run can drive all
 * three shapes the bridge has to tell apart:
 *
 *   …-recover  refuse turn 1, then succeed — the model took the nudge
 *   …-persist  refuse every turn but always answer — the measured agy 1.1.19
 *              case: the file is written, the reply is real, the status lies
 *   …-silent   refuse every turn and never answer — a turn that truly died
 *
 * Every stdin line is echoed to AGY_FAKE_TRANSCRIPT so the harness can prove
 * WHAT the bridge sent.
 */
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";

const arg = (flag, fallback) =>
  process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback;
const conversationId = arg("--conversation", "fake-conv-artifact");
const model = arg("--model", "fake-model");
const transcript = process.env.AGY_FAKE_TRANSCRIPT ?? "/dev/null";
const here = basename(process.cwd());
const mode = here.includes("persist") ? "persist" : here.includes("silent") ? "silent" : "recover";
const REFUSAL =
  "declaring permissions: cortex tool write_to_file: convert tool call for " +
  "permissions: model output error: invalid tool call error (invalid_args) " +
  `${process.cwd()}/src/Foo.tsx is not a valid artifact path; artifacts must ` +
  `be in /home/x/.gemini/antigravity-cli/brain/${conversationId}/`;

const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);

// `agy models`: like real agy, --gemini-dir is only valid on `agy acp` —
// with `models` it prints usage to stderr and exits 2; the catalog itself
// is keyed by the HOME basename.
if (process.argv.includes("models")) {
  if (process.argv.includes("--gemini-dir")) {
    process.stderr.write(
      "usage: agy [-p <prompt>]\n" +
        "       agy models\n" +
        "       agy acp [--gemini-dir <dir>]\n" +
        "agy: --gemini-dir is only valid with the acp subcommand\n",
    );
    process.exit(2);
  }
  appendFileSync(transcript, `${JSON.stringify({ home: basename(process.env.HOME ?? ""), __models: true })}\n`);
  process.stdout.write("fake-model\tFake Model\n");
  process.exit(0);
}

out({
  event: "init",
  conversation_id: conversationId,
  init: { model, cwd: process.cwd(), tools: ["write_to_file"], permission_mode: "always-proceed" },
});

let step = 0;
let turns = 0;
// Lifecycle (spec §12.4): die with the owner — stdin EOF, a signal, or a
// reparented ppid (owner died, init/systemd adopted us) all end the fake.
const ownerPpid = process.ppid;
setInterval(() => {
  if (process.ppid !== ownerPpid) process.exit(0);
}, 1_500).unref();
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => process.exit(0));
}
const rlFake = createInterface({ input: process.stdin, crlfDelay: Infinity });
rlFake.on("close", () => process.exit(0));
rlFake.on("line", (line) => {
  if (line.trim().length === 0) return;
  appendFileSync(transcript, `${line}\n`);
  turns += 1;
  const scope = { conversation_id: conversationId };
  const usage = { input_tokens: 10 * turns, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 10 * turns + 2 };
  const refuse = mode === "recover" ? turns === 1 : true;
  if (mode !== "silent") {
    out({
      event: "step_update",
      step_update: {
        ...scope,
        step_index: step++,
        state: "DONE",
        step_type: "agent_response",
        text_delta: turns === 1 ? "I will write src/Foo.tsx." : "src/Foo.tsx already has that content.",
        usage,
      },
    });
  }
  out({
    event: "result",
    result: refuse
      ? { ...scope, status: "ERROR", response: "", num_turns: turns, error: REFUSAL, usage }
      : { ...scope, status: "SUCCESS", response: "done", num_turns: turns, usage },
  });
});
