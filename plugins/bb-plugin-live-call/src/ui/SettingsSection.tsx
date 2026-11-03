/**
 * Раздел «Live Call» в настройках. Поля ключей, голоса и лимитов bb рисует сам
 * из bb.settings.define; здесь — статус, звонок одной кнопкой и проба Extended.
 * Прежняя версия передавала в слот DOM-функцию вместо React-компонента и падала.
 */
import { useCallback, useEffect, useState } from "react";

import { callEngine } from "./engine.js";
import { Icon } from "./icons.js";

const RPC_ENDPOINT = "/api/v1/plugins/live-call/rpc";

type StatusResult = {
  configured: boolean;
  keys: number;
  activeCall: { callId: string; threadId: string | null; mode: string; startedAt: number } | null;
};
type ProbeResult = { extendedNativeTools: boolean; checkedAt: string; detail?: string };

async function rpc<Output>(method: string, input: object = {}): Promise<Output> {
  const response = await fetch(`${RPC_ENDPOINT}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as { ok: boolean; result?: Output; error?: { message?: string } };
  if (!body.ok) throw new Error(body.error?.message ?? "запрос не удался");
  return body.result as Output;
}

export function SettingsSection() {
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ running: boolean; result?: ProbeResult; error?: string }>({ running: false });

  const refresh = useCallback(async () => {
    try {
      setStatus(await rpc<StatusResult>("status"));
      setStatusError(null);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const runProbe = async () => {
    setProbe({ running: true });
    try {
      setProbe({ running: false, result: await rpc<ProbeResult>("probe") });
    } catch (e) {
      setProbe({ running: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="lc-root lc-settings">
      <div className="lc-settings__rows">
        <Row label="Ключи AI Studio">
          {statusError ? (
            <span className="lc-bad">сервер не ответил: {statusError}</span>
          ) : !status ? (
            <span className="lc-sub">проверяю…</span>
          ) : status.configured ? (
            <span>
              {status.keys} {status.keys === 1 ? "ключ — Extended недоступен, нужен второй" : "ключа: основной и запасной"}
            </span>
          ) : (
            <span className="lc-bad">не заданы — добавь в поле «Ключи Gemini» выше</span>
          )}
        </Row>
        <Row label="Звонок">
          {status?.activeCall ? (
            <span className="lc-ok">идёт · {status.activeCall.mode === "extended" ? "Extended" : "Быстрый"}</span>
          ) : (
            <span className="lc-sub">нет</span>
          )}
        </Row>
        <Row label="Горячие клавиши">
          <span className="lc-sub">
            <kbd>⌘/Ctrl ⇧ L</kbd> позвонить или завершить · <kbd>⌘/Ctrl ⇧ K</kbd> сменить режим. Переназначить — в палитре команд.
          </span>
        </Row>
      </div>
      <div className="lc-settings__actions">
        <button type="button" className="lc-btn lc-btn--primary" disabled={!status?.configured} onClick={() => callEngine.start()}>
          <Icon name="phone" />
          Позвонить
        </button>
        <button type="button" className="lc-btn lc-btn--ghost" disabled={probe.running} onClick={() => void runProbe()}>
          {probe.running ? <Icon name="loader" className="lc-spin" /> : <Icon name="sparkles" />}
          {probe.running ? "Проверяю Extended…" : "Проверить Extended"}
        </button>
      </div>
      {probe.result && (
        <p className={probe.result.extendedNativeTools ? "lc-ok" : "lc-sub"}>
          {probe.result.extendedNativeTools
            ? `Extended сам вызывает инструменты (${probe.result.checkedAt}) — можно перейти на одну сессию.`
            : `Extended по-прежнему не вызывает инструменты сам — работает через помощника. ${probe.result.detail ?? ""} (${probe.result.checkedAt})`}
        </p>
      )}
      {probe.error && <p className="lc-bad">Проверка не удалась: {probe.error}</p>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="lc-settings__row">
      <span className="lc-settings__label">{label}</span>
      <span className="lc-settings__value">{children}</span>
    </div>
  );
}
