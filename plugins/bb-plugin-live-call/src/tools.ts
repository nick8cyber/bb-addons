/**
 * ToolRegistry: объявления функций и исполнители поверх bb.sdk (контракт §4).
 * Класс подтверждения: R — сразу, C/P/L — через ConfirmationGate (спека §5).
 * Запуск агентов — класс L: только «запускай».
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BrainCenter } from "./brain-center.js";
import { TOOL_RESULT_MAX_CHARS, TOOL_TIMEOUT_MS, type Json, type ToolClass, type ToolResult } from "./contract.js";
import { argsHash, type ConfirmationGate } from "./confirmation-gate.js";
import type { ContextLedger } from "./context-ledger.js";
import { fetchThreadMessages, formatMessageTime, type ThreadMessage } from "./thread-messages.js";

export interface ThreadBrief {
  id: string;
  title: string;
  project: string;
  status: string;
  updatedAt: number;
}

export interface ToolContext {
  sdk: BbPluginApi["sdk"];
  gate: ConfirmationGate;
  ledger: ContextLedger;
  /** Карточка действия в оверлей и транскрипт звонка. */
  reportAction: (tool: string, cls: ToolClass, status: "running" | "done" | "failed" | "cancelled", summary: string, threadId?: string, actionId?: string) => void;
  /** Один id на всё действие: «идёт» и «готово» обновляют одну карточку. */
  newActionId?: (tool: string) => string;
  callsProjectId: () => string | null;
  /** Своя память голосового агента (хранилище плагина), не общая память BB. */
  voiceMemory?: { add(text: string): { id: number; duplicate: boolean }; list(): Array<{ id: number; text: string }> };
  /** Аргументы ожидающего подтверждения — сервер хранит их сам, модель не подменит. */
  rememberArgs?: (argsHash: string, args: Record<string, unknown>) => void;
  /** id целевого треда для звонка по треду (§12). */
  targetThreadId?: string;
  /** Кэшированные сообщения треда для звонка по треду. */
  threadMessages?: ThreadMessage[];
  /** Таймаут проверки доставки (мс), по умолчанию 5000. */
  deliveryTimeoutMs?: number;
  deliveryIntervalMs?: number;
  /** Мозговой центр звонка по треду (§12.11). */
  brain?: BrainCenter;
  isTargetThreadActive?: () => Promise<boolean>;
}

export interface ToolDef {
  name: string;
  cls: ToolClass;
  /** Сколько аудио-слов просить у владельца; для say-фразы (спека §5). */
  word: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Готовая фраза-вопрос для подтверждения; {args} подставляются. */
  confirmSay?: (args: Record<string, unknown>) => string;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export function truncate(value: unknown): ToolResult {
  const text = JSON.stringify(value ?? null);
  if (text.length <= TOOL_RESULT_MAX_CHARS) return { ok: true, data: value as Json, truncated: false };
  return {
    ok: true,
    data: { truncatedText: `${text.slice(0, TOOL_RESULT_MAX_CHARS)}…` } as unknown as Json,
    truncated: true,
  };
}

function briefOf(t: Record<string, unknown>): ThreadBrief {
  return {
    id: String(t.id ?? ""),
    title: String(t.title ?? ""),
    project: String(t.projectId ?? t.project ?? ""),
    status: String(t.status ?? ""),
    updatedAt: Number(t.updatedAt ?? 0),
  };
}

/** Имя треда из речи: без кавычек, пунктуации и регистра, ё→е. */
export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[«»"'“”„.,!?:;()\[\]]/g, " ").replace(/\s+/g, " ").trim();
}

/** Треды звонков (провайдер live-call) — не рабочие треды; в поиске и списках не нужны. */
const isCallThread = (t: Record<string, unknown>) => t.providerId === "live-call";

/**
 * Поиск BB по названию и сообщениям (`threads.search`): находит тред в любом
 * проекте, а не только в первых 100 из threads.list — там их вытесняли треды
 * звонков (баг приёмки 02.11: координатор не нашёл существующий тред по имени).
 */
export async function searchThreads(sdk: BbPluginApi["sdk"], query: string): Promise<Array<Record<string, unknown>>> {
  const q = query.trim();
  if (!q) return [];
  try {
    const res = (await (sdk.threads as unknown as { search(a: { query: string }): Promise<unknown> }).search({ query: q })) as {
      active?: { results?: Array<{ thread?: Record<string, unknown> }> };
      archived?: { results?: Array<{ thread?: Record<string, unknown> }> };
    };
    const pick = (g?: { results?: Array<{ thread?: Record<string, unknown> }> }) =>
      (g?.results ?? []).map((r) => r.thread).filter((x): x is Record<string, unknown> => Boolean(x?.id));
    return [...pick(res.active), ...pick(res.archived)].filter((x) => !isCallThread(x));
  } catch {
    return [];
  }
}

/** Человеческий статус треда для голоса: что владельцу важно знать. */
function stateOf(t: Record<string, unknown>): "работает" | "ждёт тебя" | "ошибка" | "свободен" {
  if (t.hasPendingInteraction) return "ждёт тебя";
  if (t.status === "active") return "работает";
  if (t.status === "error") return "ошибка";
  return "свободен";
}

function minutesAgo(ts: unknown): number | null {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? Math.max(0, Math.round((Date.now() - n) / 60000)) : null;
}

/**
 * Индекс тредов для голоса: видимые, не архивные, без тредов звонков, новые сверху,
 * с названием проекта и человеческим статусом. Раньше list_threads брал 60 тредов
 * со всего BB и игнорировал project — модель говорила «в BB нет запущенных тредов»,
 * когда они были (приёмка 03.11).
 */
async function threadIndex(sdk: BbPluginApi["sdk"], projectId?: string): Promise<{ threads: Array<Record<string, unknown>>; projectNames: Map<string, string> }> {
  const projects = ((await withTimeout(sdk.projects.list() as Promise<Array<Record<string, unknown>>>)) ?? []) as Array<Record<string, unknown>>;
  const projectNames = new Map((Array.isArray(projects) ? projects : []).map((p) => [String(p.id), String(p.name ?? p.id)]));
  // Без проекта — по каждому проекту отдельно: один threads.list отдаёт не больше 200
  // тредов из всего BB, и работающие туда могли не попасть (приёмка 03.11: из 324
  // тредов выборка не содержала ни проекта BB, ни одного из 13 работающих).
  const listOne = async (pid?: string) => {
    const res = await withTimeout(sdk.threads.list({ limit: 200, ...(pid ? { projectId: pid } : {}) } as never) as Promise<unknown>);
    return (Array.isArray(res) ? res : ((res as { threads?: unknown[] })?.threads ?? [])) as Array<Record<string, unknown>>;
  };
  const ids = projectId ? [projectId] : [...projectNames.keys()];
  const chunks = await Promise.all(ids.map((pid) => listOne(pid).catch(() => [] as Array<Record<string, unknown>>)));
  const seen = new Set<string>();
  const raw = chunks.flat().filter((x) => {
    const id = String(x.id ?? "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const threads = raw
    // projectId есть в схеме threads.list, но фильтруем и сами: без этого «треды BB» снова
    // превратились бы в треды всего BB, если параметр перестанут учитывать.
    .filter((x) => !projectId || String(x.projectId ?? "") === projectId)
    .filter((x) => !isCallThread(x) && !x.archivedAt && !x.deletedAt && x.visibility !== "hidden")
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
  return { threads, projectNames };
}

function voiceBrief(t: Record<string, unknown>, projectNames: Map<string, string>) {
  return {
    id: String(t.id ?? ""),
    title: String(t.title ?? t.titleFallback ?? "").slice(0, 120),
    project: projectNames.get(String(t.projectId ?? "")) ?? String(t.projectId ?? ""),
    state: stateOf(t),
    updatedMinutesAgo: minutesAgo(t.updatedAt),
  };
}

/** Проект из речи («BB», «бб», id) → id. */
async function resolveProjectId(sdk: BbPluginApi["sdk"], ref: string): Promise<string | undefined> {
  const r = normalizeTitle(ref);
  if (!r) return undefined;
  if (ref.startsWith("proj_")) return ref;
  const projects = ((await withTimeout(sdk.projects.list() as Promise<Array<Record<string, unknown>>>)) ?? []) as Array<Record<string, unknown>>;
  const lat = (s: string) => s.replace(/б/g, "b").replace(/в/g, "b").replace(/с/g, "c").replace(/к/g, "k").replace(/р/g, "r").replace(/м/g, "m");
  const hit =
    projects.find((p) => normalizeTitle(String(p.name ?? "")) === r) ??
    projects.find((p) => lat(normalizeTitle(String(p.name ?? ""))) === lat(r)) ??
    projects.find((p) => normalizeTitle(String(p.name ?? "")).includes(r));
  return hit ? String(hit.id) : undefined;
}

/** Нечёткое сопоставление имени из речи с открытыми тредами (контракт §4). */
export async function resolveThreadRef(
  sdk: BbPluginApi["sdk"],
  ref: string,
): Promise<{ ok: true; thread: Record<string, unknown> } | { ok: false; message: string; candidates: ThreadBrief[] }> {
  const refTrim = ref.trim();
  const refLower = refTrim.toLowerCase();

  // 1. Явный id: threads.get напрямую — list() может не отдать тред первой страницей.
  if (refLower.startsWith("thr_")) {
    try {
      const t = (await sdk.threads.get({ threadId: refTrim })) as unknown as Record<string, unknown>;
      if (t?.id) return { ok: true, thread: t };
    } catch {
      // id не существует — ищем по названию ниже.
    }
  }

  // 2. Поиск BB: точное или единственное совпадение по названию.
  const want = normalizeTitle(refTrim);
  const found = await searchThreads(sdk, refTrim);
  if (found.length > 0) {
    const exact = found.filter((t) => normalizeTitle(String(t.title ?? "")) === want);
    if (exact.length === 1) return { ok: true, thread: exact[0] };
    const prefix = found.filter((t) => normalizeTitle(String(t.title ?? "")).startsWith(want) || want.startsWith(normalizeTitle(String(t.title ?? ""))));
    if (prefix.length === 1) return { ok: true, thread: prefix[0] };
    if (found.length === 1) return { ok: true, thread: found[0] };
  }

  // 3. Активные треды (listRunning отдаёт массив).
  const collect = (arr: unknown): Array<Record<string, unknown>> =>
    Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [];
  try {
    const running = collect(await sdk.threads.listRunning());
    const byId = running.find((t) => String(t.id ?? "").toLowerCase() === refLower);
    if (byId) return { ok: true, thread: byId };
    const byTitle = running.filter((t) => String(t.title ?? "").toLowerCase().includes(refLower));
    if (byTitle.length === 1) return { ok: true, thread: byTitle[0] };
    if (byTitle.length > 1) {
      return { ok: false, message: `несколько тредов подходят под «${ref}»: ${byTitle.slice(0, 3).map((t) => String(t.title ?? "")).join("; ")}`, candidates: byTitle.slice(0, 3).map(briefOf) };
    }
  } catch {
    // listRunning недоступен — ищем по общему списку.
  }

  // 3. Общий список.
  const list = await sdk.threads.list({ limit: 100 });
  const threads = collect(list);
  const byId = threads.find((t) => String(t.id ?? "").toLowerCase() === refLower);
  if (byId) return { ok: true, thread: byId };
  const matches = threads.filter((t) => String(t.title ?? "").toLowerCase().includes(refLower));
  if (matches.length === 1) return { ok: true, thread: matches[0] };
  const candidates = matches.slice(0, 3).map(briefOf);
  if (matches.length === 0) return { ok: false, message: `тред «${ref}» не найден`, candidates: [] };
  return { ok: false, message: `несколько тредов подходят под «${ref}»: ${candidates.map((c) => c.title).join("; ")}`, candidates };
}

type InteractionListResult = { interactions?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
type InteractionsArea = { list(a: { threadId: string }): Promise<InteractionListResult> };

/** Вызов RPC внешнего плагина с честной ошибкой вместо падения. */
/**
 * Memory не даёт search/add по RPC (только админские list/update/delete) —
 * работаем через его CLI: он ходит на этот же сервер локально.
 */
export const SHARED_KB_SOURCE =
  "ОБЩАЯ база знаний BB — заметки и правила всех агентов-кодеров. Это НЕ твоя память звонков: не говори «у меня в памяти», говори «в базе знаний BB нашлось».";
export const OWN_MEMORY_SOURCE = "ТВОЯ память звонков — только это ты помнишь о владельце. Ничего сверх списка не добавляй.";

async function memoryCli(ctx: ToolContext, args: string[]): Promise<ToolResult> {
  try {
    const { spawn } = await import("node:child_process");
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn("bb", ["memory", ...args], { timeout: 15000 });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += String(d)));
      // stderr — предупреждения CLI («customAcpAgents … no longer read»): в результат не идут, только в ошибку.
      child.stderr.on("data", (d) => (err += String(d)));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error((err || out).trim().slice(0, 300) || `exit ${code}`))));
    });
    void ctx;
    return truncate(stdout.trim());
  } catch (e) {
    return { ok: false, error: { code: "memory_cli_failed", message: String(e).slice(0, 300) } };
  }
}

