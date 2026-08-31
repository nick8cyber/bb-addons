/**
 * The unified provider inventory: one flat list for everything pi can see in
 * models.json plus everything this plugin remembers owning, in the order the
 * host returned them. Rows are disclosure headers — expanding one renders the
 * editor the shell passes in, which is where every per-row action now lives
 * except the one refresh a never-written built-in has nowhere else to host.
 */
import type { ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "../../lib/utils";
import type { ProviderRow } from "../contract.js";
import { providerTone, type RpcCall, type RunBusy } from "./atoms.js";
import { ChevronDownIcon, RefreshIcon } from "./icons.js";
import { Dot, EmptyState, QuietBadge, ToneText, type Tone } from "./kit.js";

/** The row action shows itself only when the pointer (or focus) is on the row. */
const HOVER_ACTION =
  "pointer-events-auto opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100";

/** What the row offers, before the key: model coverage in a few words. */
function modelSummary(row: ProviderRow): string {
  if (row.modelCount === 0) return "no models yet";
  const count = `${row.modelCount} ${row.modelCount === 1 ? "model" : "models"}`;
  return row.selectionMode === "all-free" ? `every free model · ${count}` : count;
}

/** Where the key comes from, in words — never the raw reference kind. */
function keySummary(row: ProviderRow): string {
  if (row.ownership === "builtin") return "key found automatically";
  switch (row.keyRefKind) {
    case "env":
      return row.keyRefDisplay;
    case "command":
      return "key from a command";
    case "env-template":
      return "key from a template";
    case "literal":
      return "key written in models.json";
    case "none":
      return "no key";
  }
}

/** A row in a bad state trades its facts line for one line of state. */
function rowState(row: ProviderRow): { tone: Tone; text: string } | undefined {
  if (row.error) return { tone: "danger", text: `Failed: ${row.error}` };
  if (row.ownership === "orphaned") return { tone: "warn", text: "Missing from models.json" };
  if (!row.apiSupported) return { tone: "warn", text: "Unavailable" };
  return undefined;
}

export interface ProviderListProps {
  providers: ProviderRow[];
  /** False when pi's bundled catalogue could not be located: the shell disables Add. */
  reservedComplete: boolean;
  busy: boolean;
  call: RpcCall;
  runBusy: RunBusy;
  /** The row currently expanded, if any. */
  openId?: string;
  /** Toggle the expanded row. */
  onToggle: (id: string) => void;
  onChanged: () => Promise<void> | void;
  onWrote: () => void;
  /** Rendered inside the expanded row: the editor. */
  renderPanel: (row: ProviderRow) => ReactNode;
}

export function ProviderList({
  providers,
  busy,
  call,
  runBusy,
  openId,
  onToggle,
  onChanged,
  onWrote,
  renderPanel,
}: ProviderListProps) {
  // The only action left at row level: a built-in that was never written has no
  // editor to host its Refresh. No drift confirmation — a block that is not in
  // models.json cannot have drifted.
  const refreshModels = (row: ProviderRow) =>
    runBusy(async () => {
      await call("refresh", { only: [row.id] });
      onWrote();
      toast.success(`${row.id} refreshed`);
      await onChanged();
    });

  if (providers.length === 0) {
    return <EmptyState>No providers yet. Add one to give pi more models.</EmptyState>;
  }

  return (
    <div className="divide-y divide-border">
      {providers.map((row) => (
        <Row
          key={row.id}
          row={row}
          open={openId === row.id}
          busy={busy}
          onToggle={onToggle}
          onRefreshModels={refreshModels}
          renderPanel={renderPanel}
        />
      ))}
    </div>
  );
}

function Row({
  row,
  open,
  busy,
  onToggle,
  onRefreshModels,
  renderPanel,
}: {
  row: ProviderRow;
  open: boolean;
  busy: boolean;
  onToggle: (id: string) => void;
  onRefreshModels: (row: ProviderRow) => Promise<void>;
  renderPanel: (row: ProviderRow) => ReactNode;
}) {
  const bareBuiltin = row.ownership === "builtin" && !row.inModelsJson;
  const state = rowState(row);
  const facts = `${modelSummary(row)} · ${keySummary(row)}`;

  const badge =
    row.ownership === "builtin" ? (
      <QuietBadge>built-in</QuietBadge>
    ) : row.ownership === "foreign" || row.ownership === "reserved" ? (
      <QuietBadge>models.json</QuietBadge>
    ) : null;

  // The action cannot legally nest inside the row <button>, so the button spans
  // the full row and the action floats above it. The floating layer ignores
  // pointer events and only the real button inside opts back in.
  return (
    <div className={cn(open && "-mx-2 my-1 rounded-md border border-border bg-card px-2")}>
      <div className="group relative">
        <button
          type="button"
          onClick={() => onToggle(row.id)}
          className={cn(
            "flex w-full items-center gap-3 py-2.5 text-left transition-none",
            open ? "cursor-default" : "hover:bg-state-hover",
            // why: reserve room under the floating action so text truncates before it
            bareBuiltin ? "pr-32" : "pr-16",
          )}
        >
          <Dot tone={providerTone(row)} />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">{row.name ?? row.id}</span>
              {badge}
            </div>
            {state ? (
              <div className="line-clamp-1 text-xs" title={state.text}>
                <ToneText tone={state.tone}>{state.text}</ToneText>
              </div>
            ) : (
              <div className="truncate text-xs text-muted-foreground" title={facts}>
                {facts}
              </div>
            )}
          </div>
        </button>
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-2">
          {bareBuiltin ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              className={HOVER_ACTION}
              onClick={() => void onRefreshModels(row)}
            >
              <RefreshIcon />
              Refresh models
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" disabled={busy} className={HOVER_ACTION} onClick={() => onToggle(row.id)}>
                Edit
              </Button>
              <ChevronDownIcon
                className={cn(
                  "size-3.5 shrink-0 text-subtle-foreground/60 transition-transform duration-150",
                  open && "rotate-180",
                )}
              />
            </>
          )}
        </div>
      </div>
      {open && <div className="border-t border-border-seam py-4">{renderPanel(row)}</div>}
    </div>
  );
}
