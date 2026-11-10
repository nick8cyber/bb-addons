/**
 * Запрос на сжатие: действие в меню треда и composer-команда исполняются
 * вне React-дерева оверлея, поэтому обмен — через синглтон с подпиской
 * (useSyncExternalStore в CompactDialogHost). Модальное подтверждение —
 * обязательный шаг: история уходит в Google AI Studio (спека «Ограничения»).
 */
export interface CompactRequest {
  threadId: string;
}

let pending: CompactRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export const compactUiStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getSnapshot(): CompactRequest | null {
    return pending;
  },
  request(req: CompactRequest): void {
    pending = req;
    emit();
  },
  cancel(): void {
    if (pending === null) return;
    pending = null;
    emit();
  },
};
