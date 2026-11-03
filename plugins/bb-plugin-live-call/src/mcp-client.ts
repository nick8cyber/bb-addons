/**
 * MCP-клиент stdio и http (§15.4 п. 1–2, 5).
 * Запуск коннектора: initialize → tools/list с таймаутом 10 с.
 * Вызов ручки: tools/call с таймаутом 30 с и сжатием до 2000 символов.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { CONNECTOR_RESULT_MAX_CHARS_DEFAULT, type ConnectorConfig } from "./project-registry.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  ok: boolean;
  data?: { result: string };
  error?: {
    code: "connector_error" | "timeout" | "invalid_argument";
    message: string;
  };
}

export function makeConnectorToolName(connectorId: string, tool: string): string {
  const raw = `${connectorId}__${tool}`;
  return raw.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
}

export function parseConnectorToolName(name: string): { connectorId: string; tool: string } | null {
  const idx = name.indexOf("__");
  if (idx === -1) return null;
  return { connectorId: name.slice(0, idx), tool: name.slice(idx + 2) };
}

/**
 * Перевод схемы MCP в поднабор Gemini functionDeclarations (§15.4 п. 2).
 * Отбрасывает неподдержанные ключи ($schema, additionalProperties и др.).
 */
export function mcpSchemaToGeminiParameters(schema?: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  const clean = (s: unknown): unknown => {
    if (!s || typeof s !== "object") return s;
    const obj = s as Record<string, unknown>;
    const res: Record<string, unknown> = {};
    if (typeof obj.type === "string") {
      res.type = obj.type;
    } else if (Array.isArray(obj.type)) {
      res.type = obj.type.find((t) => t !== "null") ?? "string";
    } else if (obj.properties) {
      res.type = "object";
    }
    if (typeof obj.description === "string") res.description = obj.description;
    if (Array.isArray(obj.required)) res.required = obj.required.filter((k): k is string => typeof k === "string");
    if (Array.isArray(obj.enum)) res.enum = obj.enum.map(String);
    if (obj.properties && typeof obj.properties === "object") {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj.properties as Record<string, unknown>)) {
        props[k] = clean(v);
      }
      res.properties = props;
    }
    if (obj.items && typeof obj.items === "object") {
      res.items = clean(obj.items);
    }
    return res;
  };
  const cleaned = clean(schema) as Record<string, unknown>;
  if (cleaned.type !== "object") cleaned.type = "object";
  if (!cleaned.properties) cleaned.properties = {};
  return cleaned;
}

export class McpClient {
  private child: ChildProcess | null = null;
  private reqId = 0;
  private pending = new Map<number | string, { resolve: (val: unknown) => void; reject: (err: Error) => void }>();
  private closed = false;

  constructor(
    public readonly config: ConnectorConfig,
    private secrets: Record<string, string> = {},
    private log?: { info(s: string): void; warn(s: string): void; error(s: string): void },
  ) {}

