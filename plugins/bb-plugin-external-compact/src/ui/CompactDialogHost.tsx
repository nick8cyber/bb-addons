/**
 * Оверлей с модальным подтверждением отправки истории в AI Studio
 * (спека «Поток» п. 6, «Ограничения»: предупреждение в UI). По «Продолжить»
 * — rpc compactThread; ход операции и ссылка на новый тред — toast (sonner).
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { contract } from "../contract.js";
import { SUMMARIZER_MODEL } from "../external-compact.js";
import { compactUiStore } from "./compactUiStore.js";

const TOAST_ID = "external-compact";

export function CompactDialogHost() {
  const pending = useSyncExternalStore(compactUiStore.subscribe, compactUiStore.getSnapshot);
  const rpc = useRpc<typeof contract>();
  const navigate = useBbNavigate();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (pending === null) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") compactUiStore.cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  const run = useCallback(async () => {
    const req = compactUiStore.getSnapshot();
    compactUiStore.cancel();
    if (req === null) return;
    toast.loading("Сжатие через Gemini запущено…", {
      id: TOAST_ID,
      description: `История уходит в Google AI Studio (${SUMMARIZER_MODEL})`,
    });
    try {
      const result = await rpc.call("compactThread", { threadId: req.threadId });
      if (result.ok && result.newThreadId) {
        const newThreadId = result.newThreadId;
        toast.success("Сжатие готово", {
          id: TOAST_ID,
          description: "Продолжение создано в новом треде",
          action: { label: "Открыть", onClick: () => navigate.toThread(newThreadId) },
        });
      } else {
        toast.error("Сжатие не удалось", {
          id: TOAST_ID,
          description: result.error ?? "unknown",
        });
      }
    } catch (e) {
      toast.error("Сжатие не удалось", {
        id: TOAST_ID,
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [rpc, navigate]);

  if (pending === null) return null;

  return (
    <div className="ec-overlay" role="presentation" onClick={() => compactUiStore.cancel()}>
      <div
        className="ec-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ec-dialog-title"
        aria-describedby="ec-dialog-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="ec-dialog-title" className="ec-dialog-title">
          Compact via Gemini (free)
        </h2>
        <p id="ec-dialog-desc" className="ec-dialog-desc">
          История сессии будет отправлена в Google AI Studio через {SUMMARIZER_MODEL}. Не
          используйте для тредов с закрытыми секретами. Продолжить?
        </p>
        <div className="ec-dialog-actions">
          <button
            type="button"
            className="ec-btn"
            onClick={() => compactUiStore.cancel()}
          >
            Отмена
          </button>
          <button
            type="button"
            ref={confirmRef}
            className="ec-btn ec-btn--primary"
            onClick={() => void run()}
          >
            Продолжить
          </button>
        </div>
      </div>
    </div>
  );
}
