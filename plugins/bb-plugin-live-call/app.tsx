/**
 * Фронтенд live-call: плавающая кнопка 📞 (вход в звонок без привязки к треду)
 * и раздел настроек со статусом и пробой Extended (спека §6).
 */
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { mountCallButton, startCall } from "./src/call-ui.js";

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
  if (!body.ok) throw new Error(body.error?.message ?? "rpc failed");
  return body.result as Output;
}

function mountCallSection(root: HTMLElement): () => void {
  root.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;font-family:system-ui,sans-serif;font-size:13px;">
      <div id="lc-status">Проверяю…</div>
      <div style="display:flex;gap:8px;">
        <button id="lc-start" style="padding:6px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.3);background:rgba(128,128,128,.08);cursor:pointer;">📞 Позвонить</button>
        <button id="lc-probe" style="padding:6px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.3);background:rgba(128,128,128,.08);cursor:pointer;">Проба Extended</button>
      </div>
      <div id="lc-probe-result" style="opacity:.7;"></div>
      <div style="opacity:.6;">Кнопка 📞 также всегда в правом нижнем углу. Горячие клавиши — после Ф0(а).</div>
    </div>`;
  const statusEl = root.querySelector("#lc-status") as HTMLElement;
  const probeResult = root.querySelector("#lc-probe-result") as HTMLElement;
  const refresh = async () => {
    try {
      const s = await rpc<StatusResult>("status");
      statusEl.textContent = s.configured
        ? `Ключей: ${s.keys}. ${s.activeCall ? `Звонок активен (${s.activeCall.mode}).` : "Звонка нет."}`
        : "Ключи не заданы: Настройки → Extensions → Live Call → Ключи Gemini.";
    } catch (e) {
      statusEl.textContent = `Сервер недоступен: ${String(e)}`;
    }
  };
  void refresh();
  const timer = setInterval(refresh, 5000);
  root.querySelector("#lc-start")?.addEventListener("click", () => void startCall());
  root.querySelector("#lc-probe")?.addEventListener("click", () => {
    probeResult.textContent = "Проба идёт (до 30 с)…";
    void rpc<ProbeResult>("probe")
      .then((r) => {
        probeResult.textContent = r.extendedNativeTools
          ? `✅ Extended доставляет toolCall (${r.checkedAt}) — можно включать нативный режим.`
          : `❌ Extended по-прежнему не доставляет toolCall (${r.detail ?? ""}, ${r.checkedAt}).`;
      })
      .catch((e) => {
        probeResult.textContent = `Проба не удалась: ${String(e)}`;
      });
  });
  return () => clearInterval(timer);
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "live-call-button",
    mount: () => mountCallButton(),
  });

  app.slots.settingsSection({
    id: "live-call",
    title: "Live Call",
    description: "Голосовой звонок с координатором BB через Gemini Live API. Ключи, голос и лимиты — в этом разделе.",
    component: mountCallSection,
  });
});
