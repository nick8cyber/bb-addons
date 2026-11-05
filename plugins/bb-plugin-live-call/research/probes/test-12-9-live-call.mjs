/**
 * Живой звонок в Extended по треду (§12.9 приёмка).
 * Использование: node test-12-9-live-call.mjs "<вопрос>" [targetThreadId]
 */

import { execSync as __exec } from "node:child_process";
const TOKEN = process.env.LC_TOKEN ?? __exec("bb call token", { encoding: "utf8" }).trim(); // §16.2
const targetThreadId = process.argv[3] || "thr_testlong02";
const question = process.argv[2] || "что сейчас происходит?";
const WS_URL = "ws://127.0.0.1:38886/api/v1/plugins/live-call/http/call";

console.log(`=== LIVE CALL TEST (§12.9) ===`);
console.log(`Target thread: ${targetThreadId}`);
console.log(`Question: "${question}"`);
console.log(`Mode: extended`);

async function runCall() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let callId = null;
    let callThreadId = null;
    let agentTranscript = "";
    const actions = [];
    let questionSent = false;
    let turnTimer = null;

    const timeout = setTimeout(() => {
      console.log("[TIMEOUT] 60s reached");
      try {
        ws.send(JSON.stringify({ type: "end" }));
      } catch {}
      setTimeout(() => {
        try { ws.close(); } catch {}
        resolve({
          callId,
          callThreadId,
          question,
          actions,
          transcript: agentTranscript.trim(),
        });
      }, 1000);
    }, 60000);

    ws.onopen = () => {
      console.log("[WS] Connected. Sending hello (extended)...");
      ws.send(JSON.stringify({
        type: "hello",
        token: TOKEN,
        protocol: 1,
        mode: "extended",
        threadId: targetThreadId,
      }));
    };

    ws.onmessage = (ev) => {
      let data = ev.data;
      if (typeof data !== "string") {
        return; // binary audio ignored
      }
      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }

      if (frame.type === "ready") {
        callId = frame.callId;
        console.log(`[READY] callId=${callId}, mode=${frame.mode}, voice=${frame.voice}`);
      }

      if (frame.type === "thread") {
        callThreadId = frame.threadId;
        console.log(`[THREAD] callThreadId=${callThreadId} (тред звонка в «Звонки»)`);
      }

      if (frame.type === "state" && frame.state === "listening" && !questionSent) {
        questionSent = true;
        console.log(`[STATE] listening. Sending question in 500ms...`);
        setTimeout(() => {
          console.log(`[SEND] text: "${question}"`);
          ws.send(JSON.stringify({ type: "text", text: question }));
        }, 500);
      }

      if (frame.type === "action") {
        console.log(`[ACTION] tool=${frame.tool}, class=${frame.class}, status=${frame.status}, summary="${frame.summary}"`);
        actions.push({
          tool: frame.tool,
          status: frame.status,
          summary: frame.summary,
        });
      }

      if (frame.type === "transcript") {
        if (frame.role === "agent") {
          if (frame.final) {
            console.log(`[TRANSCRIPT final] "${frame.text}"`);
            agentTranscript += (agentTranscript ? " " : "") + frame.text;
            if (turnTimer) clearTimeout(turnTimer);
            turnTimer = setTimeout(() => {
              console.log("[DONE] Agent finished speaking. Ending call...");
              try {
                ws.send(JSON.stringify({ type: "end" }));
              } catch {}
            }, 4000);
          } else {
            process.stdout.write(`.`);
          }
        } else if (frame.role === "owner" && frame.final) {
          console.log(`\n[TRANSCRIPT owner] "${frame.text}"`);
        }
      }

      if (frame.type === "ended") {
        console.log(`[ENDED] reason=${frame.reason}`);
        clearTimeout(timeout);
        if (turnTimer) clearTimeout(turnTimer);
        ws.close();
        resolve({
          callId,
          callThreadId,
          question,
          actions,
          transcript: agentTranscript.trim(),
        });
      }

      if (frame.type === "error") {
        console.log(`[ERROR] code=${frame.code}, message="${frame.message}"`);
        clearTimeout(timeout);
        ws.close();
        resolve({
          callId,
          callThreadId,
          question,
          actions,
          transcript: agentTranscript.trim(),
          error: frame,
        });
      }
    };

    ws.onerror = (err) => {
      console.error("[WS ERROR]", err);
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      resolve({
        callId,
        callThreadId,
        question,
        actions,
        transcript: agentTranscript.trim(),
      });
    };
  });
}

runCall().then((res) => {
  console.log("\n=======================================================");
  console.log("CALL SUMMARY");
  console.log("=======================================================");
  console.log(`Call ID: ${res.callId}`);
  console.log(`Call Thread: ${res.callThreadId}`);
  console.log(`Question: ${res.question}`);
  console.log(`Actions called: ${res.actions.length}`);
  for (const a of res.actions) {
    console.log(`  - ${a.tool} (${a.status}): ${a.summary}`);
  }
  const readMessagesCalled = res.actions.some((a) => a.tool === "thread_read_messages");
  console.log(`thread_read_messages called: ${readMessagesCalled ? "YES (FAIL)" : "NO (OK)"}`);
  console.log(`Agent response:\n${res.transcript}`);
  console.log("=======================================================\n");
  process.exit(0);
}).catch((err) => {
  console.error("Call failed:", err);
  process.exit(1);
});
