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
 *            conversation 44069b14: turn 1 is the genuine quota hit (failed
 *            tool call, NO reply, ERROR result); turns 2-3 then answer yet get
 *            the SAME verbatim error re-attached — the reply completed, so the
 *            bridge must complete them and NOT show the banner again; turn 4
 *            has no reply and a DIFFERENT new countdown and must fail with the
 *            new text surfaced; turn 5 answers and carries that same new text
 *            and must complete (a completed reply makes the error baggage)
 *   reject-then-exit  the genuine immediate reject on a fresh child, as agy
 *            really behaves with a dead quota: identity announces, the turn
 *            is refused on the first call, an ERROR result with no reply
 *            names the quota, then the process exits 1 — the raw exit must
 *            not add a second banner over the text that already explained it
 *   quota-retry  the same reject but with a SHORT window ("Resets in 2s."),
 *            close enough for the bridge's quota auto-retry: a resumed child
 *            (--conversation present) answers successfully, so the queued
 *            retry turn must re-run and complete
 *   quota-retry-always  every child rejects, so the retry budget runs out:
 *            the second attempt must fail honestly with no further retries
 *   stall   the turn opens with a live tool item and then the process says
 *            NOTHING — no result, no stderr, alive but mute — exactly a tool
 *            blocked on a password prompt (and indistinguishable from a
 *            working quiet tool). The tool-tier stall budget
 *            (AGY_TOOL_STALL_MS) must fail the turn naming the silence,
 *            kill this child, and leave the session rebuildable (the
 *            harness then answers the next turn). Crucially the model-tier
 *            budget must NOT fire while the tool is open — mid-work kills
 *            are the bug this pair exists to prevent.
 *   stall-quiet  a turn the child never answers: no tool item at all. The
 *            model-tier budget (AGY_STALL_KILL_MS) must fail it.
 *   ineligible  four stderr lines then exit 1 before init, only on the HOME
 *            ending in FAKE_INELIGIBLE_LABEL. FAKE_INELIGIBLE_AFTER_TURN
 *            defers the refusal until that input, to test existing context.
 *   ineligible-result / ineligible-noinit-result  the same refusal via result.
 *   ineligible-location  location restriction before init, without a URL.
 *   network-eligibility  a SOCKS error during the check, never an auth error.
 *   race429                      turn 1 succeeds, then a 429 banner trails its
 *                                result; turn 2 crashes before its result
 *   stale429 / stale-ineligible  turn 1 reports stderr but succeeds; turn 2
 *            crashes with a fatal stderr line before result.
 *   tool-quota-exit  tool ERROR quota on stdout, exit before result.
 *
 * Every stdin line is echoed to AGY_FAKE_TRANSCRIPT so the harness can prove
 * WHAT the bridge sent.
 */
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// Account-specific modes reproduce failures across multiple child generations.
const homeLabel = basename(process.env.HOME ?? "");
const modesByLabel = JSON.parse(process.env.AGY_FAKE_MODE_BY_LABEL ?? "{}");
const mode = modesByLabel[homeLabel] ?? process.env.AGY_FAKE_ERROR_MODE ?? "stderr";
const conversationId =
  process.argv.includes("--conversation")
    ? process.argv[process.argv.indexOf("--conversation") + 1]
    : process.env.AGY_FAKE_FRESH_IDS === "1"
      ? `fake-conv-${process.pid}`
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
const QUOTA_SHORT =
  "⚠ Individual quota reached. Please upgrade your subscription to " +
  "increase your limits. Resets in 2s.";
const REJECTED =
  "shots fired: the backend refused this session while quota is exhausted";

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const INELIGIBLE = [
  "error: Eligibility check failed: Your current account is not eligible for Antigravity. Verify your account to continue.",
  "Alternatively, try signing in with another personal Google account.",
  "Please verify your account in your browser to continue:",
  "https://accounts.google.com/v3/signin/continue?plt=fake-verification&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini",
].join("\n");
const NETWORK_ELIGIBILITY = 'Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": socks connect tcp 203.0.113.10:1080->example:443: unknown error general SOCKS server failure';
const LOCATION_ELIGIBILITY = "error: Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.";
const ineligibleHome = Object.hasOwn(modesByLabel, homeLabel) ||
  (Boolean(process.env.FAKE_INELIGIBLE_LABEL) &&
    (process.env.HOME ?? "").endsWith(`/${process.env.FAKE_INELIGIBLE_LABEL}`));

