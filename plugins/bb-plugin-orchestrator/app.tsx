/**
 * bb-plugin-orchestrator — Frontend entry (spec §13.2 п.1 + §25 + §29.2):
 * - «Роль» picker in the composer action row (RoleSelect).
 * - Interactive mode toggle [ ✅ Авто ] / [ 👤 Сам ] (ApprovalModeToggle)
 *   in the thread header action row (§29.2, Б2, r34.2):
 *   * In task window (executor): toggles confirmation_mode ONLY for that task.
 *   * In coordinator window (orchestrator): toggles orchestrator.approvalMode for project.
 * - Owner gate interaction card (OwnerGateCard) via PluginInteractionRequest (§29.1, §29.2).
 */
import {
  definePluginApp,
  useComposerView,
  useRpc,
  useSettings,
  type PluginPendingInteractionProps,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type ChangeEvent } from "react";
import type { rpcContract } from "./server";
import { createT, resolveLang } from "./src/i18n/index.js";

type Contract = typeof rpcContract;

// §19.3 (r33) + §30 (r34): Available roles in composer select
const ROLE_OPTIONS = [
  { id: "none", labelKey: "app.roleNone" },
  { id: "orchestrator", labelKey: "app.roleOrchestrator" },
  { id: "executor", labelKey: "app.roleExecutor" },
  { id: "auditor", labelKey: "app.roleAuditor" },
  { id: "researcher", labelKey: "app.roleResearcher" },
  { id: "architect", labelKey: "app.roleArchitect" },
] as const;
type RoleId = (typeof ROLE_OPTIONS)[number]["id"];
const DEFAULT_ROLE: RoleId = "executor";
const PICKABLE = new Set<string>(ROLE_OPTIONS.map((o) => o.id));

function RoleSelect() {
  const view = useComposerView();
  const rpc = useRpc<Contract>();
  const { values } = useSettings();
  const t = createT(resolveLang(values?.language));
  const scope = view.scope;
  const isThread = scope.kind === "thread";
  const projectId = scope.kind === "new-thread" ? scope.projectId : null;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const [role, setRole] = useState<string>(DEFAULT_ROLE);
  const [lockedLabel, setLockedLabel] = useState<string | null>(null);

  const report = (next: RoleId) => {
    if (isThread && threadId) {
      void rpc
        .call("setThreadRole", { threadId, role: next })
        .catch(() => undefined);
      return;
    }
    void rpc
      .call("setPendingRole", { projectId, role: next })
      .catch(() => undefined);
  };

  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const apply = (next: string) => {
      if (!alive) return;
      if (PICKABLE.has(next)) {
        setRole(next);
        setLockedLabel(null);
      } else {
        setLockedLabel(next === "helper" ? t("app.roleHelper") : next);
      }
    };
    const load = () =>
      isThread && threadId
        ? rpc
            .call("threadRole", { threadId })
            .then((res) => apply(res?.role ?? "none"))
            .catch(() => {
              retryTimer = setTimeout(() => {
                if (!alive) return;
                void rpc
                  .call("threadRole", { threadId })
                  .then((res) => apply(res?.role ?? "none"))
                  .catch(() => apply("none"));
              }, 1000);
            })
        : rpc
            .call("pendingRole", { projectId })
            .then((res) => apply(res?.role ?? DEFAULT_ROLE))
            .catch(() => {
              retryTimer = setTimeout(() => {
                if (!alive) return;
                void rpc
                  .call("pendingRole", { projectId })
                  .then((res) => apply(res?.role ?? DEFAULT_ROLE))
                  .catch(() => apply(DEFAULT_ROLE));
              }, 1000);
            });
    void load();
    return () => {
      alive = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [projectId, threadId, isThread]);

  const onChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as RoleId;
    setRole(next);
    report(next);
  };

  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        opacity: 0.85,
        whiteSpace: "nowrap",
      }}
    >
      {t("app.role")}
      <select
        value={lockedLabel !== null ? "__locked" : role}
        onChange={onChange}
        disabled={lockedLabel !== null}
        style={{
          font: "inherit",
          color: "inherit",
          background: "transparent",
          border: "1px solid rgba(128,128,128,.4)",
          borderRadius: 6,
          padding: "2px 4px",
          colorScheme: "dark",
        }}
      >
        {lockedLabel !== null ? (
          <option value="__locked">{lockedLabel}</option>
        ) : (
          ROLE_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {t(option.labelKey)}
            </option>
          ))
        )}
      </select>
    </label>
  );
}

