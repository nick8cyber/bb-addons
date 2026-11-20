/**
 * bb-plugin-orchestrator — Frontend entry (spec §13.2 п.1 + §25 + §29.2):
 * - Unified «Роль» and interactive mode menu (RoleApprovalMenu)
 *   in the composer action row (§29.2, PLUG-359):
 *   * In task window (executor): toggles confirmation_mode ONLY for that task.
 *   * In coordinator window (orchestrator): toggles orchestrator.approvalMode for project.
 * - Owner gate interaction card (OwnerGateCard) via PluginInteractionRequest (§29.1, §29.2).
 */
import "./app.css";
import {
  definePluginApp,
  useComposerView,
  useRpc,
  useSettings,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useState } from "react";
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

/**
 * §29.2 (20.11 решение владельца, PLUG-359):
 * Единый компактный селектор роли и режима одобрения в строке поля ввода.
 * Вместо «подпись Роль + список + тумблер» — одна кнопка-меню.
 * По нажатию открывается меню из двух секций:
 * 1) «Роль»: список доступных ролей треда, галочкой отмечена активная роль;
 * 2) Разделитель и «Одобрение»: «✅ Авто» и «👤 Сам», галочкой отмечен текущий режим;
 *    секция отображается ТОЛЬКО если workGraph != off и роль orchestrator или executor.
 * Выбор в одной части не сбрасывает режим в другой, и наоборот.
 */
