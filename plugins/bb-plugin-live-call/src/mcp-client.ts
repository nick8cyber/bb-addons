/**
 * MCP-клиент stdio и http (§14, §15.4 п. 1–2, 5, §16.7).
 * Запуск коннектора: initialize (протокол 2025-06-18) → tools/list с таймаутом 10 с.
 * Вызов ручки: tools/call с таймаутом 30 с и сжатием до maxResultChars.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import {
  CONNECTOR_RESULT_MAX_CHARS_DEFAULT,
  resolveStrictClass,
  type ConnectorConfig,
  type RepoProjectEnvironment,
} from "./project-registry.js";
import { getSecretOccurrences, isValidSecretValue, maskSecrets } from "./secret-filter.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  ok: boolean;
  data?: { result: string };
  raw?: unknown;
  maskedFullText?: string;
  error?: {
    code: "connector_error" | "timeout" | "invalid_argument" | "connector_unavailable";
    message: string;
  };
}

/**
 * Извлечение confirm_token из сырого ответа (§14.10 п. 3).
 * Ищется в direct property, structuredContent (объект или JSON-строка),
 * или в текстовых частях content (JSON или блок).
 */
export function extractConfirmToken(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  const checkObj = (o: unknown): string | undefined => {
    if (o && typeof o === "object") {
      const rec = o as Record<string, unknown>;
      if (typeof rec.confirm_token === "string" && rec.confirm_token) return rec.confirm_token;
    }
    return undefined;
  };

  const direct = checkObj(obj);
  if (direct) return direct;

  if (obj.structuredContent !== undefined) {
    const fromSc = checkObj(obj.structuredContent);
    if (fromSc) return fromSc;
    if (typeof obj.structuredContent === "string") {
      try {
        const parsed = JSON.parse(obj.structuredContent);
        const fromParsed = checkObj(parsed);
        if (fromParsed) return fromParsed;
      } catch {}
    }
  }

  if (Array.isArray(obj.content)) {
    for (const item of obj.content) {
      const fromItem = checkObj(item);
      if (fromItem) return fromItem;
      if (item && typeof item === "object" && typeof item.text === "string") {
        try {
          const parsed = JSON.parse(item.text);
          const fromText = checkObj(parsed);
          if (fromText) return fromText;
        } catch {}
        const jsonMatch = item.text.match(/\{[\s\S]*"confirm_token"\s*:\s*"([^"]+)"[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            const fromJsonMatch = checkObj(parsed);
            if (fromJsonMatch) return fromJsonMatch;
          } catch {
            if (jsonMatch[1]) return jsonMatch[1];
          }
        }
      }
    }
  }

  return undefined;
}

export interface ResolvedToolInspection {
  tool: string;
  candidateName: string;
  status: "active" | "skipped";
  cls?: "R" | "C" | "P" | "L";
  skipReason?: "invalid_name" | "name_collision" | "schema_unsupported" | "deny" | "invalid_class";
  geminiParams?: Record<string, unknown>;
}

export function makeConnectorToolName(connectorId: string, tool: string): string {
  const raw = `${connectorId}__${tool}`;
  return raw.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
}

export function isValidConnectorToolName(name: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(name) && name.length <= 64;
}

export function parseConnectorToolName(name: string): { connectorId: string; tool: string } | null {
  const idx = name.indexOf("__");
  if (idx === -1) return null;
  return { connectorId: name.slice(0, idx), tool: name.slice(idx + 2) };
}

/**
 * Проверка ручки коннектора (§14.3, §14.4, §15.3, review PLUG-117).
 * Проверяет допустимость имени, коллизии внутри проекта, схему Gemini, строгий класс R/C/P/L/deny.
 */
