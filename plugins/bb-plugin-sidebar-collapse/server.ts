import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  bb.settings.define({
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
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
