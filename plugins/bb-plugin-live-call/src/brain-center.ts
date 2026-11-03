/**
 * Мозговой центр звонка по треду (контракт §12.11).
 * Скрытый тред agy (gemini-3.8-flash-medium) в отдельном worktree.
 * Готовит глубокую сводку переписки и отвечает на вопросы / выполняет задания.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CallStore } from "./call-store.js";
import { fetchThreadMessages, formatAllThreadMessagesText, type ThreadMessage } from "./thread-messages.js";
import { truncate } from "./tools.js";
import type { ToolResult } from "./contract.js";

export interface BrainCenterOptions {
  sdk: BbPluginApi["sdk"];
  store: CallStore;
  callId: string;
  targetThreadId: string;
  targetThreadTitle: string;
  targetProjectId: string;
  targetHostId?: string;
  targetBranchName?: string;
  isGitRepo?: boolean;
  allMessages: ThreadMessage[];
  storageDir: string;
  log?: { info(s: string): void; warn(s: string): void; error(s: string): void };
}

export class BrainCenter {
  threadId: string | null = null;
  /** Изменения разрешены только в отдельном worktree (§12.11 п.1). Не-git проект или worktree не создался → false. */
  canModify = false;
  lastWorktreePath: string | null = null;
  summary: string | null = null;
  summaryMs: number | null = null;
  summaryTimedOut = false;
  startedAt = 0;
  private closed = false;

  onSummaryReady?: (summaryText: string, ms: number) => void;
  onSummaryTimeout?: () => void;

  constructor(private opts: BrainCenterOptions) {}

  async start(): Promise<string | null> {
    // Не-git проект: worktree быть не может, общая папка проекта запрещена (§12.11 п.1).
    // Мозговой центр идёт в отдельную пустую папку (workspace personal): сводка и вопросы работают
    // по файлу переписки, изменений проекта нет (canModify=false). Решение владельца 03.11.
    this.startedAt = Date.now();
    try {
      mkdirSync(this.opts.storageDir, { recursive: true });
      const historyFile = join(this.opts.storageDir, `brain-history-${this.opts.callId}.txt`);
      const allText = formatAllThreadMessagesText(this.opts.allMessages);
      writeFileSync(historyFile, allText, "utf8");

      const prompt = `Ты — мозговой центр голосового звонка по треду «${this.opts.targetThreadTitle}» в BB.
Твоя роль — Staff Engineer / технический координатор.

Вся переписка треда сохранена в файле:
${historyFile}

Прочитай этот файл и быстро подготовь ёмкую выжимку по треду (150–200 слов):
1. Цель треда.
2. Что сделано.
3. На чём остановились.
4. Что ждёт владельца (вопросы, согласования, блокеры).
5. Открытые вопросы.

Отвечай предельно ёмко, естественно и технически точно, без списков и markdown-разметки (твой ответ будет сразу пересказан голосом).
После составления сводки жди следующих вопросов.${this.opts.isGitRepo ? "" : "\n\nВАЖНО: ты работаешь в отдельной пустой папке, файлов проекта здесь нет — только переписка треда в файле выше. Изменения проекта недоступны: файлы проекта не ищи и не трогай, только анализируй переписку и отвечай."}`;

      const environment = this.opts.isGitRepo
        ? {
            type: "host" as const,
            ...(this.opts.targetHostId ? { hostId: this.opts.targetHostId } : {}),
            workspace: {
              type: "managed-worktree" as const,
              baseBranch: this.opts.targetBranchName
                ? { kind: "named" as const, name: this.opts.targetBranchName }
                : { kind: "default" as const },
            },
          }
        : {
            type: "host" as const,
            ...(this.opts.targetHostId ? { hostId: this.opts.targetHostId } : {}),
            workspace: { type: "personal" as const },
          };

      let spawned: { id: string };
      try {
        spawned = (await this.opts.sdk.threads.spawn({
          projectId: this.opts.targetProjectId,
          providerId: "agy",
          model: "gemini-3.8-flash-medium",
          visibility: "hidden",
          title: `🧠 Мозговой центр: ${this.opts.targetThreadTitle}`,
          environment,
          prompt,
        } as never)) as unknown as { id: string };
      } catch (e) {
        // Без отдельного worktree мозговой центр НЕ запускается в общей папке проекта (§12.11 п.1).
        this.opts.log?.warn?.(`brain spawn failed, no fallback to project folder: ${String(e)}`);
        this.opts.store.event(this.opts.callId, "brain_failed", { error: String(e).slice(0, 300) });
        return null;
      }
      this.canModify = Boolean(this.opts.isGitRepo);

      this.threadId = String(spawned.id);
      this.opts.store.event(this.opts.callId, "brain_started", { threadId: this.threadId });

      // Ожидание начальной сводки до 60 с
      void this.waitInitialSummary();

      return this.threadId;
    } catch (e) {
      this.opts.log?.error?.(`BrainCenter start failed: ${String(e)}`);
      return null;
    }
  }

  private async waitInitialSummary(): Promise<void> {
    if (!this.threadId) return;
    const threadId = this.threadId;
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished && !this.closed) {
        this.summaryTimedOut = true;
        this.opts.log?.warn?.(`BrainCenter summary timed out after 60s for ${threadId}`);
        this.onSummaryTimeout?.();
      }
    }, 60_000);

    try {
      await this.waitForIdle(threadId, 60_000);
      if (this.closed) return;
      finished = true;
      clearTimeout(timer);
      await this.getWorktreePath();
      const ms = Date.now() - this.startedAt;
      this.summaryMs = ms;
      const out = (await this.opts.sdk.threads.output({ threadId }).catch(() => null)) as unknown as { output?: string | null } | null;
      this.summary = String(out?.output ?? "").trim();
      this.opts.store.event(this.opts.callId, "brain_summary", { ms, chars: this.summary.length });
      this.onSummaryReady?.(this.summary, ms);
    } catch (e) {
      if (!finished && !this.closed) {
        clearTimeout(timer);
        this.opts.log?.warn?.(`BrainCenter waitInitialSummary error: ${String(e)}`);
        this.onSummaryTimeout?.();
      }
    }
  }

  async ask(question: string): Promise<ToolResult> {
    if (!this.threadId) {
      return { ok: false, error: { code: "not_found", message: "мозговой центр не запущен" } };
    }
    const threadId = this.threadId;
    const startTs = Date.now();
    try {
      // Дожидаемся готовности треда (завершения начальной сводки или предыдущего хода)
      await this.waitForIdle(threadId, 60_000);

      await this.opts.sdk.threads.send({
        threadId,
        mode: "start",
        input: [{ type: "text", text: question, mentions: [] }],
      } as never);

      await this.waitForIdle(threadId, 120_000);
      const ms = Date.now() - startTs;
      const out = (await this.opts.sdk.threads.output({ threadId }).catch(() => null)) as unknown as { output?: string | null } | null;
      let text = String(out?.output ?? "").trim();
      if (!text) {
        const msgs = await fetchThreadMessages(this.opts.sdk, threadId).catch(() => []);
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "agent" && msgs[i].text.trim()) {
            text = msgs[i].text.trim();
            break;
          }
        }
      }
      this.opts.store.event(this.opts.callId, "brain_answer", { tool: "brain_ask", ms });
      return truncate({ answer: text, ms });
    } catch (e) {
      const ms = Date.now() - startTs;
      this.opts.log?.warn?.(`BrainCenter ask error: ${String(e)}`);
      return { ok: false, error: { code: "timeout", message: `мозговой центр не ответил вовремя (${ms} мс)` } };
    }
  }

  async task(taskDescription: string, checkTargetActive: () => Promise<boolean>): Promise<ToolResult> {
    if (!this.canModify) {
      return { ok: false, error: { code: "changes_unavailable", message: "изменения недоступны: у мозгового центра нет отдельной копии репозитория (проект не git или копия не создалась). Вопросы задавать можно." } };
    }
    if (!this.threadId) {
      return { ok: false, error: { code: "not_found", message: "мозговой центр не запущен" } };
    }
    const targetActive = await checkTargetActive().catch(() => false);
    if (targetActive) {
      return {
        ok: false,
        error: {
          code: "target_active",
          message: "агент треда сейчас работает — передать задачу ему?",
        },
      };
    }
    const threadId = this.threadId;
    const startTs = Date.now();
    try {
      // Дожидаемся готовности треда (завершения начальной сводки или предыдущего хода)
      await this.waitForIdle(threadId, 60_000);

      await this.opts.sdk.threads.send({
        threadId,
        mode: "start",
        input: [{ type: "text", text: taskDescription, mentions: [] }],
      } as never);

      await this.waitForIdle(threadId, 120_000);
      const ms = Date.now() - startTs;
      const out = (await this.opts.sdk.threads.output({ threadId }).catch(() => null)) as unknown as { output?: string | null } | null;
      let text = String(out?.output ?? "").trim();
      if (!text) {
        const msgs = await fetchThreadMessages(this.opts.sdk, threadId).catch(() => []);
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "agent" && msgs[i].text.trim()) {
            text = msgs[i].text.trim();
            break;
          }
        }
      }
      this.opts.store.event(this.opts.callId, "brain_answer", { tool: "brain_task", ms });
      return truncate({ result: text, ms });
    } catch (e) {
      const ms = Date.now() - startTs;
      this.opts.log?.warn?.(`BrainCenter task error: ${String(e)}`);
      return { ok: false, error: { code: "timeout", message: `мозговой центр не выполнил задачу (${ms} мс): ${String((e as Error)?.message ?? e)}` } };
    }
  }

  async getWorktreePath(): Promise<string | null> {
    if (!this.threadId) return this.lastWorktreePath;
    const res = (await this.opts.sdk.threads.get({ threadId: this.threadId }).catch(() => null)) as unknown as {
      environment?: { path?: string };
    } | null;
    const p = res?.environment?.path ?? null;
    if (p) this.lastWorktreePath = p;
    return p;
  }

  private async waitForIdle(threadId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const waitArea = this.opts.sdk.threads as unknown as { wait?(a: { threadId: string; status: string; timeoutMs?: number }): Promise<unknown> };
    if (typeof waitArea?.wait === "function") {
      try {
        await waitArea.wait({ threadId, status: "idle", timeoutMs });
        return;
      } catch {
        // Fallback на poll
      }
    }

    while (Date.now() < deadline) {
      if (this.closed) return;
      await new Promise((r) => setTimeout(r, 1000));
      const res = (await this.opts.sdk.threads.get({ threadId }).catch(() => null)) as unknown as {
        thread?: { status?: string };
        status?: string;
      } | null;
      const st = res?.thread?.status ?? res?.status;
      if (st === "idle" || st === "error") {
        return;
      }
    }
    throw new Error(`waitForIdle timed out after ${timeoutMs}ms`);
  }

  async archive(): Promise<void> {
    this.closed = true;
    if (!this.threadId) return;
    const id = this.threadId;
    this.threadId = null;
    try {
      await this.opts.sdk.threads.stop({ threadId: id }).catch(() => {});
      await this.opts.sdk.threads.archive({ threadId: id }).catch(() => {});
      this.opts.log?.info?.(`Archived brain center thread ${id}`);
    } catch (e) {
      this.opts.log?.warn?.(`Failed to archive brain center thread ${id}: ${String(e)}`);
    }
  }
}