export function inspectConnectorTool(
  tool: McpTool,
  connCfg: ConnectorConfig,
  repoEnv: RepoProjectEnvironment,
  seenToolNames: Set<string>,
): ResolvedToolInspection {
  const rawName = `${connCfg.id}__${tool.name}`;
  if (!tool.name || !tool.name.trim() || !isValidConnectorToolName(rawName)) {
    return {
      tool: tool.name,
      candidateName: rawName,
      status: "skipped",
      skipReason: "invalid_name",
    };
  }

  const candidateName = rawName;
  if (seenToolNames.has(candidateName)) {
    return {
      tool: tool.name,
      candidateName,
      status: "skipped",
      skipReason: "name_collision",
    };
  }

  // Двухшаговая ручка (§14.10 п. 2): confirm/confirm_token разрешены в схеме, но не обязательны.
  const isTwoStep = Boolean(connCfg.twoStep && connCfg.twoStep.includes(tool.name));
  const geminiParams = toGeminiSchema(tool.inputSchema, isTwoStep);
  if (geminiParams && isTwoStep && Array.isArray((geminiParams as any).required)) {
    (geminiParams as any).required = (geminiParams as any).required.filter(
      (k: string) => k !== "confirm" && k !== "confirm_token",
    );
  }
  if (!geminiParams) {
    return {
      tool: tool.name,
      candidateName,
      status: "skipped",
      skipReason: "schema_unsupported",
    };
  }

  const connTools = connCfg.tools as Record<string, any> | undefined;
  const regCls = connTools && Object.hasOwn(connTools, tool.name) ? connTools[tool.name] : connCfg.defaultClass;
  const repoCls = repoEnv.tools && Object.hasOwn(repoEnv.tools, tool.name) ? repoEnv.tools[tool.name] : undefined;

  // Безопасная валидация классов до сравнения: неверный класс реестра или репо не должен
  // превращаться в допустимый класс через fallback (§14.8, review PLUG-117 P2-2).
  const isValidRegCls =
    regCls === "R" || regCls === "C" || regCls === "P" || regCls === "L" || regCls === "deny";
  if (!isValidRegCls) {
    return {
      tool: tool.name,
      candidateName,
      status: "skipped",
      skipReason: "invalid_class",
      geminiParams,
    };
  }

  if (repoCls !== undefined && repoCls !== "R" && repoCls !== "C" && repoCls !== "P" && repoCls !== "L") {
    return {
      tool: tool.name,
      candidateName,
      status: "skipped",
      skipReason: "invalid_class",
      geminiParams,
    };
  }

  const strictCls = resolveStrictClass(regCls, repoCls);

  if (strictCls === "deny") {
    return {
      tool: tool.name,
      candidateName,
      status: "skipped",
      skipReason: "deny",
      geminiParams,
    };
  }

  if (strictCls !== "R" && strictCls !== "C" && strictCls !== "P" && strictCls !== "L") {
    return {
      tool: tool.name,
      candidateName,
      status: "skipped",
      skipReason: "invalid_class",
      geminiParams,
    };
  }

  seenToolNames.add(candidateName);
  return {
    tool: tool.name,
    candidateName,
    status: "active",
    cls: strictCls,
    geminiParams,
  };
}

const SUPPORTED_PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

/**
 * Перевод JSON Schema в схему параметров Gemini (§14.4).
 * Переносится: type, description, properties, required, items, enum (строки),
 * format (date, date-time у строк), minimum, maximum, minItems, maxItems;
 * type: [X, "null"] и anyOf: [X, {type: "null"}] → X + nullable: true.
 * Отбрасывается: $schema, $id, title, default, examples, additionalProperties.
 * Неподдержанные схемы ($ref, oneOf, allOf, иной anyOf, patternProperties, корень не object,
 * числовой enum, свойство без type) → null (§14.4, review п. 6).
 */
