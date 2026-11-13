/**
 * bb-plugin-orchestrator — Frontend entry (spec §13.2 п.1): the «Роль»
 * picker in the new-thread composer's action row. The pick persists per
 * project in `pending_roles` via the plugin's RPC; the `message.dispatch`
 * hook applies it to the thread's first message.
 */
import {
  definePluginApp,
  useComposerView,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type ChangeEvent } from "react";
import type { rpcContract } from "./server";
import { createT, resolveLang } from "./src/i18n/index.js";

type Contract = typeof rpcContract;

const ROLE_OPTIONS = [
  { id: "orchestrator", labelKey: "app.roleOrchestrator" },
  { id: "executor", labelKey: "app.roleExecutor" },
  { id: "auditor", labelKey: "app.roleAuditor" },
] as const;
type RoleId = (typeof ROLE_OPTIONS)[number]["id"];
const DEFAULT_ROLE: RoleId = "orchestrator";

function RoleSelect() {
  const view = useComposerView();
  const rpc = useRpc<Contract>();
  const { values } = useSettings();
  const t = createT(resolveLang(values?.language));
  const scope = view.scope;
  const projectId = scope.kind === "new-thread" ? scope.projectId : null;
  const [role, setRole] = useState<RoleId>(DEFAULT_ROLE);

  const report = (next: RoleId) => {
    void rpc
      .call("setPendingRole", { projectId, role: next })
      .catch(() => undefined);
  };

  // §13.2 п.1: report the selection on mount and on every change. A
  // reopened window restores the project's remembered pick first, then
  // reports it — the stored row always mirrors what the list shows. A
  // transient read failure must not clobber the stored pick: retry the
  // read once after a second, and only then fall back to the default so
  // the shown value is the one that will actually apply.
  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const apply = (next: RoleId) => {
      if (alive) setRole(next);
      report(next);
    };
    const load = () =>
      rpc
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
  }, [projectId]);

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
        value={role}
        onChange={onChange}
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
        {ROLE_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>
            {t(option.labelKey)}
          </option>
        ))}
      </select>
    </label>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "orchestrator-role",
    scopes: ["new-thread"],
    actions: [{ id: "role-select", component: RoleSelect }],
  });
});
