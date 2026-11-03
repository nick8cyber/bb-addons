/**
 * Живой звонок по треду (§12.10 приёмка, вариант B — единая сессия с инструментами).
 * Использование: node test-12-10-live-call.mjs "<вопрос>" [targetThreadId] [--confirm]
 */

const question = process.argv[2] || "что сейчас происходит?";
const targetThreadId = (process.argv[3] && !process.argv[3].startsWith("--")) ? process.argv[3] : "thr_mock_target";
const autoConfirm = process.argv.includes("--confirm") || process.argv[3] === "--confirm";
const WS_URL = "ws://127.0.0.1:38886/api/v1/plugins/live-call/http/call";

console.log(`=== LIVE CALL TEST (§12.10, Variant B) ===`);
console.log(`Target thread: ${targetThreadId}`);
console.log(`Question: "${question}"`);
console.log(`Auto confirm: ${autoConfirm}`);
console.log(`Mode: normal (single session on gemini-3.8-live)`);

async function runCall() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let callId = null;
    let callThreadId = null;
    let agentTranscript = "";
    const actions = [];
    let questionSent = false;
    let turnTimer = null;
    let confirmed = false;

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
      console.log("[WS] Connected. Sending hello (normal)...");
      ws.send(JSON.stringify({
        type: "hello",
        protocol: 1,
        mode: "normal",
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
        console.log(`[THREAD] callThreadId=${callThreadId}`);
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
          class: frame.class,
          status: frame.status,
          summary: frame.summary,
        });
      }

      if (frame.type === "confirmation") {
        const confId = frame.confirmationId || frame.confirmation?.id;
        const summary = frame.summary || frame.confirmation?.say;
        console.log(`[CONFIRMATION] id=${confId}, say="${summary}"`);
        if (autoConfirm && !confirmed && confId) {
          confirmed = true;
          console.log(`[CONFIRM] Sending approve in 500ms...`);
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: "confirm",
              confirmationId: confId,
              decision: "approve",
            }));
          }, 500);
        }
      }

      if (frame.type === "confirmation_result") {
        console.log(`[CONFIRMATION_RESULT] verdict=${frame.verdict}`);
      }

      if (frame.type === "transcript") {
        if (frame.role === "agent") {
          if (frame.final) {
            console.log(`\n[TRANSCRIPT agent final] "${frame.text}"`);
            agentTranscript += (agentTranscript ? " " : "") + frame.text;
            if (turnTimer) clearTimeout(turnTimer);
            if (autoConfirm && !confirmed) {
              console.log("[WAIT] autoConfirm waiting for confirmation before ending...");
              return;
            }
            const waitTime = confirmed ? 6000 : 4000;
            turnTimer = setTimeout(() => {
              console.log("[DONE] Agent finished speaking. Ending call...");
              try {
                ws.send(JSON.stringify({ type: "end" }));
              } catch {}
            }, waitTime);
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
  console.log(`Agent response:\n${res.transcript}`);
  console.log("=======================================================\n");
  process.exit(0);
}).catch((err) => {
  console.error("Call failed:", err);
  process.exit(1);
});
