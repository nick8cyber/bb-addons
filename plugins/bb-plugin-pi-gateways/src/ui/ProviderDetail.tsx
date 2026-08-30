/**
 * The expanded card for one provider: what it is connected to, where its key
 * reference points, which models are written for it, and the destructive
 * actions. The model editor deliberately shows the union of what is saved and
 * what the gateway currently lists, so a model that quietly vanished from the
 * catalogue is visible rather than silently dropped on the next write.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type {
  ApiKind,
  ProbeOutput,
  ProviderDetailOutput,
  RefreshCustomOutput,
  UpdateCustomOutput,
} from "../contract.js";
import {
  EMPTY_KEY_SOURCE,
  KeySourceFields,
  ModelPriceChip,
  StateBadge,
  apiLabel,
  keySourceOf,
  modelSizeSummary,
  type KeySourceState,
  type RpcCall,
  type RunBusy,
} from "./AddProviderForm.js";

interface EditorRow {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Written into models.json today. */
  saved: boolean;
  /** Listed by the most recent successful probe. */
  fresh: boolean;
  free?: boolean;
  priceKnown?: boolean;
}

export interface ProviderDetailProps {
  id: string;
  call: RpcCall;
  busy: boolean;
  runBusy: RunBusy;
  onClose: () => void;
  /** Reload the inventory after a mutation. */
  onChanged: () => Promise<void> | void;
  /** A write landed in models.json: arm the picker-restart notice. */
  onWrote: () => void;
}

