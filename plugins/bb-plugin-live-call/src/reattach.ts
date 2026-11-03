/**
 * Что делать с hello браузера (контракт §2.2, переподключение).
 * - нет звонка: resume → «gone» (звонок уже завершён), без resume → «start»;
 * - звонок ждёт возврата (detached): resume с его callId или hello без resume
 *   (страницу перезагрузили и callId потерян) → «reattach»; чужой resume → «gone»;
 * - звонок идёт с живым браузером: «busy» (второе устройство не перехватывает).
 */
export type HelloDecision = "start" | "reattach" | "busy" | "gone";

export function decideHello(active: { callId: string; detached: boolean } | null, resume: string | undefined): HelloDecision {
  if (!active) return resume ? "gone" : "start";
  if (!active.detached) return "busy";
  if (resume && resume !== active.callId) return "gone";
  return "reattach";
}
