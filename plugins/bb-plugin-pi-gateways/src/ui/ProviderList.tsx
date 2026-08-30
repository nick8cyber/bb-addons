/**
 * The unified provider inventory: one list for everything pi can see in
 * models.json plus everything this plugin remembers owning, grouped by how much
 * of it we are allowed to touch. Replaces the old built-in / custom-endpoint
 * split, where a block written by hand or by another tool was simply invisible.
 */
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { Ownership, ProviderRow, RefreshCustomOutput } from "../contract.js";
import { StateBadge, apiLabel, type RpcCall, type RunBusy } from "./AddProviderForm.js";

const GROUPS: Array<{ key: string; title: string; hint: string; owns: readonly Ownership[] }> = [
  {
    key: "builtin",
    title: "Built-in",
    hint: "Shipped with the plugin: credentials are discovered from the vendor CLI, not configured here.",
    owns: ["builtin"],
  },
  {
    key: "managed",
    title: "Managed",
    hint: "Created or adopted here. Editable, refreshable and removable.",
    owns: ["owned", "adopted", "orphaned"],
  },
  {
    key: "unmanaged",
    title: "Unmanaged",
    hint: "Present in models.json but not managed by this plugin. Adopt one to take it over, or leave it alone.",
    owns: ["foreign", "reserved"],
  },
];

const OWNERSHIP_LABEL: Record<Ownership, string> = {
  builtin: "built-in",
  owned: "managed",
  adopted: "adopted",
  foreign: "not managed",
  orphaned: "missing from models.json",
  reserved: "reserved by pi",
};

function OwnershipBadge({ ownership }: { ownership: Ownership }) {
  const tone =
    ownership === "owned" || ownership === "adopted"
      ? "border-primary/40 text-foreground"
      : ownership === "foreign" || ownership === "orphaned" || ownership === "reserved"
        ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
        : "border-border text-muted-foreground";
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}>
      {OWNERSHIP_LABEL[ownership]}
    </span>
  );
}

/** Built-ins refresh through their own flow; adopted-limited blocks cannot refresh at all. */
function isRefreshable(row: ProviderRow): boolean {
  if (row.ownership === "builtin") return true;
  if (row.ownership === "owned" || row.ownership === "adopted" || row.ownership === "orphaned") {
    return row.apiSupported;
  }
  return false;
}

/** Nothing to expand for a built-in that has not been written to models.json yet. */
function hasDetail(row: ProviderRow): boolean {
  return row.inModelsJson || row.ownership === "orphaned";
}

function canDisown(row: ProviderRow): boolean {
  return row.ownership === "adopted" || row.ownership === "orphaned";
}

function canDelete(row: ProviderRow): boolean {
  return row.ownership === "owned" || row.ownership === "adopted" || row.ownership === "foreign";
}

export interface ProviderListProps {
  providers: ProviderRow[];
  modelsJsonPath: string;
  /** False when pi's bundled catalogue could not be located: adoption is refused. */
  reservedComplete: boolean;
  busy: boolean;
  call: RpcCall;
  runBusy: RunBusy;
  openId?: string;
  onDetails: (id: string) => void;
  onAdopt: (row: ProviderRow) => void;
  /** Reload the inventory after a mutation. */
  onChanged: () => Promise<void> | void;
  /** A write landed in models.json: arm the picker-restart notice. */
  onWrote: () => void;
}

