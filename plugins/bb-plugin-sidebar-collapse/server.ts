import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  bb.settings.define({
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
        "Сколько чатов проекта видно до нажатия «Show more». 0 — показывать все.",
      default: 5,
    },
    keepAttention: {
      type: "boolean",
      label: "Always show chats waiting for you",
      description:
        "Не скрывать под «Show more» чаты, которые ждут ответа или упали с ошибкой.",
      default: true,
    },
    showBranchName: {
      type: "boolean",
      label: "Show the git branch in a row",
      description:
        "Дописывать в строку чата имя ветки его окружения. Родной список bb ветку не показывает.",
      default: false,
    },
    showThreadCount: {
      type: "boolean",
      label: "Show the chat count next to a project",
      description:
        "Дописывать в заголовок проекта число его корневых чатов.",
      default: false,
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