async function pluginRpc(ctx: ToolContext, pluginId: string, method: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    const res = await withTimeout(
      (ctx.sdk.plugins as unknown as { callRpc(a: unknown): Promise<unknown> }).callRpc({ pluginId, method, input } as never),
    );
    return truncate(res);
  } catch (e) {
    return { ok: false, error: { code: "rpc_failed", message: `${pluginId}.${method}: ${String(e)}` } };
  }
}

/** Массив или {поле: массив} → массив (SDK возвращает разные формы). */
export function toArray(v: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  if (!v || typeof v !== "object") return [];
  const obj = v as Record<string, unknown>;
  if (Array.isArray(obj.items)) return obj.items as Array<Record<string, unknown>>;
  if (Array.isArray(obj.events)) return obj.events as Array<Record<string, unknown>>;
  if (Array.isArray(obj.messages)) return obj.messages as Array<Record<string, unknown>>;
  if (Array.isArray(obj.threads)) return obj.threads as Array<Record<string, unknown>>;
  return [];
}
const asArray = toArray;

/** Проверяет наличие текста сообщения в событии любого типа (turn requested, steer, provider message и др.). */
export function eventContainsText(e: Record<string, unknown>, needle: string): boolean {
  if (!needle) return false;
  try {
    const data = e.data ?? e;
    if (typeof data === "string") return data.includes(needle);
    if (typeof data === "object" && data !== null) {
      const obj = data as Record<string, unknown>;
      // Стандартный input массива реплик (client/turn/requested и др.)
      const input = obj.input as Array<{ text?: string }> | undefined;
      if (Array.isArray(input)) {
        const text = input.map((x) => x?.text ?? "").join(" ");
        if (text.includes(needle)) return true;
      }
      // Очередь или steer в rawEvent (например, provider/unhandled с queue_update / steering как в thr_testshort1)
      const rawEvent = obj.rawEvent as { params?: { message?: { steering?: string[]; followUp?: string[] } } } | undefined;
      const steering = rawEvent?.params?.message?.steering;
      if (Array.isArray(steering) && steering.some((s) => typeof s === "string" && s.includes(needle))) {
        return true;
      }
      // Текстовые поля
      if (typeof obj.text === "string" && obj.text.includes(needle)) return true;
      if (typeof obj.message === "string" && obj.message.includes(needle)) return true;
      // Универсальный fallback через сериализацию
      return JSON.stringify(obj).includes(needle);
    }
  } catch {
    // Игнорируем ошибки сериализации
  }
  return false;
}

/**
 * Проверка доставки сообщения в тред после sdk.threads.send (до ~5 с).
 * Ищет текст среди ВСЕХ типов событий треда (turn requested, steer, provider message и др.)
 * или сообщение в очереди с этим текстом.
 */