export function ProviderDetail({ id, call, busy, runBusy, onClose, onChanged, onWrote }: ProviderDetailProps) {
  const [detail, setDetail] = useState<ProviderDetailOutput | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [selectionMode, setSelectionMode] = useState<"all-free" | "explicit">("explicit");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [touchedModels, setTouchedModels] = useState(false);
  const [probe, setProbe] = useState<ProbeOutput | undefined>(undefined);
  const [probing, setProbing] = useState(false);
  const [migrateKey, setMigrateKey] = useState(false);
  const [keyForm, setKeyForm] = useState<KeySourceState>(EMPTY_KEY_SOURCE);
  const [mismatch, setMismatch] = useState<string | undefined>(undefined);
  // Destructive actions and drift overwrites confirm on a second press of the same
  // button rather than through window.confirm: a native dialog is suppressed in some
  // host contexts, where the click then silently does nothing, and it cannot be styled.
  const [pending, setPending] = useState<"delete" | "disown" | "save-drift" | "refresh-drift" | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const result = await call<ProviderDetailOutput>("providerDetail", { id });
      setDetail(result);
      setLoadError(undefined);
      setName(result.row.name ?? result.row.id);
      setBaseUrl(result.row.baseUrl ?? "");
      setFreeOnly(result.row.freeOnly ?? false);
      setSelectionMode(result.row.selectionMode ?? "explicit");
      setSelected(new Set(result.models.map((model) => model.id)));
      setTouchedModels(false);
      setProbe(undefined);
      setMigrateKey(false);
      setKeyForm(EMPTY_KEY_SOURCE);
      setMismatch(undefined);
      setPending(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [call, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const row = detail?.row;
  const editable = row?.ownership === "owned" || row?.ownership === "adopted" || row?.ownership === "orphaned";
  const inlineKey = detail?.manifest?.keySource.type === "inline";
  const requiresExplicitModels = row?.requiresExplicitModels ?? true;
  const keySource = keySourceOf(keyForm);
  const baseUrlChanged = Boolean(row) && baseUrl.trim() !== (row?.baseUrl ?? "");

  const editorRows = useMemo<EditorRow[]>(() => {
    if (!detail) return [];
    const fresh = new Map((probe?.ok ? probe.models : []).map((model) => [model.id, model]));
    const rows: EditorRow[] = detail.models.map((model) => {
      const match = fresh.get(model.id);
      return {
        id: model.id,
        name: model.name,
        contextWindow: match?.contextWindow ?? model.contextWindow,
        maxTokens: match?.maxTokens ?? model.maxTokens,
        saved: true,
        fresh: Boolean(match),
        free: match?.free,
        priceKnown: match?.priceKnown,
      };
    });
    const savedIds = new Set(detail.models.map((model) => model.id));
    for (const model of fresh.values()) {
      if (savedIds.has(model.id)) continue;
      rows.push({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        saved: false,
        fresh: true,
        free: model.free,
        priceKnown: model.priceKnown,
      });
    }
    return rows;
  }, [detail, probe]);

  const probedOk = Boolean(probe?.ok);
  /**
   * Ticked ids we can positively say no reachable catalogue lists — either the
   * protocol cannot be probed at all, or a probe just came back without them.
   * Never assumed from a missing probe: the host fetches the catalogue itself on
   * save, and its verification is worth more than a guess made here.
   */
  const unverifiedSelection = useMemo(() => {
    if (row && !row.apiSupported) return selected.size > 0;
    if (!probedOk) return false;
    const listed = new Set((probe?.models ?? []).map((model) => model.id));
    return [...selected].some((modelId) => !listed.has(modelId));
  }, [probe, probedOk, row, selected]);

  const toggleModel = (modelId: string) => {
    setTouchedModels(true);
    setSelectionMode("explicit");
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const runProbe = () =>
    runBusy(async () => {
      if (!row || !row.apiSupported) throw new Error("this provider's protocol is not one the plugin can speak");
      if (!baseUrl.trim()) throw new Error("a base URL is required to test the connection");
      setProbing(true);
      setProbe(undefined);
      try {
        const result = await call<ProbeOutput>("probe", {
          id: row.id,
          presetId: row.presetId,
          baseUrl: baseUrl.trim(),
          // The host reads the protocol back off the managed entry; the field is
          // required by the schema and only a supported row reaches this point.
          api: (row.api ?? "openai-completions") as ApiKind,
        });
        setProbe(result);
        if (!result.ok) {
          toast.error(`probe failed: ${result.error ?? "unknown error"}`);
          return;
        }
        toast.success(`${result.totalCount} compatible models, ${result.freeCount} free`);
      } finally {
        setProbing(false);
      }
    });

  const save = () => {
    if (!row) return;
    if (baseUrlChanged && !probedOk) {
      toast.error("test the connection after changing the service URL before saving");
      return;
    }
    // Overwriting a block that changed outside the plugin needs the same second press.
    if (row.drifted && pending !== "save-drift") {
      setPending("save-drift");
      return;
    }
    setPending(undefined);
    void runBusy(async () => {
      const patch: Record<string, unknown> = { id: row.id };
      if (name.trim() && name.trim() !== (row.name ?? row.id)) patch.name = name.trim();
      if (baseUrlChanged) patch.baseUrl = baseUrl.trim();
      if (freeOnly !== (row.freeOnly ?? false)) patch.freeOnly = freeOnly;
      if (touchedModels) {
        patch.selectionMode = selectionMode;
        if (selectionMode === "explicit") {
          if (selected.size === 0) throw new Error("select at least one model, or switch to every free model");
          patch.selectedModelIds = [...selected].sort();
          if (unverifiedSelection) patch.allowUnverifiedModels = true;
        }
      }
      if (migrateKey) {
        if (!keySource) throw new Error("fill in where the key should live before migrating");
        patch.keySource = keySource;
        if (mismatch) patch.confirmMismatch = true;
      }
      if (row.drifted) patch.acceptDrift = true;
      try {
        const result = await call<UpdateCustomOutput>("updateCustom", patch);
        if (result.warning) toast.warning(result.warning);
        if (result.missing?.length) {
          toast.warning(`kept ${result.missing.length} model(s) the catalogue no longer lists`);
        }
        onWrote();
        toast.success(`${row.id} saved (${result.modelCount} models)`);
        setMismatch(undefined);
        await onChanged();
        await load();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The host refuses a key migration whose new source resolves to a different
        // token; re-sending with confirmMismatch is the user's explicit override.
        if (migrateKey && !mismatch && /mismatch|different token/i.test(message)) {
          setMismatch(message);
          return;
        }
        throw error;
      }
    });
  };

  const refresh = () => {
    if (!row) return;
    if (row.drifted && pending !== "refresh-drift") {
      setPending("refresh-drift");
      return;
    }
    setPending(undefined);
    void runBusy(async () => {
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
      await load();
    });
  };

  const remove = () => {
    if (!row) return;
    if (pending !== "delete") {
      setPending("delete");
      return;
    }
    setPending(undefined);
    void runBusy(async () => {
      await call("deleteProvider", { id: row.id, force: row.ownership === "foreign" ? true : undefined });
      onWrote();
      toast.success(`${row.id} deleted`);
      await onChanged();
      onClose();
    });
  };

  const disown = () => {
    if (!row) return;
    if (pending !== "disown") {
      setPending("disown");
      return;
    }
    setPending(undefined);
    void runBusy(async () => {
      await call("disown", { id: row.id });
      toast.success(`${row.id} is no longer managed here — models.json is untouched`);
      await onChanged();
      onClose();
    });
  };

  if (loadError) {
    return (
      <Card className="border-primary">
        <CardContent className="flex items-start justify-between gap-2 pt-6 text-xs">
          <span className="text-red-600 dark:text-red-400">{loadError}</span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!detail || !row) {
    return (
      <Card className="border-primary">
        <CardContent className="pt-6 text-xs text-muted-foreground">Loading {id}…</CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-primary">
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium">{row.name ?? row.id}</div>
            <div className="truncate text-xs text-muted-foreground">
              <code>{row.id}</code> · {apiLabel(row.api)} · {row.modelCount} models ·{" "}
              {row.inModelsJson ? <StateBadge ok>in models.json</StateBadge> : <StateBadge ok={false}>not in models.json</StateBadge>}
            </div>
          </div>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Close
          </Button>
        </div>

        {row.drifted && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            This block changed outside the plugin since it was last written here. Saving or refreshing overwrites those
            changes, and asks for a second press before doing so.
          </div>
        )}
        {row.error && <div className="text-xs text-red-600 dark:text-red-400">{row.error}</div>}
        {row.warnings.map((warning) => (
          <div key={warning} className="text-xs text-amber-600 dark:text-amber-400">
            {warning}
          </div>
        ))}
        {(row.ownership === "foreign" || row.ownership === "reserved") && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            {row.ownership === "foreign"
              ? "This provider is read-only until it is adopted. Close details and press Adopt in the provider list before testing or editing it."
              : "This provider id is reserved by pi and cannot be adopted or edited here."}
          </div>
        )}

        {/* ---- Connection ------------------------------------------------------ */}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Display name</span>
            <Input value={name} disabled={!editable || busy} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Service URL</span>
            <Input
              value={baseUrl}
              disabled={!editable || busy || Boolean(row.presetId)}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setProbe(undefined);
              }}
            />
          </label>
          <div className="sm:col-span-2 space-y-1 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
            <div>
              Protocol: {apiLabel(row.api)}
              {!row.apiSupported && (
                <span className="ml-1 text-amber-600 dark:text-amber-400">
                  — not one this plugin can speak; probe and refresh are unavailable
                </span>
              )}
              . The protocol is never editable: a different one is a different provider.
            </div>
            {row.presetId && (
              <div>
                Linked preset: <code>{row.presetId}</code> — its URL is fixed by the preset.
              </div>
            )}
            {row.pricingPolicy && <div>Pricing policy: {row.pricingPolicy}</div>}
            {detail.manifest && (
              <div>
                {detail.manifest.origin === "adopted" ? "Adopted" : "Created"} here
                {detail.manifest.adoptedAt ? ` on ${detail.manifest.adoptedAt.slice(0, 10)}` : ""}
                {detail.manifest.updatedAt ? `, last written ${detail.manifest.updatedAt.slice(0, 10)}` : ""}
              </div>
            )}
            {detail.headerNames.length > 0 && (
              <div>
                Custom headers: {detail.headerNames.map((header) => `${header}: «set»`).join(", ")} — carried forward
                verbatim on every write and never read out.
              </div>
            )}
            {baseUrlChanged && (
              <div className="text-amber-600 dark:text-amber-400">
                A changed service URL must be tested before it can be saved.
              </div>
            )}
          </div>
        </div>

        {/* ---- Key reference --------------------------------------------------- */}
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="text-xs">
            Key reference: <span className="font-mono">{row.keyRefDisplay}</span>{" "}
            <span className="text-muted-foreground">({row.keyRefKind})</span>
          </div>
          {inlineKey && (
            <div className="text-xs text-muted-foreground">
              This key lives only in models.json — the plugin has never copied it. It is read live whenever a probe or
              refresh needs it, and carried forward unchanged on every write.
            </div>
          )}
          {editable && (
            <>
              {!migrateKey ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setMigrateKey(true);
                    setMismatch(undefined);
                  }}
                >
                  {inlineKey ? "Migrate key reference" : "Point at a different key"}
                </Button>
              ) : (
                <>
                  <KeySourceFields
                    value={keyForm}
                    onChange={(patch) => {
                      setKeyForm((previous) => ({ ...previous, ...patch }));
                      setMismatch(undefined);
                    }}
                    label="Where the key should live from now on — saving rewrites the block to reference it:"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setMigrateKey(false);
                      setKeyForm(EMPTY_KEY_SOURCE);
                      setMismatch(undefined);
                    }}
                  >
                    Keep the current reference
                  </Button>
                </>
              )}
            </>
          )}
          {mismatch && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
              {mismatch}
              <div className="mt-1 text-muted-foreground">Press Save again to rewrite it with the new reference anyway.</div>
            </div>
          )}
        </div>

        {/* ---- Models ---------------------------------------------------------- */}
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-medium">Models written for this provider</div>
            <div className="flex gap-2">
              {editable && row.apiSupported && (
                <Button variant="secondary" size="sm" disabled={busy || probing} onClick={() => void runProbe()}>
                  {probing ? "Probing…" : "Test connection"}
                </Button>
              )}
              {editable && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setTouchedModels(true);
                    setSelectionMode("explicit");
                    setSelected(new Set(editorRows.filter((model) => model.fresh || model.saved).map((model) => model.id)));
                  }}
                >
                  Select all listed
                </Button>
              )}
              {editable && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setTouchedModels(true);
                    setSelectionMode("explicit");
                    setSelected(new Set());
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>

          {editable && !requiresExplicitModels && (
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="radio"
                checked={selectionMode === "all-free"}
                onChange={() => {
                  setTouchedModels(true);
                  setSelectionMode("all-free");
                }}
              />
              Keep every free model the gateway lists
              <input
                type="radio"
                className="ml-4"
                checked={selectionMode === "explicit"}
                onChange={() => {
                  setTouchedModels(true);
                  setSelectionMode("explicit");
                }}
              />
              Only the models ticked below
            </label>
          )}

          {probe && !probe.ok && (
            <div className="text-xs text-red-600 dark:text-red-400">Probe failed: {probe.error}</div>
          )}

          <div className="max-h-64 space-y-1 overflow-y-auto">
            {editorRows.map((model) => (
              <label
                key={model.id}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent"
              >
                <input
                  type="checkbox"
                  disabled={!editable || busy || selectionMode === "all-free"}
                  checked={selected.has(model.id)}
                  onChange={() => toggleModel(model.id)}
                />
                <span className="truncate font-mono">{model.id}</span>
                {modelSizeSummary(model) && <span className="text-muted-foreground">{modelSizeSummary(model)}</span>}
                {probedOk && model.saved && !model.fresh && (
                  <span className="text-amber-600 dark:text-amber-400">saved · delisted</span>
                )}
                {model.fresh && !model.saved && <span className="text-emerald-600 dark:text-emerald-400">new in catalogue</span>}
                <ModelPriceChip free={model.free} priceKnown={model.priceKnown} />
              </label>
            ))}
            {editorRows.length === 0 && (
              <div className="py-2 text-xs text-muted-foreground">
                Nothing is written for this provider yet. Test the connection to list what the gateway offers.
              </div>
            )}
          </div>

          {!probedOk && (
            <div className="text-xs text-muted-foreground">
              Prices are shown once the connection has been tested — the list above is what models.json holds today.
            </div>
          )}
          {touchedModels && selectionMode === "explicit" && unverifiedSelection && (
            <div className="text-xs text-amber-600 dark:text-amber-400">
              Some ticked models are not in a catalogue this plugin has seen; they will be written by id alone.
            </div>
          )}
          {editorRows.some((model) => model.priceKnown === false) && (
            <div className="text-xs text-muted-foreground">* no published price: not classified as free</div>
          )}
        </div>

        {editable && !requiresExplicitModels && (
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={freeOnly}
              disabled={busy}
              onChange={(e) => setFreeOnly(e.target.checked)}
              className="mt-0.5 size-4"
            />
            <span className="text-xs">
              Free models only (zero-priced)
              {!freeOnly && (
                <span className="mt-0.5 block font-medium text-red-600 dark:text-red-400">
                  Paid models will be offered too — picking one spends real money on this endpoint.
                </span>
              )}
            </span>
          </label>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {editable && (
            <Button size="sm" disabled={busy || probing} onClick={save}>
              {pending === "save-drift" ? "Overwrite and save" : mismatch ? "Save anyway" : "Save"}
            </Button>
          )}
          {row.apiSupported && (row.ownership === "owned" || row.ownership === "adopted" || row.ownership === "orphaned") && (
            <Button variant="outline" size="sm" disabled={busy} onClick={refresh}>
              {pending === "refresh-drift" ? "Overwrite and refresh" : "Refresh"}
            </Button>
          )}
          {(pending === "save-drift" || pending === "refresh-drift") && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPending(undefined)}>
              Cancel
            </Button>
          )}
        </div>

        {/* ---- Danger zone ----------------------------------------------------- */}
        {(row.ownership === "owned" || row.ownership === "adopted" || row.ownership === "orphaned" || row.ownership === "foreign") && (
          <div className="space-y-2 rounded-md border border-red-500/40 p-3">
            <div className="text-xs font-medium text-red-600 dark:text-red-400">Danger zone</div>
            {pending === "delete" && (
              <div className="text-xs text-red-600 dark:text-red-400">
                {row.ownership === "foreign"
                  ? "This block is not managed here. Deleting it may simply be rewritten by whatever generates it — press Confirm delete to force it."
                  : "The provider block and everything this plugin remembers about it will be removed."}
              </div>
            )}
            {pending === "disown" && (
              <div className="text-xs text-amber-600 dark:text-amber-400">
                Forgetting leaves the models.json block exactly as it is and only stops managing it here.
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {row.ownership !== "orphaned" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="text-red-600 dark:text-red-400"
                  onClick={remove}
                >
                  {pending === "delete" ? "Confirm delete" : "Delete"}
                </Button>
              )}
              {(row.ownership === "adopted" || row.ownership === "orphaned") && (
                <Button variant="outline" size="sm" disabled={busy} onClick={disown}>
                  {pending === "disown" ? "Confirm forget" : "Forget (keep the block)"}
                </Button>
              )}
              {(pending === "delete" || pending === "disown") && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPending(undefined)}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
