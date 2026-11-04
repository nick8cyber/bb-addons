/**
 * EventBridge: подписка на события BB по «наблюдаемым» тредам (спека §4).
 * События встают в очередь и вбрасываются в модель только в паузе:
 * нет речи владельца и модель в IDLE. Кеш pending — из realtime-события
 * interaction.pending (глобального списка в SDK нет, контракт §4).
 */
export interface PendingCacheRow {
  threadId: string;
  title: string;
  kind: "question" | "permission";
  prompt: string;
}

export class EventBridge {
  private watched = new Set<string>();
  private queue: Array<{ kind: "thread.idle" | "thread.failed" | "interaction.pending"; threadId: string; summary: string }> = [];
  private pendingCache = new Map<string, PendingCacheRow>();
  private modelBusy = false;
  private ownerSpeaking = false;

  watch(threadId: string) {
    this.watched.add(threadId);
  }

  isWatching(threadId: string): boolean {
    return this.watched.has(threadId);
  }

  unwatch(threadId: string) {
    this.watched.delete(threadId);
    this.pendingCache.delete(threadId);
  }

  /** Сброс слежения и очереди при завершении звонка (§16.4). */
  reset(): void {
    this.watched.clear();
    this.queue = [];
  }

  setModelBusy(busy: boolean) {
    this.modelBusy = busy;
  }

  setOwnerSpeaking(speaking: boolean) {
    this.ownerSpeaking = speaking;
  }

  onThreadIdle(threadId: string, summary: string) {
    if (!this.watched.has(threadId)) return;
    this.queue.push({ kind: "thread.idle", threadId, summary });
  }

  onThreadFailed(threadId: string, summary: string) {
    if (!this.watched.has(threadId)) return;
    this.queue.push({ kind: "thread.failed", threadId, summary });
  }

  onInteractionPending(threadId: string, title: string, kind: "question" | "permission", prompt: string) {
    this.pendingCache.set(threadId, { threadId, title, kind, prompt });
    if (!this.watched.has(threadId)) return;
    this.queue.push({ kind: "interaction.pending", threadId, summary: `${title}: ${prompt.slice(0, 200)}` });
  }

  pendingSnapshot(): PendingCacheRow[] {
    return [...this.pendingCache.values()];
  }

  /** Очередь, которую CallSession дренирует в паузе. */
  drain(): Array<{ kind: string; threadId: string; summary: string; queued: boolean }> {
    const out = this.queue;
    this.queue = [];
    return out.map((e) => ({ ...e, queued: out.length > 1 }));
  }

  /** Можно ли вбрасывать: модель не говорит и владелец молчит. */
  get canInject(): boolean {
    return !this.modelBusy && !this.ownerSpeaking;
  }
}