export async function verifyThreadDelivery(
  sdk: BbPluginApi["sdk"],
  threadId: string,
  text: string,
  startTime: number,
  timeoutMs = 5000,
  intervalMs = 250,
): Promise<boolean> {
  const cleanNeedle = text.trim();
  const deadline = Date.now() + timeoutMs;

  while (true) {
    // 1. Проверяем события треда (поиск по ВСЕМ типам событий: turn, steer, provider и др.)
    try {
      const eventsArea = (sdk.threads as unknown as { events?: { list(a: Record<string, unknown>): Promise<unknown> } })?.events;
      if (eventsArea && typeof eventsArea.list === "function") {
        const res = await eventsArea.list({ threadId });
        const rows = toArray(res);
        for (let i = rows.length - 1; i >= 0 && i >= rows.length - 20; i--) {
          const e = rows[i];
          const createdAt = Number(e.createdAt ?? (e as { ts?: unknown }).ts ?? 0);
          if (!createdAt || createdAt >= startTime - 1000) {
            if (eventContainsText(e, cleanNeedle)) {
              return true;
            }
          }
        }
      }
    } catch {
      // Игнорируем ошибки опроса событий
    }

    // 2. Проверяем сообщения в очереди треда (queuedMessages или queue)
    try {
      const threadsArea = sdk.threads as unknown as {
        queuedMessages?: { list(a: Record<string, unknown>): Promise<unknown> };
        queue?: { list(a?: Record<string, unknown>): Promise<unknown> };
      };
      const qRows: Array<Record<string, unknown>> = [];
      if (typeof threadsArea?.queuedMessages?.list === "function") {
        const qRes = await threadsArea.queuedMessages.list({ threadId });
        qRows.push(...toArray(qRes));
      }
      if (typeof threadsArea?.queue?.list === "function") {
        const qRes = await threadsArea.queue.list({ threadId });
        qRows.push(...toArray(qRes));
      }
      for (const q of qRows) {
        if (eventContainsText(q, cleanNeedle)) return true;
      }
    } catch {
      // Игнорируем ошибки опроса очереди
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }

  return false;
}

async function withTimeout<T>(p: Promise<T>, ms = TOOL_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const TOOLS: ToolDef[] = [
  {
    name: "bb_overview",
    cls: "R",
    word: "",
    description: "Обзор BB по проектам: что работает, что ждёт владельца, что упало. Новые сверху.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const { threads, projectNames } = await threadIndex(ctx.sdk);
      const byProject = new Map<string, { project: string; working: number; waiting: number; failed: number; total: number }>();
      for (const t of threads) {
        const name = projectNames.get(String(t.projectId ?? "")) ?? "без проекта";
        const row = byProject.get(name) ?? { project: name, working: 0, waiting: 0, failed: 0, total: 0 };
        const st = stateOf(t);
        if (st === "работает") row.working += 1;
        if (st === "ждёт тебя") row.waiting += 1;
        if (st === "ошибка") row.failed += 1;
        row.total += 1;
        byProject.set(name, row);
      }
      const pick = (st: string, n: number) => threads.filter((t) => stateOf(t) === st).slice(0, n).map((t) => voiceBrief(t, projectNames));
      return truncate({
        projects: [...byProject.values()].sort((a, b) => b.working + b.waiting - (a.working + a.waiting)),
        working: pick("работает", 10),
        waitingForOwner: pick("ждёт тебя", 10),
        // Ошибки старше 3 суток — история, не новость для звонка.
        recentErrors: pick("ошибка", 20).filter((x) => (x.updatedMinutesAgo ?? 0) <= 3 * 24 * 60).slice(0, 5),
        note: "state: работает — ход идёт сейчас; ждёт тебя — агент задал вопрос; ошибка — последний ход упал (мог быть давно, смотри updatedMinutesAgo).",
      });
    },
  },
  {
    name: "list_threads",
    cls: "R",
    word: "",
    description: "Треды проекта или всего BB с состоянием (работает / ждёт тебя / ошибка / свободен), новые сверху. До 15.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "название проекта, например BB" },
        status: { type: "string", enum: ["working", "waiting", "error", "idle", "any"] },
        query: { type: "string", description: "поиск по названию треда" },
      },
    },
    async execute(args, ctx) {
      const q = String(args.query ?? "").trim();
      const projectRef = String(args.project ?? "").trim();
      const projectId = projectRef ? await resolveProjectId(ctx.sdk, projectRef) : undefined;
      if (projectRef && !projectId) return { ok: false, error: { code: "not_found", message: `нет проекта «${projectRef}»` } };
      const { threads, projectNames } = await threadIndex(ctx.sdk, projectId);
      let list = threads;
      if (q) {
        const found = new Set((await searchThreads(ctx.sdk, q)).map((x) => String(x.id)));
        list = list.filter((x) => found.has(String(x.id)));
      }
      const map: Record<string, string> = { working: "работает", waiting: "ждёт тебя", error: "ошибка", idle: "свободен" };
      const status = String(args.status ?? "any");
      let items = list.map((x) => voiceBrief(x, projectNames));
      if (status !== "any" && map[status]) items = items.filter((x) => x.state === map[status]);
      return truncate({ total: items.length, threads: items.slice(0, 15) });
    },
  },
  {
    name: "read_thread",
    cls: "R",
    word: "",
    description: "Статус и последний вывод треда, усечение ≤ 4000 символов.",
    parameters: { type: "object", properties: { thread: { type: "string", description: "id или название треда" } }, required: ["thread"] },
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      const t = ref.thread;
      const out = await withTimeout(ctx.sdk.threads.output({ threadId: String(t.id) }) as Promise<{ output: string | null }>);
      const lastOutput = String(out.output ?? "").slice(0, 4000);
      const state = stateOf(t);
      let currentTask: string | undefined;
      if (state === "работает" || state === "ждёт тебя") {
        // Что тред делает сейчас: последняя поставленная ему задача (событие запроса хода).
        try {
          const ev = (await withTimeout(
            (ctx.sdk.threads as unknown as { events: { list(a: Record<string, unknown>): Promise<unknown> } }).events.list({
              threadId: String(t.id),
              order: "desc",
              types: ["client/turn/requested"],
              limit: 1,
            }),
          )) as unknown;
          const rows = (Array.isArray(ev) ? ev : ((ev as { events?: unknown[] })?.events ?? [])) as Array<{ data?: { input?: Array<{ text?: string }> } }>;
          currentTask = rows[0]?.data?.input?.map((x) => x.text ?? "").join(" ").trim().slice(0, 600) || undefined;
        } catch {
          currentTask = undefined;
        }
      }
      return truncate({
        thread: { ...briefOf(t), state, updatedMinutesAgo: minutesAgo(t.updatedAt) },
        ...(currentTask ? { currentTask } : {}),
        lastOutput,
        note:
          state === "работает"
            ? "Тред СЕЙЧАС работает над currentTask. lastOutput — ответ ПРОШЛОГО хода, он может быть устаревшим (например, старое сообщение о лимите). Не выдавай его за текущее состояние."
            : "lastOutput — последний законченный ответ треда.",
      });
    },
  },
  {
    name: "list_pending",
    cls: "R",
    word: "",
    description: "Вопросы и запросы разрешений от агентов, ожидающие владельца.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const res = await withTimeout(ctx.sdk.threads.listRunning() as Promise<Array<Record<string, unknown>>>);
      const pending: Array<{ threadId: string; title: string; kind: string; prompt: string }> = [];
      for (const t of (Array.isArray(res) ? res : []).slice(0, 10)) {
        try {
          const ints = await withTimeout(
            (ctx.sdk.threads as unknown as { interactions: { list(a: { threadId: string }): Promise<{ interactions?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>> } }).interactions.list({ threadId: String(t.id) }),
          );
          const rows = (Array.isArray(ints) ? ints : (ints.interactions ?? [])) as Array<Record<string, unknown>>;
          for (const i of rows) {
            const payload = (i.payload ?? {}) as Record<string, unknown>;
            pending.push({
              threadId: String(t.id),
              title: String(t.title ?? ""),
              kind: String(payload.kind ?? i.kind ?? "question"),
              prompt: String(payload.prompt ?? payload.subject ?? "").slice(0, 300),
            });
          }
        } catch {
          // Тред мог закрыться между listRunning и interactions.list — пропускаем.
        }
      }
      return truncate(pending);
    },
  },
  {
    name: "watch_thread",
    cls: "R",
    word: "",
    description: "Доложить голосом, когда тред закончит или упадёт.",
    parameters: { type: "object", properties: { thread: { type: "string" } }, required: ["thread"] },
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      ctx.reportAction("watch_thread", "R", "done", `Наблюдаю за «${String(ref.thread.title ?? ref.thread.id)}»`, String(ref.thread.id));
      return truncate({ watching: true });
    },
  },
  {
    name: "send_to_thread",
    cls: "C",
    word: "да",
    description: "Сообщение в существующий тред с меткой [голос]. Запуск работы решает получатель.",
    parameters: {
      type: "object",
      properties: { thread: { type: "string" }, text: { type: "string", description: "точный текст сообщения" } },
      required: ["thread", "text"],
    },
    confirmSay: (args) => `Отправить в «${String(args.thread)}» сообщение: «${String(args.text)}»? Скажи «да» или «отмена».`,
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      const threadId = String(ref.thread.id);
      const text = String(args.text ?? "");
      const startTime = Date.now();
      try {
        await withTimeout(
          ctx.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text: `[голос] ${text}`, mentions: [] }] } as never),
        );
      } catch {
        ctx.reportAction("send_to_thread", "C", "failed", "не доставлено", threadId);
        return { ok: false, error: { code: "delivery_failed", message: "не доставлено" } };
      }
      const delivered = await verifyThreadDelivery(
        ctx.sdk,
        threadId,
        text,
        startTime,
        ctx.deliveryTimeoutMs ?? 5000,
        ctx.deliveryIntervalMs ?? 250,
      );
      if (!delivered) {
        ctx.reportAction("send_to_thread", "C", "failed", "не доставлено", threadId);
        return { ok: false, error: { code: "delivery_failed", message: "не доставлено" } };
      }
      ctx.ledger.add("tool", `send_to_thread → ${threadId}: ${text.slice(0, 200)}`);
      ctx.reportAction("send_to_thread", "C", "done", `Отправил в «${String(ref.thread.title ?? threadId)}»`, threadId);
      return truncate({ sent: true, threadId });
    },
  },
  {
    name: "answer_interaction",
    cls: "C",
    word: "да",
    description: "Ответ на вопрос агента или решение запроса разрешения. grant: true — класс P, только «разрешаю».",
    parameters: {
      type: "object",
      properties: {
        thread: { type: "string" },
        answer: { type: "string", description: "текст ответа для вопроса" },
        interactionId: { type: "string", description: "id ожидающего взаимодействия, если известно" },
        grant: { type: "boolean", description: "true — разрешить агенту действие (класс P)" },
      },
      required: ["thread"],
    },
    confirmSay: (args) =>
      args.grant
        ? `Разрешить агенту в «${String(args.thread)}»? Скажи «разрешаю» или «отмена».`
        : `Ответить агенту в «${String(args.thread)}»: «${String(args.answer ?? "")}». Скажи «да» или «отмена».`,
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      const threadId = String(ref.thread.id);
      const interactions = ctx.sdk.threads.interactions;
      const listed = await withTimeout(
        (interactions as unknown as InteractionsArea).list({ threadId }),
      );
      const rows = (Array.isArray(listed) ? listed : (listed.interactions ?? [])) as Array<Record<string, unknown>>;
      let target: Record<string, unknown> | undefined;
      const wantedId = args.interactionId ? String(args.interactionId) : null;
      if (wantedId) target = rows.find((i) => String(i.id) === wantedId);
      else if (rows.length === 1) target = rows[0];
      else if (rows.length > 1) {
        return { ok: false, error: { code: "ambiguous", message: `у треда ${rows.length} ожидающих взаимодействий, назови какое` } };
      }
      if (!target) return { ok: false, error: { code: "not_found", message: "у треда нет ожидающих взаимодействий" } };
      const interactionId = String(target.id);
      const payload = (target.payload ?? {}) as Record<string, unknown>;
      if (args.grant) {
        await withTimeout(
          (interactions as unknown as { resolve(a: { interactionId: string; threadId: string; resolution: unknown }): Promise<unknown> }).resolve({
            interactionId,
            threadId,
            resolution: { kind: "approval", decision: "allow_once", grantedPermissions: payload.grantedPermissions ?? null },
          } as never),
        );
      } else {
        await withTimeout(
          (interactions as unknown as { respond(a: { interactionId: string; threadId: string; value: unknown }): Promise<unknown> }).respond({
            interactionId,
            threadId,
            value: { kind: "user_answer", answers: { default: { freeText: String(args.answer ?? "") } } },
          } as never),
        );
      }
      ctx.ledger.add("tool", `answer_interaction ${threadId}: ${args.grant ? "разрешено" : String(args.answer ?? "").slice(0, 200)}`);
      ctx.reportAction("answer_interaction", args.grant ? "P" : "C", "done", args.grant ? "Разрешил агенту" : "Ответил агенту", threadId);
      return truncate({ resolved: true });
    },
  },
  {
    name: "stop_thread",
    cls: "C",
    word: "да",
    description: "Остановить тред. Подтверждение: «да» или «останавливай».",
    parameters: { type: "object", properties: { thread: { type: "string" } }, required: ["thread"] },
    confirmSay: (args) => `Остановить тред «${String(args.thread)}»? Скажи «да», «останавливай» или «отмена».`,
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      await withTimeout(ctx.sdk.threads.stop({ threadId: String(ref.thread.id) }) as Promise<unknown>);
      ctx.reportAction("stop_thread", "C", "done", `Остановил «${String(ref.thread.title ?? ref.thread.id)}»`, String(ref.thread.id));
      return truncate({ stopped: true });
    },
  },
  {
    name: "start_thread",
    cls: "L",
    word: "запускай",
    description: "Запустить нового агента: проект, задача, пресет. Класс L: только «запускай».",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "имя или id проекта" },
        task: { type: "string", description: "полный промпт задачи" },
        preset: { type: "string", description: "имя пресета bb tasks, если нужно" },
      },
      required: ["project", "task"],
    },
    confirmSay: (args) => `Запускаю агента в проекте «${String(args.project)}» с задачей: «${String(args.task).slice(0, 200)}». Скажи «запускай» или «отмена».`,
    async execute(args, ctx) {
      const projects = (await withTimeout(ctx.sdk.projects.list() as Promise<Array<Record<string, unknown>>>)) ?? [];
      const ref = String(args.project ?? "").trim().toLowerCase();
      const project = (Array.isArray(projects) ? projects : []).find(
        (p) => String(p.id ?? "").toLowerCase() === ref || String(p.name ?? "").toLowerCase().includes(ref),
      );
      if (!project) return { ok: false, error: { code: "not_found", message: `проект «${String(args.project)}» не найден` } };
      const thread = await withTimeout(
        ctx.sdk.threads.spawn({
          projectId: String(project.id),
          prompt: String(args.task),
          title: `[голос] ${String(args.task).slice(0, 60)}`,
          environment: { type: "project-default" },
        } as never),
      );
      const threadId = String((thread as unknown as { id: string }).id);
      ctx.ledger.add("tool", `start_thread → ${threadId}`);
      ctx.reportAction("start_thread", "L", "done", `Запустил агента «${String(args.task).slice(0, 60)}»`, threadId);
      return truncate({ threadId, title: String(args.task).slice(0, 60) });
    },
  },
  {
    name: "list_tasks",
    cls: "R",
    word: "",
    description: "Задачи трекера по статусу: backlog, in_progress, in_review, done. До 15.",
    parameters: {
      type: "object",
      properties: { status: { type: "string", description: "статус задач, например backlog или in_progress" } },
    },
    async execute(args, ctx) {
      const res = await withTimeout(
        (ctx.sdk.plugins as unknown as { callRpc(a: unknown): Promise<unknown> }).callRpc({
          pluginId: "tasks",
          method: "listTasks",
          input: { status: args.status, limit: 15 },
        } as never),
      ).catch((e: unknown) => ({ error: String(e) }));
      return truncate(res);
    },
  },
  {
    name: "tasks_create",
    cls: "C",
    word: "да",
    description: "Создать задачу в трекере (запись, без исполнения).",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, spec: { type: "string" }, project: { type: "string" } },
      required: ["title", "spec"],
    },
    confirmSay: (args) => `Создать задачу «${String(args.title)}»? Скажи «да» или «отмена».`,
    async execute(args, ctx) {
      const res = await pluginRpc(ctx, "tasks", "createTask", { title: args.title, description: args.spec, project: args.project });
      ctx.reportAction("tasks_create", "C", res.ok ? "done" : "failed", `Создал задачу «${String(args.title)}»`);
      return res;
    },
  },
  {
    name: "tasks_dispatch",
    cls: "L",
    word: "запускай",
    description: "Раздать задачу исполнителю. Класс L: только «запускай».",
    parameters: {
      type: "object",
      properties: { key: { type: "string" }, preset: { type: "string" } },
      required: ["key", "preset"],
    },
    confirmSay: (args) => `Раздать задачу ${String(args.key)} исполнителю (${String(args.preset)})? Скажи «запускай» или «отмена».`,
    async execute(args, ctx) {
      const res = await pluginRpc(ctx, "tasks", "dispatch", { key: args.key, preset: args.preset });
      ctx.reportAction("tasks_dispatch", "L", res.ok ? "done" : "failed", `Раздал задачу ${String(args.key)}`);
      return res;
    },
  },
  {
    name: "search_memory",
    cls: "R",
    word: "",
    description: "Поиск по ОБЩЕЙ базе знаний BB (память и заметки всех агентов) по конкретному вопросу. НЕ твоя память звонков — её ты уже знаешь из инструкции. До 5 записей.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async execute(args, ctx) {
      const r = await memoryCli(ctx, ["search", String(args.query)]);
      if (!r.ok) return r;
      // Метка источника идёт ПЕРВОЙ: голос получает её даже в обрезанной вставке [СИСТЕМА].
      // 03.11 голос выдал правила агентов-кодеров из общей памяти за «мою память».
      return truncate({ source: SHARED_KB_SOURCE, results: r.data });
    },
  },
  {
    name: "switch_mode",
    cls: "R",
    word: "",
    description: "Переключить режим звонка: extended (по умолчанию, думает глубже) или normal — режим «Быстрый». «Быстрый режим» владельца = normal.",
    parameters: {
      type: "object",
      properties: { mode: { type: "string", enum: ["normal", "extended"] } },
      required: ["mode"],
    },
    async execute(args, ctx) {
      ctx.reportAction("switch_mode", "R", "running", String(args.mode ?? "normal"));
      return truncate({ switching: true });
    },
  },
  {
    name: "end_call",
    cls: "R",
    word: "",
    description: "Завершить звонок с итогом.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      ctx.reportAction("end_call", "R", "done", "Завершаю звонок");
      return truncate({ ending: true });
    },
  },
  {
    name: "thread_updates",
    cls: "R",
    word: "",
    description: "События треда с момента N минут назад: завершения, падения, сообщения. До 10.",
    parameters: {
      type: "object",
      properties: { thread: { type: "string" }, sinceMinutes: { type: "number" } },
      required: ["thread"],
    },
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      const threadId = String(ref.thread.id);
      const since = Date.now() - Number(args.sinceMinutes ?? 30) * 60_000;
      const events = await withTimeout(
        (ctx.sdk.threads as unknown as { events: { list(a: { threadId: string }): Promise<unknown> } }).events.list({ threadId }),
      );
      const rows = asArray(events)
        .filter((e) => Number(e.createdAt ?? e.ts ?? 0) >= since)
        .slice(-10)
        .map((e) => ({ at: e.createdAt ?? e.ts, kind: String(e.type ?? e.kind ?? ""), text: String(e.text ?? e.summary ?? "").slice(0, 200) }));
      return truncate({ threadId, events: rows });
    },
  },
  {
    name: "read_task",
    cls: "R",
    word: "",
    description: "Детали задачи трекера по ключу (например PLUG-89): описание, статус, комментарии.",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    async execute(args, ctx) {
      return pluginRpc(ctx, "tasks", "getTaskByKey", { key: args.key });
    },
  },
  {
    name: "system_health",
    cls: "R",
    word: "",
    description: "Здоровье BB: активные и упавшие треды, провайдеры моделей.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const providers = (await withTimeout(ctx.sdk.providers.list() as Promise<Array<Record<string, unknown>>>)) ?? [];
      const running = asArray(await withTimeout(ctx.sdk.threads.listRunning() as Promise<Array<Record<string, unknown>>>));
      return truncate({
        running: running.length,
        failed: running.filter((t) => t.status === "error").map((t) => String(t.title ?? t.id)).slice(0, 5),
        providers: providers.slice(0, 8).map((pr) => ({ id: pr.id, enabled: pr.enabled !== false })),
      });
    },
  },
  {
    name: "pr_status",
    cls: "R",
    word: "",
    description: "Статус pull request треда.",
    parameters: { type: "object", properties: { thread: { type: "string" } }, required: ["thread"] },
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      const t = ref.thread as Record<string, unknown>;
      return truncate({ thread: briefOf(t), pr: (t.pullRequest ?? {}) as Record<string, unknown> });
    },
  },
  {
    name: "provider_status",
    cls: "R",
    word: "",
    description: "Провайдеры моделей: какие включены.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const providers = (await withTimeout(ctx.sdk.providers.list() as Promise<Array<Record<string, unknown>>>)) ?? [];
      return truncate(providers.map((pr) => ({ id: pr.id, name: pr.name ?? pr.id, enabled: pr.enabled !== false })));
    },
  },
  {
    name: "plugin_status",
    cls: "R",
    word: "",
    description: "Установленные плагины BB и их состояние.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const res = (await withTimeout(ctx.sdk.plugins.list({}) as Promise<{ plugins?: Array<Record<string, unknown>> }>)) ?? {};
      const plugins = (res.plugins ?? []) as Array<Record<string, unknown>>;
      return truncate(plugins.slice(0, 25).map((pl) => ({ id: pl.id, name: pl.name ?? pl.id, status: pl.status ?? (pl.enabled === false ? "disabled" : "running") })));
    },
  },
  {
    name: "skills_list",
    cls: "R",
    word: "",
    description: "Установленные скиллы BB. До 20.",
    parameters: { type: "object", properties: { project: { type: "string", description: "название проекта; по умолчанию первый" } } },
    async execute(args, ctx) {
      // Было: projectId "personal" и id хоста вместо окружения — BB отвечал 404 Project not found.
      const projectRef = String(args.project ?? "").trim();
      let projectId = projectRef ? await resolveProjectId(ctx.sdk, projectRef) : undefined;
      if (!projectId) {
        const projects = ((await withTimeout(ctx.sdk.projects.list() as Promise<Array<Record<string, unknown>>>)) ?? []) as Array<Record<string, unknown>>;
        projectId = projects.length > 0 ? String(projects[0].id) : undefined;
      }
      if (!projectId) return { ok: false, error: { code: "not_found", message: "нет проектов" } };
      const res = (await withTimeout(ctx.sdk.skills.list({ projectId, environmentId: null } as never) as Promise<unknown>)) as { skills?: unknown[] } | unknown[] | null;
      const skills = Array.isArray(res) ? res : ((res as { skills?: unknown[] } | null)?.skills ?? []);
      return truncate({ total: skills.length, skills: asArray(skills).slice(0, 30).map((sk) => String(sk.name ?? sk.id)) });
    },
  },
  {
    name: "prompt_history",
    cls: "R",
    word: "",
    description: "Последние промпты владельца в проекте. До 10.",
    parameters: { type: "object", properties: { project: { type: "string" } } },
    async execute(args, ctx) {
      const projects = (await withTimeout(ctx.sdk.projects.list() as Promise<Array<Record<string, unknown>>>)) ?? [];
      const ref = String(args.project ?? "").trim().toLowerCase();
      const project = ref ? projects.find((p) => String(p.id ?? "").toLowerCase() === ref || String(p.name ?? "").toLowerCase().includes(ref)) : projects[0];
      if (!project) return { ok: false, error: { code: "not_found", message: `проект «${String(args.project ?? "")}» не найден` } };
      const res = await withTimeout(
        (ctx.sdk as unknown as { experimental_promptHistory: { list(a: { projectId: string }): Promise<unknown> } }).experimental_promptHistory.list({ projectId: String(project.id) }),
      );
      const rows = asArray(res).slice(0, 10).map((r) => String(r.prompt ?? r.text ?? "").slice(0, 200));
      return truncate({ project: String(project.name ?? project.id), prompts: rows });
    },
  },
  {
    name: "project_branches",
    cls: "R",
    word: "",
    description: "Ветки проекта.",
    parameters: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
    async execute(args, ctx) {
      const projects = (await withTimeout(ctx.sdk.projects.list() as Promise<Array<Record<string, unknown>>>)) ?? [];
      const ref = String(args.project ?? "").trim().toLowerCase();
      const project = projects.find((p) => String(p.id ?? "").toLowerCase() === ref || String(p.name ?? "").toLowerCase().includes(ref));
      if (!project) return { ok: false, error: { code: "not_found", message: `проект «${String(args.project)}» не найден` } };
      const res = await withTimeout(
        (ctx.sdk.projects as unknown as { branches(a: { projectId: string }): Promise<unknown> }).branches({ projectId: String(project.id) }),
      );
      return truncate({ project: String(project.name ?? project.id), branches: res });
    },
  },
  {
    name: "search_all",
    cls: "R",
    word: "",
    description: "Единый поиск: треды + задачи + память одним вызовом. До 5 в каждой категории.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async execute(args, ctx) {
      const q = String(args.query ?? "").trim();
      const threads = await withTimeout(ctx.sdk.threads.search({ query: q } as never) as Promise<unknown>).catch(() => [] as unknown);
      const memory = await memoryCli(ctx, ["search", q]);
      const tasks = await pluginRpc(ctx, "tasks", "listTasks", { query: q, limit: 5 });
      return truncate({ threads: asArray(threads).slice(0, 5).map(briefOf), memory, tasks });
    },
  },
  {
    name: "task_comment",
    cls: "C",
    word: "да",
    description: "Комментарий к задаче трекера.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" }, body: { type: "string" } },
      required: ["key", "body"],
    },
    confirmSay: (args) => `Комментарий к задаче ${String(args.key)}: «${String(args.body).slice(0, 200)}». Скажи «да» или «отмена».`,
    async execute(args, ctx) {
      return pluginRpc(ctx, "tasks", "createComment", { key: args.key, body: args.body });
    },
  },
  {
    name: "task_status",
    cls: "C",
    word: "да",
    description: "Перевести задачу в статус: backlog, in_progress, in_review, done, canceled.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" }, status: { type: "string", enum: ["backlog", "in_progress", "in_review", "done", "canceled"] } },
      required: ["key", "status"],
    },
    confirmSay: (args) => `Перевести задачу ${String(args.key)} в «${String(args.status)}»? Скажи «да» или «отмена».`,
    async execute(args, ctx) {
      return pluginRpc(ctx, "tasks", "updateTask", { key: args.key, status: args.status });
    },
  },
  {
    name: "task_due",
    cls: "C",
    word: "да",
    description: "Установить срок задачи (YYYY-MM-DD).",
    parameters: {
      type: "object",
      properties: { key: { type: "string" }, due: { type: "string" } },
      required: ["key", "due"],
    },
    confirmSay: (args) => `Срок задачи ${String(args.key)} — ${String(args.due)}? Скажи «да» или «отмена».`,
    async execute(args, ctx) {
      return pluginRpc(ctx, "tasks", "updateTask", { key: args.key, dueDate: args.due });
    },
  },
  {
    name: "archive_thread",
    cls: "C",
    word: "да",
    description: "Тред в архив (не удаляет).",
    parameters: { type: "object", properties: { thread: { type: "string" } }, required: ["thread"] },
    confirmSay: (args) => `Архивировать тред «${String(args.thread)}»? Скажи «да» или «отмена».`,
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      const threadId = String(ref.thread.id);
      await withTimeout(ctx.sdk.threads.archive({ threadId }) as Promise<unknown>);
      ctx.reportAction("archive_thread", "C", "done", `Архивировал «${String(ref.thread.title ?? threadId)}»`, threadId);
      return truncate({ archived: true });
    },
  },
  {
    name: "compact_thread",
    cls: "C",
    word: "да",
    description: "Сжать контекст длинного треда (штатный /compact).",
    parameters: { type: "object", properties: { thread: { type: "string" } }, required: ["thread"] },
    confirmSay: (args) => `Сжать контекст треда «${String(args.thread)}»? Скажи «да» или «отмена».`,
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      const threadId = String(ref.thread.id);
      await withTimeout(ctx.sdk.threads.compact({ threadId }) as Promise<unknown>);
      ctx.reportAction("compact_thread", "C", "done", `Сжал контекст «${String(ref.thread.title ?? threadId)}»`, threadId);
      return truncate({ compacted: true });
    },
  },
  {
    name: "queue_message",
    cls: "C",
    word: "да",
    description: "Сообщение в очередь треда — доставится, когда тред освободится; работу не запускает.",
    parameters: {
      type: "object",
      properties: { thread: { type: "string" }, text: { type: "string" } },
      required: ["thread", "text"],
    },
    confirmSay: (args) => `В очередь треда «${String(args.thread)}»: «${String(args.text).slice(0, 200)}». Скажи «да» или «отмена».`,
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      const threadId = String(ref.thread.id);
      await withTimeout(
        (ctx.sdk.threads as unknown as { queuedMessages: { create(a: { threadId: string; text: string }): Promise<unknown> } }).queuedMessages.create({ threadId, text: `[голос] ${String(args.text)}` }),
      );
      ctx.reportAction("queue_message", "C", "done", `В очередь «${String(ref.thread.title ?? threadId)}»`, threadId);
      return truncate({ queued: true, threadId });
    },
  },
  {
    name: "pin_thread",
    cls: "C",
    word: "да",
    description: "Закрепить или открепить тред в сайдбаре.",
    parameters: {
      type: "object",
      properties: { thread: { type: "string" }, unpin: { type: "boolean" } },
      required: ["thread"],
    },
    confirmSay: (args) => `${args.unpin ? "Открепить" : "Закрепить"} тред «${String(args.thread)}»? Скажи «да» или «отмена».`,
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      const threadId = String(ref.thread.id);
      const threads = ctx.sdk.threads as unknown as { pin(a: { threadId: string }): Promise<unknown>; unpin(a: { threadId: string }): Promise<unknown> };
      if (args.unpin) await withTimeout(threads.unpin({ threadId }));
      else await withTimeout(threads.pin({ threadId }));
      ctx.reportAction("pin_thread", "C", "done", `${args.unpin ? "Открепил" : "Закрепил"} «${String(ref.thread.title ?? threadId)}»`, threadId);
      return truncate({ pinned: !args.unpin });
    },
  },
  {
    name: "thread_rename",
    cls: "C",
    word: "да",
    description: "Переименовать тред.",
    parameters: {
      type: "object",
      properties: { thread: { type: "string" }, title: { type: "string" } },
      required: ["thread", "title"],
    },
    confirmSay: (args) => `Переименовать «${String(args.thread)}» в «${String(args.title)}»? Скажи «да» или «отмена».`,
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      const threadId = String(ref.thread.id);
      await withTimeout(ctx.sdk.threads.update({ threadId, title: String(args.title) } as never));
      ctx.reportAction("thread_rename", "C", "done", `Переименовал в «${String(args.title)}»`, threadId);
      return truncate({ renamed: true });
    },
  },
  {
    name: "thread_hide",
    cls: "C",
    word: "да",
    description: "Скрыть или вернуть тред в сайдбаре (не архив).",
    parameters: {
      type: "object",
      properties: { thread: { type: "string" }, unhide: { type: "boolean" } },
      required: ["thread"],
    },
    confirmSay: (args) => `${args.unhide ? "Вернуть" : "Скрыть"} тред «${String(args.thread)}»? Скажи «да» или «отмена».`,
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      const threadId = String(ref.thread.id);
      await withTimeout(ctx.sdk.threads.update({ threadId, visibility: args.unhide ? "visible" : "hidden" } as never));
      ctx.reportAction("thread_hide", "C", "done", `${args.unhide ? "Вернул" : "Скрыл"} «${String(ref.thread.title ?? threadId)}»`, threadId);
      return truncate({ hidden: !args.unhide });
    },
  },
  {
    name: "recall",
    cls: "R",
    word: "",
    description: "Что записано в ТВОЕЙ памяти звонков (предпочтения владельца из прошлых звонков). Вызывай на «что у тебя в памяти / что ты помнишь / что запомнил». Общую базу знаний BB не трогает.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      if (!ctx.voiceMemory) return { ok: false, error: { code: "no_memory", message: "память звонков недоступна" } };
      const items = ctx.voiceMemory.list().map((m) => m.text);
      return truncate({ source: OWN_MEMORY_SOURCE, count: items.length, items });
    },
  },
  {
    name: "remember",
    cls: "C",
    word: "да",
    description: "Запомнить предпочтение или факт владельца в СВОЮ память голосового агента (только для звонков, не общая память BB). Помнится во всех следующих звонках.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "что запомнить, одной фразой" } },
      required: ["text"],
    },
    confirmSay: (args) => `Запомнить в мою память звонков: «${String(args.text).slice(0, 200)}»? Скажи «да» или «отмена».`,
    async execute(args, ctx) {
      if (!ctx.voiceMemory) return { ok: false, error: { code: "no_memory", message: "память звонков недоступна" } };
      const r = ctx.voiceMemory.add(String(args.text ?? ""));
      return { ok: true, data: { saved: true, duplicate: r.duplicate, where: "память голосового агента (только звонки)" } };
    },
  },
  {
    name: "call_note",
    cls: "C",
    word: "да",
    description: "Пометка в итог текущего звонка.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    confirmSay: (args) => `Отметить в итоге звонка: «${String(args.text).slice(0, 200)}»? Скажи «да» или «отмена».`,
    async execute(args, ctx) {
      ctx.ledger.add("system", `Пометка: ${String(args.text)}`);
      ctx.reportAction("call_note", "C", "done", `Пометка: ${String(args.text).slice(0, 80)}`);
      return truncate({ noted: true });
    },
  },
  {
    name: "retry_thread",
    cls: "L",
    word: "запускай",
    description: "Перезапустить упавший тред. Класс L: только «запускай».",
    parameters: { type: "object", properties: { thread: { type: "string" } }, required: ["thread"] },
    confirmSay: (args) => `Перезапустить тред «${String(args.thread)}»? Скажи «запускай» или «отмена».`,
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      const threadId = String(ref.thread.id);
      await withTimeout(ctx.sdk.threads.retry({ threadId }) as Promise<unknown>);
      ctx.reportAction("retry_thread", "L", "done", `Перезапустил «${String(ref.thread.title ?? threadId)}»`, threadId);
      return truncate({ retried: true, threadId });
    },
  },
  {
    name: "stop_all_agents",
    cls: "L",
    word: "запускай",
    description: "Остановить ВСЕ активные треды кроме треда звонка. Массовая операция, класс L.",
    parameters: { type: "object", properties: {} },
    confirmSay: () => "Остановить все активные треды? Скажи «запускай» или «отмена».",
    async execute(_args, ctx) {
      const running = asArray(await withTimeout(ctx.sdk.threads.listRunning() as Promise<Array<Record<string, unknown>>>));
      const stopped: string[] = [];
      for (const t of running) {
        if (t.status === "error") continue;
        try {
          await withTimeout(ctx.sdk.threads.stop({ threadId: String(t.id) }) as Promise<unknown>);
          stopped.push(String(t.title ?? t.id));
        } catch {
          // тред мог закрыться между listRunning и stop
        }
      }
      ctx.reportAction("stop_all_agents", "L", "done", `Остановил ${stopped.length}: ${stopped.slice(0, 5).join("; ")}`);
      return truncate({ stopped });
    },
  },
  {
    name: "handoff_thread",
    cls: "L",
    word: "запускай",
    description: "Передать тред другой модели: новый тред с контекстом старого (в BB модель треда сменить нельзя).",
    parameters: {
      type: "object",
      properties: { thread: { type: "string" }, model: { type: "string" } },
      required: ["thread", "model"],
    },
    confirmSay: (args) => `Передать тред «${String(args.thread)}» на ${String(args.model)} в новом треде? Скажи «запускай» или «отмена».`,
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      const source = ref.thread as Record<string, unknown>;
      const out = await withTimeout(ctx.sdk.threads.output({ threadId: String(source.id) }) as Promise<{ output: string | null }>);
      const brief = String(out.output ?? "").slice(-1500);
      const thread = await withTimeout(
        ctx.sdk.threads.spawn({
          projectId: String(source.projectId),
          prompt: `Продолжи работу из треда ${String(source.id)} («${String(source.title ?? "")}»). Последнее состояние:\n${brief}\nСначала прочитай исходный тред, потом продолжай.`,
          title: `[хендофф ${String(args.model)}] ${String(source.title ?? "").slice(0, 50)}`,
          environment: { type: "project-default" },
        } as never),
      );
      const threadId = String((thread as unknown as { id: string }).id);
      ctx.reportAction("handoff_thread", "L", "done", `Передал на ${String(args.model)}: ${threadId}`, threadId);
      return truncate({ threadId, from: String(source.id) });
    },
  },
  {
    name: "fork_thread",
    cls: "L",
    word: "запускай",
    description: "Клонировать тред с контекстом для отдельной доработки.",
    parameters: { type: "object", properties: { thread: { type: "string" } }, required: ["thread"] },
    confirmSay: (args) => `Клонировать тред «${String(args.thread)}»? Скажи «запускай» или «отмена».`,
    async execute(args, ctx) {
      const ref = await resolveThreadRef(ctx.sdk, String(args.thread ?? ""));
      if (!ref.ok) return { ok: false, error: { code: "ambiguous", message: ref.message } };
      const source = ref.thread as Record<string, unknown>;
      const res = await withTimeout(ctx.sdk.threads.fork({ sourceThreadId: String(source.id) } as never) as Promise<{ id: string }>);
      const threadId = String(res.id);
      ctx.reportAction("fork_thread", "L", "done", `Клонировал «${String(source.title ?? source.id)}»`, threadId);
      return truncate({ threadId, from: String(source.id) });
    },
  },
];

