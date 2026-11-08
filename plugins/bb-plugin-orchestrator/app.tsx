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
} from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type ChangeEvent } from "react";
import type { rpcContract } from "./server";

type Contract = typeof rpcContract;

const ROLE_OPTIONS = [
  { id: "orchestrator", label: "Оркестратор" },
  { id: "executor", label: "Исполнитель" },
  { id: "auditor", label: "Аудитор" },
] as const;
type RoleId = (typeof ROLE_OPTIONS)[number]["id"];
const DEFAULT_ROLE: RoleId = "orchestrator";

function RoleSelect() {
  const view = useComposerView();
  const rpc = useRpc<Contract>();
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
  // reports it — the stored row always mirrors what the list shows.
  useEffect(() => {
    let alive = true;
    void rpc
      .call("pendingRole", { projectId })
      .then((res) => {
        const next = res?.role ?? DEFAULT_ROLE;
        if (alive) setRole(next);
        report(next);
      })
      .catch(() => report(DEFAULT_ROLE));
    return () => {
      alive = false;
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
      Роль
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
            {option.label}
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
