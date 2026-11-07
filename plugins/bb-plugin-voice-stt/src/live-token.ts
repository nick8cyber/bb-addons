/**
 * Одноразовые токены для WS `/live-voice` (спека voice-stt-live §4.1):
 * TTL 30 с, погашается при первом hello. Хранилище in-memory — токен нужен
 * только между RPC `liveToken` и первым кадром сокета.
 */
import { randomUUID } from "node:crypto";

export const LIVE_TOKEN_TTL_MS = 30_000;

export class LiveTokenStore {
  private readonly tokens = new Map<string, number>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = LIVE_TOKEN_TTL_MS,
  ) {}

  /** Выпускает токен; заодно выметает просроченные. */
  issue(): string {
    this.sweep();
    const token = randomUUID();
    this.tokens.set(token, this.now() + this.ttlMs);
    return token;
  }

  /**
   * Одноразовая проверка: валидный токен погашается сразу, повторное hello
   * с ним уже не пройдёт. Просроченный/неизвестный → false.
   */
  consume(token: string): boolean {
    const expiresAt = this.tokens.get(token);
    if (expiresAt === undefined) return false;
    this.tokens.delete(token);
    return this.now() < expiresAt;
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, expiresAt] of this.tokens) {
      if (now >= expiresAt) this.tokens.delete(token);
    }
  }
}
