/**
 * Живой звонок 1 по треду (§12.11 приёмка):
 * Длинный тред (thr_testlong02):
 * 1) Приветствие («Привет, сейчас обрабатываю информацию по треду»);
 * 2) Сводка мозгового центра и её время в мс;
 * 3) Ответ на «На чём остановились?»;
 * 4) Один вызов brain_ask.
 *
 * Использование: node research/probes/test-12-11-call1.mjs <targetThreadId>
 */

const targetThreadId = process.argv[2];
if (!targetThreadId) {
  console.error("Usage: node test-12-11-call1.mjs <targetThreadId>");
  process.exit(1);
}

const WS_URL = "ws://127.0.0.1:38886/api/v1/plugins/live-call/http/call";

console.log(`=== LIVE CALL 1 (§12.11) ===`);
console.log(`Target thread: ${targetThreadId}`);

async function runCall() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let callId = null;
    let callThreadId = null;
    const turns = [];
    const actions = [];
    let state = "init";
    let summaryMs = null;

    const timeout = setTimeout(() => {
      console.log("\n[TIMEOUT] 180s reached, closing call...");
      try { ws.send(JSON.stringify({ type: "end" })); } catch {}
      setTimeout(() => {
        try { ws.close(); } catch {}
        resolve({ callId, callThreadId, turns, actions, summaryMs });
      }, 2000);
    }, 180_000);

    ws.onopen = () => {
      console.log("[WS] Connected. Sending hello...");
      ws.send(JSON.stringify({
        type: "hello",
        protocol: 1,
        mode: "normal",
        threadId: targetThreadId,
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

      if (frame.type === "transcript") {
        if (frame.role === "agent" && frame.final) {
          console.log(`\n[AGENT FINAL] ${frame.text}\n`);
          turns.push({ role: "agent", text: frame.text, at: Date.now() });

          // Обработка стадий диалога
          if (state === "init") {
            // Первое сообщение агента — приветствие
            console.log("--> Приветствие получено. Ждём сводку мозгового центра...");
            state = "waiting_summary";
          } else if (state === "waiting_summary") {
            // Второе сообщение агента — пересказ сводки мозгового центра
            console.log("--> Сводка озвучена! Задаём вопрос «На чём остановились?» через 1.5 с...");
            state = "asking_paused";
            setTimeout(() => {
              console.log('[USER SEND] "На чём остановились?"');
              ws.send(JSON.stringify({ type: "text", text: "На чём остановились?" }));
              state = "waiting_paused_answer";
            }, 1500);
          } else if (state === "waiting_paused_answer") {
            // Третье сообщение агента — ответ на «На чём остановились?»
            console.log("--> Ответ на «На чём остановились?» получен! Запрашиваем brain_ask через 1.5 с...");
            state = "asking_brain";
            setTimeout(() => {
              const q = "Спроси у мозгового центра через brain_ask: какие сейчас главные открытые вопросы?";
              console.log(`[USER SEND] "${q}"`);
              ws.send(JSON.stringify({ type: "text", text: q }));
              state = "waiting_brain_answer";
            }, 1500);
          } else if (state === "waiting_brain_answer") {
            // Четвёртое сообщение агента — результат вызова brain_ask
            console.log("--> Ответ по brain_ask получен! Завершаем звонок через 3 с...");
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
        resolve({ callId, callThreadId, turns, actions, summaryMs });
      }

      if (frame.type === "error") {
        console.error(`[ERROR] ${frame.code}: ${frame.message}`);
        clearTimeout(timeout);
        ws.close();
        resolve({ callId, callThreadId, turns, actions, summaryMs, error: frame });
      }
    };

    ws.onerror = (e) => {
      console.error("[WS ERROR]", e);
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      resolve({ callId, callThreadId, turns, actions, summaryMs });
    };
  });
}

runCall().then((res) => {
  console.log("\n=======================================================");
  console.log("LIVE CALL 1 RESULTS");
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
