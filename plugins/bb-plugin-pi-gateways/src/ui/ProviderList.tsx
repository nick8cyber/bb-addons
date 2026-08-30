/**
 * The unified provider inventory: one list for everything pi can see in
 * models.json plus everything this plugin remembers owning, grouped by how much
 * of it we are allowed to touch. Rows are disclosure headers — expanding one
 * renders the detail editor (or adoption panel) the shell passes in, which is
 * where every per-row action except Adopt now lives.
 */
import type { ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "../../lib/utils";
import type { Ownership, ProviderRow } from "../contract.js";
import { apiLabel, endpointHost, providerTone, type RpcCall, type RunBusy } from "./atoms.js";
import { ChevronDownIcon, RefreshIcon } from "./icons.js";
import { Badge, Dot, EmptyState, GroupHeading, MetaLine, Mono } from "./kit.js";

const GROUPS: Array<{ key: string; title: string; hint: string; owns: readonly Ownership[] }> = [
  {
    key: "builtin",
    title: "Built-in",
    hint: "Come with the plugin. The key is found for you.",
    owns: ["builtin"],
  },
  {
    key: "managed",
    title: "Managed here",
    hint: "You can edit these.",
    owns: ["owned", "adopted", "orphaned"],
  },
  {
    key: "unmanaged",
    title: "In the file only",
    hint: "Already in models.json. Start managing one to edit it here.",
    owns: ["foreign", "reserved"],
  },
];

/** Nothing to expand for a built-in that has not been written to models.json yet. */
function hasDetail(row: ProviderRow): boolean {
  return row.inModelsJson || row.ownership === "orphaned";
}

export interface ProviderListProps {
  providers: ProviderRow[];
  /** False when pi's bundled catalogue could not be located: adoption is refused. */
  reservedComplete: boolean;
  busy: boolean;
  call: RpcCall;
  runBusy: RunBusy;
  /** The row currently expanded, if any. */
  openId?: string;
  /** Toggle the expanded row. */
  onToggle: (id: string) => void;
  /** Start adoption for an unmanaged row. */
  onAdopt: (row: ProviderRow) => void;
  onChanged: () => Promise<void> | void;
  onWrote: () => void;
  /** Rendered inside the expanded row: the detail editor or the adoption panel. */
  renderPanel: (row: ProviderRow) => ReactNode;
}

export function ProviderList({
  providers,
  reservedComplete,
  busy,
  call,
  runBusy,
  openId,
  onToggle,
  onAdopt,
  onChanged,
  onWrote,
  renderPanel,
}: ProviderListProps) {
  // The only action left at row level besides Adopt: a built-in that was never
  // written has no detail row to host its Refresh. No drift confirmation — a
  // block that is not in models.json cannot have drifted.
  const refreshBuiltin = (row: ProviderRow) =>
    runBusy(async () => {
      await call("refresh", { only: [row.id] });
      onWrote();
      toast.success(`${row.id} refreshed`);
      await onChanged();
    });

  return (
    <div className="space-y-6">
      {GROUPS.map((group) => {
        const rows = providers.filter((row) => group.owns.includes(row.ownership));
        if (rows.length === 0 && group.key !== "managed") return null;
        return (
          <div key={group.key} className="space-y-2">
            <GroupHeading title={group.title} count={rows.length} hint={group.hint} />
            {rows.length === 0 ? (
              <EmptyState>
                Nothing here yet. Add a provider, or start managing one that is already in models.json.
              </EmptyState>
            ) : (
              <div className="divide-y divide-border-hairline overflow-hidden rounded-lg border border-border bg-card">
                {rows.map((row) => (
                  <Row
                    key={row.id}
                    row={row}
                    open={openId === row.id}
                    busy={busy}
                    reservedComplete={reservedComplete}
                    onToggle={onToggle}
                    onAdopt={onAdopt}
                    onRefreshBuiltin={refreshBuiltin}
                    renderPanel={renderPanel}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Row({
  row,
  open,
  busy,
  reservedComplete,
  onToggle,
  onAdopt,
  onRefreshBuiltin,
  renderPanel,
}: {
  row: ProviderRow;
  open: boolean;
  busy: boolean;
  reservedComplete: boolean;
  onToggle: (id: string) => void;
  onAdopt: (row: ProviderRow) => void;
  onRefreshBuiltin: (row: ProviderRow) => Promise<void>;
  renderPanel: (row: ProviderRow) => ReactNode;
}) {
  const detail = hasDetail(row);
  const adoptable = row.ownership === "foreign";
  const bareBuiltin = row.ownership === "builtin" && !row.inModelsJson;

  const adoptButton = adoptable && (
    <Button
      variant="outline"
      size="sm"
      className="pointer-events-auto"
      disabled={busy || !reservedComplete}
      onClick={(event) => {
        event.stopPropagation();
        onAdopt(row);
      }}
    >
      Manage here
    </Button>
  );

  const identity = (
    <>
      <Dot tone={providerTone(row)} className="mt-1.5" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{row.name ?? row.id}</span>
          {row.ownership === "orphaned" && <Badge tone="warn">missing from models.json</Badge>}
          {row.ownership === "reserved" && <Badge tone="neutral">reserved by pi</Badge>}
          {row.drifted && <Badge tone="warn">edited outside bb</Badge>}
          {!row.apiSupported && row.ownership !== "builtin" && <Badge tone="neutral">unsupported protocol</Badge>}
          {!row.inModelsJson && row.ownership !== "orphaned" && <Badge tone="neutral">not in models.json</Badge>}
        </div>
        <MetaLine
          items={[<Mono>{row.id}</Mono>, endpointHost(row.baseUrl), apiLabel(row.api), `${row.modelCount} models`]}
        />
        {row.error && (
          <div className="line-clamp-1 text-2xs text-destructive-text" title={row.error}>
            {row.error}
          </div>
        )}
      </div>
    </>
  );

  if (!detail) {
    return (
      <div className="flex items-start gap-3 px-3 py-2.5">
        {identity}
        <div className="flex shrink-0 items-center gap-2">
          {adoptButton}
          {bareBuiltin && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void onRefreshBuiltin(row);
              }}
            >
              <RefreshIcon />
              Refresh
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Adopt cannot legally nest inside the header <button>, so the header button
  // spans the full row and the action cluster floats above it. The cluster
  // ignores pointer events — clicks on the decorative chevron fall through to
  // the header — and only the real buttons inside opt back in.
  return (
    <div>
      <div className="relative">
        <button
          type="button"
          onClick={() => onToggle(row.id)}
          className={cn(
            "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-none hover:bg-state-hover",
            open && "bg-surface-recessed",
            // why: reserve room under the floating cluster so text truncates before it
            adoptable ? "pr-24" : "pr-9",
          )}
        >
          {identity}
        </button>
        <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center gap-2">
          {adoptButton}
          <ChevronDownIcon
            className={cn("size-3.5 text-muted-foreground transition-transform duration-150", open && "rotate-180")}
          />
        </div>
      </div>
      {open && (
        <div className="border-t border-border-hairline bg-surface-recessed px-3 py-4">{renderPanel(row)}</div>
      )}
    </div>
  );
}
