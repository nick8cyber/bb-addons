/**
 * Ядро external-compact (спека docs/specs/external-compact.md): экспорт истории
 * через `bb handoff export`, сжатие бесплатной gemini-3.6-flash в AI Studio и
 * продолжение новым тредом. Чистые функции тестируются напрямую; сайд-эффекты
 * уходят через внедряемые deps — серверные привязки живут в server.ts.
 *
 * Секреты: ключ Gemini уходит только в заголовок x-goog-api-key REST-запроса и
 * никогда не попадает в логи, ошибки и RPC-ответы.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  SUMMARIZER_MODEL,
  OFFER_POLL_MIN_INTERVAL_MS,
  isCompactionOffered,
  type ThreadUsageLike,
} from "./contract.js";

export {
  SUMMARIZER_MODEL,
  OFFER_POLL_MIN_INTERVAL_MS,
  isCompactionOffered,
  type ThreadUsageLike,
};

const execFileAsync = promisify(execFile);

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
/** Безопасная граница одного запроса (спека «Поток» п. 3). */
export const SAFE_SINGLE_PASS_TOKENS = 800_000;
/** В настройке — до двух ключей: основной и фолбэк на 429. */
export const GEMINI_MAX_KEYS = 2;
export const EXPORT_TIMEOUT_MS = 120_000;
export const SUMMARIZE_TIMEOUT_MS = 180_000;

export type CompactErrorCode =
  | "no_keys"
  | "thread_not_found"
  | "export_failed"
  | "too_large"
  | "rate_limited"
  | "gemini_rejected"
  | "invalid_response"
  | "spawn_failed"
  | "archive_failed"
  | "internal";

export class ExternalCompactError extends Error {
  readonly code: CompactErrorCode;
  constructor(code: CompactErrorCode, message: string) {
    super(message);
    this.name = "ExternalCompactError";
    this.code = code;
  }
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Разбор настройки geminiApiKey: 1–2 ключа, по одному на строку; пустые строки
 * и дубли отбрасываются, сверх двух — игнорируются.
 */
export function parseGeminiKeys(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const key = line.trim();
    if (key) seen.add(key);
  }
  return [...seen].slice(0, GEMINI_MAX_KEYS);
}

/**
 * Гейт по размеру (спека «Поток» п. 3): до SAFE_SINGLE_PASS_TOKENS — один
 * запрос; больше — чанкование по seq. Размер неизвестен — считаем проходимым,
 * фактический объём покажет экспорт.
 */
export type SizeGate = "single" | "chunked";
export function sizeGate(usedTokens: number | null | undefined): SizeGate {
  if (usedTokens == null || usedTokens <= SAFE_SINGLE_PASS_TOKENS) return "single";
  return "chunked";
}

/**
 * Иерархическое сжатие (спека «Поток» п. 3): верхние границы — сколько чанков
 * первого уровня и сколько раундов сведения допустимы. Сверх — явный отказ
 * too_large, не молчаливый обрыв.
 */
export const MAX_CHUNKS = 32;
export const MAX_REDUCE_DEPTH = 3;
/** Пессимистичный перевод токен-границы в символы: чанк больше не влезет в окно. */
export const HARD_SINGLE_PASS_CHARS = 4 * SAFE_SINGLE_PASS_TOKENS;

/**
 * Тело транскрипта в markdown-экспорте `bb handoff export` — часть после
 * заголовка `## Transcript`. Шапка (Captured, счётчики, Latest result) у
 * префиксных экспортов различается, поэтому сравнение идёт только по телу.
 */
export function transcriptBody(exportMd: string): string {
  const m = /^## Transcript\s*$/m.exec(exportMd);
  return m ? exportMd.slice(m.index + m[0].length) : exportMd;
}

export function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * Дельта-чанк: `bb handoff export --up-to-seq N` отдаёт только префикс истории,
 * поэтому чанк i — это транскрипт экспорта среза i без общего префикса со
 * срезом i-1. Рендер одних и тех же событий детерминирован, так что транскрипт
 * меньшего среза — литеральный префикс большего; если рендер нестабилен, общий
 * префикс просто короче и чанк получает лишнее перекрытие, а не пропуск.
 */
