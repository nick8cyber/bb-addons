/**
 * bb-plugin-external-compact (спека docs/specs/external-compact.md): настройки,
 * RPC compactThread/status, CLI `bb external-compact`.
 *
 * Ключи Gemini — secret-настройка; в логи, stdout и RPC-ответы идут только их
 * количество, никогда значения.
 */
import {
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { contract, type StatusOutput } from "./src/contract.js";
import {
  compactThread,
  ExternalCompactError,
  exportThreadHistory,
  parseGeminiKeys,
  summarizeWithGemini,
  SUMMARIZER_MODEL,
  type CompactThreadDeps,
} from "./src/external-compact.js";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    geminiApiKey: {
      type: "string",
      secret: true,
      label: "Ключи Gemini (AI Studio)",
      description: "1–2 ключа, по одному на строку (второй — фолбэк на 429)",
    },
    autoArchiveSource: {
      type: "boolean",
      default: false,
      label: "Архивировать исходный тред",
      description: "Архивировать исходный тред после успешного сжатия",
    },
  });

  const getKeys = async (): Promise<string[]> =>
    parseGeminiKeys((await settings.get()).geminiApiKey);
  const getAutoArchive = async (): Promise<boolean> =>
    (await settings.get()).autoArchiveSource ?? false;

  const collectStatus = async (): Promise<StatusOutput> => {
    const keys = await getKeys();
    return {
      ready: keys.length > 0,
      geminiKeys: keys.length,
      model: SUMMARIZER_MODEL,
      autoArchiveSource: await getAutoArchive(),
      ...(keys.length === 0
        ? { note: "geminiApiKey не настроен — задайте 1–2 ключа AI Studio в настройках плагина" }
        : {}),
    };
  };

  const deps: CompactThreadDeps = {
    getKeys,
    getAutoArchive,
    getThread: async (threadId) => {
      try {
        const [thread, defaults] = await Promise.all([
          bb.sdk.threads.get({ threadId }),
          bb.sdk.threads.defaultExecutionOptions({ threadId }).catch(() => null),
        ]);
        return {
          projectId: thread.projectId,
          environmentId: thread.environmentId,
          providerId: thread.providerId,
          model: defaults?.model ?? null,
          title: thread.title ?? thread.titleFallback ?? null,
        };
      } catch {
        return null;
      }
    },
    getUsage: async (threadId) => {
      const ctx = await bb.sdk.threads.context({ threadId }).catch(() => null);
      return ctx?.usage ?? null;
    },
    exportHistory: (threadId, upToSeq) =>
      exportThreadHistory(threadId, upToSeq == null ? {} : { upToSeq }),
    listCutSeqs: async (threadId) => {
      // Кандидаты на --up-to-seq: концы сообщений агента (item/completed с
      // item.type === "agentMessage"). Постранично по events.list.
      const seqs: number[] = [];
      let afterSeq: string | undefined;
      const PAGE = "500";
      for (;;) {
        const rows = await bb.sdk.threads.events.list({
          threadId,
          order: "asc",
          limit: PAGE,
          types: ["item/completed"],
          ...(afterSeq ? { afterSeq } : {}),
        });
        if (rows.length === 0) break;
        for (const row of rows) {
          const itemType = (row.data as { item?: { type?: string } } | undefined)?.item?.type;
          if (itemType === "agentMessage") seqs.push(row.seq);
        }
        if (rows.length < Number(PAGE)) break;
        afterSeq = String(rows[rows.length - 1].seq);
      }
      return seqs;
    },
    summarize: (history, keys) => summarizeWithGemini(history, keys),
    spawnContinuation: async (target, prompt) => {
      if (!target.projectId) {
        throw new ExternalCompactError(
          "spawn_failed",
          "у исходного треда нет проекта — продолжение создать некуда",
        );
      }
      const spawned = await bb.sdk.threads.spawn({
        projectId: target.projectId,
        ...(target.providerId ? { providerId: target.providerId } : {}),
        ...(target.model ? { model: target.model } : {}),
        environment: target.environmentId
          ? { type: "reuse" as const, environmentId: target.environmentId }
          : { type: "project-default" as const },
        title: target.title ?? undefined,
        prompt,
      });
      return spawned.id;
    },
    archiveSource: async (threadId) => {
      await bb.sdk.threads.archive({ threadId });
    },
    log: bb.log,
  };

  const runCompact = (threadId: string) => compactThread(deps, { threadId });

  bb.rpc.register(contract, {
    compactThread: async ({ threadId }) => runCompact(threadId),
    status: async () => collectStatus(),
  });

  bb.cli.register(
    defineCli({
      name: "external-compact",
      summary:
        "Сжать тред бесплатной Gemini (AI Studio) и продолжить в новом треде",
      description:
        "Экспортирует историю через `bb handoff export`, сводит её gemini-3.6-flash " +
        "и создаёт новый тред с summary первым сообщением. Исходный тред не удаляется " +
        "(архивация — настройкой autoArchiveSource, default off).",
      root: cliCommand({
        summary: "Сжать указанный тред и продолжить в новом",
        positionals: [
          { name: "threadId", description: "ID исходного треда (thr_…)", required: true },
        ],
        options: {
          json: { type: "boolean", description: "JSON-вывод результата" },
        },
        unexpectedPositionalHint:
          "Один аргумент — id треда. Подкоманда: bb external-compact status.",
        run: async ({ options, positionals }) => {
          const result = await runCompact(positionals.threadId);
          if (options.json) {
            return {
              exitCode: result.ok ? 0 : 1,
              stdout: `${JSON.stringify(result, null, 2)}\n`,
            };
          }
          if (!result.ok) {
            return { exitCode: 1, stderr: `${result.error ?? "failed"}\n` };
          }
          return {
            exitCode: 0,
            stdout: `Сжатие готово: новый тред @thread:${result.newThreadId}\n`,
          };
        },
      }),
      commands: {
        status: cliCommand({
          summary: "Проверка настройки ключа и готовности",
          options: {
            json: { type: "boolean", description: "JSON-вывод статуса" },
          },
          run: async ({ options }) => {
            const s = await collectStatus();
            if (options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify(s, null, 2)}\n` };
            }
            const lines = [
              `gemini keys: ${s.geminiKeys > 0 ? `${s.geminiKeys} key(s)` : "не настроены"}`,
              `model: ${s.model}`,
              `autoArchiveSource: ${s.autoArchiveSource ? "on" : "off"}`,
              `ready: ${s.ready ? "yes" : "no"}`,
            ];
            if (s.note) lines.push(`note: ${s.note}`);
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
      },
    }),
  );

  bb.onDispose(() => {
    bb.log.info("bb-plugin-external-compact disposed");
  });
}