export const threadReadMessagesTool: ToolDef = {
  name: "thread_read_messages",
  cls: "R",
  word: "",
  description: "Сообщения треда по номерам from-to (до 10 за вызов) или по query (подстрока, до 5 совпадений), целиком.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "integer", description: "номер первого сообщения (1..N)" },
      to: { type: "integer", description: "номер последнего сообщения (1..N, до 10 за вызов)" },
      query: { type: "string", description: "поиск по подстроке в тексте сообщений (до 5 совпадений)" },
    },
  },
  async execute(args, ctx) {
    const threadId = ctx.targetThreadId ?? (typeof args.thread === "string" ? String(args.thread) : undefined);
    let messages = ctx.threadMessages;
    if (!messages && threadId) {
      messages = await fetchThreadMessages(ctx.sdk, threadId);
    }
    const msgs = messages ?? [];
    if (args.query && typeof args.query === "string" && args.query.trim()) {
      const q = args.query.trim().toLowerCase();
      const matched = msgs.filter((m) => m.text.toLowerCase().includes(q)).slice(0, 5);
      return truncate({
        query: args.query,
        count: matched.length,
        messages: matched.map((m) => ({
          number: m.number,
          role: m.role,
          text: m.text,
          time: formatMessageTime(m.createdAt),
        })),
      });
    }

    const start = Math.max(1, typeof args.from === "number" ? Math.floor(args.from) : 1);
    const requestedTo = typeof args.to === "number" ? Math.floor(args.to) : start + 9;
    const end = Math.min(requestedTo, start + 9);

    const matched = msgs.filter((m) => m.number >= start && m.number <= end);
    return truncate({
      from: start,
      to: end,
      count: matched.length,
      messages: matched.map((m) => ({
        number: m.number,
        role: m.role,
        text: m.text,
        time: formatMessageTime(m.createdAt),
      })),
    });
  },
};

