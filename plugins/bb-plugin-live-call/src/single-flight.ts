/**
 * Один вопрос мозговому центру за раз (спека §7.2.6): совпадающий вопрос или его
 * продолжение присоединяется к незавершённому и получает тот же ответ (карточка
 * одна, ход в тред мозгового центра один); другой вопрос ждёт в очереди и уходит
 * после ответа на текущий.
 */
import type { ToolResult } from "./contract.js";

/** Совпадение или продолжение: один вопрос — префикс другого после нормализации. */
export function sameBrainQuestion(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  return x.length > 0 && y.length > 0 && (x === y || x.startsWith(y) || y.startsWith(x));
}

interface PendingAsk {
  question: string;
  callIds: string[];
  settled: boolean;
  promise: Promise<ToolResult>;
}

export class QuestionFlight {
  private asks: PendingAsk[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  /** Новый вызов присоединился бы к незавершённому вопросу (текущему или ждущему). */
  willJoin(question: string): boolean {
    return this.asks.some((a) => !a.settled && sameBrainQuestion(a.question, question));
  }

  ask(
    question: string,
    callId: string | undefined,
    run: (callIds: string[]) => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const match = this.asks.find((a) => !a.settled && sameBrainQuestion(a.question, question));
    if (match) {
      if (callId) match.callIds.push(callId);
      return match.promise;
    }
    const box: PendingAsk = {
      question,
      callIds: callId ? [callId] : [],
      settled: false,
      promise: undefined as never,
    };
    const p = this.tail.then(async () => {
      try {
        return await run(box.callIds);
      } finally {
        box.settled = true;
        this.asks = this.asks.filter((a) => !a.settled);
      }
    });
    box.promise = p;
    this.asks.push(box);
    this.tail = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }
}
