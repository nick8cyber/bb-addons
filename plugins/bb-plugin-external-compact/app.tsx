/**
 * Фронтенд external-compact (спека docs/specs/external-compact.md, «Поток»
 * п. 6):
 * - действие «Compact via Gemini (free)» в меню треда → модальное
 *   предупреждение об отправке истории в AI Studio → rpc compactThread;
 * - та же команда в палитре композера;
 * - бейдж протухшего кэша на строке треда (experimental_threadRowMetadata).
 * Не автомат — решение владельца, как у штатного тоггла.
 */
import "./app.css";
import { toast } from "sonner";
import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS,
} from "@get-bb/plugin-sdk/app";

import { CacheBadge, useCacheBadgeData } from "./src/ui/cacheBadge.js";
import { CompactDialogHost } from "./src/ui/CompactDialogHost.js";
import { compactUiStore } from "./src/ui/compactUiStore.js";

export default definePluginApp((app) => {
  // Диалог подтверждения и запуск rpc живут в оверлее — единая точка для
  // меню треда и composer-команды.
  app.slots.experimental_appOverlay({
    id: "external-compact",
    component: CompactDialogHost,
  });

  app.slots.experimental_threadAction({
    id: "compact-via-gemini",
    title: "Compact via Gemini (free)",
    icon: "Shrink",
    group: experimental_THREAD_ACTION_GROUPS.lifecycle,
    item: ({ thread }) => ({
      label: "Compact via Gemini (free)",
      icon: "Shrink",
      run: () => {
        compactUiStore.request({ threadId: thread.id });
      },
    }),
  });

  app.composer.experimental_registerCommand({
    id: "compact-via-gemini",
    title: "Compact via Gemini (free)",
    run: ({ composer }) => {
      if (composer.scope.kind !== "thread") {
        toast.error("Сжатие доступно в композере открытого треда");
        return;
      }
      compactUiStore.request({ threadId: composer.scope.threadId });
    },
  });

  app.slots.experimental_threadRowMetadata({
    id: "cache-expired",
    useData: useCacheBadgeData,
    component: CacheBadge,
  });
});
