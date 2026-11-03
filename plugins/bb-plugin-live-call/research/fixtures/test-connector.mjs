#!/usr/bin/env node
/**
 * Тестовый MCP-коннектор stdio (§15.6 п. 2).
 * Ручки:
 * - get_info (класс R)
 * - set_status (класс C)
 * - forbidden_action (запрещена реестром)
 */
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = req;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test-connector", version: "1.0.0" },
    });
  } else if (method === "notifications/initialized") {
    // Уведомление, ответ не требуется
  } else if (method === "tools/list") {
    sendResult(id, {
      tools: [
        {
          name: "get_info",
          description: "Получить диагностическую информацию о тестовом сервисе",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "set_status",
          description: "Установить рабочий статус тестового сервиса",
          inputSchema: {
            type: "object",
            properties: {
              status: { type: "string", description: "новый статус" },
            },
            required: ["status"],
          },
        },
        {
          name: "forbidden_action",
          description: "Запрещённая операция коннектора",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    });
  } else if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments ?? {};
    if (toolName === "get_info") {
      sendResult(id, {
        content: [{ type: "text", text: "test-connector status: OK, items: 3" }],
        isError: false,
      });
    } else if (toolName === "set_status") {
      sendResult(id, {
        content: [{ type: "text", text: `status updated to: ${args.status ?? "unknown"}` }],
        isError: false,
      });
    } else if (toolName === "forbidden_action") {
      sendResult(id, {
        content: [{ type: "text", text: "forbidden_action executed" }],
        isError: false,
      });
    } else {
      sendError(id, -32601, `Неизвестный инструмент ${toolName}`);
    }
  } else if (id !== undefined) {
    sendError(id, -32601, `Метод ${method} не поддерживается`);
  }
});

function sendResult(id, result) {
  if (id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
  if (id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}