export function ProviderList({
  providers,
  modelsJsonPath,
  reservedComplete,
  busy,
  call,
  runBusy,
  openId,
  onDetails,
  onAdopt,
  onChanged,
  onWrote,
}: ProviderListProps) {
  // Destructive actions confirm on a second press of the same button rather than
  // through window.confirm: a native dialog is suppressed in some host contexts,
  // where the click then silently does nothing, and it cannot be styled.
  // The same pattern arms the drift overwrite, which is destructive to whatever
  // changed the block outside the plugin.
  const [pending, setPending] = useState<string | undefined>(undefined);

  const arm = (token: string): boolean => {
    if (pending === token) {
      setPending(undefined);
      return true;
    }
    setPending(token);
    return false;
  };

  const refreshBuiltins = () =>
    runBusy(async () => {
      await call("refresh");
      onWrote();
      toast.success("built-in gateways refreshed");
      await onChanged();
    });

  const refresh = (row: ProviderRow) => {
    // Overwriting a block that changed outside the plugin needs the same second press.
    if (row.drifted && !arm(`refresh:${row.id}`)) return;
    void runBusy(async () => {
      if (row.ownership === "builtin") {
        await call("refresh", { only: [row.id] });
        onWrote();
        toast.success(`${row.id} refreshed`);
        await onChanged();
        return;
      }
      const result = await call<RefreshCustomOutput>("refreshCustom", {
        ids: [row.id],
        acceptDrift: row.drifted ? [row.id] : undefined,
      });
      const outcome = result.results[0];
      if (!outcome?.ok) {
        toast.error(outcome?.error ?? `${row.id} could not be refreshed`);
      } else {
        onWrote();
        if (outcome.warning) toast.warning(outcome.warning);
        if (outcome.missing?.length) {
          toast.warning(`kept ${outcome.missing.length} model(s) the catalogue no longer lists`);
        }
        toast.success(`${row.id} refreshed`);
      }
      await onChanged();
    });
  };

  const remove = (row: ProviderRow) => {
    if (!arm(`delete:${row.id}`)) return;
    void runBusy(async () => {
      await call("deleteProvider", { id: row.id, force: row.ownership === "foreign" ? true : undefined });
      onWrote();
      toast.success(`${row.id} deleted`);
      await onChanged();
    });
  };

  const disown = (row: ProviderRow) => {
    if (!arm(`disown:${row.id}`)) return;
    void runBusy(async () => {
      await call("disown", { id: row.id });
      toast.success(`${row.id} is no longer managed here — models.json is untouched`);
      await onChanged();
    });
  };

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium">Providers served through pi</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{modelsJsonPath}</div>
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void refreshBuiltins()}>
            Refresh all built-ins
          </Button>
        </div>

        {!reservedComplete && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            pi's bundled catalogue could not be located, so an id collision cannot be ruled out. Adding and adopting
            providers stays blocked until it can be checked.
          </div>
        )}

        {GROUPS.map((group) => {
          const rows = providers.filter((row) => group.owns.includes(row.ownership));
          if (rows.length === 0 && group.key !== "managed") return null;
          return (
            <div key={group.key} className="space-y-2">
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.title}</div>
                <div className="text-xs text-muted-foreground">{group.hint}</div>
              </div>

              {rows.map((row) => (
                <div key={row.id} className={`rounded-md border px-3 py-2 ${openId === row.id ? "border-primary" : "border-border"}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium">{row.name ?? row.id}</span>
                        <OwnershipBadge ownership={row.ownership} />
                        {row.drifted && (
                          <span className="rounded border border-amber-500/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
                            changed outside the plugin
                          </span>
                        )}
                        {!row.apiSupported && row.ownership !== "builtin" && (
                          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            unsupported protocol
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        <code>{row.id}</code>
                        {row.baseUrl ? ` · ${row.baseUrl}` : ""} · {apiLabel(row.api)} · {row.modelCount} models
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        key: <span className="font-mono">{row.keyRefDisplay}</span>
                        {row.hasHeaders && " · custom headers set"}
                        {" · "}
                        {row.error ? (
                          <StateBadge ok={false}>{row.error}</StateBadge>
                        ) : row.inModelsJson ? (
                          <StateBadge ok>in models.json</StateBadge>
                        ) : (
                          <StateBadge ok={false}>not in models.json</StateBadge>
                        )}
                      </div>
                      {row.warnings.map((warning) => (
                        <div key={warning} className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
                          {warning}
                        </div>
                      ))}
                      {pending === `refresh:${row.id}` && (
                        <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                          This block changed outside the plugin. Refreshing overwrites those changes — press Refresh
                          again to confirm.
                        </div>
                      )}
                      {pending === `delete:${row.id}` && (
                        <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                          {row.ownership === "foreign"
                            ? "This block is not managed here. Deleting it may simply be rewritten by whatever generates it — press Confirm delete to force it."
                            : "The provider block and everything this plugin remembers about it will be removed."}
                        </div>
                      )}
                      {pending === `disown:${row.id}` && (
                        <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                          Forgetting leaves the models.json block exactly as it is and only stops managing it here.
                        </div>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-wrap gap-2">
                      {hasDetail(row) && (
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => onDetails(row.id)}>
                          Details
                        </Button>
                      )}
                      {isRefreshable(row) && (
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => refresh(row)}>
                          {pending === `refresh:${row.id}` ? "Overwrite anyway" : "Refresh"}
                        </Button>
                      )}
                      {row.ownership === "foreign" && (
                        <Button variant="secondary" size="sm" disabled={busy || !reservedComplete} onClick={() => onAdopt(row)}>
                          Adopt
                        </Button>
                      )}
                      {canDisown(row) && (
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => disown(row)}>
                          {pending === `disown:${row.id}` ? "Confirm forget" : "Forget"}
                        </Button>
                      )}
                      {canDelete(row) && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          className="text-red-600 dark:text-red-400"
                          onClick={() => remove(row)}
                        >
                          {pending === `delete:${row.id}` ? "Confirm delete" : "Delete"}
                        </Button>
                      )}
                      {pending?.endsWith(`:${row.id}`) && (
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPending(undefined)}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {rows.length === 0 && (
                <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                  Nothing here yet — add a provider below, or adopt one that already lives in models.json. The token
                  stays wherever it lives today; only a reference is written.
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
