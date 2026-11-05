/**
 * Загрузка и форматирование сообщений треда для звонка по треду (контракт §12.2).
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export interface ThreadMessage {
  number: number;
  role: "owner" | "agent";
  text: string;
  createdAt: number;
}

export function formatMessageTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  return `${day}.${month} ${hours}:${minutes}`;
}

export function formatSingleMessage(m: ThreadMessage): string {
  const roleStr = m.role === "owner" ? "Владелец" : "Агент";
  const timeStr = formatMessageTime(m.createdAt);
  const header = timeStr ? `[${m.number}] ${roleStr} (${timeStr}):` : `[${m.number}] ${roleStr}:`;
  return `${header}\n${m.text}`;
}

export interface FormattedThreadBlock {
  block: string;
  messagesCount: number;
  skippedCount: number;
  chars: number;
}

export function formatAllThreadMessagesText(messages: ThreadMessage[]): string {
  if (messages.length === 0) return "(нет сообщений)";
  return messages.map(formatSingleMessage).join("\n\n");
}

export function formatThreadMessagesBlock(messages: ThreadMessage[]): FormattedThreadBlock {
  if (messages.length === 0) {
    const block = "(нет сообщений)";
    return {
      block,
      messagesCount: 0,
      skippedCount: 0,
      chars: block.length,
    };
  }

  if (messages.length <= 30) {
    const lastN = messages[messages.length - 1].number;
    const header = `ПОСЛЕДНИЕ СООБЩЕНИЯ (1–${lastN})`;
    const formatted = messages.map(formatSingleMessage).join("\n\n");
    const block = `${header}\n\n${formatted}`;
    return {
      block,
      messagesCount: messages.length,
      skippedCount: 0,
      chars: block.length,
    };
  }

  const first10 = messages.slice(0, 10).map(formatSingleMessage).join("\n\n");
  const skipped = messages.length - 30;
  const marker = `… пропущено ${skipped} (дочитай \`thread_read_messages\`) …`;
  const last20Messages = messages.slice(messages.length - 20);
  const last20 = last20Messages.map(formatSingleMessage).join("\n\n");
  const k = last20Messages[0].number;
  const n = last20Messages[last20Messages.length - 1].number;

  const headerFirst = "НАЧАЛО ТРЕДА (1–10)";
  const headerLast = `ПОСЛЕДНИЕ СООБЩЕНИЯ (${k}–${n})`;

  const block = `${headerFirst}\n\n${first10}\n\n${marker}\n\n${headerLast}\n\n${last20}`;
  return {
    block,
    messagesCount: 30,
    skippedCount: skipped,
    chars: block.length,
  };
}

/**
 * Чтение сообщений треда через sdk.threads.events.list с постраничным обходом.
 * Только сообщения владельца (client/turn/requested) и ответы агента (item/completed agentMessage).
 */
export async function fetchThreadMessages(
  sdk: BbPluginApi["sdk"],
  threadId: string,
): Promise<ThreadMessage[]> {
  const eventsArea = (sdk.threads as unknown as { events: { list(a: Record<string, unknown>): Promise<unknown> } })?.events;
  if (!eventsArea || typeof eventsArea.list !== "function") {
    return [];
  }

  const allEvents: Array<Record<string, unknown>> = [];
  let afterSeq: string | undefined = undefined;

  while (true) {
    let res: unknown;
    try {
      res = await eventsArea.list({
        threadId,
        order: "asc",
        limit: 100,
        ...(afterSeq !== undefined ? { afterSeq } : {}),
      });
    } catch (e) {
      console.error("eventsArea.list failed:", e);
      break;
    }
    const rows = (Array.isArray(res) ? res : ((res as { events?: unknown[] })?.events ?? [])) as Array<Record<string, unknown>>;
    if (!rows.length) break;
    allEvents.push(...rows);
    const lastSeq = rows[rows.length - 1]?.seq;
    if (lastSeq === undefined || rows.length < 100) break;
    const nextSeqStr = String(lastSeq);
    if (nextSeqStr === afterSeq) break;
    afterSeq = nextSeqStr;
  }

  const messages: ThreadMessage[] = [];
  let count = 0;

  for (const e of allEvents) {
    if (e.type === "client/turn/requested") {
      const data = e.data as { input?: Array<{ text?: string }> } | undefined;
      const text = (data?.input ?? []).map((x) => x.text ?? "").join("").trim();
      if (text) {
        count++;
        messages.push({
          number: count,
          role: "owner",
          text,
          createdAt: Number(e.createdAt ?? 0),
        });
      }
    } else if (e.type === "item/completed") {
      const data = e.data as { item?: { type?: string; text?: string } } | undefined;
      if (data?.item?.type === "agentMessage") {
        const text = String(data.item.text ?? "").trim();
        if (text) {
          count++;
          messages.push({
            number: count,
            role: "agent",
            text,
            createdAt: Number(e.createdAt ?? 0),
          });
        }
      }
    }
  }

  return messages;
}