function RoleApprovalMenu() {
  const view = useComposerView();
  const rpc = useRpc<Contract>();
  const { values } = useSettings();
  const t = createT(resolveLang(values?.language));

  const scope = view?.scope;
  const isThread = scope?.kind === "thread";
  const projectId = scope?.kind === "new-thread" ? scope.projectId : null;
  const threadId = scope?.kind === "thread" ? scope.threadId : null;

  const [role, setRole] = useState<string>(DEFAULT_ROLE);
  const [lockedLabel, setLockedLabel] = useState<string | null>(null);
  const [taskKey, setTaskKey] = useState<string | null>(null);
  const [mode, setMode] = useState<"auto" | "manual" | null>(null);
  const [serverWorkGraph, setServerWorkGraph] = useState<string | null>(null);

  const report = (next: RoleId) => {
    setRole(next);
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

  const switchMode = (nextMode: "auto" | "manual") => {
    setMode(nextMode);
    if (role === "orchestrator") {
      void rpc
        .call("setProjectApprovalMode", { projectId, mode: nextMode })
        .catch(() => {});
    } else if (role === "executor" && taskKey) {
      void rpc
        .call("setTaskConfirmationMode", { taskKey, mode: nextMode })
        .catch(() => {});
    }
  };

  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const applyRole = (next: string) => {
      if (!alive) return;
      if (PICKABLE.has(next)) {
        setRole(next);
        setLockedLabel(null);
      } else {
        setLockedLabel(next === "helper" ? t("app.roleHelper") : next);
      }
    };

    const loadRole = () =>
      isThread && threadId
        ? rpc
            .call("threadRole", { threadId })
            .then((res) => applyRole(res?.role ?? "none"))
            .catch(() => {
              retryTimer = setTimeout(() => {
                if (!alive) return;
                void rpc
                  .call("threadRole", { threadId })
                  .then((res) => applyRole(res?.role ?? "none"))
                  .catch(() => applyRole("none"));
              }, 1000);
            })
        : rpc
            .call("pendingRole", { projectId })
            .then((res) => applyRole(res?.role ?? DEFAULT_ROLE))
            .catch(() => {
              retryTimer = setTimeout(() => {
                if (!alive) return;
                void rpc
                  .call("pendingRole", { projectId })
                  .then((res) => applyRole(res?.role ?? DEFAULT_ROLE))
                  .catch(() => applyRole(DEFAULT_ROLE));
              }, 1000);
            });

    void loadRole();

    // Mode loading
    if (role === "orchestrator") {
      void rpc
        .call("projectApprovalMode", { projectId, threadId })
        .then((res) => {
          if (!alive) return;
          if (res?.mode) setMode(res.mode);
          if (res?.workGraph) setServerWorkGraph(res.workGraph);
        })
        .catch(() => {});
    } else if (role === "executor" && threadId) {
      void rpc
        .call("taskConfirmationMode", { threadId })
        .then((res) => {
          if (!alive) return;
          if (res?.taskKey) setTaskKey(res.taskKey);
          if (res?.mode) setMode(res.mode);
          if (res?.workGraph) setServerWorkGraph(res.workGraph);
        })
        .catch(() => {});
    }

    return () => {
      alive = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [projectId, threadId, isThread, role]);

  // Determine if workGraph is active: effective project mode from serverWorkGraph takes precedence
  // over global settings values?.workGraph (§29.2, §32.2)
  const workGraphVal = serverWorkGraph ?? (values?.workGraph as string) ?? "off";
  const workGraphOn = workGraphVal === "strict" || workGraphVal === "shadow";
  const hasApproval =
    workGraphOn && (role === "orchestrator" || role === "executor");

  const currentMode =
    role === "orchestrator" ? mode : (mode ?? "auto");
  const modeGlyph = currentMode === "manual" ? "👤" : "✅";

  const activeOption = ROLE_OPTIONS.find((o) => o.id === role);
  const roleLabel =
    lockedLabel !== null
      ? lockedLabel
      : activeOption
      ? t(activeOption.labelKey)
      : role;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="orch-role-menu-trigger"
          title={
            hasApproval
              ? role === "orchestrator"
                ? `${roleLabel} (${t("app.approvalModeProject")}: ${
                    currentMode === "manual" ? t("app.modeManual") : t("app.modeAuto")
                  })`
                : `${roleLabel} (${t("app.approvalModeTask", { task: taskKey ?? "" })}: ${
                    currentMode === "manual" ? t("app.modeManual") : t("app.modeAuto")
                  })`
              : roleLabel
          }
        >
          <span>{roleLabel}</span>
          {hasApproval && <span>{modeGlyph}</span>}
          <span style={{ opacity: 0.6, fontSize: 10, marginLeft: 1 }}>▾</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="orch-role-menu-content"
          sideOffset={5}
          align="start"
        >
          <DropdownMenu.Label className="orch-role-menu-label">
            {t("app.role")}
          </DropdownMenu.Label>
          {lockedLabel !== null ? (
            <DropdownMenu.Item
              disabled
              className="orch-role-menu-item"
            >
              <span>{lockedLabel}</span>
              <span style={{ color: "#4ade80", fontWeight: 600 }}>✓</span>
            </DropdownMenu.Item>
          ) : (
            ROLE_OPTIONS.map((opt) => {
              const isSelected = role === opt.id;
              return (
                <DropdownMenu.Item
                  key={opt.id}
                  className="orch-role-menu-item"
                  onSelect={() => {
                    report(opt.id);
                  }}
                >
                  <span style={{ fontWeight: isSelected ? 600 : 400 }}>
                    {t(opt.labelKey)}
                  </span>
                  {isSelected && (
                    <span style={{ color: "#4ade80", fontWeight: 600 }}>✓</span>
                  )}
                </DropdownMenu.Item>
              );
            })
          )}

          {hasApproval && (
            <>
              <DropdownMenu.Separator className="orch-role-menu-separator" />
              <DropdownMenu.Label className="orch-role-menu-label">
                {t("app.approvalMode")}
              </DropdownMenu.Label>
              <DropdownMenu.Item
                className="orch-role-menu-item"
                onSelect={() => {
                  switchMode("auto");
                }}
              >
                <span style={{ fontWeight: currentMode === "auto" ? 600 : 400 }}>
                  ✅ {t("app.modeAuto")}
                </span>
                {currentMode === "auto" && (
                  <span style={{ color: "#4ade80", fontWeight: 600 }}>✓</span>
                )}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="orch-role-menu-item"
                onSelect={() => {
                  switchMode("manual");
                }}
              >
                <span style={{ fontWeight: currentMode === "manual" ? 600 : 400 }}>
                  👤 {t("app.modeManual")}
                </span>
                {currentMode === "manual" && (
                  <span style={{ color: "#4ade80", fontWeight: 600 }}>✓</span>
                )}
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
  const defaultTarget =
    route === "docs"
      ? "spec"
      : gateStage === "pre_code"
        ? (route === "feature" ? "spec" : undefined)
        : "code";
  const [target, setTarget] = useState<string | undefined>(defaultTarget);

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
        target,
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
          {(() => {
            if (gateStage === "pre_code") {
              if (route === "feature") {
                return (
                  <div style={{ marginBottom: 6 }}>
                    <label style={{ marginRight: 6 }}>{t("app.target")}:</label>
                    <select
                      value={target ?? "spec"}
                      onChange={(e) => setTarget(e.target.value)}
                      style={{
                        background: "transparent",
                        color: "inherit",
                        border: "1px solid rgba(128,128,128,.4)",
                        borderRadius: 4,
                        padding: "2px 4px",
                      }}
                    >
                      <option value="spec">spec</option>
                      <option value="design">design</option>
                    </select>
                  </div>
                );
              }
              return null;
            }

            if (route === "docs") {
              return (
                <div style={{ marginBottom: 6 }}>
                  <label style={{ marginRight: 6 }}>{t("app.target")}:</label>
                  <select
                    value={target ?? "spec"}
                    onChange={(e) => setTarget(e.target.value)}
                    style={{
                      background: "transparent",
                      color: "inherit",
                      border: "1px solid rgba(128,128,128,.4)",
                      borderRadius: 4,
                      padding: "2px 4px",
                    }}
                  >
                    <option value="spec">spec</option>
                  </select>
                </div>
              );
            }

            if (route === "feature") {
              return (
                <div style={{ marginBottom: 6 }}>
                  <label style={{ marginRight: 6 }}>{t("app.target")}:</label>
                  <select
                    value={target ?? "code"}
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
                    <option value="spec">spec</option>
                    <option value="design">design</option>
                  </select>
                </div>
              );
            }

            return (
              <div style={{ marginBottom: 6 }}>
                <label style={{ marginRight: 6 }}>{t("app.target")}:</label>
                <select
                  value={target ?? "code"}
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
                </select>
              </div>
            );
          })()}
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
      { id: "role-menu", component: RoleApprovalMenu },
    ],
  });

  app.slots.pendingInteraction({
    id: "orchestrator-owner-gate",
    component: OwnerGateCard,
  });
});
