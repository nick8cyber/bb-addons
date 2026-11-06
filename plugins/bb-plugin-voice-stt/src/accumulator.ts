/**
 * LiveTranscriptAccumulator — прямой порт OmniFlow `LiveTranscriptAccumulator.swift`
 * (спека §6.5).
 *
 * `interimInputTranscription` сервера ЗАМЕНЯЕТ текст открытого сегмента (не
 * дельта), а пауза начинает новый сегмент — без накопления каждый новый
 * сегмент затирал бы транскрипт и терял начало диктовки.
 */
export class LiveTranscriptAccumulator {
  private committedSegments: string[] = [];
  private currentSegment = "";

  /** Интерим сервера для открытого сегмента (полная замена). */
  feedInterim(text: string): void {
    this.currentSegment = text;
  }

  /** Финальный/уточнённый текст открытого сегмента — тоже замена, не дописка. */
  feedFinal(text: string): void {
    this.currentSegment = text;
  }

  /** Закрывает открытый сегмент в committed (идемпотентно при пустом). */
  endSegment(): void {
    const trimmed = this.currentSegment.trim();
    if (trimmed !== "") {
      this.committedSegments.push(trimmed);
    }
    this.currentSegment = "";
  }

  /** Закрывает открытый сегмент перед началом нового. */
  startSegment(): void {
    this.endSegment();
  }

  /** Всё распознанное: committed + открытый сегмент. */
  current(): string {
    const parts = [...this.committedSegments];
    const trimmed = this.currentSegment.trim();
    if (trimmed !== "") {
      parts.push(trimmed);
    }
    return parts.join(" ");
  }

  /** Финальный транскрипт всей сессии. */
  finalText(): string {
    return this.current();
  }

  reset(): void {
    this.committedSegments = [];
    this.currentSegment = "";
  }
}
