/**
 * KeyPool: основной и запасной ключ (контракт §3). Ключ закреплён за сессией.
 * TPM учитывается по usageMetadata за скользящие 60 с — только чтобы предупредить
 * владельца. Смена ключа — по 429/RESOURCE_EXHAUSTED, заранее не меняем.
 */
import { TPM_WARN_THRESHOLD, TPM_WINDOW_MS } from "./contract.js";

export interface KeyPoolOptions {
  onWarning?: (message: string) => void;
  onKeySwitch?: (active: number, of: number, reason: "quota" | "unavailable") => void;
}

export class QuotaExhaustedError extends Error {
  readonly code = "quota_all_keys";
  constructor(message = "оба ключа исчерпаны по квоте") {
    super(message);
  }
}

export class KeyPool {
  private keys: string[];
  private activeIndex = 0;
  /** Скользящее окно токенов: [время, токены]. */
  private usage: Array<{ at: number; tokens: number }> = [];
  private warned = false;
  private exhausted = new Set<number>();

  constructor(keys: string[], private opts: KeyPoolOptions = {}) {
    this.keys = keys.filter((k) => k.trim().length > 0);
    if (this.keys.length === 0) throw new Error("нет ключей Gemini");
  }

  get count(): number {
    return this.keys.length;
  }

  get active(): number {
    return this.activeIndex + 1;
  }

  get of(): number {
    return this.keys.length;
  }

  key(index = this.activeIndex): string {
    return this.keys[index];
  }

  get activeKey(): string {
    return this.key(this.activeIndex);
  }

  get extendedNeedsBoth(): boolean {
    // В extended VOICE и ROUTER идут на разных ключах, запаса нет (контракт §1).
    return this.keys.length >= 2;
  }

  /** Учёт usageMetadata от Gemini. */
  addUsage(promptTokens: number, at = Date.now()) {
    this.usage.push({ at, tokens: promptTokens });
    this.usage = this.usage.filter((u) => at - u.at < TPM_WINDOW_MS);
    const total = this.usage.reduce((a, u) => a + u.tokens, 0);
    if (total > TPM_WARN_THRESHOLD && !this.warned) {
      this.warned = true;
      this.opts.onWarning?.(
        `разговор упирается в лимит 60 тыс. токенов/мин: сейчас ${total}`,
      );
    }
    if (total <= TPM_WARN_THRESHOLD) this.warned = false;
  }

  tpm(): number {
    return this.usage.reduce((a, u) => a + u.tokens, 0);
  }

  /**
   * Переход на запасной ключ. Возврат: индекс нового активного ключа.
   * Бросает QuotaExhaustedError, если запасного нет или он тоже исчерпан.
   */
  switchOnQuota(): number {
    this.exhausted.add(this.activeIndex);
    const next = this.keys.findIndex((_, i) => !this.exhausted.has(i));
    if (next === -1) throw new QuotaExhaustedError();
    this.activeIndex = next;
    this.usage = [];
    this.warned = false;
    this.opts.onKeySwitch?.(this.active, this.of, "quota");
    return this.activeIndex;
  }

  /** Псевдоним ротации ключей при квоте. */
  rotate(): number {
    return this.switchOnQuota();
  }

  /** Новый звонок: основной ключ, счётчики квоты сбрасывать не нужно в рамках звонка. */
  reset(): void {
    this.activeIndex = 0;
    this.exhausted.clear();
    this.usage = [];
    this.warned = false;
  }
}
