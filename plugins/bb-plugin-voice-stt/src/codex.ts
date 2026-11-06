/**
 * Codex — точный порт протокола встроенного provider-codex bb 0.48.1
 * (`host.js`, спека §7). Cookie-jar + повтор Cloudflare-challenge из бандла
 * осознанно НЕ портируется (документированное упрощение спеки §7.2).
 *
 * `~/.codex/auth.json` читается только на хосте; значения наружу не уходят.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  AiServiceFailure,
  ERROR_BODY_MAX_CHARS,
  RESPONSE_MAX_BYTES,
  type CodexAuthState,
  type FailureCode,
} from "./contract.js";

const CHATGPT_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const AUTH_JWT_CLAIMS = "https://api.openai.com/auth";
const PROFILE_JWT_CLAIMS = "https://api.openai.com/profile";
export const CODEX_TRANSCRIBE_MODEL = "gpt-transcribe";

// --- auth.json (порт classifyAuthJson / readCodexAuthFile / readCodexAuthCredentials) ---

export function resolveCodexHome(homeDir: string, env: NodeJS.ProcessEnv): string {
  return resolve(env.CODEX_HOME?.trim() || join(homeDir, ".codex"));
}

export function codexAuthPath(homeDir: string, env: NodeJS.ProcessEnv): string {
  return join(resolveCodexHome(homeDir, env), "auth.json");
}

export type CodexCredentials =
  | { type: "apiKey"; apiKey: string }
  | {
      type: "chatgpt";
      accessToken: string;
      accountId: string;
      accountEmail: string | null;
      expired: boolean;
      isFedrampAccount: boolean;
    };

export type CodexAuthFileState =
  | { state: "ok"; credentials: CodexCredentials; authPath: string }
  | { state: "missing"; authPath: string }
  | { state: "unreadable"; authPath: string }
  | { state: "malformed"; authPath: string }
  | { state: "unusable"; reason: "not_object" | "api_key" | "access_token" | "account_id"; authPath: string };

type ClassifiedAuth =
  | { state: "ok"; credentials: CodexCredentials }
  | { state: "unusable"; reason: "not_object" | "api_key" | "access_token" | "account_id" };

function asJsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return asJsonObject(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

/** Claims-объект токена; принимает и JWT-строку, и уже-объект claims (порт бандла). */
function chatGptClaims(token: unknown): Record<string, unknown> | null {
  const payload =
    typeof token === "string" ? decodeJwtPayload(token) : asJsonObject(token);
  return asJsonObject(payload?.[AUTH_JWT_CLAIMS]);
}

function accountEmail(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const profile = asJsonObject(payload?.[PROFILE_JWT_CLAIMS]);
  return nonEmptyString(payload?.["email"]) ?? nonEmptyString(profile?.["email"]);
}

function tokenExpired(token: string): boolean {
  const exp = decodeJwtPayload(token)?.["exp"];
  return typeof exp === "number" && Date.now() >= exp * 1_000;
}

/** Порт `classifyAuthJson` бандла — чистая функция над распарсенным auth.json. */
export function classifyAuthJson(value: unknown): ClassifiedAuth {
  const json = asJsonObject(value);
  if (json === null) return { state: "unusable", reason: "not_object" };
  const authMode = nonEmptyString(json["auth_mode"]);
  const openAiKey = nonEmptyString(json["OPENAI_API_KEY"]);
  if (authMode === "apikey" || authMode === "apiKey" || (authMode === null && openAiKey !== null)) {
    return openAiKey === null
      ? { state: "unusable", reason: "api_key" }
      : { state: "ok", credentials: { type: "apiKey", apiKey: openAiKey } };
  }
  const tokens = asJsonObject(json["tokens"]);
  const accessToken = nonEmptyString(tokens?.["access_token"]);
  if (tokens === null || accessToken === null) {
    return { state: "unusable", reason: "access_token" };
  }
  const accessClaims = chatGptClaims(accessToken);
  const idToken = nonEmptyString(tokens?.["id_token"]);
  // Бандл: строка-JWT → claims под `https://api.openai.com/auth`; объект —
  // уже сами claims, используется напрямую.
  const idClaims = idToken === null ? asJsonObject(tokens?.["id_token"]) : chatGptClaims(idToken);
  const accountId =
    nonEmptyString(tokens?.["account_id"]) ??
    nonEmptyString(accessClaims?.["chatgpt_account_id"]) ??
    nonEmptyString(idClaims?.["chatgpt_account_id"]);
  if (accountId === null) return { state: "unusable", reason: "account_id" };
  return {
    state: "ok",
    credentials: {
      type: "chatgpt",
      accessToken,
      accountId,
      accountEmail: accountEmail(accessToken) ?? (idToken === null ? null : accountEmail(idToken)),
      expired: tokenExpired(accessToken),
      isFedrampAccount:
        accessClaims?.["chatgpt_account_is_fedramp"] === true ||
        idClaims?.["chatgpt_account_is_fedramp"] === true,
    },
  };
}