export function sliceChunkDelta(covered: string, current: string): string {
  return current.slice(commonPrefixLength(covered, current));
}

/**
 * Внутренние точки разреза для chunkCount чанков: до chunkCount-1 seq-границ,
 * равномерно по кандидатам; хвост до конца истории покрывает полный экспорт.
 * Кандидатов меньше, чем нужно точек — берём все (гранулярность сообщений —
 * минимальная из доступных, дальше дробить нечем).
 */
export function pickChunkCuts(
  candidateSeqs: readonly number[],
  chunkCount: number,
): number[] {
  const seqs = [...new Set(candidateSeqs)].sort((a, b) => a - b);
  const wanted = chunkCount - 1;
  if (wanted <= 0 || seqs.length === 0) return [];
  if (seqs.length <= wanted) return seqs;
  const cuts: number[] = [];
  for (let i = 1; i <= wanted; i++) {
    cuts.push(seqs[Math.ceil((i * seqs.length) / chunkCount) - 1]);
  }
  return [...new Set(cuts)];
}

/**
 * Разрезание текста на части не длиннее maxChars: по границам абзацев, при
 * отсутствии подходящей — жёстко по длине (для уровней сведения > 0, где
 * seq-границ уже нет).
 */
export function splitTextBySize(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n\n", maxChars);
    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/** Промпт сведения частичных summary в итоговое (спека «Поток» п. 3). */
export function buildMergePrompt(): string {
  return [
    "Сведи частичные summary одной сессии агента в единое summary для продолжения работы.",
    "Сохрани цели и прямые инструкции владельца, принятые решения, состояние",
    "репозитория, открытые задачи и блокеры. Убери дубли между частями.",
    "Компактный структурированный markdown на языке исходной сессии.",
  ].join("\n");
}

/** Обёртка чанка контекстом «часть i из k» для суммаризатора. */
export function chunkSummaryInput(chunk: string, index: number, total: number): string {
  return [
    `Это часть ${index + 1} из ${total} сериализованной истории одной сессии.`,
    "Сожми её так, чтобы по всем частям можно было собрать общее summary.",
    "",
    chunk,
  ].join("\n");
}

/** Зависимости иерархического сжатия — серверные привязки в server.ts. */
export interface HierarchicalSummarizeDeps {
  /** Seq-границы сообщений треда (кандидаты для --up-to-seq), по возрастанию. */
  listCutSeqs(threadId: string): Promise<number[]>;
  /** Экспорт истории: без upToSeq — целиком, с ним — префикс до seq. */
  exportPart(threadId: string, upToSeq?: number): Promise<string>;
  summarize(history: string, keys: readonly string[]): Promise<string>;
  log: { info(msg: string): void; warn(msg: string): void };
}

async function reduceSummaries(
  deps: HierarchicalSummarizeDeps,
  summaries: readonly string[],
  keys: readonly string[],
  depth: number,
): Promise<string> {
  if (depth >= MAX_REDUCE_DEPTH) {
    throw new ExternalCompactError(
      "too_large",
      `частичные summary не сходятся за ${MAX_REDUCE_DEPTH} раундов сведения`,
    );
  }
  const merged = summaries.map((s, i) => `## Часть ${i + 1}\n\n${s}`).join("\n\n");
  if (merged.length <= SAFE_SINGLE_PASS_TOKENS) {
    return deps.summarize(`${buildMergePrompt()}\n\n---\n\n${merged}`, keys);
  }
  if (merged.length > HARD_SINGLE_PASS_CHARS && depth + 1 >= MAX_REDUCE_DEPTH) {
    throw new ExternalCompactError(
      "too_large",
      `сводный текст ${merged.length} символов превышает окно модели`,
    );
  }
  const next: string[] = [];
  for (const part of splitTextBySize(merged, SAFE_SINGLE_PASS_TOKENS)) {
    next.push(await deps.summarize(`${buildMergePrompt()}\n\n---\n\n${part}`, keys));
  }
  return reduceSummaries(deps, next, keys, depth + 1);
}

/**
 * Иерархическое сжатие истории треда (спека «Поток» п. 3): нарезка по
 * `--up-to-seq`, экспорт каждого среза, summary чанков через gemini-3.6-flash,
 * затем сводный summary (с повторными раундами, если сводка сама не влезает).
 * Совсем не влезает — явный отказ too_large.
 */
export async function summarizeHistoryHierarchical(
  deps: HierarchicalSummarizeDeps,
  threadId: string,
  estimatedTokens: number,
  keys: readonly string[],
): Promise<string> {
  const chunkCount = Math.ceil(estimatedTokens / SAFE_SINGLE_PASS_TOKENS);
  if (chunkCount > MAX_CHUNKS) {
    throw new ExternalCompactError(
      "too_large",
      `оценка ${estimatedTokens} токенов требует ${chunkCount} чанков (> ${MAX_CHUNKS}): история слишком велика`,
    );
  }
  const cuts = pickChunkCuts(await deps.listCutSeqs(threadId), chunkCount);
  const docs: string[] = [];
  for (const seq of cuts) docs.push(await deps.exportPart(threadId, seq));
  docs.push(await deps.exportPart(threadId));
  const chunks: string[] = [];
  let covered = "";
  for (const doc of docs) {
    const transcript = transcriptBody(doc);
    const delta = sliceChunkDelta(covered, transcript).trim();
    if (delta.length > 0) chunks.push(delta);
    covered = transcript;
  }
  if (chunks.length === 0) {
    throw new ExternalCompactError(
      "invalid_response",
      "экспорт истории по срезам дал пустой результат",
    );
  }
  const oversized = chunks.find((c) => c.length > HARD_SINGLE_PASS_CHARS);
  if (oversized !== undefined) {
    throw new ExternalCompactError(
      "too_large",
      `чанк ${oversized.length} символов крупнее окна модели: дальше по seq не дробится`,
    );
  }
  deps.log.info(
    `external-compact: ${threadId}: ${chunks.length} чанков (${cuts.length} срезов + хвост)`,
  );
  const partSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    partSummaries.push(
      await deps.summarize(chunkSummaryInput(chunks[i], i, chunks.length), keys),
    );
  }
  return reduceSummaries(deps, partSummaries, keys, 0);
}

