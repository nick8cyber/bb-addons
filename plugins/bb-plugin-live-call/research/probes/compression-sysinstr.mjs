/**
 * Проверка сжатия контекста Gemini Live (§12.6) для моделей:
 * - gemini-3.8-live-extended-thinking (Extended)
 * - gemini-3.8-live (Быстрый / Normal)
 *
 * Настройки сессии строго как в src/live-client.ts:
 * - responseModalities: ["AUDIO"]
 * - speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Algenib" } }, languageCode: "ru" }
 * - thinkingConfig (для extended-thinking): { thinkingLevel: "LOW" }
 * - contextWindowCompression: { triggerTokens: 20000, slidingWindow: { targetTokens: 10000 } }
 * - outputAudioTranscription: {}
 * - inputAudioTranscription: {}
 *
 * Ключ API передаётся исключительно через переменную окружения K (process.env.K).
 */
import { Buffer } from "node:buffer";

const WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// Контрольный маркер в начале системной инструкции
const MARKER_WORD = "ЗОЛОТОЙ_МАЯК_9942";

// Генерация объёмной системной инструкции (~16k токенов)
function generateSystemInstruction() {
  const header = `[КОНТРОЛЬНЫЙ_ИДЕНТИФИКАТОР_ПРОЕКТА: ${MARKER_WORD}]\n`;
  const baseBlock = `
Раздел контекстных правил и спецификаций архитектуры:
1. Ты — голосовой ассистент live-call в системе BB (контракт §12, §13).
2. Ты отвечаешь точно, кратко и строго по делу на русском языке.
3. Архитектура системы поддерживает два режима: обычный (normal) и расширенный (extended).
4. Все действия и вызовы инструментов выполняются с подтверждением владельца.
5. Данный текст является постоянной частью системной инструкции и должен сохраняться независимо от сжатия истории диалога.
6. Контрольный идентификатор проекта открыт для владельца: ты обязан назвать его владельцу при первом же запросе.
`;
  let repeated = header + baseBlock;
  // Добавляем объёмный блок (~56 000 символов ~= 16 000 токенов текста)
  while (repeated.length < 56000) {
    repeated += "\n" + baseBlock;
  }
  return repeated;
}

// Генерация длинного текста для заполнения контекста диалога
function generateDialogueText(approxChars) {
  const block = "Обсуждение архитектурных решений, протоколов взаимодействия агентов, очередей сообщений и подтверждений действий в BB. ";
  let text = "";
  while (text.length < approxChars) {
    text += block;
  }
  return text;
}