export const threadSendTool: ToolDef = {
  name: "thread_send",
  cls: "C",
  word: "да",
  description: "Сообщение в этот тред от владельца с меткой [голос]. Запуск работы решает получатель.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "точный текст сообщения" },
    },
    required: ["text"],
  },
  confirmSay: (args) => `Отправить в тред сообщение: «${String(args.text ?? "")}»? Скажи «да» или «отмена».`,
  async execute(args, ctx) {
    const threadId = ctx.targetThreadId;
    if (!threadId) {
      return { ok: false, error: { code: "not_found", message: "тред звонка не определён" } };
    }
    const text = String(args.text ?? "");
    const startTime = Date.now();
    try {
      await withTimeout(
        ctx.sdk.threads.send({
          threadId,
          mode: "auto",
          input: [{ type: "text", text: `[голос] ${text}`, mentions: [] }],
        } as never),
      );
    } catch {
      ctx.reportAction("thread_send", "C", "failed", "не доставлено", threadId);
      return { ok: false, error: { code: "delivery_failed", message: "не доставлено" } };
    }
    const delivered = await verifyThreadDelivery(
      ctx.sdk,
      threadId,
      text,
      startTime,
      ctx.deliveryTimeoutMs ?? 5000,
      ctx.deliveryIntervalMs ?? 250,
    );
    if (!delivered) {
      ctx.reportAction("thread_send", "C", "failed", "не доставлено", threadId);
      return { ok: false, error: { code: "delivery_failed", message: "не доставлено" } };
    }
    ctx.ledger.add("tool", `thread_send → ${threadId}: ${text.slice(0, 200)}`);
    ctx.reportAction("thread_send", "C", "done", `Отправил в тред: «${text.slice(0, 60)}»`, threadId);
    return truncate({ sent: true, threadId });
  },
};