/** Читает и классифицирует `~/.codex/auth.json` (CODEX_HOME honoured). */
export async function readCodexAuthFile(options?: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CodexAuthFileState> {
  const authPath = codexAuthPath(options?.homeDir ?? homedir(), options?.env ?? process.env);
  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? (e as NodeJS.ErrnoException).code : null;
    return code === "ENOENT" ? { state: "missing", authPath } : { state: "unreadable", authPath };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "malformed", authPath };
  }
  return { ...classifyAuthJson(parsed), authPath };
}

const UNUSABLE_MESSAGES: Record<
  "not_object" | "api_key" | "access_token" | "account_id",
  (authPath: string) => string
> = {
  not_object: (p) => `Codex auth file at ${p} is not valid JSON. Run codex login on this host.`,
  api_key: (p) =>
    `Codex auth file at ${p} does not contain a usable API key. Run codex login on this host.`,
  access_token: (p) =>
    `Codex auth file at ${p} does not contain a usable access token. Run codex login on this host.`,
  account_id: () =>
    `Codex auth tokens do not include a ChatGPT account id. Run codex login on this host.`,
};

/** Порт `readCodexAuthCredentials` — бросает AiServiceFailure(auth_required). */
export async function readCodexAuthCredentials(options?: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CodexCredentials> {
  const file = await readCodexAuthFile(options);
  switch (file.state) {
    case "ok":
      return file.credentials;
    case "missing":
    case "unreadable":
      throw new AiServiceFailure(
        "auth_required",
        "codex_auth_missing",
        `Codex auth file not found at ${file.authPath}. Run codex login on this host.`,
      );
    case "malformed":
      throw new AiServiceFailure(
        "auth_required",
        "codex_auth_invalid",
        UNUSABLE_MESSAGES.not_object(file.authPath),
      );
    case "unusable":
      throw new AiServiceFailure(
        "auth_required",
        "codex_auth_invalid",
        UNUSABLE_MESSAGES[file.reason](file.authPath),
      );
  }
}

/** Маппинг состояния auth.json в `voice-stt.status.codexAuth` (спека §7.1). */
export function mapCodexAuthState(file: CodexAuthFileState): CodexAuthState {
  switch (file.state) {
    case "ok":
      return file.credentials.type === "chatgpt" && file.credentials.expired ? "expired" : "ok";
    case "missing":
    case "unreadable":
      return "missing";
    case "malformed":
      return "invalid";
    case "unusable":
      return "unusable";
  }
}

// --- HTTP (порт транспорта provider-codex, без cookie-jar retry) ---

function createChatGptHeaders(auth: Extract<CodexCredentials, { type: "chatgpt" }>): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${auth.accessToken}`);
  headers.set("chatgpt-account-id", auth.accountId);
  headers.set("originator", "bb");
  headers.set("User-Agent", "bb-host-daemon");
  if (auth.isFedrampAccount) headers.set("X-OpenAI-Fedramp", "true");
  return headers;
}

function createOpenAiHeaders(auth: Extract<CodexCredentials, { type: "apiKey" }>): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${auth.apiKey}`);
  headers.set("User-Agent", "bb-host-daemon");
  return headers;
}

interface RequestDeadline {
  expiresAt: number;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}

function createRequestDeadline(timeoutMs: number, signal: AbortSignal | undefined): RequestDeadline {
  return { expiresAt: Date.now() + timeoutMs, timeoutMs, signal };
}

function codexRequestCancelledError(): AiServiceFailure {
  return new AiServiceFailure("request_failed", "codex_request_cancelled", "Codex request was cancelled");
}

function codexRequestTimeoutError(timeoutMs: number): AiServiceFailure {
  return new AiServiceFailure(
    "timeout",
    "codex_request_timeout",
    `Codex request timed out after ${timeoutMs}ms`,
  );
}

function remainingTimeoutMs(deadline: RequestDeadline): number {
  if (deadline.signal?.aborted) throw codexRequestCancelledError();
  const remaining = Math.ceil(deadline.expiresAt - Date.now());
  if (remaining <= 0) throw codexRequestTimeoutError(deadline.timeoutMs);
  return remaining;
}

/** Порт `runWithTimeout` бандла: внешний abort → cancelled, таймер → timeout. */
async function runWithTimeout<T>(options: {
  deadline: RequestDeadline;
  work: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const inner = new AbortController();
  const timer = setTimeout(() => inner.abort(), remainingTimeoutMs(options.deadline));
  const onOuterAbort = () => inner.abort();
  options.deadline.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    return await options.work(inner.signal);
  } catch (e) {
    if (options.deadline.signal?.aborted) throw codexRequestCancelledError();
    if (inner.signal.aborted) throw codexRequestTimeoutError(options.deadline.timeoutMs);
    throw e;
  } finally {
    clearTimeout(timer);
    options.deadline.signal?.removeEventListener("abort", onOuterAbort);
  }
}