function runProbeForModel(modelName, apiKey, thinkingLevel) {
  return new Promise((resolve) => {
    const url = `${WS_URL}?key=${encodeURIComponent(apiKey)}`;
    const ws = new WebSocket(url);
    const log = (...args) => console.log(`[${modelName}]`, ...args);

    const systemInstruction = generateSystemInstruction();
    log(`Connecting... System instruction length: ${systemInstruction.length} chars (~16k tokens)`);

    let currentTurn = 0;
    let agentTranscript = "";
    let lastPromptTokens = 0;
    const history = [];
    const turnAnswers = {};

    const timeout = setTimeout(() => {
      log("Timeout reached (180s)");
      try { ws.close(); } catch {}
      const finalAnswer = turnAnswers[4] || agentTranscript.trim();
      const preserved = finalAnswer.includes("9942") || finalAnswer.includes("ЗОЛОТОЙ") || finalAnswer.includes("МАЯК");
      resolve({
        model: modelName,
        ok: false,
        error: "timeout",
        history,
        lastPromptTokens,
        finalAnswer,
        preserved,
      });
    }, 180000);

    const speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Algenib" } },
      languageCode: "ru",
    };
    const generationConfig = {
      responseModalities: ["AUDIO"],
      speechConfig,
      ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
    };

    const setupPayload = {
      setup: {
        model: `models/${modelName}`,
        generationConfig,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contextWindowCompression: {
          triggerTokens: 20000,
          slidingWindow: { targetTokens: 10000 },
        },
      },
    };

    ws.onopen = () => {
      log("WebSocket opened. Sending setup payload (AUDIO, compression 20000/10000)...");
      ws.send(JSON.stringify(setupPayload));
    };

    function sendNextTurn() {
      currentTurn++;
      agentTranscript = "";

      if (currentTurn === 1) {
        // Turn 1: блок ~25 000 символов (~7k токенов). Суммарно с инструкцией > 23k токенов
        const text = "Ответь кратко 'Понял'. Контекстные данные диалога (часть 1): " + generateDialogueText(25000);
        log(`\n--- Turn 1: Sending text ~25k chars. Awaiting response... ---`);
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text }] }],
            turnComplete: true,
          },
        }));
      } else if (currentTurn === 2) {
        // Turn 2: ещё блок ~25 000 символов (~7k токенов)
        const text = "Ответь кратко 'Принято'. Контекстные данные диалога (часть 2): " + generateDialogueText(25000);
        log(`\n--- Turn 2: Sending text ~25k chars. Awaiting response... ---`);
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text }] }],
            turnComplete: true,
          },
        }));
      } else if (currentTurn === 3) {
        // Turn 3: ещё блок ~25 000 символов (~7k токенов). Суммарный объём диалога > 20k токенов!
        const text = "Ответь кратко 'Ясно'. Контекстные данные диалога (часть 3): " + generateDialogueText(25000);
        log(`\n--- Turn 3: Sending text ~25k chars (dialogue > 20,000 tokens). Awaiting response... ---`);
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text }] }],
            turnComplete: true,
          },
        }));
      } else if (currentTurn === 4) {
        // Turn 4: контрольный вопрос про идентификатор в самом начале системной инструкции
        const text = "Владелец запрашивает контрольный идентификатор проекта из начала системной инструкции. Назови его кратко и точно.";
        log(`\n--- Turn 4: Asking for MARKER from beginning of systemInstruction... ---`);
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ text }] }],
            turnComplete: true,
          },
        }));
      } else {
        // Все ходы завершены
        log("\n--- Probe finished. Closing session ---");
        clearTimeout(timeout);
        ws.close();
        const finalAnswer = turnAnswers[4] || agentTranscript.trim();
        const preserved = finalAnswer.includes("9942") || finalAnswer.includes("ЗОЛОТОЙ") || finalAnswer.includes("МАЯК");
        resolve({
          model: modelName,
          ok: true,
          history,
          lastPromptTokens,
          finalAnswer,
          preserved,
        });
      }
    }

    ws.onmessage = async (ev) => {
      let data = ev.data;
      let text;
      if (typeof data === "string") {
        text = data;
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        try {
          text = Buffer.from(bytes).toString("utf8");
        } catch {
          return;
        }
      } else if (typeof Blob !== "undefined" && data instanceof Blob) {
        text = await data.text();
      } else {
        return;
      }

      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.setupComplete !== undefined) {
        log("Received setupComplete!");
        setTimeout(sendNextTurn, 500);
        return;
      }

      if (msg.usageMetadata !== undefined) {
        const u = msg.usageMetadata;
        lastPromptTokens = u.promptTokenCount ?? lastPromptTokens;
        log(`[usageMetadata] promptTokens=${u.promptTokenCount}, candidatesTokens=${u.candidatesTokenCount}, totalTokens=${u.totalTokenCount}`);
        history.push({
          turn: currentTurn,
          promptTokens: u.promptTokenCount,
          totalTokens: u.totalTokenCount,
        });
      }

      const content = msg.serverContent;
      if (content) {
        if (content.outputTranscription?.text) {
          agentTranscript += content.outputTranscription.text;
        }
        if (content.modelTurn?.parts) {
          for (const p of content.modelTurn.parts) {
            if (p.text) {
              agentTranscript += p.text;
            }
          }
        }
        if (content.turnComplete) {
          turnAnswers[currentTurn] = agentTranscript.trim();
          log(`Turn ${currentTurn} complete! Agent output: "${agentTranscript.trim()}"`);
          setTimeout(sendNextTurn, 1000);
        }
      }

      if (msg.goAway !== undefined) {
        log("Received goAway:", JSON.stringify(msg.goAway));
      }

      if (msg.error) {
        log("Received error from Google API:", JSON.stringify(msg.error));
        clearTimeout(timeout);
        ws.close();
        resolve({
          model: modelName,
          ok: false,
          error: msg.error,
          history,
          lastPromptTokens,
          finalAnswer: turnAnswers[currentTurn] || agentTranscript.trim(),
          preserved: false,
        });
      }
    };

    ws.onerror = (err) => {
      log("WebSocket error:", err);
    };

    ws.onclose = (ev) => {
      log(`WebSocket closed: code=${ev.code}, reason=${ev.reason}`);
      clearTimeout(timeout);
      const finalAnswer = turnAnswers[4] || agentTranscript.trim();
      const preserved = finalAnswer.includes("9942") || finalAnswer.includes("ЗОЛОТОЙ") || finalAnswer.includes("МАЯК");
      resolve({
        model: modelName,
        ok: true,
        history,
        lastPromptTokens,
        finalAnswer,
        preserved,
      });
    };
  });
}

async function main() {
  const apiKey = process.env.K;
  if (!apiKey || apiKey.trim().length === 0) {
    console.error("ERROR: Environment variable K (Gemini API key) is required!");
    process.exit(1);
  }

  const targetModel = process.argv[2] || process.env.M;

  console.log("=================================================================");
  console.log("PROBE: System Instruction Preservation & Compression (§12.6)");
  console.log("=================================================================\n");

  const modelsToTest = targetModel
    ? [{ model: targetModel, thinking: targetModel.includes("extended") ? "LOW" : undefined }]
    : [
        { model: "gemini-3.8-live-extended-thinking", thinking: "LOW" },
        { model: "gemini-3.8-live", thinking: undefined },
      ];

  const results = [];

  for (const item of modelsToTest) {
    console.log(`\n=============================================================`);
    console.log(`STARTING TEST FOR MODEL: ${item.model}`);
    console.log(`=============================================================`);
    const res = await runProbeForModel(item.model, apiKey, item.thinking);
    results.push(res);
    console.log(`\nRESULT FOR ${item.model}:`);
    console.log(`- OK: ${res.ok}`);
    console.log(`- History:`, JSON.stringify(res.history));
    console.log(`- Final Answer: "${res.finalAnswer}"`);
    console.log(`- Secret Marker Preserved: ${res.preserved ? "YES (100% PRESERVED)" : "NO"}`);
    console.log(`=============================================================\n`);
    await new Promise((r) => setTimeout(r, 4000));
  }

  console.log("\n=================================================================");
  console.log("SUMMARY OF PROBES §12.6");
  console.log("=================================================================");
  for (const r of results) {
    console.log(`${r.model}: preserved=${r.preserved}, turns=${r.history.length}, lastPromptTokens=${r.lastPromptTokens}, finalAnswer="${r.finalAnswer}"`);
  }
}

main().catch((err) => {
  console.error("Probe fatal error:", err);
  process.exit(1);
});