/**
 * §29.2 (Б2, r34.2): Interactive toggle [ ✅ Авто ] / [ 👤 Сам ]
 * Mounted in thread header action row and/or composer action row.
 */
function ApprovalModeToggle(props?: Partial<PluginThreadHeaderActionProps>) {
  const view = useComposerView();
  const rpc = useRpc<Contract>();
  const { values } = useSettings();
  const t = createT(resolveLang(values?.language));

  const scope = view?.scope;
  const threadId =
    props?.threadId ?? (scope?.kind === "thread" ? scope.threadId : null);
  const projectId =
    props?.projectId ??
    (scope?.kind === "new-thread" ? scope.projectId : null);

  const [threadRole, setThreadRole] = useState<string | null>(null);
  const [taskKey, setTaskKey] = useState<string | null>(null);
  const [mode, setMode] = useState<"auto" | "manual" | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let alive = true;
    if (!threadId) {
      setLoading(false);
      return;
    }

    rpc
      .call("threadRole", { threadId })
      .then(async (res) => {
        if (!alive) return;
        const role = res?.role ?? "none";
        setThreadRole(role);

        if (role === "orchestrator") {
          const pMode = await rpc
            .call("projectApprovalMode", { projectId })
            .catch(() => null);
          if (!alive) return;
          setMode(pMode?.mode ?? "manual");
          setLoading(false);
        } else if (role === "executor") {
          const tMode = await rpc
            .call("taskConfirmationMode", { threadId })
            .catch(() => null);
          if (!alive) return;
          setTaskKey(tMode?.taskKey ?? null);
          setMode(tMode?.mode ?? null);
          setLoading(false);
        } else {
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [threadId, projectId]);

  if (
    loading ||
    !threadRole ||
    (threadRole !== "orchestrator" && threadRole !== "executor")
  ) {
    return null;
  }
  if (threadRole === "executor" && !taskKey) {
    return null;
  }

  const currentMode =
    mode ?? (threadRole === "orchestrator" ? "manual" : "auto");

  const switchMode = (nextMode: "auto" | "manual") => {
    if (nextMode === currentMode) return;
    setMode(nextMode);
    if (threadRole === "orchestrator") {
      void rpc
        .call("setProjectApprovalMode", { projectId, mode: nextMode })
        .catch(() => {});
    } else if (threadRole === "executor" && taskKey) {
      void rpc
        .call("setTaskConfirmationMode", { taskKey, mode: nextMode })
        .catch(() => {});
    }
  };

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 6,
        border: "1px solid rgba(128,128,128,.4)",
        overflow: "hidden",
        fontSize: 11,
        height: 24,
        background: "rgba(0,0,0,.2)",
      }}
      title={
        threadRole === "orchestrator"
          ? t("app.approvalModeProject")
          : t("app.approvalModeTask", { task: taskKey ?? "" })
      }
    >
      <button
        type="button"
        onClick={() => switchMode("auto")}
        style={{
          border: "none",
          padding: "2px 7px",
          background:
            currentMode === "auto" ? "rgba(34,197,94,.25)" : "transparent",
          color: currentMode === "auto" ? "#4ade80" : "inherit",
          fontWeight: currentMode === "auto" ? 600 : 400,
          cursor: "pointer",
          fontSize: 11,
        }}
      >
        ✅ {t("app.modeAuto")}
      </button>
      <button
        type="button"
        onClick={() => switchMode("manual")}
        style={{
          border: "none",
          borderLeft: "1px solid rgba(128,128,128,.3)",
          padding: "2px 7px",
          background:
            currentMode === "manual" ? "rgba(59,130,246,.25)" : "transparent",
          color: currentMode === "manual" ? "#60a5fa" : "inherit",
          fontWeight: currentMode === "manual" ? 600 : 400,
          cursor: "pointer",
          fontSize: 11,
        }}
      >
        👤 {t("app.modeManual")}
      </button>
    </div>
  );
}

