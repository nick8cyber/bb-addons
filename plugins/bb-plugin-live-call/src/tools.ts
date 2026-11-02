/**
 * ToolRegistry: объявления функций и исполнители поверх bb.sdk (контракт §4).
 * Класс подтверждения: R — сразу, C/P/L — через ConfirmationGate (спека §5).
 * Запуск агентов — класс L: только «запускай».
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { TOOL_RESULT_MAX_CHARS, TOOL_TIMEOUT_MS, type Json, type ToolClass, type ToolResult } from "./contract.js";
import { argsHash, type ConfirmationGate } from "./confirmation-gate.js";
import type { ContextLedger } from "./context-ledger.js";

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
  reportAction: (tool: string, cls: ToolClass, status: "running" | "done" | "failed" | "cancelled", summary: string, threadId?: string) => void;
  callsProjectId: () => string | null;
  /** Аргументы ожидающего подтверждения — сервер хранит их сам, модель не подменит. */
  rememberArgs?: (argsHash: string, args: Record<string, unknown>) => void;
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

function truncate(value: unknown): ToolResult {
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

/** Нечёткое сопоставление имени из речи с открытыми тредами (контракт §4). */
export async function resolveThreadRef(
  sdk: BbPluginApi["sdk"],
  ref: string,
): Promise<{ ok: true; thread: Record<string, unknown> } | { ok: false; message: string; candidates: ThreadBrief[] }> {
  const refLower = ref.trim().toLowerCase();
  const list = await sdk.threads.list({ limit: 50 });
  const threads = ((list as unknown as { threads?: Record<string, unknown>[]; items?: Record<string, unknown>[] }).threads ??
    (list as unknown as { items?: Record<string, unknown>[] }).items ??
    []) as Record<string, unknown>[];
  const exact = threads.find((t) => String(t.id ?? "").toLowerCase() === refLower);
  if (exact) return { ok: true, thread: exact };
  const matches = threads.filter((t) => String(t.title ?? "").toLowerCase().includes(refLower));
  if (matches.length === 1) return { ok: true, thread: matches[0] };
  const candidates = matches.slice(0, 3).map(briefOf);
  if (matches.length === 0) return { ok: false, message: `тред «${ref}» не найден`, candidates: [] };
  return { ok: false, message: `несколько тредов подходят под «${ref}»: ${candidates.map((c) => c.title).join("; ")}`, candidates };
}

type InteractionListResult = { interactions?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
type InteractionsArea = { list(a: { threadId: string }): Promise<InteractionListResult> };

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
    description: "Обзор BB: проекты, активные треды, ожидающие ответа, ошибки. До 10 в каждой группе.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const projects = await withTimeout(ctx.sdk.projects.list() as Promise<{ projects?: Record<string, unknown>[] }>);
      const running = await withTimeout(ctx.sdk.threads.listRunning() as Promise<{ threads?: Record<string, unknown>[] }>);
      const list = (running.threads ?? []).slice(0, 10).map(briefOf);
      return truncate({
        projects: (projects.projects ?? []).slice(0, 10).map((p) => ({ id: p.id, name: p.name })),
        running: list,
        waiting: [],
        failed: list.filter((t) => t.status === "error"),
      });
    },
  },
  {
    name: "list_threads",
    cls: "R",
    word: "",
    description: "Треды по проекту, статусу или поиску. До 15.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "имя или id проекта" },
        status: { type: "string", enum: ["active", "waiting", "error", "any"] },
        query: { type: "string", description: "поиск по названию" },
      },
    },
    async execute(args, ctx) {
      const res = await withTimeout(ctx.sdk.threads.list({ limit: 15 }) as Promise<{ threads?: Record<string, unknown>[] }>);
      let items = (res.threads ?? []).map(briefOf);
      const q = String(args.query ?? "").toLowerCase();
      if (q) items = items.filter((t) => t.title.toLowerCase().includes(q));
      const status = String(args.status ?? "any");
      if (status !== "any") {
        const map: Record<string, string> = { active: "active", waiting: "waiting", error: "error" };
        items = items.filter((t) => t.status === (map[status] ?? status));
      }
      return truncate(items.slice(0, 15));
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
      const out = await withTimeout(ctx.sdk.threads.output({ threadId: String(t.id) }) as Promise<{ output?: string; text?: string }>);
      const lastOutput = String(out.output ?? out.text ?? "").slice(0, 4000);
      return truncate({ thread: briefOf(t), lastOutput });
    },
  },
  {
    name: "list_pending",
    cls: "R",
    word: "",
    description: "Вопросы и запросы разрешений от агентов, ожидающие владельца.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const res = await withTimeout(ctx.sdk.threads.listRunning() as Promise<{ threads?: Record<string, unknown>[] }>);
      const pending: Array<{ threadId: string; title: string; kind: string; prompt: string }> = [];
      for (const t of (res.threads ?? []).slice(0, 10)) {
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
      await withTimeout(
        ctx.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text: `[голос] ${String(args.text)}`, mentions: [] }] } as never),
      );
      ctx.ledger.add("tool", `send_to_thread → ${threadId}: ${String(args.text).slice(0, 200)}`);
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
      const projects = await withTimeout(ctx.sdk.projects.list() as Promise<{ projects?: Array<Record<string, unknown>> }>);
      const ref = String(args.project ?? "").trim().toLowerCase();
      const project = (projects.projects ?? []).find(
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
      const res = await withTimeout(
        (ctx.sdk.plugins as unknown as { callRpc(a: unknown): Promise<unknown> }).callRpc({
          pluginId: "tasks",
          method: "createTask",
          input: { title: args.title, description: args.spec, project: args.project },
        } as never),
      ).catch((e: unknown) => ({ error: String(e) }));
      ctx.reportAction("tasks_create", "C", "done", `Создал задачу «${String(args.title)}»`);
      return truncate(res);
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
      const res = await withTimeout(
        (ctx.sdk.plugins as unknown as { callRpc(a: unknown): Promise<unknown> }).callRpc({
          pluginId: "tasks",
          method: "dispatch",
          input: { key: args.key, preset: args.preset },
        } as never),
      ).catch((e: unknown) => ({ error: String(e) }));
      ctx.reportAction("tasks_dispatch", "L", "done", `Раздал задачу ${String(args.key)}`);
      return truncate(res);
    },
  },
  {
    name: "search_memory",
    cls: "R",
    word: "",
    description: "Поиск по памяти BB. До 5 записей.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async execute(args, ctx) {
      const res = await withTimeout(
        (ctx.sdk.plugins as unknown as { callRpc(a: unknown): Promise<unknown> }).callRpc({
          pluginId: "memory",
          method: "search",
          input: { query: args.query, limit: 5 },
        } as never),
      ).catch((e: unknown) => ({ error: String(e) }));
      return truncate(res);
    },
  },
  {
    name: "switch_mode",
    cls: "R",
    word: "",
    description: "Переключить режим звонка: normal или extended.",
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
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Объявления для setup в режиме native (контракт §3): behavior NON_BLOCKING. */
export function nativeDeclarations(): unknown[] {
  return TOOLS.filter((t) => t.name !== "confirm_action").map((t) => ({
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
    ctx.reportAction(def.name, "R", "running", def.description);
    try {
      const result = await def.execute(args, ctx);
      ctx.reportAction(def.name, "R", result.ok ? "done" : "failed", def.description);
      return { result, executed: result.ok };
    } catch (e) {
      ctx.reportAction(def.name, "R", "failed", String(e));
      return { result: { ok: false, error: { code: "internal", message: String(e) } }, executed: false };
    }
  }
  const say = def.confirmSay ? def.confirmSay(args) : `${def.description} Подтвердите.`;
  const req = ctx.gate.request(def.name, args, def.cls, say);
  if ("rejected" in req) {
    return { result: { ok: false, error: { code: req.rejected, message: req.message } }, executed: false };
  }
  ctx.rememberArgs?.(req.pending.argsHash, args);
  if (req.pending.verdict === "approved") {
    // Кнопка «Подтвердить» или повтор голосом после verdict: исполняет сервер.
    const result = await def.execute(args, ctx);
    ctx.gate.consume(req.pending.confirmationId);
    return { result, executed: result.ok };
  }
  return { result: { ok: false, needsConfirmation: { confirmationId: req.pending.confirmationId, say } }, executed: false };
}