async function refuseEligibility() {
  if (mode.includes("result")) {
    out({
      event: "result",
      result: {
        conversation_id: mode === "ineligible-noinit-result" ? "" : conversationId,
        status: "ERROR", response: "", num_turns: 0,
        // Mixed case and only the second detector phrase prove both rules.
        error: mode === "ineligible-result"
          ? "Please VERIFY YOUR ACCOUNT to continue."
          : mode === "ineligible-result-not-eligible"
            ? "Your current account is NOT ELIGIBLE FOR ANTIGRAVITY."
            : INELIGIBLE,
      },
    });
  } else {
    // Separate chunks, and no newline on the URL: neither the first nor last
    // stderr line alone is the complete diagnostic from the incident.
    let diagnostic = mode === "network-eligibility"
      ? NETWORK_ELIGIBILITY
      : mode === "ineligible-location" ? LOCATION_ELIGIBILITY : INELIGIBLE;
    if (mode === "ineligible-noisy-stderr") {
      diagnostic = diagnostic.replace("\nAlternatively,", "\nAdditional account eligibility details from the backend.\nAlternatively,");
      diagnostic = `warning: earlier call hit a rate limit (429), try again later\n${diagnostic}\ninfo: cleaning up after refusal`;
    }
    const lines = diagnostic.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      process.stderr.write(lines[i] + (i < lines.length - 1 ? "\n" : ""));
      await sleep(15);
    }
  }
  await sleep(30);
  process.exit(1);
}

// Env recording for the relay harness: the selected HOME / GEMINI_API_KEY /
// GOOGLE_GEMINI_BASE_URL the shim actually ran with, before any traffic.
const recordEnv = process.env.AGY_FAKE_RECORD_ENV ?? "";
if (recordEnv.length > 0) {
  const names = recordEnv.split(",").map((n) => n.trim()).filter(Boolean);
  const snapshot = {};
  for (const name of names) {
    snapshot[name] = process.env[name] ?? null;
  }
  appendFileSync(
    transcript,
    `${JSON.stringify({ __env: snapshot, __argv: process.argv.slice(2) })}\n`,
  );
}

if ((mode.startsWith("ineligible") || mode === "network-eligibility") &&
    ineligibleHome && !process.env.FAKE_INELIGIBLE_AFTER_TURN && !mode.startsWith("ineligible-result")) {
  await refuseEligibility();
}

if (mode === "server-500-noinit") {
  // A child spawned for a turn that dies to Google's 500 before init.
  const err = "API error (attempt 1): INTERNAL (code 500): Internal error encountered.";
  process.stderr.write(`error: ${err}\n`);
  process.stderr.write(`AGY_ERROR: {"short_error":"${err}","retryable":false,"error_id":"fake-500-noinit"}\n`);
  await sleep(30);
  process.exit(3);
}

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

