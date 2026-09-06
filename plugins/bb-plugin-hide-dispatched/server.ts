/**
 * bb-plugin-hide-dispatched — скрывает из сайдбара треды, порождённые раздачей
 * задач (bb tasks dispatch), переводя их в visibility: "hidden".
 *
 * Серверная часть. Фоновая подписка на thread.created плюс CLI `bb hide-dispatched`.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

interface KvState {
  enabled: boolean;
  tracked: string[];
  hiddenCount: number;
}

const DEFAULT_TRACKED = ["tasks"];
const KV_KEY = "hide-dispatched:state";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("bb-plugin-hide-dispatched loaded");

  const readState = async (): Promise<KvState> => {
    const state = await bb.storage.kv.get<KvState>(KV_KEY);
    return {
      enabled: state?.enabled ?? true,
      tracked: state?.tracked?.length ? state.tracked : DEFAULT_TRACKED,
      hiddenCount: state?.hiddenCount ?? 0,
    };
  };

  const writeState = async (state: KvState): Promise<void> => {
    await bb.storage.kv.set(KV_KEY, state);
  };

  const isTracked = (state: KvState, originPluginId: string | null | undefined): boolean => {
    if (!originPluginId) return false;
    return state.tracked.includes(originPluginId);
  };

  const hideThread = async (threadId: string): Promise<boolean> => {
    // Сначала запись, потом счётчик: упавший update не должен накручивать цифру.
    await bb.sdk.threads.update({ threadId, visibility: "hidden" });
    const state = await readState();
    await writeState({ ...state, hiddenCount: state.hiddenCount + 1 });
    return true;
  };

  // Фоновая подписка: прячем подходящие треды сразу при создании.
  bb.events.on("thread.created", async ({ thread }) => {
    try {
      const state = await readState();
      if (!state.enabled) return;
      if (!isTracked(state, thread.originPluginId)) return;
      if (thread.visibility === "hidden") return; // уже скрыт — ничего не пишем
      await hideThread(thread.id);
      bb.log.info(`Hidden dispatched thread ${thread.id} (originPluginId=${thread.originPluginId})`);
    } catch (err) {
      // Падение подписчика не должно ломать создание тредов.
      bb.log.error(`hide-dispatched: failed to hide thread ${thread.id}: ${(err as Error)?.message ?? String(err)}`);
    }
  });

  const renderStatus = (state: KvState) =>
    `enabled: ${state.enabled}\n` +
    `tracked originPluginIds: ${state.tracked.join(", ") || "(none)"}\n` +
    `hidden total: ${state.hiddenCount}\n`;

  bb.cli.register({
    name: "hide-dispatched",
    summary: "Automatically hide threads spawned by task dispatch (bb tasks dispatch) from the sidebar",
    commands: [
      {
        name: "status",
        summary: "Show whether hiding is on, which originPluginIds are tracked, and how many threads were hidden in total",
        usage: "bb hide-dispatched status [--json]",
      },
      {
        name: "on",
        summary: "Enable hiding of dispatched threads",
        usage: "bb hide-dispatched on [--json]",
      },
      {
        name: "off",
        summary: "Disable hiding of dispatched threads",
        usage: "bb hide-dispatched off [--json]",
      },
      {
        name: "sweep",
        summary: "Hide existing visible threads that match a tracked originPluginId (--dry-run only prints candidates)",
        usage: "bb hide-dispatched sweep [--dry-run] [--json]",
      },
    ],
    async run(argv, _ctx) {
      const json = argv.includes("--json");
      const cmd = argv.find((a) => a !== "--json");

      if (!cmd || cmd === "status") {
        const state = await readState();
        if (json) {
          return { exitCode: 0, stdout: JSON.stringify(state, null, 2) + "\n" };
        }
        return { exitCode: 0, stdout: renderStatus(state) };
      }

      if (cmd === "on" || cmd === "off") {
        const state = await readState();
        const enabled = cmd === "on";
        await writeState({ ...state, enabled });
        const result = { ...state, enabled };
        if (json) {
          return { exitCode: 0, stdout: JSON.stringify(result, null, 2) + "\n" };
        }
        return {
          exitCode: 0,
          stdout: `Hide-dispatched is now ${enabled ? "ENABLED" : "DISABLED"}.\n`,
        };
      }

      if (cmd === "sweep") {
        const dryRun = argv.includes("--dry-run");
        const state = await readState();

        // list() по умолчанию отдаёт только видимые треды. Архивные исключаем
        // явно: они и так не в сайдбаре, а скрытие мешало бы искать их в архиве.
        const threads = await bb.sdk.threads.list({ includeHidden: false, archived: false });
        const candidates = threads.filter(
          (t) => isTracked(state, t.originPluginId) && t.visibility !== "hidden",
        );

        if (dryRun) {
          const list = candidates.map((t) => ({
            id: t.id,
            originPluginId: t.originPluginId,
            visibility: t.visibility,
            title: t.title ?? t.titleFallback ?? null,
          }));
          if (json) {
            return { exitCode: 0, stdout: JSON.stringify({ dryRun: true, count: list.length, threads: list }, null, 2) + "\n" };
          }
          let out = `Dry run: ${candidates.length} candidate thread(s) would be hidden.\n`;
          for (const t of list) {
            out += `  ${t.id} (${t.title ?? "(untitled)"}) originPluginId=${t.originPluginId}\n`;
          }
          return { exitCode: 0, stdout: out };
        }

        let hiddenNow = 0;
        for (const t of candidates) {
          try {
            await hideThread(t.id);
            hiddenNow++;
          } catch (err) {
            bb.log.error(`hide-dispatched: sweep failed for ${t.id}: ${(err as Error)?.message ?? String(err)}`);
          }
        }

        const final = await readState();
        const result = { dryRun: false, hiddenNow, hiddenTotal: final.hiddenCount };
        if (json) {
          return { exitCode: 0, stdout: JSON.stringify(result, null, 2) + "\n" };
        }
        return {
          exitCode: 0,
          stdout: `Sweep: hid ${hiddenNow} thread(s). Hidden in total: ${final.hiddenCount}.\n`,
        };
      }

      return {
        exitCode: 1,
        stderr: `Unknown subcommand '${cmd}'. Commands: status, on, off, sweep [--dry-run]\n`,
      };
    },
  });

  bb.onDispose(() => {
    bb.log.info("bb-plugin-hide-dispatched disposed");
  });
}