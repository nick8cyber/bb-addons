/**
 * bb-plugin-orchestrator — Frontend entry (spec §13.2 п.1 + §25): the
 * «Роль» picker in the composer action row. In the new-thread window
 * (scope `new-thread`) the pick persists per project in `pending_roles`
 * via the plugin's RPC; the `message.dispatch` hook applies it to the
 * thread's first message. In a thread window (scope `thread`, §25) the
 * list shows the thread's decided role from `thread_roles` and the
 * owner's change writes it with `source = "owner"` — effective on the
 * thread's next turn.
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

// §19.3 (r33): «Без плагина» / "No plugin" — FIRST in the list; the
// stored pick or the server default role fills the select, nothing is
// written until the user actually changes it.
const ROLE_OPTIONS = [
  { id: "none", labelKey: "app.roleNone" },
  { id: "orchestrator", labelKey: "app.roleOrchestrator" },
  { id: "executor", labelKey: "app.roleExecutor" },
  { id: "auditor", labelKey: "app.roleAuditor" },
  // §21.1 (r33): «Ресерчер» / "Researcher" — internet research, no
  // project tools.
  { id: "researcher", labelKey: "app.roleResearcher" },
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
  // §25: a non-pickable decided role (helper, release-auditor, anything
  // the list does not offer) renders the select disabled with the
  // role's own label — «Помощник» for a helper thread.
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

  // §19.3 (r33): the select READS the remembered pick (or shows the
  // server default) and writes ONLY on a user change — the window's own
  // open used to write `orchestrator`, which is exactly the default
  // r33 removed. A transient read failure retries once after a second.
  // §25: in a thread window the select reads the thread's decided role
  // instead (no row → «Без плагина») — and writes through `setThreadRole`.
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

export default definePluginApp((app) => {
  app.composer.customize({
    id: "orchestrator-role",
    scopes: ["new-thread", "thread"],
    actions: [{ id: "role-select", component: RoleSelect }],
  });
});