export function toGeminiSchema(schema?: unknown, isTwoStep = false): Record<string, unknown> | null {
  if (schema === undefined || schema === null) {
    return { type: "object", properties: {} };
  }
  if (typeof schema !== "object" || Array.isArray(schema)) {
    return null;
  }

  const cleanNode = (node: unknown): Record<string, unknown> | null => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return null;
    }
    const raw = node as Record<string, unknown>;

    // Запрещённые конструкции: $ref, oneOf, allOf, patternProperties
    if ("$ref" in raw || "oneOf" in raw || "allOf" in raw || "patternProperties" in raw) {
      return null;
    }

    let target = raw;
    let nullable = false;

    // anyOf: поддерживается только форма [X, { type: "null" }] или [{ type: "null" }, X]
    if ("anyOf" in raw) {
      if (!Array.isArray(raw.anyOf) || raw.anyOf.length !== 2) {
        return null;
      }
      const isNull = (item: unknown): boolean => {
        if (!item || typeof item !== "object") return false;
        const rec = item as Record<string, unknown>;
        return rec.type === "null" || (Array.isArray(rec.type) && rec.type[0] === "null");
      };

      const [first, second] = raw.anyOf;
      if (isNull(first) && !isNull(second) && typeof second === "object") {
        target = second as Record<string, unknown>;
        nullable = true;
      } else if (isNull(second) && !isNull(first) && typeof first === "object") {
        target = first as Record<string, unknown>;
        nullable = true;
      } else {
        return null;
      }
    }

    // Определение типа и nullable
    let resolvedType: string | undefined = undefined;
    if (typeof target.type === "string") {
      if (target.type === "null") {
        return null;
      }
      if (!SUPPORTED_PRIMITIVE_TYPES.has(target.type)) {
        return null;
      }
      resolvedType = target.type;
    } else if (Array.isArray(target.type)) {
      const types = target.type.filter((t): t is string => typeof t === "string");
      if (types.length !== target.type.length) return null;
      if (types.includes("null")) nullable = true;
      const nonNull = [...new Set(types.filter((t) => t !== "null"))];
      if (nonNull.length === 1 && SUPPORTED_PRIMITIVE_TYPES.has(nonNull[0])) {
        // type: [X, "null"]
        resolvedType = nonNull[0];
      } else if (
        nonNull.length >= 2 &&
        nonNull.includes("string") &&
        nonNull.every((t) => t === "string" || t === "number" || t === "integer")
      ) {
        // Скалярное объединение со строкой ([string, number|integer]) → string: сервер
        // принимает строку, а Gemini объединений типов не знает (§14.4, ревью 04.11 —
        // суммы и id в CRM объявлены так).
        resolvedType = "string";
      } else {
        return null;
      }
    } else if (target.properties && typeof target.properties === "object") {
      resolvedType = "object";
    } else {
      // Свойство без type (§14.4, review п. 6) — неподдерживаемая схема
      return null;
    }

    if (target.nullable === true) {
      nullable = true;
    }

    const res: Record<string, unknown> = { type: resolvedType };
    if (nullable) res.nullable = true;

    if (typeof target.description === "string") {
      res.description = target.description;
    }

    // enum — только строки (§14.4)
    if ("enum" in target) {
      if (!Array.isArray(target.enum)) return null;
      for (const item of target.enum) {
        if (typeof item !== "string") {
          return null; // числовой или иной enum не поддерживается
        }
      }
      if (resolvedType !== "string") return null;
      res.enum = [...target.enum];
    }

    // format: date, date-time у строк
    if (typeof target.format === "string") {
      if (resolvedType === "string" && (target.format === "date" || target.format === "date-time")) {
        res.format = target.format;
      }
    }

    // minimum / maximum для чисел
    if (typeof target.minimum === "number") res.minimum = target.minimum;
    if (typeof target.maximum === "number") res.maximum = target.maximum;

    // minItems / maxItems для массивов
    if (typeof target.minItems === "number") res.minItems = target.minItems;
    if (typeof target.maxItems === "number") res.maxItems = target.maxItems;

    // items для массивов
    if (resolvedType === "array") {
      if (!target.items || typeof target.items !== "object") return null;
      const itemsCleaned = cleanNode(target.items);
      if (!itemsCleaned) return null;
      res.items = itemsCleaned;
    }

    // properties для объектов
    if (resolvedType === "object") {
      const props: Record<string, unknown> = {};
      if (target.properties && typeof target.properties === "object") {
        for (const [k, v] of Object.entries(target.properties as Record<string, unknown>)) {
          const propCleaned = cleanNode(v);
          if (!propCleaned) return null;
          props[k] = propCleaned;
        }
      }
      res.properties = props;

      if (Array.isArray(target.required)) {
        res.required = target.required.filter((k): k is string => typeof k === "string");
      }
    }

    return res;
  };

  const root = cleanNode(schema);
  if (!root || root.type !== "object") {
    return null;
  }
  if (!root.properties) {
    root.properties = {};
  }
  // Для двухшаговых ручек снимаем confirm и confirm_token из required ТОЛЬКО на корневом уровне (§14.10)
  if (isTwoStep && Array.isArray(root.required)) {
    root.required = (root.required as string[]).filter(
      (k) => k !== "confirm" && k !== "confirm_token",
    );
  }
  return root;
}

/**
 * Обратная совместимость для вызова mcpSchemaToGeminiParameters.
 */
export function mcpSchemaToGeminiParameters(schema?: Record<string, unknown>, isTwoStep = false): Record<string, unknown> {
  const res = toGeminiSchema(schema, isTwoStep);
  return res ?? { type: "object", properties: {} };
}

export const liveConnectorClients = new Set<McpClient>();

/**
 * Потоковый сборщик и фильтр stderr коннектора (§14.6, коммит b73fedb).
 */