  /**
   * Запуск и опрос ручек коннектора: initialize → tools/list с таймаутом 10 с (§15.4 п. 1).
   */
  async start(timeoutMs = 10_000): Promise<McpTool[]> {
    if (this.config.transport === "stdio") {
      await this.startStdio();
    }

    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`таймаут инициализации коннектора ${this.config.id} (${timeoutMs / 1000} с)`)), timeoutMs),
    );

    try {
      return await Promise.race([this.initAndListTools(), timer]);
    } catch (e) {
      this.close();
      throw e;
    }
  }

  private async startStdio(): Promise<void> {
    const cmd = this.config.command;
    if (!cmd || cmd.length === 0) {
      throw new Error(`коннектор ${this.config.id}: не указана команда`);
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
    };
    if (this.config.secrets) {
      for (const secretKey of this.config.secrets) {
        if (this.secrets[secretKey]) {
          env[secretKey] = this.secrets[secretKey];
        }
      }
    }

    const child = spawn(cmd[0], cmd.slice(1), {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.on("error", (err) => {
      this.log?.warn?.(`MCP [${this.config.id}] child error: ${String(err)}`);
      this.rejectAll(err);
    });

    child.on("close", (code) => {
      if (!this.closed) {
        this.log?.warn?.(`MCP [${this.config.id}] exited code=${code}`);
        this.rejectAll(new Error(`коннектор ${this.config.id} завершил работу с кодом ${code}`));
      }
    });

    child.stderr?.on("data", (d: Buffer) => {
      this.log?.warn?.(`MCP [${this.config.id}] stderr: ${d.toString("utf-8").trim()}`);
    });

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: { id?: number | string; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(msg.error.message ?? "MCP error"));
          } else {
            p.resolve(msg.result);
          }
        }
      });
    }
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private async request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) throw new Error(`коннектор ${this.config.id} закрыт`);

    if (this.config.transport === "http") {
      return this.requestHttp(method, params, timeoutMs);
    }

    const id = ++this.reqId;
    const req = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`таймаут запроса ${method} (${timeoutMs} мс)`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        this.child?.stdin?.write(JSON.stringify(req) + "\n");
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    if (this.closed) return;
    const req = { jsonrpc: "2.0", method, params };
    if (this.config.transport === "stdio") {
      try {
        this.child?.stdin?.write(JSON.stringify(req) + "\n");
      } catch {
        // Игнорируем ошибки при отправке уведомлений
      }
    } else if (this.config.transport === "http") {
      void this.requestHttp(method, params, 5000).catch(() => {});
    }
  }

  private async requestHttp(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const url = this.config.url;
    if (!url) throw new Error(`коннектор ${this.config.id}: не указан url`);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.secrets) {
      for (const s of this.config.secrets) {
        if (this.secrets[s]) {
          headers[s] = this.secrets[s];
          if (/token|auth/i.test(s) && !headers["Authorization"]) {
            headers["Authorization"] = `Bearer ${this.secrets[s]}`;
          }
        }
      }
    }

    const id = ++this.reqId;
    const req = { jsonrpc: "2.0", id, method, params };

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (data.error) {
      throw new Error(data.error.message ?? "MCP HTTP error");
    }
    return data.result;
  }

  private async initAndListTools(): Promise<McpTool[]> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "live-call", version: "1.0.0" },
    });

    await this.notify("notifications/initialized", {});

    const listRes = (await this.request("tools/list", {})) as { tools?: McpTool[] };
    return Array.isArray(listRes?.tools) ? listRes.tools : [];
  }

  /**
   * Вызов инструмента коннектора (§15.4 п. 5).
   * Таймаут 30 с; сжатие результата до 2000 символов; ok: false с кодом при ошибке.
   */
  async callTool(tool: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<McpCallResult> {
    try {
      const res = (await this.request("tools/call", { name: tool, arguments: args }, timeoutMs)) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };

      const isError = Boolean(res?.isError);
      let text = (res?.content ?? []).map((c) => c.text ?? "").join("\n").trim();
      if (!text && isError) text = "ошибка выполнения инструмента";

      // Сжатие до maxResultChars (по умолчанию 2000 символов, §15.2, §15.4 п. 5)
      const maxChars = this.config.maxResultChars ?? CONNECTOR_RESULT_MAX_CHARS_DEFAULT;
      if (text.length > maxChars) {
        text = text.slice(0, maxChars - 1) + "…";
      }

      if (isError) {
        return {
          ok: false,
          error: {
            code: "connector_error",
            message: text,
          },
        };
      }

      return {
        ok: true,
        data: { result: text },
      };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const isTimeout = /таймаут/i.test(msg) || /timeout/i.test(msg);
      return {
        ok: false,
        error: {
          code: isTimeout ? "timeout" : "connector_error",
          message: msg.slice(0, 2000),
        },
      };
    }
  }

  close(): void {
    this.closed = true;
    this.rejectAll(new Error("клиент закрыт"));
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // сокет или процесс закрыт
      }
      const c = this.child;
      setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {
          // процесс завершён
        }
      }, 500);
      this.child = null;
    }
  }
}
