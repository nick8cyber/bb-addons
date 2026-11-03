/**
 * Живой звонок 2 по треду (§12.11 приёмка):
 * Тестовый тред с собственным worktree:
 * brain_task «создай файл test-brain.txt с текстом ok» -> confirm approve ->
 * файл появился в worktree мозгового центра, а не в папке целевого треда; после проверки файл удалить.
 *
 * Использование: node research/probes/test-12-11-call2.mjs <testThreadId>
 */

const testThreadId = process.argv[2];
if (!testThreadId) {
  console.error("Usage: node test-12-11-call2.mjs <testThreadId>");
  process.exit(1);
}

const WS_URL = "ws://127.0.0.1:38886/api/v1/plugins/live-call/http/call";

console.log(`=== LIVE CALL 2 (§12.11) ===`);
console.log(`Test thread: ${testThreadId}`);

async function runCall() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let callId = null;
    let callThreadId = null;
    const turns = [];
    const actions = [];
    let state = "init";
    let confirmed = false;

    const timeout = setTimeout(() => {
      console.log("\n[TIMEOUT] 180s reached, closing call...");
      try { ws.send(JSON.stringify({ type: "end" })); } catch {}
      setTimeout(() => {
        try { ws.close(); } catch {}
        resolve({ callId, callThreadId, turns, actions });
      }, 2000);
    }, 180_000);

    ws.onopen = () => {
      console.log("[WS] Connected. Sending hello...");
      ws.send(JSON.stringify({
        type: "hello",
        protocol: 1,
        mode: "normal",
        threadId: testThreadId,
      }));
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (frame.type === "ready") {
        callId = frame.callId;
        console.log(`[READY] callId=${callId}, targetThread=${frame.targetThreadId}`);
      }

      if (frame.type === "thread") {
        callThreadId = frame.threadId;
        console.log(`[THREAD] callThreadId=${callThreadId}`);
      }

      if (frame.type === "action") {
        console.log(`[ACTION] ${frame.tool} (${frame.status}): ${frame.summary}`);
        actions.push(frame);
      }

      if (frame.type === "confirmation") {
        const confId = frame.confirmationId || frame.confirmation?.id;
        const summary = frame.summary || frame.confirmation?.say;
        console.log(`[CONFIRMATION REQUEST] id=${confId}, say="${summary}"`);
        if (!confirmed && confId) {
          confirmed = true;
          console.log(`[USER SEND] approve confirmation in 1s...`);
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: "confirm",
              confirmationId: confId,
              decision: "approve",
            }));
          }, 1000);
        }
      }

      if (frame.type === "confirmation_result") {
        console.log(`[CONFIRMATION RESULT] verdict=${frame.verdict}`);
      }

      if (frame.type === "transcript") {
        if (frame.role === "agent" && frame.final) {
          console.log(`\n[AGENT FINAL] ${frame.text}\n`);
          turns.push({ role: "agent", text: frame.text, at: Date.now() });

          if (state === "init") {
            console.log("--> Приветствие получено. Ждём сводку мозгового центра...");
            state = "waiting_summary";
          } else if (state === "waiting_summary") {
            console.log("--> Сводка озвучена! Отправляем задачу brain_task через 1.5 с...");
            state = "sending_task";
            setTimeout(() => {
              const taskText = "поставь задачу мозговому центру: создай файл test-brain.txt с текстом ok";
              console.log(`[USER SEND] "${taskText}"`);
              ws.send(JSON.stringify({ type: "text", text: taskText }));
              state = "waiting_task_done";
            }, 1500);
          } else if (state === "waiting_task_done" && confirmed) {
            console.log("--> Задача выполнена мозговым центром и подтверждена агентом! Завершаем звонок через 3 с...");
            state = "finishing";
            setTimeout(() => {
              console.log("[USER SEND] end call");
              try { ws.send(JSON.stringify({ type: "end" })); } catch {}
            }, 3000);
          }
        } else if (frame.role === "owner" && frame.final) {
          console.log(`[OWNER FINAL] ${frame.text}`);
          turns.push({ role: "owner", text: frame.text, at: Date.now() });
        }
      }

      if (frame.type === "ended") {
        console.log(`[ENDED] reason=${frame.reason}`);
        clearTimeout(timeout);
        ws.close();
        resolve({ callId, callThreadId, turns, actions });
      }

      if (frame.type === "error") {
        console.error(`[ERROR] ${frame.code}: ${frame.message}`);
        clearTimeout(timeout);
        ws.close();
        resolve({ callId, callThreadId, turns, actions, error: frame });
      }
    };

    ws.onerror = (e) => {
      console.error("[WS ERROR]", e);
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      resolve({ callId, callThreadId, turns, actions });
    };
  });
}

runCall().then((res) => {
  console.log("\n=======================================================");
  console.log("LIVE CALL 2 RESULTS");
  console.log("=======================================================");
  console.log(`Call ID: ${res.callId}`);
  console.log(`Call Thread: ${res.callThreadId}`);
  console.log(`Turns count: ${res.turns.length}`);
  for (let i = 0; i < res.turns.length; i++) {
    const t = res.turns[i];
    console.log(`[${i + 1}] ${t.role.toUpperCase()}: ${t.text}`);
  }
  console.log(`Actions count: ${res.actions.length}`);
  for (const a of res.actions) {
    console.log(`  - ${a.tool} (${a.status}): ${a.summary}`);
  }
  console.log("=======================================================\n");
  process.exit(0);
}).catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
