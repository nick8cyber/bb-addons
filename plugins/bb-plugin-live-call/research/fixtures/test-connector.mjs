#!/usr/bin/env node
/**
 * Тестовый MCP-коннектор stdio (§15.6 п. 2).
 * Ручки:
 * - get_info (класс R)
 * - set_status (класс C)
 * - forbidden_action (запрещена реестром)
 * - create_record (двухшаговая ручка, класс C, §14.10)
 */
import readline from "node:readline";
import crypto from "node:crypto";

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
            properties: {
              long: { type: "boolean", description: "длинный вывод" },
              secret_echo: { type: "string", description: "эхо секрета" },
            },
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
        {
          name: "create_record",
          description: "Создать запись в тестовом сервисе (двухшаговая)",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "название записи" },
              confirm: { type: "boolean", description: "подтверждение операции" },
              confirm_token: { type: "string", description: "токен подтверждения" },
              long: { type: "boolean", description: "длинное превью" },
            },
            required: ["title"],
          },
        },
      ],
    });
  } else if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments ?? {};
    if (toolName === "get_info") {
      let text = "test-connector status: OK, items: 3";
      if (args.secret_echo) {
        text += ` secret=${args.secret_echo}`;
      }
      if (args.long) {
        text += " " + "Diagnostic info data. ".repeat(60);
      }
      sendResult(id, {
        content: [{ type: "text", text }],
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
    } else if (toolName === "create_record") {
      const cleanArgs = {};
      for (const [k, v] of Object.entries(args)) {
        if (k !== "confirm" && k !== "confirm_token" && k !== "long") {
          cleanArgs[k] = v;
        }
      }
      const sortedKeys = Object.keys(cleanArgs).sort();
      const canonical = JSON.stringify(
        sortedKeys.reduce((acc, k) => {
          acc[k] = cleanArgs[k];
          return acc;
        }, {})
      );
      const expectedToken = crypto
        .createHmac("sha256", "test-connector-secret-key")
        .update(canonical)
        .digest("hex");

      if (args.confirm === true) {
        if (args.confirm_token !== expectedToken) {
          sendResult(id, {
            content: [{ type: "text", text: "неверный токен подтверждения" }],
            isError: true,
          });
        } else {
          sendResult(id, {
            content: [{ type: "text", text: `Запись «${args.title ?? ""}» успешно создана` }],
            isError: false,
          });
        }
      } else {
        const baseText = `Превью создания записи: title=${args.title ?? ""}. Токен: ${expectedToken}`;
        const previewText = args.long ? `${baseText} ${"Длинное описание записи. ".repeat(60)}` : baseText;
        sendResult(id, {
          content: [{ type: "text", text: previewText }],
          structuredContent: {
            preview: previewText,
            confirm_token: expectedToken,
          },
          confirm_token: expectedToken,
          isError: false,
        });
      }
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
