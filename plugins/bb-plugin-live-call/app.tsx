/**
 * Фронтенд live-call (контракт §15.1, §15.8).
 * Входы в звонок:
 * - иконка в футере сайдбара «Позвонить координатору» и Mod+Shift+L (без изменений)
 * - кнопка в шапке треда «Звонок по треду» (иконка телефона)
 * - действие в панели нового треда «Позвонить по проекту» (experimental_newThreadPanelAction)
 * - команда палитры «Live Call: позвонить по проекту» с выбором проекта
 * - события window: bb-live-call:projects и bb-live-call:start-project
 * - оверлей CallOverlay и экран SettingsSection с подтверждением diff реестра
 */
import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";

import { CallOverlay } from "./src/ui/CallOverlay.js";
import { Icon } from "./src/ui/icons.js";
import { SettingsSection } from "./src/ui/SettingsSection.js";
import { callEngine } from "./src/ui/engine.js";
import { initProjectEvents } from "./src/ui/project-events.js";
import { rpc, type ProjectCallsListResult } from "./src/ui/rpc.js";

const PHONE_ICON = "live-call/phone";

/** Пропсы слота experimental_threadHeaderAction (в типах SDK 0.6 слот legacy и не объявлен, рантайм хоста его принимает). */
interface ThreadHeaderActionProps {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}

/** Кнопка звонка по треду в шапке: нативный threadAction/placement "header" рисует только label без иконки (контракт §12). */
function ThreadCallButton({ threadId, isCompactViewport }: ThreadHeaderActionProps) {
  return (
    <button
      type="button"
      title="Звонок по треду"
      aria-label="Звонок по треду"
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-foreground hover:bg-state-hover"
      onClick={() => (callEngine.isActive() ? callEngine.requestExpand() : callEngine.start({ threadId }))}
    >
      <Icon name="phone" size={14} />
      {isCompactViewport ? null : <span>Звонок по треду</span>}
    </button>
  );
}

/** Нет звонка — позвонить; звонок идёт — развернуть док. */
const callOrFocus = () => (callEngine.isActive() ? callEngine.requestExpand() : callEngine.start());

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "live-call", component: CallOverlay });

  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "call",
    label: "Позвонить координатору",
    icon: PHONE_ICON,
    onActivate: callOrFocus,
  });

  (app.slots as unknown as {
    experimental_threadHeaderAction(registration: {
      id: string;
      title: string;
      component: ComponentType<ThreadHeaderActionProps>;
    }): void;
  }).experimental_threadHeaderAction({
    id: "call",
    title: "Звонок по треду",
    component: ThreadCallButton,
  });

  // Действие панели создания треда «Позвонить по проекту» (§15.1 п. 1)
  app.slots.experimental_newThreadPanelAction({
    id: "call-project",
    title: "Позвонить по проекту",
    icon: PHONE_ICON,
    component: () => null,
    run: async (context) => {
      const projectId = context.projectId;
      if (!projectId) {
        callEngine.showNotice("звонок для проекта не настроен");
        return;
      }
      try {
        const res = await rpc<ProjectCallsListResult>("projectCallsList");
        const project = (res.projects || []).find((p) => p.projectId === projectId);
        if (!project) {
          callEngine.showNotice("звонок для проекта не настроен");
          return;
        }
        // pending звонит по прежнему подтверждённому реестру; голос сам скажет подтвердить (§15.8)
        if (project.state === "approved" || project.state === "pending") {
          if (callEngine.isActive()) {
            callEngine.requestExpand();
          } else {
            callEngine.start({ projectId });
          }
        } else {
          callEngine.showNotice("звонок для проекта не настроен");
        }
      } catch {
        callEngine.showNotice("звонок для проекта не настроен");
      }
    },
  });

  // Обычный звонок координатору в один клик (Mod+Shift+L) — без изменений (§15.1 п. 3)
  app.commands.register({
    id: "call-toggle",
    title: "Live Call: позвонить / завершить звонок",
    defaultShortcut: { key: "l", mod: true, shift: true },
    run: () => (callEngine.isActive() ? callEngine.end() : callEngine.start()),
  });

  // Команда «Live Call: позвонить по проекту» с выбором проекта (§15.1 п. 2)
  app.commands.register({
    id: "call-project",
    title: "Live Call: позвонить по проекту",
    run: async () => {
      try {
        const res = await rpc<ProjectCallsListResult>("projectCallsList");
        const approved = (res.projects || []).filter((p) => p.state === "approved" || p.state === "pending");
        if (approved.length === 0) {
          callEngine.showNotice("звонок для проекта не настроен");
          return;
        }
        callEngine.openProjectPicker(approved.map((p) => ({ projectId: p.projectId, title: p.title || p.projectId })));
      } catch {
        callEngine.showNotice("звонок для проекта не настроен");
      }
    },
  });

  app.slots.settingsSection({
    id: "live-call",
    title: "Live Call",
    description: "Голосовой звонок с координатором BB через Gemini Live API. Ключи, голос и лимиты — в этом разделе.",
    component: SettingsSection,
  });

  // Инициализация событий window §15.1
  initProjectEvents();
});
