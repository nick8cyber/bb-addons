/**
 * The expanded detail of one provider row: what it is connected to, where its
 * key reference points, which models are written for it, and the destructive
 * actions. It renders content only — the row above it carries the name and the
 * chevron that closes it. The model editor deliberately shows the union of what
 * is saved and what the gateway currently lists, so a model that quietly
 * vanished from the catalogue is visible rather than silently dropped on the
 * next write.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
  apiLabel,
  keySourceOf,
  modelSizeSummary,
  type KeySourceState,
  type RpcCall,
  type RunBusy,
} from "./atoms.js";
import { KeyIcon, SpinnerIcon } from "./icons.js";
import {
  ActionBar,
  Badge,
  Block,
  Choice,
  Field,
  MetaLine,
  ModelPicker,
  Mono,
  Note,
  Segmented,
  Spacer,
  ToneText,
} from "./kit.js";

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
      <div className="space-y-3">
        <Note tone="danger" boxed>
          {loadError}
        </Note>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
          Close
        </Button>
      </div>
    );
  }

  if (!detail || !row) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <SpinnerIcon /> Loading…
      </div>
    );
  }

  const canRefresh =
    row.apiSupported && (row.ownership === "owned" || row.ownership === "adopted" || row.ownership === "orphaned");
  const canForget = row.ownership === "adopted" || row.ownership === "orphaned";
  const canDelete = row.ownership === "owned" || row.ownership === "adopted" || row.ownership === "foreign";

  return (
    <div className="space-y-5">
      {row.drifted && (
        <Note tone="warn" boxed>
          Changed outside the plugin since it was last written here. Saving or refreshing overwrites those changes and
          asks twice.
        </Note>
      )}
      {row.error && (
        <Note tone="danger" boxed>
          {row.error}
        </Note>
      )}
      {row.warnings.map((warning) => (
        <Note key={warning} tone="warn">
          {warning}
        </Note>
      ))}
      {row.ownership === "foreign" && (
        <Note tone="warn" boxed>
          Read-only until adopted. Press Adopt in the row above to edit or test it.
        </Note>
      )}
      {row.ownership === "reserved" && (
        <Note tone="warn" boxed>
          This id is reserved by pi and cannot be adopted or edited here.
        </Note>
      )}

      <Block title="Connection">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Display name">
            <Input value={name} disabled={!editable || busy} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Service URL">
            <Input
              value={baseUrl}
              disabled={!editable || busy || Boolean(row.presetId)}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setProbe(undefined);
              }}
            />
          </Field>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-surface-recessed px-3 py-2 text-2xs">
          <dt className="text-subtle-foreground">Protocol</dt>
          <dd className="min-w-0 text-foreground">
            {apiLabel(row.api)} {!row.apiSupported && <ToneText tone="warn">not supported here</ToneText>}
          </dd>
          {row.presetId && (
            <>
              <dt className="text-subtle-foreground">Preset</dt>
              <dd className="min-w-0 text-foreground">
                <Mono>{row.presetId}</Mono> — its URL is fixed by the preset
              </dd>
            </>
          )}
          {row.pricingPolicy && (
            <>
              <dt className="text-subtle-foreground">Pricing</dt>
              <dd className="min-w-0 text-foreground">{row.pricingPolicy}</dd>
            </>
          )}
          {detail.manifest && (
            <>
              <dt className="text-subtle-foreground">Origin</dt>
              <dd className="min-w-0 text-foreground">
                {detail.manifest.origin === "adopted" ? "Adopted" : "Created"} here
                {detail.manifest.adoptedAt ? ` on ${detail.manifest.adoptedAt.slice(0, 10)}` : ""}
                {detail.manifest.updatedAt ? `, last written ${detail.manifest.updatedAt.slice(0, 10)}` : ""}
              </dd>
            </>
          )}
          {detail.headerNames.length > 0 && (
            <>
              <dt className="text-subtle-foreground">Headers</dt>
              <dd className="min-w-0 text-foreground">
                {detail.headerNames.join(", ")} — carried forward, never read out
              </dd>
            </>
          )}
        </dl>
        <Note>The protocol is never editable: a different protocol is a different provider.</Note>
        {baseUrlChanged && <Note tone="warn">A changed service URL must be tested before it can be saved.</Note>}
      </Block>

      <Block title="Key">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <KeyIcon className="text-muted-foreground" />
          <Mono className="min-w-0 break-all">{row.keyRefDisplay}</Mono>
          <Badge>{row.keyRefKind}</Badge>
        </div>
        {inlineKey && (
          <Note>
            Lives only in models.json. The plugin never copies it — it is read live when needed and carried forward on
            every write.
          </Note>
        )}
        {editable && !migrateKey && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setMigrateKey(true);
              setMismatch(undefined);
            }}
          >
            {inlineKey ? "Migrate key" : "Change key"}
          </Button>
        )}
        {editable && migrateKey && (
          <>
            <KeySourceFields
              value={keyForm}
              onChange={(patch) => {
                setKeyForm((previous) => ({ ...previous, ...patch }));
                setMismatch(undefined);
              }}
              label="Where the key should live from now on"
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
              Cancel
            </Button>
          </>
        )}
        {mismatch && (
          <Note tone="warn" boxed>
            {mismatch} Press Save again to rewrite it with the new reference.
          </Note>
        )}
      </Block>

      <Block
        title="Models"
        actions={
          <>
            {editable && row.apiSupported && (
              <Button variant="outline" size="sm" disabled={busy || probing} onClick={() => void runProbe()}>
                {probing ? (
                  <>
                    <SpinnerIcon /> Testing…
                  </>
                ) : (
                  "Test"
                )}
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
                Select all
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
          </>
        }
      >
        {editable && !requiresExplicitModels && (
          <Segmented
            value={selectionMode}
            options={[
              { value: "all-free", label: "Every free model" },
              { value: "explicit", label: "Only ticked" },
            ]}
            onChange={(mode) => {
              setTouchedModels(true);
              setSelectionMode(mode);
            }}
          />
        )}

        {probe && !probe.ok && <Note tone="danger">Probe failed: {probe.error}</Note>}

        <ModelPicker
          rows={editorRows.map((model) => ({
            id: model.id,
            size: modelSizeSummary(model),
            price: <ModelPriceChip free={model.free} priceKnown={model.priceKnown} />,
            tags:
              probedOk && model.saved && !model.fresh ? (
                <Badge tone="warn">delisted</Badge>
              ) : model.fresh && !model.saved ? (
                <Badge tone="ok">new</Badge>
              ) : undefined,
          }))}
          selected={selected}
          onToggle={toggleModel}
          disabled={!editable || busy || selectionMode === "all-free"}
          empty="Nothing is written for this provider yet. Test the connection to see what the gateway offers."
        />
        <MetaLine items={[`${selected.size} of ${editorRows.length} selected`]} />

        {!probedOk && (
          <Note>Prices appear once the connection is tested — the list above is what models.json holds today.</Note>
        )}
        {touchedModels && selectionMode === "explicit" && unverifiedSelection && (
          <Note tone="warn">
            Some ticked models are not in any catalogue this plugin has seen; they will be written by id alone.
          </Note>
        )}
        {editorRows.some((model) => model.priceKnown === false) && (
          <Note>* no published price: not classified as free</Note>
        )}

        {editable && !requiresExplicitModels && (
          <Choice
            type="checkbox"
            checked={freeOnly}
            disabled={busy}
            onSelect={() => setFreeOnly((previous) => !previous)}
            title="Free models only (zero-priced)"
            tone="danger"
            description={!freeOnly ? "Paid models will be offered too — picking one spends real money." : undefined}
          />
        )}
      </Block>

      {pending === "delete" && (
        <Note tone="danger">
          {row.ownership === "foreign"
            ? "This block is not managed here and may be rewritten by whatever generates it. Press Confirm delete to force it."
            : "Removes the provider block and everything this plugin remembers about it."}
        </Note>
      )}
      {pending === "disown" && (
        <Note tone="warn">Leaves the models.json block exactly as it is and only stops managing it here.</Note>
      )}
      {pending === "save-drift" && (
        <Note tone="warn">Saving overwrites the changes made outside the plugin.</Note>
      )}
      {pending === "refresh-drift" && (
        <Note tone="warn">Refreshing overwrites the changes made outside the plugin.</Note>
      )}

      {(editable || canRefresh || canForget || canDelete) && (
        <ActionBar>
          {editable && (
            <Button size="sm" disabled={busy || probing} onClick={save}>
              {pending === "save-drift" ? "Overwrite and save" : mismatch ? "Save anyway" : "Save"}
            </Button>
          )}
          {canRefresh && (
            <Button variant="outline" size="sm" disabled={busy} onClick={refresh}>
              {pending === "refresh-drift" ? "Overwrite and refresh" : "Refresh"}
            </Button>
          )}
          {pending !== undefined && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPending(undefined)}>
              Cancel
            </Button>
          )}
          <Spacer />
          {canForget && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={disown}>
              {pending === "disown" ? "Confirm forget" : "Forget"}
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="text-destructive-text hover:text-destructive-text"
              onClick={remove}
            >
              {pending === "delete" ? "Confirm delete" : "Delete"}
            </Button>
          )}
        </ActionBar>
      )}
    </div>
  );
}