export function createMcpStderrCollector(
  secretVals: string[],
  logLine: (line: string) => void,
  budget = 2000,
) {
  const maxSecretLen = secretVals.length > 0 ? Math.max(0, ...secretVals.map((s) => s.length)) : 0;
  const dec = new StringDecoder("utf8");
  let head = "";
  let lineLen = 0;
  let lineEndsWithCR = false;
  let remainingBudget = budget;
  let decoderEnded = false;

  const emitLine = (h: string, len: number, B: number): { out: string; C: number } => {
    if (len === 0) return { out: "", C: 0 };
    if (len <= B) {
      return { out: maskSecrets(h, secretVals), C: len };
    }
    let C = B;
    for (;;) {
      const prev = C;
      for (const [s, e] of getSecretOccurrences(h, secretVals)) {
        if (s < C && C < e) {
          C = s;
        }
      }
      if (C > 0 && !/\s/.test(h[C - 1])) {
        let k = C;
        while (k > 0 && !/\s/.test(h[k - 1])) {
          k--;
        }
        C = k;
      }
      if (C === prev) break;
    }
    const maskedPart = maskSecrets(h.slice(0, C), secretVals);
    return { out: maskedPart + `…[обрезано ${len - C}]`, C };
  };

  const flush = () => {
    if (lineLen === 0) return;
    if (remainingBudget > 0) {
      const r = emitLine(head, lineLen, remainingBudget);
      if (r.out) {
        logLine(r.out);
      }
      remainingBudget -= Math.max(r.C, Math.min(lineLen, remainingBudget));
    }
    head = "";
    lineLen = 0;
    lineEndsWithCR = false;
  };

  const feed = (t: string) => {
    for (const ch of t.split(/(\n)/)) {
      if (ch === "\n") {
        if (lineEndsWithCR) {
          lineLen--;
          if (head.endsWith("\r")) {
            head = head.slice(0, -1);
          }
          lineEndsWithCR = false;
        }
        flush();
        continue;
      }
      if (ch.length > 0) {
        lineEndsWithCR = ch.endsWith("\r");
      }
      if (remainingBudget <= 0) {
        lineLen += ch.length;
        continue;
      }
      const cap = remainingBudget + maxSecretLen;
      if (head.length < cap) {
        head += ch.slice(0, cap - head.length);
      }
      lineLen += ch.length;
    }
  };

  const onData = (d: Buffer | string) => {
    if (Buffer.isBuffer(d)) {
      feed(dec.write(d));
    } else {
      feed(d);
    }
  };

  const onEnd = () => {
    if (decoderEnded) return;
    decoderEnded = true;
    feed(dec.end());
    if (lineEndsWithCR) {
      lineLen--;
      if (head.endsWith("\r")) {
        head = head.slice(0, -1);
      }
      lineEndsWithCR = false;
    }
    flush();
  };

  return {
    onData,
    onEnd,
    getRemainingBudget: () => remainingBudget,
    getHeadLen: () => head.length,
  };
}

export interface McpClientOwner {
  type: "call" | "diagnostics";
  callId?: string;
  onStopFailed?: (id: string, pid: number) => void;
}

export class McpClient {
  private child: ChildProcess | null = null;
  private reqId = 0;
  private pending = new Map<number | string, { resolve: (val: unknown) => void; reject: (err: Error) => void }>();
  private closed = false;
  private alive = true;
  private sessionId: string | null = null;
  private stderrChars = 0;
  private abortController = new AbortController();
  private closePromise: Promise<void> | null = null;
  private closePending = false;
  private closeAttempted = false;
  private closeFailed = false;
  private lateDeletes = new Set<Promise<void>>();
  private started = false;
  private childExited = false;
  private lastPid: number | null = null;
  private inFlightHttpRequests = 0;

  constructor(
    public readonly config: ConnectorConfig,
    private secrets: Record<string, string> = {},
    private log?: { info(s: string): void; warn(s: string): void; error(s: string): void },
    private owner?: McpClientOwner,
  ) {
    liveConnectorClients.add(this);
  }

  getPid(): number | null {
    return this.child?.pid ?? this.lastPid;
  }

  isCloseAttempted(): boolean {
    return this.closeAttempted;
  }

  isCloseFailed(): boolean {
    return this.closeFailed;
  }