// AGY_FAKE_PREINIT_ARM: the next FRESH child (no --conversation) dies to a
// quota banner before init, once — a seed that cannot even start.
if (process.env.AGY_FAKE_PREINIT_ARM && existsSync(process.env.AGY_FAKE_PREINIT_ARM) &&
    !process.argv.includes("--conversation")) {
  unlinkSync(process.env.AGY_FAKE_PREINIT_ARM);
  process.stderr.write(`${QUOTA_SHORT}\n`);
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
    if (mode === "compact-fail") {
      // The nightly incident: "/compact" dies to Google's 500 (stderr +
      // AGY_ERROR, ERROR result, exit 3). The bridge's summary request is
      // answered per AGY_FAKE_SUMMARY_MODE (ok | empty | fail); anything else
      // is an ordinary turn.
      let content = "";
      try { content = JSON.parse(line).message?.content ?? ""; } catch {}
      const err = "API error (attempt 1): INTERNAL (code 500): Internal error encountered.";
      const die = () => {
        process.stderr.write(`error: ${err}\n`);
        process.stderr.write(`AGY_ERROR: {"short_error":"${err}","retryable":false,"error_id":"fake-compact"}\n`);
        out({ event: "result", result: { ...scope, status: "ERROR", response: "", num_turns: turns, error: err, usage } });
        setTimeout(() => process.exit(3), 100);
      };
      if (content.trim() === "/compact") {
        // AGY_FAKE_COMPACT_MODE: die (result + exit 3, default), exit (exit 3
        // with no result), stall (never answers).
        const compactMode = process.env.AGY_FAKE_COMPACT_MODE ?? "die";
        if (compactMode === "stall") return;
        if (compactMode === "billing" || compactMode === "overloaded") {
          const text = compactMode === "billing"
            ? "Your billing account is disabled; add credits to continue."
            : "API error (attempt 1): UNAVAILABLE (code 503): The model is overloaded.";
          out({ event: "result", result: { ...scope, status: "ERROR", response: "", num_turns: turns, error: text, usage } });
          setTimeout(() => process.exit(3), 100);
          return;
        }
        if (compactMode === "exit") {
          process.stderr.write(`error: ${err}\n`);
          setTimeout(() => process.exit(3), 50);
          return;
        }
        die();
        return;
      }
      if (content.startsWith("[compaction-handoff]") && process.env.AGY_FAKE_SEED_MODE === "fail") {
        die();
        return;
      }
      if (content.startsWith("[compaction-fallback]")) {
        const summaryMode = process.env.AGY_FAKE_SUMMARY_MODE ?? "ok";
        if (summaryMode === "fail") {
          die();
          return;
        }
        if (summaryMode === "quota") {
          out({ event: "result", result: { ...scope, status: "ERROR", response: "", num_turns: turns, error: QUOTA_SHORT, usage } });
          setTimeout(() => process.exit(1), 100);
          return;
        }
        if (summaryMode === "quota-exit") {
          process.stderr.write(`${QUOTA_SHORT}\n`);
          setTimeout(() => process.exit(1), 50);
          return;
        }
        const text = summaryMode === "empty" ? "" : "SUMMARY-OF-WORK: goal G; done D; next N";
        if (text.length > 0) {
          out({ event: "step_update", step_update: { ...scope, step_index: step++, state: "DONE",
            step_type: "agent_response", text_delta: text, usage } });
        }
        out({ event: "result", result: { ...scope, status: "SUCCESS", response: text, num_turns: turns, usage } });
        return;
      }
    }
    if (mode === "race429") {
      if (turns === 1) {
        // The result lands first; the 429 banner trails it, after the bridge
        // has already written the queued turn 2.
        out({ event: "step_update", step_update: { ...scope, step_index: step++, state: "DONE",
          step_type: "agent_response", text_delta: "answered 1", usage } });
        out({ event: "result", result: { ...scope, status: "SUCCESS", response: "answered 1", num_turns: turns, usage } });
        process.stderr.write("⚠ Rate limit reached (429): slow down and try again later.\n");
        return;
      }
      process.stderr.write("fatal: backend stream reset by peer\n");
      setTimeout(() => process.exit(1), 50);
      return;
    }
    if (mode === "stale429" || mode === "stale-ineligible") {
      if (turns === 1) {
        process.stderr.write((mode === "stale429"
          ? "⚠ Rate limit reached (429): slow down and try again later."
          : INELIGIBLE) + "\n");
        // Continue to the ordinary successful result below.
      } else {
        process.stderr.write("fatal: backend stream reset by peer\n");
        setTimeout(() => process.exit(1), 50);
        return;
      }
    }
    if (mode === "tool-quota-exit") {
      const message = "⚠ Rate limit reached (429): slow down and try again later.";
      out({ event: "step_update", step_update: {
        ...scope, step_index: step++, state: "ERROR", step_type: "tool",
        tool_name: "run_command", tool_info: { error: { message } },
      } });
      setTimeout(() => process.exit(1), 50);
      return;
    }
    if (mode === "tool-ineligible") {
      const message = "npm: verify your account to publish this package";
      out({
        event: "step_update",
        step_update: {
          ...scope, step_index: step++, state: "ERROR", step_type: "tool",
          tool_name: "run_command", tool_info: { error: { message } },
        },
      });
      out({ event: "result", result: { ...scope, status: "ERROR", response: "", error: message, num_turns: turns, usage } });
      setTimeout(() => process.exit(1), 100);
      return;
    }
    if ((mode.startsWith("ineligible") || mode === "network-eligibility") &&
        ineligibleHome && turns >= Number(process.env.FAKE_INELIGIBLE_AFTER_TURN ?? 1)) {
      void refuseEligibility();
      return;
    }
    if (mode === "stderr" && !bannerSent) {
      // The banner arrives mid-turn, after the session asked real work: that
      // is when agy's model call actually fails, and it guarantees identity
      // has been announced before the line reaches the bridge's stderr sink.
      bannerSent = true;
      process.stderr.write(`${QUOTA}\n`);
      process.stderr.write("warning: the model is behind and may be slow\n");
    }
    if (mode === "tool") {
      // A live start first, then twice verbatim: the bridge must stream the
      // tool's name and its ACTIVE/DONE settle live, and still report the
      // message once per turn.
      out({
        event: "step_update",
        step_update: {
          ...scope,
          step_index: step++,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "write_to_file",
          tool_info: { name: "write_to_file" },
        },
      });
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
            duration_seconds: 1.5,
          },
        });
      }
    }
    if (mode === "residue") {
      // Turn 1 is the genuine quota hit: a failed tool call, NO reply, and
      // the ERROR result that ends it. Turns 2-3 answer yet agy re-attaches
      // the SAME frozen text to their result — the reply completed, so the
      // bridge completes them and does not re-show the banner. Turn 4 has no
      // reply and a DIFFERENT countdown: a genuinely dead turn that must fail
      // and surface the new text. Turn 5 answers and carries that same new
      // text: a completed reply makes it baggage too.
      const fresh = turns === 4 || turns === 5;
      if (turns === 1 || turns === 4) {
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
        }
        out({
          event: "result",
          result: {
            ...scope,
            status: "ERROR",
            response: "",
            num_turns: turns,
            error: fresh ? FRESH_QUOTA : QUOTA,
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
            error: fresh ? FRESH_QUOTA : QUOTA,
            usage,
          },
        });
      }
      return;
    }
    if (mode === "server-500-exit") {
      // The 01.11 incident's shape: Google's 500 on stderr with agy's
      // AGY_ERROR JSON tail, the ERROR result, then exit 3.
      if (turns === 1) {
        const err = "API error (attempt 1): INTERNAL (code 500): Internal error encountered.";
        process.stderr.write(`error: ${err}\n`);
        process.stderr.write(`AGY_ERROR: {"short_error":"${err}","retryable":false,"error_id":"fake-500"}\n`);
        out({ event: "result", result: { ...scope, status: "ERROR", response: "", num_turns: turns, error: err, usage } });
        setTimeout(() => process.exit(3), 100);
        return;
      }
    }
    if (mode === "server-503-result" || mode === "server-503-overloaded") {
      if (turns === 1) {
        out({ event: "result", result: { ...scope, status: "ERROR", response: "", num_turns: turns,
          error: mode === "server-503-result"
            ? "API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable."
            : "API error (attempt 1): UNAVAILABLE (code 503): The model is overloaded.", usage } });
        return;
      }
    }
    if (mode === "tool-5xx") {
      // A tool's own 5xx (agy-framed, worst case) that agy then reports as
      // the turn's error: must NOT be tagged for an automatic whole-turn re-run.
      if (turns === 1) {
        const err = "API error (attempt 1): UNAVAILABLE (code 503): upstream 504 Gateway Timeout, context deadline exceeded";
        out({ event: "step_update", step_update: { ...scope, step_index: step++, state: "ERROR", step_type: "tool",
          tool_name: "run_command", tool_info: { name: "run_command", error: { message: err } }, duration_seconds: 0.5 } });
        out({ event: "result", result: { ...scope, status: "ERROR", response: "", num_turns: turns, error: err, usage } });
        return;
      }
    }
    if (mode === "reject-then-exit") {
      // Identity announces, the turn is refused on the first call, the ERROR
      // result with no reply names the quota — and only then does agy exit 1.
      if (turns === 1) {
        out({
          event: "step_update",
          step_update: {
            ...scope,
            step_index: step++,
            state: "DONE",
            step_type: "user_input",
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
        setTimeout(() => process.exit(1), 100);
      }
      return;
    }
    if (mode === "quota-retry" || mode === "quota-retry-always") {
      // The auto-retry shape: a fresh child rejects the first turn with a
      // SHORT window ("Resets in 2s.") and exits 1, exactly like
      // reject-then-exit but close enough for the bridge's quota auto-retry
      // to schedule a re-run. A child spawned WITH --conversation is that
      // re-run: quota-retry answers it successfully; quota-retry-always
      // rejects again, so the retry budget runs out and the turn must fail
      // honestly on the second attempt.
      const resumed = process.argv.includes("--conversation");
      if (!resumed || mode === "quota-retry-always") {
        out({
          event: "step_update",
          step_update: {
            ...scope,
            step_index: step++,
            state: "DONE",
            step_type: "user_input",
          },
        });
        out({
          event: "result",
          result: {
            ...scope,
            status: "ERROR",
            response: "",
            num_turns: turns,
            error: QUOTA_SHORT,
            usage,
          },
        });
        setTimeout(() => process.exit(1), 100);
      } else {
        out({
          event: "step_update",
          step_update: {
            ...scope,
            step_index: step++,
            state: "DONE",
            step_type: "agent_response",
            text_delta: "recovered after quota",
            usage,
          },
        });
        out({
          event: "result",
          result: {
            ...scope,
            status: "SUCCESS",
            response: "recovered after quota",
            num_turns: turns,
            usage,
          },
        });
      }
      return;
    }
    if (mode === "stall") {
      // One live tool item, then permanent silence: no result ever — a tool
      // the bridge cannot tell apart from a working quiet one (agy does not
      // stream tool output). AGY_TOOL_STALL_MS (the tool budget, not the
      // model's AGY_STALL_KILL_MS) decides when the bridge gives up.
      out({
        event: "step_update",
        step_update: {
          ...scope,
          step_index: step++,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { name: "run_command" },
        },
      });
      return;
    }
    if (mode === "stall-quiet") {
      // A turn the child never answers at all: no tool item, no result, no
      // stderr — the model tier (AGY_STALL_KILL_MS, no tool in flight) must
      // fail it.
      return;
    }
    if (mode === "pool-retry") {
      // The pool shape: EVERY account refuses its first request (each home
      // gets one quota hit, marked by a sentinel in that home) and works
      // afterwards. The bridge must cool the burnt account, rotate to a
      // sibling home, and — when the fresh conversation finally lands on an
      // already-punished home — complete. Success also proves the proxy and
      // HOME env actually followed the account.
      const sentinel = join(process.env.HOME ?? "/tmp", ".pool-rejected");
      if (!existsSync(sentinel)) {
        writeFileSync(sentinel, `${process.pid}\n`);
        out({
          event: "step_update",
          step_update: {
            ...scope,
            step_index: step++,
            state: "DONE",
            step_type: "user_input",
          },
        });
        out({
          event: "result",
          result: {
            ...scope,
            status: "ERROR",
            response: "",
            num_turns: turns,
            error: QUOTA_SHORT,
            usage,
          },
        });
        setTimeout(() => process.exit(1), 100);
      } else {
        out({
          event: "step_update",
          step_update: {
            ...scope,
            step_index: step++,
            state: "DONE",
            step_type: "agent_response",
            text_delta: "pool recovered",
            usage,
          },
        });
        out({
          event: "result",
          result: {
            ...scope,
            status: "SUCCESS",
            response: "pool recovered",
            num_turns: turns,
            usage,
          },
        });
      }
      return;
    }
    if (mode === "pool-bare-once" || mode === "pool-exit-once" || mode === "pool-exit-trailing") {
      // PLUG-58 shapes: a quota WITHOUT any "Resets in" countdown, fired
      // ONCE per data dir (root sentinel file) so the bridge must rotate to
      // a sibling on classification alone. pool-bare-once refuses via an
      // ERROR result carrying a bare 429 text; pool-exit-once dies BEFORE
      // any result, leaving only a stderr banner behind; pool-exit-trailing
      // is the same death but buries the banner under a trailing
      // non-quota stderr line (the auditor's blind spot: lastStderr alone
      // no longer names the quota).
      const BARE = "⚠ Rate limit reached (429): slow down and try again later.";
      const onceFile =
        process.env.AGY_FAKE_ONCE_FILE ?? `/tmp/agy-${mode}-done`;
      if (!existsSync(onceFile)) {
        writeFileSync(onceFile, `${process.pid}\n`);
        if (mode === "pool-exit-once" || mode === "pool-exit-trailing") {
          process.stderr.write(`${BARE}\n`);
          if (mode === "pool-exit-trailing") {
            process.stderr.write(`info: cleaning up and shutting down\n`);
          }
          setTimeout(() => process.exit(1), 100);
        } else {
          out({
            event: "step_update",
            step_update: {
              ...scope,
              step_index: step++,
              state: "DONE",
              step_type: "user_input",
            },
          });
          out({
            event: "result",
            result: {
              ...scope,
              status: "ERROR",
              response: "",
              num_turns: turns,
              error: BARE,
              usage,
            },
          });
          setTimeout(() => process.exit(1), 100);
        }
      } else {
        out({
          event: "step_update",
          step_update: {
            ...scope,
            step_index: step++,
            state: "DONE",
            step_type: "agent_response",
            text_delta: "pool recovered",
            usage,
          },
        });
        out({
          event: "result",
          result: {
            ...scope,
            status: "SUCCESS",
            response: "pool recovered",
            num_turns: turns,
            usage,
          },
        });
      }
      return;
    }
    const reply = () => {
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
    };
    // slow-reply: think silently for a while before answering, like the real
    // model does; long enough for the bridge's 1s stall sweep to look.
    if (mode === "slow-reply") {
      setTimeout(reply, Number(process.env.AGY_FAKE_REPLY_DELAY_MS ?? "1500"));
      return;
    }
    reply();
  },
);
