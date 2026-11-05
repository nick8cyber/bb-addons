import * as sdk from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";

/**
 * BB 0.48 still supports these public runtime hooks for existing plugins, while
 * SDK 0.6.104 omits their retired TypeScript declarations. Keep the narrow
 * compatibility boundary here: native confirmations/navigation remain host-owned.
 */
export interface SidebarRowActions {
  open(threadId: string, options?: { split?: boolean }): void;
  openNewThread(options?: { projectId?: string; focusPrompt?: boolean }): void;
  setPinned(threadId: string, pinned: boolean): Promise<void>;
  setRead(threadId: string, read: boolean): Promise<void>;
  rename(threadId: string, title: string): Promise<void>;
  archive(threadId: string): void;
  requestDelete(threadId: string): void;
}
export function useSidebarRowActions(): SidebarRowActions {
  const runtime = sdk as typeof sdk & { experimental_useSidebarThreadActions(): SidebarRowActions };
  return runtime.experimental_useSidebarThreadActions();
}
export function registerHeaderControl(app: PluginAppBuilder, registration: {
  id: string; title: string; component: ComponentType<{ threadId: string }>;
}): void {
  const slots = app.slots as typeof app.slots & {
    experimental_threadHeaderAction(value: typeof registration): void;
  };
  slots.experimental_threadHeaderAction(registration);
}