  /**
   * Запуск и опрос ручек коннектора: initialize → tools/list с таймаутом 10 с (§15.4 п. 1).
   */
  async start(timeoutMs = 10_000): Promise<McpTool[]> {
    this.started = true;
    // Проверка наличия и валидности всех требуемых секретов (§14.1, 266a726, §14.9)
    if (this.config.secrets && this.config.secrets.length > 0) {
      for (const s of this.config.secrets) {
        if (!this.secrets || typeof this.secrets[s] !== "string" || !(s in this.secrets)) {
          throw new Error(`connector_secret_missing: отсутствует секрет «${s}» для коннектора ${this.config.id}`);
        }
        const val = this.secrets[s];
        if (!isValidSecretValue(val)) {
          this.log?.warn?.(`connector_secret_invalid: недопустимый секрет «${s}» для коннектора ${this.config.id}`);
          throw new Error(`connector_secret_invalid: недопустимый секрет «${s}» для коннектора ${this.config.id}`);
        }
      }
    }

    if (this.config.transport === "stdio") {
      await this.startStdio();
    }

    const timer = new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`таймаут инициализации коннектора ${this.config.id} (${timeoutMs / 1000} с)`)),
        timeoutMs,
      );
      t.unref?.();
    });

    try {
      return await Promise.race([this.initAndListTools(), timer]);
    } catch (e) {
      await this.close();
      throw e;
    }
  }

  private async startStdio(): Promise<void> {
    const cmd = this.config.command;
    if (!cmd || cmd.length === 0) {
      throw new Error(`коннектор ${this.config.id}: не указана команда`);
    }

    // §14.1, §16.7 п. 1: env = {PATH, HOME, LANG} + только секреты из secrets своей записи.
    // Никакие ключи Gemini и прочее окружение плагина не передаются!
    const env: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "LANG"]) {
      if (process.env[k] !== undefined) {
        env[k] = process.env[k]!;
      }
    }
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
      detached: true,
    });
    this.child = child;
    this.lastPid = child.pid ?? null;
    this.alive = true;

    // Защита от EPIPE uncaughtException при внезапном закрытии процесса (§13 п. 3, review п. 8)
    child.stdin?.on("error", () => {});

    child.on("error", (err) => {
      this.alive = false;
      if (!child.pid) {
        this.childExited = true;
      }
      this.log?.warn?.(`MCP [${this.config.id}] child error: ${String(err)}`);
      this.rejectAll(new Error(`connector_unavailable: ${String(err)}`));
    });

    child.on("exit", () => {
      this.alive = false;
      this.childExited = true;
    });

    child.on("close", (code) => {
      this.alive = false;
      this.childExited = true;
      if (!this.closed) {
        this.log?.warn?.(`MCP [${this.config.id}] exited code=${code}`);
        this.rejectAll(new Error(`connector_unavailable: коннектор ${this.config.id} завершил работу с кодом ${code}`));
      }
    });

    // stderr коннектора — потоково (§14.6, коммит b73fedb, 266a726)
    const secretVals = Object.values(this.secrets).filter(isValidSecretValue);
    const collector = createMcpStderrCollector(
      secretVals,
      (line) => this.log?.warn?.(`MCP [${this.config.id}] stderr: ${line}`),
      2000,
    );

    child.stderr?.on("data", (d: Buffer) => {
      collector.onData(d);
    });

    child.stderr?.on("end", () => {
      collector.onEnd();
    });
    child.on("close", () => {
      collector.onEnd();
    });

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: { id?: number | string; result?: unknown; error?: { code?: number; message?: string } };
        try {
          msg = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            const errCode = msg.error.code === -32602 ? "invalid_argument" : "connector_error";
            const err = new Error(msg.error.message ?? "MCP error");
            (err as any).code = errCode;
            p.reject(err);
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
    if (this.closed || !this.alive) {
      const err = new Error(`коннектор ${this.config.id} недоступен`);
      (err as any).code = "connector_unavailable";
      throw err;
    }

    if (this.config.transport === "http") {
      return this.requestHttp(method, params, timeoutMs);
    }

    const id = ++this.reqId;
    const req = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          // §14.5: при таймауте уходит notifications/cancelled
          void this.notify("notifications/cancelled", { requestId: id }).catch(() => {});
          reject(new Error(`таймаут запроса ${method} (${timeoutMs} мс)`));
        }
      }, timeoutMs);
      timer.unref?.();

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
    if (this.closed || !this.alive) return;
    // Уведомления в JSON-RPC не содержат поля id (§14.1, review п. 5/18)
    const req = { jsonrpc: "2.0", method, params };
    if (this.config.transport === "stdio") {
      try {
        this.child?.stdin?.write(JSON.stringify(req) + "\n");
      } catch {
        // Игнорируем ошибки при отправке уведомлений
      }
    } else if (this.config.transport === "http") {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      if (this.sessionId) {
        headers["Mcp-Session-Id"] = this.sessionId;
      }
      if (this.config.secrets && this.config.secrets.length > 0) {
        const firstSecret = this.config.secrets[0];
        if (this.secrets[firstSecret]) {
          headers["Authorization"] = `Bearer ${this.secrets[firstSecret]}`;
        }
      }
      const signal = AbortSignal.any([
        this.abortController.signal,
        AbortSignal.timeout(5000),
      ]);
      this.inFlightHttpRequests++;
      void fetch(this.config.url!, {
        method: "POST",
        headers,
        body: JSON.stringify(req),
        signal,
      })
        .catch(() => {})
        .finally(() => {
          this.inFlightHttpRequests--;
        });
    }
  }

  /**
   * HTTP-транспорт Streamable HTTP (§14.1, review п. 5).
   * Accept: application/json, text/event-stream.
   * Mcp-Session-Id из initialize во всех последующих запросах.
   * Ответ SSE читается до сообщения с нужным id.
   * Секрет уходит как Authorization: Bearer <значение первого секрета>.
   */
  private async requestHttp(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.closed) throw new Error(`коннектор ${this.config.id} закрыт`);

    const url = this.config.url;
    if (!url) throw new Error(`коннектор ${this.config.id}: не указан url`);

    this.inFlightHttpRequests++;
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      if (this.sessionId) {
        headers["Mcp-Session-Id"] = this.sessionId;
      }
      if (this.config.secrets && this.config.secrets.length > 0) {
        const firstSecret = this.config.secrets[0];
        if (this.secrets[firstSecret]) {
          headers["Authorization"] = `Bearer ${this.secrets[firstSecret]}`;
        }
      }

      const id = ++this.reqId;
      const req = { jsonrpc: "2.0", id, method, params };

      const signal = AbortSignal.any([
        this.abortController.signal,
        AbortSignal.timeout(timeoutMs),
      ]);

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(req),
          signal,
        });
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (name === "TimeoutError" || name === "AbortError") throw new Error(`timeout: таймаут ${timeoutMs} мс`);
        // Сеть оборвалась посреди звонка: коннектор недоступен до конца звонка (§14.5, ревью PLUG-113)
        this.alive = false;
        throw new Error(`connector_unavailable: ${String((e as Error)?.message ?? e)}`);
      }

      if (!res.ok) {
        if (res.status >= 500) {
          this.alive = false;
          throw new Error(`connector_unavailable: HTTP ${res.status} ${res.statusText}`);
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const sid = res.headers.get("mcp-session-id");
      if (sid) {
        if (this.closed) {
          void this.sendDelete(sid);
        } else {
          this.sessionId = sid;
        }
      }

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        const text = await res.text();
        const lines = text.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data:")) {
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;
            try {
              const data = JSON.parse(jsonStr) as {
                id?: number | string;
                result?: unknown;
                error?: { code?: number; message?: string };
              };
              if (data && typeof data === "object" && data.id === id) {
                if (data.error) {
                  const errCode = data.error.code === -32602 ? "invalid_argument" : "connector_error";
                  const err = new Error(data.error.message || "MCP HTTP error");
                  (err as any).code = errCode;
                  throw err;
                }
                return data.result;
              }
            } catch (e) {
              if ((e as any)?.code) throw e;
            }
          }
        }
        throw new Error(`не найден ответ для запроса ${id} в SSE потоке`);
      }

      const data = (await res.json()) as { id?: number | string; result?: unknown; error?: { code?: number; message?: string } };
      if (data.error) {
        const errCode = data.error.code === -32602 ? "invalid_argument" : "connector_error";
        const err = new Error(data.error.message ?? "MCP HTTP error");
        (err as any).code = errCode;
        throw err;
      }
      return data.result;
    } finally {
      this.inFlightHttpRequests--;
    }
  }

  private async initAndListTools(): Promise<McpTool[]> {
    // Протокол 2025-06-18, clientInfo: bb-live-call (§14.2, review п. 16)
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bb-live-call", version: "1.0.0" },
    });

    await this.notify("notifications/initialized", {});

    // Постраничный опрос tools/list с курсором (§14.2, review п. 16)
    const tools: McpTool[] = [];
    let cursor: string | undefined = undefined;
    do {
      const params: Record<string, unknown> = cursor ? { cursor } : {};
      const listRes = (await this.request("tools/list", params)) as {
        tools?: McpTool[];
        nextCursor?: string;
      };
      if (Array.isArray(listRes?.tools)) {
        tools.push(...listRes.tools);
      }
      cursor = typeof listRes?.nextCursor === "string" && listRes.nextCursor ? listRes.nextCursor : undefined;
    } while (cursor);

    return tools;
  }

  /**
   * Вызов инструмента коннектора (§14.5, §15.4 п. 5, §16.7).
   * Таймаут 30 с; сжатие результата до maxResultChars; ok: false с кодом при ошибке.
   * Фильтрация секретов и обрезка сообщений об ошибках до 500 символов.
   */
  async callTool(tool: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<McpCallResult> {
    if (!this.alive || this.closed) {
      return {
        ok: false,
        error: {
          code: "connector_unavailable",
          message: `коннектор ${this.config.id} недоступен`,
        },
      };
    }

    const secretValues = Object.values(this.secrets).filter(isValidSecretValue);
    try {
      const res = (await this.request("tools/call", { name: tool, arguments: args }, timeoutMs)) as {
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: unknown;
        isError?: boolean;
      };

      const isError = Boolean(res?.isError);
      let text = "";
      if (res?.structuredContent !== undefined) {
        text = typeof res.structuredContent === "string" ? res.structuredContent : JSON.stringify(res.structuredContent);
      } else if (Array.isArray(res?.content)) {
        text = res.content
          .map((c) => {
            if (c.type === "text") return c.text ?? "";
            return `[${c.type || "unknown"}]`;
          })
          .join("\n")
          .trim();
      }
      if (!text && isError) text = "ошибка выполнения инструмента";

      // Маскировка секретов до обрезки (§14.6, §14.10)
      const maskedFull = maskSecrets(text, secretValues);

      // Сжатие до maxResultChars (по умолчанию 2000 символов, §15.2, §15.4 п. 5)
      const maxChars = this.config.maxResultChars ?? CONNECTOR_RESULT_MAX_CHARS_DEFAULT;
      let trimmed = maskedFull;
      if (trimmed.length > maxChars) {
        trimmed = trimmed.slice(0, maxChars - 1) + "…";
      }

      if (isError) {
        return {
          ok: false,
          error: {
            code: "connector_error",
            message: trimmed.slice(0, 500),
          },
          raw: res,
          maskedFullText: maskedFull,
        };
      }

      return {
        ok: true,
        data: { result: trimmed },
        raw: res,
        maskedFullText: maskedFull,
      };
    } catch (e) {
      const rawMsg = String((e as Error)?.message ?? e);
      const code = (e as any)?.code;
      const isTimeout = /таймаут/i.test(rawMsg) || /timeout/i.test(rawMsg);
      const maskedMsg = maskSecrets(rawMsg, secretValues).slice(0, 500);

      if (code === "invalid_argument" || /invalid_argument/i.test(rawMsg) || /-32602/.test(rawMsg)) {
        return {
          ok: false,
          error: {
            code: "invalid_argument",
            message: maskedMsg,
          },
        };
      }

      if (code === "connector_unavailable" || /connector_unavailable/i.test(rawMsg) || !this.alive) {
        return {
          ok: false,
          error: {
            code: "connector_unavailable",
            message: maskedMsg,
          },
        };
      }

      return {
        ok: false,
        error: {
          code: isTimeout ? "timeout" : "connector_error",
          message: maskedMsg,
        },
      };
    }
  }

  private sendDelete(sessionId: string): Promise<void> {
    if (!this.config.url) return Promise.resolve();
    const headers: Record<string, string> = {
      "Mcp-Session-Id": sessionId,
    };
    if (this.config.secrets && this.config.secrets.length > 0) {
      const firstSecret = this.config.secrets[0];
      if (this.secrets[firstSecret]) {
        headers["Authorization"] = `Bearer ${this.secrets[firstSecret]}`;
      }
    }
    let resolveLate!: () => void;
    const p = new Promise<void>((r) => {
      resolveLate = r;
    });
    this.lateDeletes.add(p);
    (async () => {
      try {
        await fetch(this.config.url!, {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        // ignore (§14.5: ошибка — игнор)
      } finally {
        this.lateDeletes.delete(p);
        if (this.isStopped()) {
          liveConnectorClients.delete(this);
        }
        resolveLate();
      }
    })();
    return p;
  }

  isStopped(): boolean {
    if (this.closePending) return false;
    if (this.inFlightHttpRequests > 0 || this.lateDeletes.size > 0 || this.sessionId !== null) return false;
    if (this.config.transport === "http") {
      if (!this.closed) return false;
      return true;
    }
    // stdio:
    // процесс не запускался (нет pid), или получен exit/close, или до exit kill(pid, 0) -> ESRCH (EPERM — жив)
    if (this.child) {
      if (!this.child.pid) return true;
      if (this.childExited || this.child.exitCode !== null || this.child.signalCode !== null) return true;
      try {
        process.kill(this.child.pid, 0);
        return false;
      } catch (e: any) {
        if (e?.code === "ESRCH") return true;
        return false;
      }
    }
    if (!this.closed && !this.started) return false;
    return true;
  }

  hasActiveClose(): boolean {
    return this.closePromise !== null;
  }

  private async terminateProcess(child: ChildProcess, options?: { immediateKill?: boolean; timeoutMs?: number }): Promise<void> {
    if (this.childExited || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    if (!child.pid) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      let termTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let hardTimer: NodeJS.Timeout | undefined;

      const done = () => {
        if (resolved) return;
        resolved = true;
        this.childExited = true;
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        if (hardTimer) clearTimeout(hardTimer);
        resolve();
      };

      const fail = (err: Error) => {
        if (resolved) return;
        resolved = true;
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        if (hardTimer) clearTimeout(hardTimer);
        reject(err);
      };

      const onExit = () => {
        this.childExited = true;
        done();
      };
      child.once("close", onExit);
      child.once("exit", onExit);

      try {
        child.stdin?.end();
      } catch {
        // ignore
      }

      const termDelay = Number(process.env.BB_LIVE_CALL_MCP_TERM_DELAY_MS) || 2000;
      const killDelay = termDelay + (Number(process.env.BB_LIVE_CALL_MCP_KILL_DELAY_MS) || 3000);

      const sendSignal = (signal: "SIGTERM" | "SIGKILL") => {
        if (this.childExited || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
        let delivered = false;
        try {
          process.kill(-child.pid, signal);
          delivered = true;
        } catch {
          // ESRCH from group kill does NOT confirm child exit!
        }
        if (!delivered) {
          try {
            if (child.kill(signal)) {
              delivered = true;
            }
          } catch {}
        }
        if (!delivered) {
          try {
            process.kill(child.pid, signal);
            delivered = true;
          } catch {
            // Check if actually dead by testing positive pid with signal 0:
            try {
              process.kill(child.pid, 0);
            } catch (e: any) {
              if (e?.code === "ESRCH") {
                done();
                return;
              }
            }
          }
        }
      };

      if (options?.immediateKill) {
        sendSignal("SIGKILL");
      } else {
        termTimer = setTimeout(() => {
          sendSignal("SIGTERM");
        }, termDelay);
        termTimer.unref?.();

        killTimer = setTimeout(() => {
          sendSignal("SIGKILL");
        }, killDelay);
        killTimer.unref?.();
      }

      const emergencyTimeout = options?.timeoutMs ?? (options?.immediateKill ? 1000 : killDelay + 1000);

      hardTimer = setTimeout(() => {
        if (this.childExited || child.exitCode !== null || child.signalCode !== null) {
          done();
          return;
        }
        if (child.pid) {
          try {
            process.kill(child.pid, 0);
            this.log?.warn?.(`MCP [${this.config.id}] connector_stop_failed: PID ${child.pid}`);
            this.owner?.onStopFailed?.(this.config.id, child.pid);
            fail(new Error(`connector_stop_failed: PID ${child.pid}`));
            return;
          } catch (e: any) {
            if (e?.code === "ESRCH") {
              done();
              return;
            }
            // EPERM or any other error means process is alive:
            this.log?.warn?.(`MCP [${this.config.id}] connector_stop_failed: PID ${child.pid}`);
            this.owner?.onStopFailed?.(this.config.id, child.pid);
            fail(new Error(`connector_stop_failed: PID ${child.pid}`));
            return;
          }
        }
        done();
      }, emergencyTimeout);
      hardTimer.unref?.();

      // Быстрая проверка: жив ли процесс (до exit)
      if (!this.childExited && child.pid) {
        try {
          process.kill(child.pid, 0);
        } catch (e: any) {
          if (e?.code === "ESRCH") {
            done();
          }
        }
      }
    });
  }

  /**
   * Корректная остановка коннектора (§14.5).
   * stdio: закрыть stdin, SIGTERM через 2 с, SIGKILL через 5 с; дожидается выхода процесса (§14.8, P1-1).
   * http: DELETE с Mcp-Session-Id; отмена активных запросов через abortController.
   * Повторные вызовы возвращают тот же Promise до полного завершения очистки (Round-2 P1-1, Round-5 A.3).
   */
  async close(options?: { immediateKill?: boolean; timeoutMs?: number }): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closeAttempted = true;
    if (this.isStopped()) {
      liveConnectorClients.delete(this);
      return;
    }
    this.closed = true;
    this.alive = false;
    this.abortController.abort();
    this.rejectAll(new Error(`коннектор ${this.config.id} закрыт`));

    this.closePending = true;
    this.closePromise = (async () => {
      try {
        if (this.config.transport === "http" && this.config.url) {
          while (this.sessionId) {
            const sid = this.sessionId;
            this.sessionId = null;
            await this.sendDelete(sid);
          }
          for (let i = 0; i < 10; i++) {
            if (this.sessionId || this.lateDeletes.size > 0) break;
            await Promise.resolve();
          }
          while (this.sessionId || this.lateDeletes.size > 0) {
            if (this.sessionId) {
              const sid = this.sessionId;
              this.sessionId = null;
              await this.sendDelete(sid);
            } else if (this.lateDeletes.size > 0) {
              await Promise.race(Array.from(this.lateDeletes));
            }
          }
        }

        if (this.child && this.child.pid) {
          const child = this.child;
          try {
            await this.terminateProcess(child, options);
            this.child = null;
          } catch (e) {
            this.closeFailed = true;
            this.closePromise = null;
            throw e;
          }
        }
      } catch (e) {
        this.closeFailed = true;
        this.closePromise = null;
        throw e;
      } finally {
        this.closePending = false;
        if (this.isStopped()) {
          liveConnectorClients.delete(this);
        }
      }
    })();

    return this.closePromise;
  }
}
