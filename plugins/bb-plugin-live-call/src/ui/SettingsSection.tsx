/**
 * Раздел «Live Call» в настройках (контракт §15.2, §15.8).
 * Поля ключей, голоса и лимитов bb рисует сам из bb.settings.define;
 * здесь — статус, звонок одной кнопкой, реестр проектов звонков с подтверждением diff.
 */
import { useCallback, useEffect, useState } from "react";

import { callEngine } from "./engine.js";
import { Icon } from "./icons.js";
import { publishProjects } from "./project-events.js";
import {
  rpc,
  type ProjectCallItem,
  type ProjectCallsApproveResult,
  type ProjectCallsListResult,
  type ProjectCallsRejectResult,
} from "./rpc.js";

type StatusResult = {
  configured: boolean;
  keys: number;
  activeCall: { callId: string; threadId: string | null; mode: string; startedAt: number } | null;
};
type ProbeResult = { extendedNativeTools: boolean; checkedAt: string; detail?: string };

export function SettingsSection() {
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectCallItem[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ running: boolean; result?: ProbeResult; error?: string }>({ running: false });

  const refresh = useCallback(async () => {
    try {
      setStatus(await rpc<StatusResult>("status"));
      setStatusError(null);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    }

    try {
      const listRes = await rpc<ProjectCallsListResult>("projectCallsList");
      setProjects(listRes.projects || []);
      setProjectsError(null);
    } catch (e) {
      setProjectsError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const approveProject = async (projectId: string, hash: string) => {
    setBusyProjectId(projectId);
    setActionError(null);
    try {
      const res = await rpc<ProjectCallsApproveResult>("projectCallsApprove", { projectId, hash });
      if (!res.ok) {
        setActionError(res.error || "Не удалось подтвердить изменения");
      } else {
        await refresh();
        await publishProjects();
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyProjectId(null);
    }
  };

  const rejectProject = async (projectId: string) => {
    setBusyProjectId(projectId);
    setActionError(null);
    try {
      await rpc<ProjectCallsRejectResult>("projectCallsReject", { projectId });
      await refresh();
      await publishProjects();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyProjectId(null);
    }
  };

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
              {status.keys} {status.keys === 1 ? "ключ" : "ключа: основной и запасной"}
            </span>
          ) : (
            <span className="lc-bad">не заданы — добавь в поле «Ключи Gemini» выше</span>
          )}
        </Row>
        <Row label="Звонок">
          {status?.activeCall ? (
            <span className="lc-ok">идёт · звонок</span>
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
      </div>

      <ProjectCallsView
        projects={projects}
        projectsError={projectsError}
        actionError={actionError}
        busyProjectId={busyProjectId}
        onApprove={approveProject}
        onReject={rejectProject}
      />

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

export function ProjectCallsView({
  projects,
  projectsError,
  actionError,
  busyProjectId,
  onApprove,
  onReject,
}: {
  projects: ProjectCallItem[] | null;
  projectsError?: string | null;
  actionError?: string | null;
  busyProjectId?: string | null;
  onApprove: (projectId: string, hash: string) => void | Promise<void>;
  onReject: (projectId: string) => void | Promise<void>;
}) {
  return (
    <div className="lc-settings__section" style={{ marginTop: "12px" }}>
      <h4 style={{ margin: "0 0 8px", fontSize: "13px", fontWeight: 600 }}>
        Звонки по проектам
      </h4>
      {actionError && <p className="lc-bad" style={{ margin: "0 0 8px" }}>{actionError}</p>}
      {projectsError ? (
        <p className="lc-bad">Не удалось загрузить реестр: {projectsError}</p>
      ) : !projects ? (
        <p className="lc-sub">Загрузка реестра проектов…</p>
      ) : projects.length === 0 ? (
        <p className="lc-sub">В реестре нет настроенных проектов.</p>
      ) : (
        <div className="lc-settings__rows" style={{ display: "flex", flexDirection: "column" }}>
          {projects.map((p) => (
            <div
              key={p.projectId}
              className="lc-settings__row"
              data-testid={`project-row-${p.projectId}`}
              style={{ flexDirection: "column", gap: "6px", alignItems: "stretch" }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                <div>
                  <strong>{p.title || p.projectId}</strong>
                  <span className="lc-sub" style={{ marginLeft: "8px" }}>{p.projectId}</span>
                </div>
                <div>
                  {p.state === "approved" && <span className="lc-ok">Подтверждён</span>}
                  {p.state === "pending" && <span className="lc-bad" style={{ color: "var(--warning, #eab308)" }}>Ждёт подтверждения</span>}
                  {p.state === "invalid" && <span className="lc-bad">Ошибка</span>}
                  {p.state === "rejected" && <span className="lc-bad">Отклонён — можно подтвердить</span>}
                </div>
              </div>

              {p.error && <p className="lc-bad" style={{ margin: 0 }}>{p.error}</p>}

              {(p.state === "pending" || p.state === "rejected") && (
                <div style={{ marginTop: "4px" }}>
                  {p.diff && p.diff.length > 0 && (
                    <pre
                      data-testid={`diff-${p.projectId}`}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "11px",
                        lineHeight: "1.4",
                        margin: "4px 0 8px",
                        padding: "8px",
                        background: "var(--secondary)",
                        borderRadius: "4px",
                        overflowX: "auto",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {p.diff.join("\n")}
                    </pre>
                  )}
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      className="lc-btn lc-btn--primary"
                      disabled={busyProjectId === p.projectId || !p.hash}
                      onClick={() => p.hash && void onApprove(p.projectId, p.hash)}
                    >
                      <Icon name="check" size={14} />
                      Подтвердить
                    </button>
                    <button
                      type="button"
                      className="lc-btn lc-btn--ghost"
                      disabled={busyProjectId === p.projectId}
                      onClick={() => void onReject(p.projectId)}
                    >
                      <Icon name="x" size={14} />
                      Отклонить
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
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
