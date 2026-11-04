/**
 * События window для межплагинной интеграции (контракт §15.1, §15.8).
 * В частности — интеграция с bb-plugin-sidebar-collapse.
 */

import { callEngine } from "./engine.js";
import { rpc, type ProjectCallsListResult } from "./rpc.js";

export const LIVE_CALL_PROJECTS_EVENT = "bb-live-call:projects";
export const LIVE_CALL_PROJECTS_REQUEST_EVENT = "bb-live-call:projects-request";
export const LIVE_CALL_START_PROJECT_EVENT = "bb-live-call:start-project";

export const PROJECT_POLL_INTERVAL_MS = 60_000;

let lastPublishedProjects: Array<{ projectId: string }> = [];

export function getLastPublishedProjects(): ReadonlyArray<{ projectId: string }> {
  return lastPublishedProjects;
}

/**
 * Публикация списка доступных (approved) проектов в window.
 */
export async function publishProjects(): Promise<Array<{ projectId: string }>> {
  if (typeof window === "undefined") return [];
  try {
    const list = await rpc<ProjectCallsListResult>("projectCallsList");
    const approved = (list.projects || [])
      .filter((p) => p.state === "approved")
      .map((p) => ({ projectId: p.projectId }));
    lastPublishedProjects = approved;
    window.dispatchEvent(
      new CustomEvent(LIVE_CALL_PROJECTS_EVENT, {
        detail: { projects: approved },
      }),
    );
    return approved;
  } catch {
    // В случае ошибки сервера не спамим в консоль
    return [];
  }
}

let cleanupActiveEvents: (() => void) | null = null;

/**
 * Инициализация слушателей window и таймера периодической публикации.
 * Возвращает функцию очистки (disposer).
 */
export function initProjectEvents(intervalMs = PROJECT_POLL_INTERVAL_MS): () => void {
  if (cleanupActiveEvents) {
    cleanupActiveEvents();
    cleanupActiveEvents = null;
  }
  if (typeof window === "undefined") {
    return () => {};
  }

  // 1. Немедленная публикация при старте
  void publishProjects();

  // 2. Ответ на запрос проектов от других плагинов (например, sidebar-collapse при монтировании)
  const onRequest = () => {
    void publishProjects();
  };
  window.addEventListener(LIVE_CALL_PROJECTS_REQUEST_EVENT, onRequest);

  // 3. Запуск звонка по проекту по событию из window
  const onStartProject = (event: Event) => {
    const custom = event as CustomEvent<{ projectId?: string }>;
    const projectId = custom.detail?.projectId;
    if (!projectId || typeof projectId !== "string") return;
    if (callEngine.isActive()) {
      callEngine.requestExpand();
    } else {
      callEngine.start({ projectId });
    }
  };
  window.addEventListener(LIVE_CALL_START_PROJECT_EVENT, onStartProject);

  // 4. Периодический опрос раз в 60 с
  const timer = setInterval(() => {
    void publishProjects();
  }, intervalMs);

  const cleanup = () => {
    window.removeEventListener(LIVE_CALL_PROJECTS_REQUEST_EVENT, onRequest);
    window.removeEventListener(LIVE_CALL_START_PROJECT_EVENT, onStartProject);
    clearInterval(timer);
    if (cleanupActiveEvents === cleanup) {
      cleanupActiveEvents = null;
    }
  };

  cleanupActiveEvents = cleanup;
  return cleanup;
}