/**
 * §29.1, §29.2: Owner gate interaction card (PluginInteractionRequest)
 * Renders in chat thread during waiting_approval at owner_gate.
 */
function OwnerGateCard(props: PluginPendingInteractionProps) {
  const { interaction, submit } = props;
  const rpc = useRpc<Contract>();
  const { values } = useSettings();
  const t = createT(resolveLang(values?.language));

  const payload = (interaction.payload || {}) as Record<string, unknown>;
  const taskKey = String(payload.taskKey || "");
  const gateStage = String(payload.gateStage || "pre_code");
  const route = String(payload.route || "");
  const level = String(payload.level || "");
  const acceptanceSha = payload.acceptanceSha
    ? String(payload.acceptanceSha).slice(0, 7)
    : null;
  const specSha = payload.specSha
    ? String(payload.specSha).slice(0, 7)
    : null;
  const resultSha = payload.resultSha
    ? String(payload.resultSha).slice(0, 7)
    : null;

  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [rejectMode, setRejectMode] = useState<boolean>(false);
  const [deferMode, setDeferMode] = useState<boolean>(false);
  const [reason, setReason] = useState<string>("");
  const [target, setTarget] = useState<string>(
    route === "feature" ? "spec" : "code",
  );

  const onApprove = async () => {
    setActionInProgress("approve");
    try {
      await rpc.call("ownerApprove", { taskKey });
      await submit({ action: "approved" });
    } catch {
      setActionInProgress(null);
    }
  };

  const onReject = async () => {
    if (!reason.trim()) return;
    setActionInProgress("reject");
    try {
      await rpc.call("ownerReject", {
        taskKey,
        reason: reason.trim(),
        target:
          gateStage === "pre_code" &&
          (route === "fix" || route === "simple")
            ? undefined
            : target,
      });
      await submit({ action: "rejected" });
    } catch {
      setActionInProgress(null);
    }
  };

  const onDefer = async () => {
    if (!reason.trim()) return;
    setActionInProgress("defer");
    try {
      await rpc.call("ownerDefer", { taskKey, reason: reason.trim() });
      await submit({ action: "deferred" });
    } catch {
      setActionInProgress(null);
    }
  };

  return (
    <div
      style={{
        border: "1px solid rgba(234,179,8,.4)",
        borderRadius: 8,
        padding: 12,
        background: "rgba(234,179,8,.05)",
        fontSize: 12,
        lineHeight: 1.5,
        maxWidth: 520,
      }}
    >
      <div
        style={{
          fontWeight: 600,
          fontSize: 13,
          marginBottom: 6,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span>🚪</span>
        <span>
          [{taskKey}]{" "}
          {gateStage === "pre_code"
            ? t("app.gatePreCode")
            : t("app.gatePreRelease")}
        </span>
      </div>

      <div
        style={{
          opacity: 0.85,
          marginBottom: 8,
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "2px 8px",
        }}
      >
        <span>Маршрут:</span>{" "}
        <strong>
          {route} / {level}
        </strong>
        {acceptanceSha && (
          <>
            <span>Договор:</span> <code>{acceptanceSha}</code>
          </>
        )}
        {specSha && (
          <>
            <span>Спецификация:</span> <code>{specSha}</code>
          </>
        )}
        {resultSha && (
          <>
            <span>Результат:</span> <code>{resultSha}</code>
          </>
        )}
      </div>

      {!rejectMode && !deferMode && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button
            type="button"
            disabled={actionInProgress !== null}
            onClick={onApprove}
            style={{
              background: "#15803d",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 12,
            }}
          >
            {actionInProgress === "approve" ? "..." : `✅ ${t("app.approve")}`}
          </button>
          <button
            type="button"
            disabled={actionInProgress !== null}
            onClick={() => setRejectMode(true)}
            style={{
              background: "#b91c1c",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 12,
            }}
          >
            ↩️ {t("app.reject")}
          </button>
          <button
            type="button"
            disabled={actionInProgress !== null}
            onClick={() => setDeferMode(true)}
            style={{
              background: "rgba(128,128,128,.2)",
              color: "inherit",
              border: "1px solid rgba(128,128,128,.4)",
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            ⏸️ {t("app.defer")}
          </button>
        </div>
      )}

      {rejectMode && (
        <div
          style={{
            marginTop: 8,
            borderTop: "1px solid rgba(128,128,128,.2)",
            paddingTop: 8,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            ↩️ {t("app.reject")}:
          </div>
          {gateStage === "pre_release" && (
            <div style={{ marginBottom: 6 }}>
              <label style={{ marginRight: 6 }}>{t("app.target")}:</label>
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                style={{
                  background: "transparent",
                  color: "inherit",
                  border: "1px solid rgba(128,128,128,.4)",
                  borderRadius: 4,
                  padding: "2px 4px",
                }}
              >
                <option value="code">code</option>
                {route === "feature" && <option value="spec">spec</option>}
                {route === "feature" && <option value="design">design</option>}
              </select>
            </div>
          )}
          <input
            type="text"
            placeholder={t("app.reason")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{
              width: "100%",
              background: "rgba(0,0,0,.2)",
              color: "inherit",
              border: "1px solid rgba(128,128,128,.4)",
              borderRadius: 4,
              padding: "4px 6px",
              marginBottom: 6,
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              disabled={!reason.trim() || actionInProgress !== null}
              onClick={onReject}
              style={{
                background: "#b91c1c",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                padding: "3px 8px",
                cursor: "pointer",
              }}
            >
              {actionInProgress === "reject" ? "..." : t("app.reject")}
            </button>
            <button
              type="button"
              onClick={() => {
                setRejectMode(false);
                setReason("");
              }}
              style={{
                background: "transparent",
                color: "inherit",
                border: "1px solid rgba(128,128,128,.3)",
                borderRadius: 4,
                padding: "3px 8px",
                cursor: "pointer",
              }}
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      {deferMode && (
        <div
          style={{
            marginTop: 8,
            borderTop: "1px solid rgba(128,128,128,.2)",
            paddingTop: 8,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            ⏸️ {t("app.defer")}:
          </div>
          <input
            type="text"
            placeholder={t("app.reason")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{
              width: "100%",
              background: "rgba(0,0,0,.2)",
              color: "inherit",
              border: "1px solid rgba(128,128,128,.4)",
              borderRadius: 4,
              padding: "4px 6px",
              marginBottom: 6,
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              disabled={!reason.trim() || actionInProgress !== null}
              onClick={onDefer}
              style={{
                background: "rgba(128,128,128,.4)",
                color: "inherit",
                border: "none",
                borderRadius: 4,
                padding: "3px 8px",
                cursor: "pointer",
              }}
            >
              {actionInProgress === "defer" ? "..." : t("app.defer")}
            </button>
            <button
              type="button"
              onClick={() => {
                setDeferMode(false);
                setReason("");
              }}
              style={{
                background: "transparent",
                color: "inherit",
                border: "1px solid rgba(128,128,128,.3)",
                borderRadius: 4,
                padding: "3px 8px",
                cursor: "pointer",
              }}
            >
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "orchestrator-role",
    scopes: ["new-thread", "thread"],
    actions: [
      { id: "role-select", component: RoleSelect },
      { id: "mode-toggle", component: ApprovalModeToggle },
    ],
  });

  app.slots.experimental_threadHeaderAction({
    id: "orchestrator-mode-toggle",
    title: "Режим одобрения",
    component: ApprovalModeToggle,
  });

  app.slots.pendingInteraction({
    id: "orchestrator-owner-gate",
    component: OwnerGateCard,
  });
});