function isCloudflareChallenge(response: Response): boolean {
  return (
    (response.status === 403 &&
      response.headers.get("cf-mitigated")?.toLowerCase() === "challenge") ||
    (response.headers.get("content-type")?.toLowerCase().startsWith("text/html") ?? false)
  );
}

function isHtmlResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().startsWith("text/html") ?? false;
}

function httpErrorCode(status: number): [FailureCode, string] {
  if (status === 401) return ["auth_required", "codex_auth_failed"];
  if (status === 429) return ["rate_limited", "codex_rate_limited"];
  if (status >= 500) return ["service_unavailable", "codex_service_unavailable"];
  return ["request_failed", "codex_request_failed"];
}

function extractProviderErrorMessage(body: string): string | null {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(collapsed);
    const find = (v: unknown): string | null => {
      if (typeof v === "string") {
        const s = v.replace(/\s+/g, " ").trim();
        return s.length > 0 ? s : null;
      }
      if (Array.isArray(v)) {
        for (const item of v) {
          const found = find(item);
          if (found !== null) return found;
        }
        return null;
      }
      const obj = asJsonObject(v);
      if (obj === null) return null;
      for (const key of ["message", "detail", "error"]) {
        if (obj[key] === undefined) continue;
        const found = find(obj[key]);
        if (found !== null) return found;
      }
      return null;
    };
    return find(parsed) ?? collapsed;
  } catch {
    return collapsed;
  }
}

async function readResponseText(
  response: Response,
  deadline: RequestDeadline,
  maxBytes: number,
): Promise<string> {
  const text = await runWithTimeout({
    deadline,
    work: async () => {
      const buf = await response.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.byteLength > maxBytes) {
        throw new AiServiceFailure(
          "invalid_response",
          "codex_response_too_large",
          "Codex response exceeded the maximum supported size.",
        );
      }
      return new TextDecoder().decode(bytes);
    },
  });
  return text;
}

async function readErrorText(response: Response, deadline: RequestDeadline): Promise<string> {
  try {
    const text = await readResponseText(response, deadline, 4 * 1024);
    return text.length > ERROR_BODY_MAX_CHARS ? `${text.slice(0, ERROR_BODY_MAX_CHARS)}...` : text;
  } catch {
    return "";
  }
}

async function createHttpError(response: Response, deadline: RequestDeadline): Promise<AiServiceFailure> {
  const prefix = `Codex transcription request failed with HTTP ${response.status}`;
  if (isCloudflareChallenge(response)) {
    return new AiServiceFailure(
      "service_unavailable",
      "codex_service_unavailable",
      `${prefix}: chatgpt.com answered with a Cloudflare challenge that bb cannot solve. Retry, or choose another service in Settings → AI services.`,
    );
  }
  const detail = isHtmlResponse(response) ? null : extractProviderErrorMessage(await readErrorText(response, deadline));
  return new AiServiceFailure(...httpErrorCode(response.status), `${prefix}${detail ? `: ${detail}` : ""}`);
}

function buildTranscriptionFormData(options: {
  audio: Buffer;
  mimeType: string;
  filename: string;
  model: string;
  hint: string | null;
}): FormData {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(options.audio)], { type: options.mimeType }), options.filename);
  form.set("model", options.model);
  if (options.hint !== null) form.set("prompt", options.hint);
  return form;
}

function parseTranscriptionResponse(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AiServiceFailure(
      "invalid_response",
      "codex_response_invalid",
      "Codex transcription response was not valid JSON.",
    );
  }
  const text = asJsonObject(parsed)?.["text"];
  if (typeof text !== "string") {
    throw new AiServiceFailure(
      "invalid_response",
      "codex_response_invalid",
      "Codex transcription response did not include transcript text.",
    );
  }
  return text;
}

export interface TranscribeCodexOptions {
  audio: Buffer;
  mimeType: string;
  filename: string;
  hint: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Точки внедрения для тестов. */
  fetchImpl?: typeof fetch;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** Порт `transcribeCodexVoice` бандла (без cookie-jar retry — §7.2). */
export async function transcribeCodex(options: TranscribeCodexOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = createRequestDeadline(options.timeoutMs, options.signal);
  const credentials = await readCodexAuthCredentials({ homeDir: options.homeDir, env: options.env });
  const form = buildTranscriptionFormData({
    audio: options.audio,
    mimeType: options.mimeType,
    filename: options.filename,
    model: CODEX_TRANSCRIBE_MODEL,
    hint: options.hint,
  });
  const url = credentials.type === "chatgpt" ? CHATGPT_TRANSCRIBE_URL : OPENAI_TRANSCRIBE_URL;
  const headers =
    credentials.type === "chatgpt" ? createChatGptHeaders(credentials) : createOpenAiHeaders(credentials);
  const response = await runWithTimeout({
    deadline,
    work: (signal) => fetchImpl(url, { method: "POST", headers, body: form, signal }),
  });
  if (!response.ok) throw await createHttpError(response, deadline);
  const body = await readResponseText(response, deadline, RESPONSE_MAX_BYTES);
  return parseTranscriptionResponse(body);
}