export const threadAnswerTool: ToolDef = {
  name: "thread_answer",
  cls: "C",
  word: "да",
  description: "Ответ на вопрос агента или решение запроса разрешения для этого треда. grant: true — класс P, только «разрешаю».",
  parameters: {
    type: "object",
    properties: {
      answer: { type: "string", description: "текст ответа для вопроса" },
      interactionId: { type: "string", description: "id ожидающего взаимодействия, если известно" },
      grant: { type: "boolean", description: "true — разрешить агенту действие (класс P)" },
    },
  },
  confirmSay: (args) =>
    args.grant
      ? "Разрешить агенту действие? Скажи «разрешаю» или «отмена»."
      : `Ответить агенту: «${String(args.answer ?? "")}». Скажи «да» или «отмена».`,
  async execute(args, ctx) {
    const threadId = ctx.targetThreadId;
    if (!threadId) {
      return { ok: false, error: { code: "not_found", message: "тред звонка не определён" } };
    }
    const interactions = ctx.sdk.threads.interactions;
    const listed = await withTimeout((interactions as unknown as InteractionsArea).list({ threadId }));
    const rows = (Array.isArray(listed) ? listed : (listed.interactions ?? [])) as Array<Record<string, unknown>>;
    let target: Record<string, unknown> | undefined;
    const wantedId = args.interactionId ? String(args.interactionId) : null;
    if (wantedId) target = rows.find((i) => String(i.id) === wantedId);
    else if (rows.length === 1) target = rows[0];
    else if (rows.length > 1) {
      return { ok: false, error: { code: "ambiguous", message: `у треда ${rows.length} ожидающих взаимодействий, назови какое` } };
    }
    if (!target) return { ok: false, error: { code: "not_found", message: "у треда нет ожидающих взаимодействий" } };
    const interactionId = String(target.id);
    const payload = (target.payload ?? {}) as Record<string, unknown>;
    if (args.grant) {
      await withTimeout(
        (interactions as unknown as { resolve(a: unknown): Promise<unknown> }).resolve({
          interactionId,
          threadId,
          resolution: { kind: "approval", decision: "allow_once", grantedPermissions: payload.grantedPermissions ?? null },
        }),
      );
    } else {
      await withTimeout(
        (interactions as unknown as { respond(a: unknown): Promise<unknown> }).respond({
          interactionId,
          threadId,
          value: { kind: "user_answer", answers: { default: { freeText: String(args.answer ?? "") } } },
        }),
      );
    }
    ctx.ledger.add("tool", `thread_answer ${threadId}: ${args.grant ? "разрешено" : String(args.answer ?? "").slice(0, 200)}`);
    ctx.reportAction("thread_answer", args.grant ? "P" : "C", "done", args.grant ? "Разрешил агенту" : "Ответил агенту", threadId);
    return truncate({ resolved: true });
  },
};

