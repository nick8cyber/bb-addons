/**
 * ContextLedger: текстовая память звонка (спека §4). Нужна при смене ключа:
 * handle привязан к ключу, новую сессию засеваем пересказом (контракт §3).
 */
export interface LedgerEntry {
  role: "owner" | "agent" | "tool" | "system";
  text: string;
  at: number;
}

export class ContextLedger {
  private entries: LedgerEntry[] = [];

  add(role: LedgerEntry["role"], text: string, at = Date.now()) {
    this.entries.push({ role, text, at });
  }

  lastOwnerUtterances(n: number): string[] {
    return this.entries
      .filter((e) => e.role === "owner")
      .slice(-n)
      .map((e) => e.text);
  }

  /** Сводка для посева новой сессии: ≤800 токенов ≈ ≤3200 символов (контракт §3). */
  handoverSummary(): string {
    const tail = this.entries.slice(-14).map((e) => {
      const who = e.role === "owner" ? "Владелец" : e.role === "agent" ? "Агент" : e.role === "tool" ? "Инструмент" : "Система";
      return `${who}: ${e.text}`;
    });
    let text = tail.join("\n");
    if (text.length > 3200) text = text.slice(text.length - 3200);
    return text;
  }
}