/** Промпт суммаризатору (спека «Поток» п. 4). */
export function buildSummaryPrompt(): string {
  return [
    "Сожми сериализованную историю сессии агента для продолжения работы в новом треде.",
    "Обязательно сохрани:",
    "- цели и задачу владельца, прямые инструкции и запреты владельца;",
    "- принятые решения и их причины;",
    "- состояние репозитория: ветки, изменённые файлы, коммиты, незакоммиченное;",
    "- открытые задачи, блокеры и следующие шаги;",
    "- ключевые ошибки и как их исправили.",
    "Пиши компактно, структурированным markdown на языке исходной сессии.",
    "Не добавляй оценок, советов и информации, которой нет в истории.",
  ].join("\n");
}

/** Первое сообщение нового треда (спека «Поток» п. 5). */
export function buildContinuationMessage(summary: string, sourceThreadId: string): string {
  return [
    `Продолжение сжатого треда @thread:${sourceThreadId}.`,
    "",
    "Ниже — summary предыдущего контекста (сжато внешним компактором на Gemini,",
    "исходный тред сохранён целиком — обращайся к нему за деталями).",
    "",
    summary,
  ].join("\n");
}

/**
 * Ответы AI Studio по таблице шлюзов (спека «Проверка и выпуск»): 429 — квота,
 * идём на следующий ключ; 403 — ключ без доступа, пробуем следующий; 404 —
 * модель снята, 400 — схема не поддержана: не повторять. 5xx — временное,
 * следующий ключ может ответить.
 */