export const brainAskTool: ToolDef = {
  name: "brain_ask",
  cls: "R",
  word: "",
  description: "Задать вопрос или задачу на анализ мозговому центру звонка (Antigravity). Мозговой центр изучает весь контекст треда и кодовую базу в изолированном worktree.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "Вопрос или аналитическая задача для мозгового центра" },
    },
    required: ["question"],
  },
  async execute(args, ctx) {
    const q = String(args.question ?? "").trim();
    if (!q) return { ok: false, error: { code: "invalid_argument", message: "укажи вопрос для мозгового центра" } };
    ctx.ledger.add("tool", `brain_ask: ${q}`);
    ctx.reportAction("brain_ask", "R", "running", `Спрашиваю у мозгового центра: «${q.slice(0, 80)}»`);
    if (!ctx.brain) {
      ctx.reportAction("brain_ask", "R", "failed", "Мозговой центр не доступен");
      return { ok: false, error: { code: "not_found", message: "мозговой центр не доступен" } };
    }
    const res = await ctx.brain.ask(q);
    if (res.ok) {
      ctx.reportAction("brain_ask", "R", "done", `Мозговой центр ответил на «${q.slice(0, 80)}»`);
    } else {
      ctx.reportAction("brain_ask", "R", "failed", "Мозговой центр не смог ответить");
    }
    return res;
  },
};

export const brainTaskTool: ToolDef = {
  name: "brain_task",
  cls: "C",
  word: "да",
  description: "Поставить задачу с изменениями (файлы, код, коммит, команды) мозговому центру в отдельном worktree. Требует подтверждения владельца «да».",
  confirmSay: (args) => `Поставить задачу мозговому центру: «${args.task}»? Скажи «да» или «отмена».`,
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Задание с изменениями: файлы, код, коммит, команды" },
    },
    required: ["task"],
  },
  async execute(args, ctx) {
    const t = String(args.task ?? "").trim();
    if (!t) return { ok: false, error: { code: "invalid_argument", message: "укажи задачу для мозгового центра" } };
    ctx.ledger.add("tool", `brain_task: ${t}`);
    ctx.reportAction("brain_task", "C", "running", `Мозговой центр выполняет: «${t.slice(0, 80)}»`);
    if (!ctx.brain) {
      ctx.reportAction("brain_task", "C", "failed", "Мозговой центр не доступен");
      return { ok: false, error: { code: "not_found", message: "мозговой центр не доступен" } };
    }
    const res = await ctx.brain.task(t, () => ctx.isTargetThreadActive?.() ?? Promise.resolve(false));
    if (res.ok) {
      ctx.reportAction("brain_task", "C", "done", `Мозговой центр выполнил: «${t.slice(0, 80)}»`);
    } else {
      const errMsg = "error" in res ? res.error.message : "ошибка";
      ctx.reportAction("brain_task", "C", "failed", `Мозговой центр не смог выполнить: ${errMsg}`);
    }
    return res;
  },
};

