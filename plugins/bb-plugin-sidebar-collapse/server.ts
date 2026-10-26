import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Project drag-and-drop is not part of the frontend sidebar API, so the list
 *  hands the move to the backend, which owns `bb.sdk`. */
export const rpcContract = defineRpcContract({
  show_native_list: {
    input: z.object({}).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  reorder_project: {
    input: z.object({
      projectId: z.string().min(1),
      previousProjectId: z.string().min(1).nullable(),
      nextProjectId: z.string().min(1).nullable(),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
});

export async function selectThreadList(bb: BbPluginApi, collapsed: boolean, isDisposed = () => false) {
  if (isDisposed()) return false;
  const key = "sidebar.threadListProvider";
  const current = (await bb.sdk.system.uiPreferences.list()).preferences[key];
  const ours = "sidebar-collapse/collapsed", native = "thread-list/thread-list";
  const target = collapsed ? ours : native;
  // A deliberate selection of another plugin belongs to the user.
  if (current.value === target || !["", "auto", "__automatic__", ours, native].includes(current.value) || isDisposed()) return false;
  await bb.sdk.system.uiPreferences.set({key, value: target, expectedRevision: current.revision});
  return true;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    // Off switch reachable without a browser:
    // `bb plugin config sidebar-collapse set useCollapsedList false` hands the
    // sidebar back to bb's own list while leaving the plugin installed.
    useCollapsedList: {
      type: "boolean",
      label: "Use the collapsed sidebar list",
      description:
        "Выключи, чтобы вернуть родной список тредов bb, не удаляя плагин.",
      default: true,
    },
    visibleThreads: {
      type: "number",
      label: "Chats shown per project",
      description:
        "Сколько чатов проекта видно до нажатия «Ещё N». 0 — показывать все.",
      default: 5,
    },
    keepAttention: {
      type: "boolean",
      label: "Always show chats waiting for you",
      description:
        "Не скрывать под «Ещё N» чаты, которые ждут ответа или упали с ошибкой.",
      default: true,
    },
    unreadFirst: {
      type: "boolean",
      label: "Непрочитанные сверху",
      description:
        "В каждом проекте показывать ветки с непрочитанными чатами выше прочитанных. Закреплённые остаются первыми.",
      default: false,
    },
    showBranchName: {
      type: "boolean",
      label: "Show the git branch in a row",
      description:
        "Дописывать в строку чата имя ветки его окружения. Родной список bb ветку не показывает.",
      default: false,
    },
    hideNavigationRail: {
      type: "boolean",
      label: "Скрыть полосу навигации",
      description: "Скрывает узкую полосу Home/Tasks/More в развёрнутом списке чатов. Настройки доступны через шестерёнку Sidebar Collapse внизу. Нативный Top list BB не меняет.",
      default: false,
    },
    showThreadCount: {
      type: "boolean",
      label: "Show the chat count next to a project",
      description: "Дописывать в заголовок проекта число его корневых чатов.",
      default: false,
    },
  });

  let disposed = false;
  let selection = Promise.resolve();
  const select = (collapsed: boolean) => {
    selection = selection.catch(() => {}).then(async () => {
      await selectThreadList(bb, collapsed, () => disposed);
    });
    return selection;
  };
  settings.onChange((next, previous) => {
    if (next.useCollapsedList !== previous.useCollapsedList) {
      void select(next.useCollapsedList).catch(error => {
        if (!disposed) bb.log.warn("Could not select sidebar list: " + String(error));
      });
    }
  });

  bb.rpc.register(rpcContract, {
    show_native_list: async () => {
      await settings.experimental_set({ useCollapsedList: false });
      await select(false);
      return { ok: true } as const;
    },
    reorder_project: async ({ projectId, previousProjectId, nextProjectId }) => {
      await bb.sdk.projects.reorder({
        projectId,
        previousProjectId,
        nextProjectId,
      });
      return { ok: true } as const;
    },
  });

  bb.onDispose(() => {
    disposed = true;
    bb.log.info("disposed");
  });
}