export interface GeminiHttpErrorInfo {
  code: CompactErrorCode;
  /** Пробовать ли следующий ключ из пула. */
  tryNextKey: boolean;
}
export function mapGeminiHttpError(status: number): GeminiHttpErrorInfo {
  if (status === 429 || status === 403) return { code: "rate_limited", tryNextKey: true };
  if (status >= 500) return { code: "rate_limited", tryNextKey: true };
  return { code: "gemini_rejected", tryNextKey: false };
}

interface GeminiGenerateResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

function extractSummaryText(data: GeminiGenerateResponse): string | null {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("").trim();
  return text === "" ? null : text;
}

export interface SummarizeOptions {
  signal?: AbortSignal;
  /** Подмена fetch в тестах. */
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

/**
 * Один REST-запрос `generateContent` на gemini-3.6-flash (спека «Модель и
 * доступ», открытый вопрос: точное имя метода сверить при реализации — оставлен
 * стандартный `:generateContent`). Ключ — только в заголовке. На 429/403/5xx
 * переходим к следующему ключу.
 */
export async function summarizeWithGemini(
  history: string,
  keys: readonly string[],
  opts: SummarizeOptions = {},
): Promise<string> {
  if (keys.length === 0) {
    throw new ExternalCompactError("no_keys", "geminiApiKey не настроен");
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? GEMINI_API_BASE;
  const prompt = buildSummaryPrompt();
  let lastError: ExternalCompactError | null = null;
  for (const key of keys) {
    let res: Response;
    try {
      res = await doFetch(`${apiBase}/models/${SUMMARIZER_MODEL}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `${prompt}\n\n---\n\n${history}` }] }],
          generationConfig: { temperature: 0.2 },
        }),
        signal: opts.signal ?? AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS),
      });
    } catch (e) {
      // Сетевой сбой/таймаут — следующий ключ может ответить.
      lastError = new ExternalCompactError("rate_limited", `Gemini request failed: ${errMessage(e)}`);
      continue;
    }
    if (res.ok) {
      let data: GeminiGenerateResponse;
      try {
        data = (await res.json()) as GeminiGenerateResponse;
      } catch {
        throw new ExternalCompactError("invalid_response", "Gemini вернул не-JSON ответ");
      }
      const text = extractSummaryText(data);
      if (text === null) {
        throw new ExternalCompactError("invalid_response", "Gemini вернул ответ без текста");
      }
      return text;
    }
    const info = mapGeminiHttpError(res.status);
    const body = await res.text().catch(() => "");
    lastError = new ExternalCompactError(
      info.code,
      `Gemini HTTP ${res.status}: ${body.slice(0, 300)}`,
    );
    if (!info.tryNextKey) throw lastError;
  }
  throw lastError ?? new ExternalCompactError("no_keys", "нет ключей Gemini");
}

export interface ExportOptions {
  signal?: AbortSignal;
  /** Бинарь bb; по умолчанию $BB_CLI или `bb` из PATH. */
  bbBin?: string;
  /** Каталог для экспорта; по умолчанию — новый tmpdir. */
  outDir?: string;
  /** Граница истории для чанкования (спека «Поток» п. 3). */
  upToSeq?: number;
}

/**
 * Экспорт истории треда штатным `bb handoff export` (спека «Поток» п. 2):
 * markdown-файл во временном каталоге, дальше читается целиком.
 */
export async function exportThreadHistory(
  threadId: string,
  opts: ExportOptions = {},
): Promise<string> {
  const bbBin = opts.bbBin ?? process.env.BB_CLI ?? "bb";
  const dir = opts.outDir ?? (await mkdtemp(join(tmpdir(), "external-compact-")));
  const out = join(dir, "handoff.md");
  const args = ["handoff", "export", threadId, "--out", out];
  if (opts.upToSeq != null) args.push("--up-to-seq", String(opts.upToSeq));
  try {
    await execFileAsync(bbBin, args, {
      timeout: EXPORT_TIMEOUT_MS,
      signal: opts.signal,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    throw new ExternalCompactError("export_failed", `bb handoff export: ${errMessage(e)}`);
  }
  try {
    return await readFile(out, "utf8");
  } catch (e) {
    throw new ExternalCompactError("export_failed", `cannot read ${out}: ${errMessage(e)}`);
  }
}

/** Пара нового треда-продолжения (спека «Поток» п. 5). */
export interface ContinuationTarget {
  projectId: string | null;
  environmentId: string | null;
  providerId: string | null;
  model: string | null;
  title: string | null;
}

export const COMPACT_TITLE_PREFIX = "[compact] ";

export interface CompactThreadDeps {
  getKeys(): Promise<string[]>;
  getAutoArchive(): Promise<boolean>;
  getThread(threadId: string): Promise<ContinuationTarget | null>;
  getUsage(threadId: string): Promise<ThreadUsageLike | null>;
  /** Экспорт истории: без upToSeq — целиком, с ним — префикс до seq. */
  exportHistory(threadId: string, upToSeq?: number): Promise<string>;
  /** Seq-границы сообщений треда для чанкования (спека «Поток» п. 3). */
  listCutSeqs(threadId: string): Promise<number[]>;
  summarize(history: string, keys: readonly string[]): Promise<string>;
  spawnContinuation(target: ContinuationTarget, prompt: string): Promise<string>;
  archiveSource(threadId: string): Promise<void>;
  log: { info(msg: string): void; warn(msg: string): void };
}

export interface CompactThreadResult {
  ok: boolean;
  newThreadId?: string;
  error?: string;
}

/**
 * Оркестрация (спека «Поток» п. 2–5): ключи → тред → гейт → экспорт → summary →
 * новый тред → опциональная архивация исходного. Архивация не валит результат:
 * продолжение уже создано. Сверх безопасной границы — иерархическое сжатие
 * по seq-срезам; совсем не влезает — явный отказ с причиной.
 */
export async function compactThread(
  deps: CompactThreadDeps,
  input: { threadId: string },
): Promise<CompactThreadResult> {
  try {
    const keys = await deps.getKeys();
    if (keys.length === 0) {
      throw new ExternalCompactError(
        "no_keys",
        "Настройка geminiApiKey пуста — задайте 1–2 ключа AI Studio в настройках плагина",
      );
    }
    const thread = await deps.getThread(input.threadId);
    if (thread === null) {
      throw new ExternalCompactError("thread_not_found", `тред ${input.threadId} не найден`);
    }
    const usage = await deps.getUsage(input.threadId);
    const summary =
      sizeGate(usage?.usedTokens) === "chunked"
        ? await summarizeHistoryHierarchical(
            {
              listCutSeqs: deps.listCutSeqs,
              exportPart: deps.exportHistory,
              summarize: deps.summarize,
              log: deps.log,
            },
            input.threadId,
            usage?.usedTokens ?? SAFE_SINGLE_PASS_TOKENS + 1,
            keys,
          )
        : await deps.summarize(await deps.exportHistory(input.threadId), keys);
    const prompt = buildContinuationMessage(summary, input.threadId);
    const newThreadId = await deps.spawnContinuation(
      { ...thread, title: `${COMPACT_TITLE_PREFIX}${thread.title ?? input.threadId}` },
      prompt,
    );
    if (await deps.getAutoArchive()) {
      try {
        await deps.archiveSource(input.threadId);
      } catch (e) {
        deps.log.warn(`external-compact: archive ${input.threadId} failed: ${errMessage(e)}`);
      }
    }
    deps.log.info(`external-compact: ${input.threadId} → ${newThreadId}`);
    return { ok: true, newThreadId };
  } catch (e) {
    const err =
      e instanceof ExternalCompactError
        ? e
        : new ExternalCompactError("internal", errMessage(e));
    deps.log.warn(`external-compact: ${input.threadId} failed: ${err.code}: ${err.message}`);
    return { ok: false, error: `${err.code}: ${err.message}` };
  }
}