export const THREAD_SPECIFIC_TOOLS: ToolDef[] = [
  threadReadMessagesTool,
  threadSendTool,
  threadAnswerTool,
  brainAskTool,
  brainTaskTool,
];

export function getThreadTools(): ToolDef[] {
  const common = TOOLS.filter((t) => ["end_call", "remember", "recall"].includes(t.name));
  return [...THREAD_SPECIFIC_TOOLS, ...common];
}

export function toolByName(name: string, targetThreadId?: string): ToolDef | undefined {
  if (targetThreadId) {
    return getThreadTools().find((t) => t.name === name);
  }
  return TOOLS.find((t) => t.name === name) ?? THREAD_SPECIFIC_TOOLS.find((t) => t.name === name);
}

/** Объявления для setup в режиме native (контракт §3): behavior NON_BLOCKING. */
export function nativeDeclarations(targetThreadId?: string): unknown[] {
  const list = targetThreadId ? getThreadTools() : TOOLS.filter((t) => t.name !== "confirm_action");
  return list.map((t) => ({
    functionDeclarations: [
      {
        name: t.name,
        description: t.description,
        behavior: "NON_BLOCKING",
        parameters: t.parameters,
      },
    ],
  }));
}

/**
 * Исполнение вызова инструмента с гейтом подтверждения.
 * Возвращает результат для toolResponse (native) или для вставки [СИСТЕМА] (router).
 */
export async function runToolCall(
  def: ToolDef,
  args: Record<string, unknown>,
  functionId: string | undefined,
  ctx: ToolContext,
): Promise<{ result: ToolResult; executed: boolean }> {
  if (def.cls === "R") {
    const actionId = ctx.newActionId?.(def.name);
    const label = readActionLabel(def.name, args);
    if (label) ctx.reportAction(def.name, "R", "running", label.running, undefined, actionId);
    try {
      const result = await def.execute(args, ctx);
      if (label) {
        const threadId = result.ok ? threadIdOf(result.data) : undefined;
        const title = result.ok ? threadTitleOf(result.data) : undefined;
        const done = title && def.name === "read_thread" ? `Прочитал «${title.slice(0, 60)}»` : label.done;
        ctx.reportAction(def.name, "R", result.ok ? "done" : "failed", result.ok ? done : `${label.failed}: ${"error" in result ? result.error.message : ""}`.slice(0, 160), threadId, actionId);
      }
      return { result, executed: result.ok };
    } catch (e) {
      if (label) ctx.reportAction(def.name, "R", "failed", `${label.failed}: ${String(e)}`.slice(0, 160), undefined, actionId);
      return { result: { ok: false, error: { code: "internal", message: String(e) } }, executed: false };
    }
  }
  const say = def.confirmSay ? def.confirmSay(args) : `${def.description} Подтвердите.`;
  const cls = (def.name === "answer_interaction" || def.name === "thread_answer") && args.grant ? "P" : def.cls;
  const req = ctx.gate.request(def.name, args, cls, say);
  if ("rejected" in req) {
    return { result: { ok: false, error: { code: req.rejected, message: req.message } }, executed: false };
  }
  ctx.rememberArgs?.(req.pending.argsHash, args);
  if (req.pending.verdict === "approved") {
    // Исполняет только CallSession.onVerdict. Повторный вызов от модели отклоняем, чтобы не дублировать действие.
    return {
      result: {
        ok: false,
        error: {
          code: "already_running",
          message: "владелец подтвердил, сервер уже выполняет действие — не вызывай повторно",
        },
      },
      executed: false,
    };
  }
  return { result: { ok: false, needsConfirmation: { confirmationId: req.pending.confirmationId, say } }, executed: false };
}


/**
 * Подписи карточек для инструментов чтения: что агент делает, а не описание
 * инструмента (баг 02.11: в карточке было «Статус и последний вывод треда, усечение…»).
 * null — инструмент карточку не рисует (switch_mode, end_call рисуют свои).
 */
export function readActionLabel(
  name: string,
  args: Record<string, unknown>,
): { running: string; done: string; failed: string } | null {
  const q = (v: unknown) => String(v ?? "").trim().slice(0, 60);
  switch (name) {
    case "bb_overview":
      return { running: "Смотрю, что происходит в BB", done: "Посмотрел, что происходит в BB", failed: "Не удалось посмотреть BB" };
    case "list_threads": {
      const parts = [args.project ? `в «${q(args.project)}»` : "", args.query ? `«${q(args.query)}»` : ""].filter(Boolean).join(" ");
      return { running: `Ищу треды${parts ? ` ${parts}` : ""}`, done: `Нашёл треды${parts ? ` ${parts}` : ""}`, failed: "Не удалось найти треды" };
    }
    case "read_thread":
      return { running: `Читаю «${q(args.thread)}»`, done: `Прочитал «${q(args.thread)}»`, failed: `Не удалось прочитать «${q(args.thread)}»` };
    case "list_pending":
      return { running: "Смотрю, что ждёт ответа", done: "Посмотрел, что ждёт ответа", failed: "Не удалось получить ожидающие" };
    case "search_memory":
      return { running: `Ищу в базе знаний BB «${q(args.query)}»`, done: `Искал в базе знаний BB «${q(args.query)}»`, failed: "Поиск в базе знаний BB не удался" };
    case "recall":
      return { running: "Смотрю свою память звонков", done: "Посмотрел свою память звонков", failed: "Не удалось прочитать память звонков" };
    case "thread_read_messages":
      return { running: "Читаю сообщения треда", done: "Прочитал сообщения треда", failed: "Не удалось прочитать сообщения треда" };
    case "brain_ask":
      return { running: `Спрашиваю у мозгового центра: «${q(args.question)}»`, done: `Мозговой центр ответил на «${q(args.question)}»`, failed: "Мозговой центр не смог ответить" };
    case "brain_task":
      return { running: `Мозговой центр выполняет: «${q(args.task)}»`, done: `Мозговой центр выполнил: «${q(args.task)}»`, failed: "Мозговой центр не смог выполнить задачу" };
    default:
      return null;
  }
}

function threadIdOf(data: unknown): string | undefined {
  const d = data as { thread?: { id?: unknown } } | null;
  return d && typeof d === "object" && d.thread && typeof d.thread.id === "string" ? d.thread.id : undefined;
}

function threadTitleOf(data: unknown): string | undefined {
  const d = data as { thread?: { title?: unknown } } | null;
  return d && typeof d === "object" && d.thread && typeof d.thread.title === "string" && d.thread.title ? d.thread.title : undefined;
}

/** Человеческие названия умений для системной инструкции (что агент может сказать о себе). */
const HUMAN: Record<string, string> = {
  bb_overview: "обзор BB по проектам", list_threads: "список тредов проекта", read_thread: "прочитать тред",
  list_pending: "что ждёт ответа владельца", watch_thread: "следить за тредом и доложить", thread_updates: "что нового в треде",
  list_tasks: "задачи трекера", read_task: "прочитать задачу", search_memory: "поиск в общей базе знаний BB (не моя память звонков)",
  system_health: "состояние системы", pr_status: "статус PR", provider_status: "состояние провайдеров моделей",
  plugin_status: "состояние плагинов", skills_list: "список навыков", prompt_history: "история запросов",
  project_branches: "ветки проекта", search_all: "поиск по тредам и сообщениям", switch_mode: "сменить режим звонка",
  end_call: "завершить звонок", send_to_thread: "написать в тред агента", queue_message: "поставить сообщение в очередь треда",
  answer_interaction: "ответить агенту на вопрос", stop_thread: "остановить тред", archive_thread: "архивировать тред",
  compact_thread: "сжать контекст треда", pin_thread: "закрепить тред", thread_rename: "переименовать тред",
  thread_hide: "скрыть тред", tasks_create: "создать задачу", task_comment: "комментарий к задаче",
  task_status: "сменить статус задачи", task_due: "срок задачи", remember: "запомнить в свою память", recall: "что я помню о владельце (моя память звонков)",
  call_note: "заметка в итог звонка", start_thread: "запустить нового агента", tasks_dispatch: "раздать задачу исполнителю",
  retry_thread: "перезапустить упавший ход", stop_all_agents: "остановить всех агентов", handoff_thread: "передать тред другому агенту",
  fork_thread: "ответвить тред",
  thread_read_messages: "прочитать сообщения треда",
  thread_send: "написать в этот тред",
  thread_answer: "ответить агенту в этом треде",
  brain_ask: "вопрос или анализ мозговому центру",
  brain_task: "задание мозговому центру в отдельном worktree",
};

export function capabilityList(targetThreadId?: string): { read: string[]; confirm: string[]; launch: string[] } {
  const list = targetThreadId ? getThreadTools() : TOOLS;
  const out = { read: [] as string[], confirm: [] as string[], launch: [] as string[] };
  for (const d of list) {
    const h = HUMAN[d.name] ?? d.name;
    if (d.cls === "R") out.read.push(h);
    else if (d.cls === "L") out.launch.push(h);
    else out.confirm.push(h);
  }
  return out;
}
