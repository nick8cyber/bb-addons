/**
 * "Add a provider": preset picker, connection fields, key-source inputs, a live
 * probe and the save call. Lifted out of PiGatewaysSection with minimal edits.
 *
 * This module is also the home of the small atoms the rest of `src/ui` shares —
 * the key-source inputs, the model chips, the state badge and the call types.
 * The add form is their primary consumer, and the provider manager keeps its
 * whole UI inside these few modules rather than growing a helper file per atom.
 */
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ApiKind, EditableKeySource, ProbeOutput, SaveCustomOutput } from "../contract.js";
import {
  SAVED_PROVIDER_PRESETS,
  availableProviderId,
  findSavedProviderPreset,
  type SavedProviderPresetId,
} from "../presets.js";

/** Every RPC in this section goes through the shell so the host picker applies uniformly. */
export type RpcCall = <T>(method: string, input?: object) => Promise<T>;
/** Runs an action behind the shared busy flag, reporting failures as a toast. */
export type RunBusy = (action: () => Promise<void>) => Promise<void>;

export const API_OPTIONS: Array<{ value: ApiKind; label: string }> = [
  { value: "openai-completions", label: "OpenAI-compatible chat" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic-compatible messages" },
  { value: "google-generative-ai", label: "Google Gemini" },
];

export function apiLabel(api: string | undefined): string {
  if (!api) return "no protocol";
  return API_OPTIONS.find((option) => option.value === api)?.label ?? api;
}

function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

export function StateBadge({ ok, children }: { ok: boolean | undefined; children: ReactNode }) {
  const tone =
    ok === undefined
      ? "text-muted-foreground"
      : ok
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-red-600 dark:text-red-400";
  return <span className={`text-xs font-medium ${tone}`}>{children}</span>;
}

/** Context/output sizes of a catalogue entry, rendered compactly or not at all. */
export function modelSizeSummary(model: { contextWindow?: number; maxTokens?: number }): string {
  const parts: string[] = [];
  if (model.contextWindow) parts.push(`${Math.round(model.contextWindow / 1000)}k context`);
  if (model.maxTokens) parts.push(`${Math.round(model.maxTokens / 1000)}k output`);
  return parts.join(" · ");
}

/**
 * The free/paid/price-unknown chip. `priceKnown === false` means the catalogue
 * carries no pricing block at all, which is never silently read as "free" for
 * providers whose pricing semantics we cannot verify.
 */
export function ModelPriceChip({ free, priceKnown }: { free?: boolean; priceKnown?: boolean }) {
  if (priceKnown === false) return <span className="ml-auto text-amber-600 dark:text-amber-400">price not listed*</span>;
  if (free === undefined) return <span className="ml-auto text-muted-foreground">price unknown</span>;
  return free ? (
    <span className="ml-auto text-emerald-600 dark:text-emerald-400">free</span>
  ) : (
    <span className="ml-auto text-red-600 dark:text-red-400">paid</span>
  );
}

/** The three ways a key may be referenced. A pasted secret is never one of them. */
export interface KeySourceState {
  keyType: "file" | "env" | "command";
  keyFile: string;
  keyEnv: string;
  keyCommand: string;
}

export const EMPTY_KEY_SOURCE: KeySourceState = {
  keyType: "env",
  keyFile: "",
  keyEnv: "",
  keyCommand: "",
};

export function keySourceOf(state: KeySourceState): EditableKeySource | undefined {
  if (state.keyType === "file" && state.keyFile.trim()) return { type: "file", path: state.keyFile.trim() };
  if (state.keyType === "env" && state.keyEnv.trim()) return { type: "env", name: state.keyEnv.trim() };
  if (state.keyType === "command" && state.keyCommand.trim()) return { type: "command", command: state.keyCommand.trim() };
  return undefined;
}

/** What will actually be written into models.json — proof that no secret is stored. */
export function keyRefPreview(state: KeySourceState): string | undefined {
  switch (state.keyType) {
    case "file":
      return state.keyFile.trim() ? `!node …/readers/read-file.mjs "${state.keyFile.trim()}"` : undefined;
    case "env":
      return state.keyEnv.trim() ? `$${state.keyEnv.trim()}` : undefined;
    case "command":
      return state.keyCommand.trim() ? `!${state.keyCommand.trim()}` : undefined;
  }
}

/** The env/file/command inputs, shared by the add form, the detail card and adoption. */
export function KeySourceFields({
  value,
  onChange,
  label = "Where the API key lives — only a reference to it gets saved:",
}: {
  value: KeySourceState;
  onChange: (patch: Partial<KeySourceState>) => void;
  label?: string;
}) {
  const preview = keyRefPreview(value);
  return (
    <div className="space-y-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-4">
        {(["env", "file", "command"] as const).map((kind) => (
          <label key={kind} className="flex cursor-pointer items-center gap-1.5 text-xs">
            <input type="radio" checked={value.keyType === kind} onChange={() => onChange({ keyType: kind })} />
            {kind === "env" ? "environment variable" : kind === "file" ? "file path" : "shell command"}
          </label>
        ))}
      </div>
      {value.keyType === "env" && (
        <Input value={value.keyEnv} onChange={(e) => onChange({ keyEnv: e.target.value })} placeholder="MY_GATEWAY_API_KEY" />
      )}
      {value.keyType === "file" && (
        <Input value={value.keyFile} onChange={(e) => onChange({ keyFile: e.target.value })} placeholder="/home/me/.config/mygateway.key" />
      )}
      {value.keyType === "command" && (
        <>
          <Input value={value.keyCommand} onChange={(e) => onChange({ keyCommand: e.target.value })} placeholder="pass show mygateway/token" />
          <span className="block text-xs text-muted-foreground">
            the command itself is stored verbatim and runs whenever pi starts a session — make sure it prints only the token
          </span>
        </>
      )}
      {preview && (
        <div className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">will be written as: {preview}</div>
      )}
    </div>
  );
}

interface FormState extends KeySourceState {
  presetId: SavedProviderPresetId | "custom";
  name: string;
  baseUrl: string;
  api: ApiKind;
  freeOnly: boolean;
}

const EMPTY_FORM: FormState = {
  ...EMPTY_KEY_SOURCE,
  presetId: "custom",
  name: "",
  baseUrl: "",
  api: "openai-completions",
  freeOnly: true,
};

export interface AddProviderFormProps {
  call: RpcCall;
  busy: boolean;
  runBusy: RunBusy;
  /** Ids already visible in models.json or the manifest, for the preview only. */
  takenIds: ReadonlySet<string>;
  /** False when pi's bundled catalogue could not be located: saving is refused. */
  reservedComplete: boolean;
  onSaved: () => Promise<void> | void;
}

export function AddProviderForm({ call, busy, runBusy, takenIds, reservedComplete, onSaved }: AddProviderFormProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [probe, setProbe] = useState<ProbeOutput | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [probing, setProbing] = useState(false);
  // Saving an endpoint whose live call failed on every model confirms on a second
  // press of the same button: the first press explains the risk, the second goes through.
  const [confirmDeadSave, setConfirmDeadSave] = useState(false);

  const update = (patch: Partial<FormState>) => setForm((previous) => ({ ...previous, ...patch }));
  const updateConnection = (patch: Partial<FormState>) => {
    update(patch);
    setProbe(undefined);
    setSelected(new Set());
    setConfirmDeadSave(false);
  };

  const choosePreset = (presetId: SavedProviderPresetId | "custom") => {
    const preset = presetId === "custom" ? undefined : findSavedProviderPreset(presetId);
    setForm(
      preset
        ? {
            ...EMPTY_FORM,
            presetId,
            name: preset.name,
            baseUrl: preset.baseUrl,
            api: preset.api,
            keyEnv: preset.keyEnv,
            freeOnly: preset.pricing !== "unknown",
          }
        : EMPTY_FORM,
    );
    // A previous provider's discovery result and pinned models are never valid
    // for the next preset, even when both happen to speak the same protocol.
    setProbe(undefined);
    setSelected(new Set());
    setConfirmDeadSave(false);
  };

  const activePreset = form.presetId === "custom" ? undefined : findSavedProviderPreset(form.presetId);
  const generatedId = useMemo(() => {
    const stem = (activePreset?.idStem ?? form.name) || endpointHost(form.baseUrl) || "custom-gateway";
    return availableProviderId(stem, takenIds);
  }, [activePreset?.idStem, form.baseUrl, form.name, takenIds]);
  const isGoogle = form.api === "google-generative-ai";
  const requiresExplicitModels = activePreset?.requiresExplicitModels ?? isGoogle;
  const pricingNotGuaranteed = activePreset?.pricing === "unknown" || isGoogle;
  const strictCataloguePricing = activePreset?.pricing !== undefined || isGoogle;

  const keySource = keySourceOf(form);

  const runProbe = () =>
    runBusy(async () => {
      if (!form.baseUrl.trim() || !keySource) throw new Error("fill the base URL and the key source first");
      setProbing(true);
      setProbe(undefined);
      setSelected(new Set());
      try {
        const result = await call<ProbeOutput>("probe", {
          presetId: form.presetId === "custom" ? undefined : form.presetId,
          baseUrl: form.baseUrl.trim(),
          api: form.api,
          keySource,
        });
        setProbe(result);
        if (!result.ok) {
          toast.error(`probe failed: ${result.error ?? "unknown error"}`);
          return;
        }
        toast.success(
          pricingNotGuaranteed
            ? `${result.totalCount} compatible models; catalogue pricing is not guaranteed`
            : `${result.totalCount} models, ${result.freeCount} free`,
        );
      } finally {
        setProbing(false);
      }
    });

  const save = () =>
    runBusy(async () => {
      if (!form.name.trim() || !form.baseUrl.trim() || !keySource) {
        throw new Error("name, base URL and a key source are required");
      }
      if (requiresExplicitModels && selected.size === 0) {
        throw new Error("test the connection and explicitly select at least one model before saving");
      }
      // A failing smoke test with no explicit narrowing almost guarantees a dead
      // picker entry, so the first Save only arms the button and says why.
      if (probe?.ok && probe.sampleCall && !probe.sampleCall.ok && selected.size === 0 && !confirmDeadSave) {
        setConfirmDeadSave(true);
        throw new Error(
          "the live call failed for every model — press Save again to store it anyway, or narrow the selection",
        );
      }
      setConfirmDeadSave(false);
      const result = await call<SaveCustomOutput>("saveCustom", {
        // Leave the automatic value to the host so it can also see foreign
        // models.json providers and close any last-moment collision race.
        presetId: form.presetId === "custom" ? undefined : form.presetId,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        api: form.api,
        keySource,
        freeOnly: requiresExplicitModels ? false : form.freeOnly,
        selectionMode: requiresExplicitModels || selected.size > 0 ? "explicit" : "all-free",
        selectedModelIds: selected.size > 0 ? [...selected].sort() : undefined,
      });
      if (result.warning) toast.warning(result.warning);
      toast.success(`${form.name.trim()} saved as ${result.id}`);
      setForm(EMPTY_FORM);
      setProbe(undefined);
      setSelected(new Set());
      await onSaved();
    });

  const toggleModel = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectableModels = (probe?.models ?? []).filter(
    (model) => requiresExplicitModels || model.free || !form.freeOnly,
  );

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div>
          <div className="font-medium">Add a provider</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Start from a known service, or choose Custom for another endpoint.
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          {SAVED_PROVIDER_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => choosePreset(preset.id)}
              className={`rounded-lg border p-3 text-left transition-colors hover:bg-accent ${
                form.presetId === preset.id ? "border-primary bg-accent" : "border-border"
              }`}
            >
              <span className="block font-medium">{preset.name}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{preset.description}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => choosePreset("custom")}
            className={`rounded-lg border p-3 text-left transition-colors hover:bg-accent ${
              form.presetId === "custom" ? "border-primary bg-accent" : "border-border"
            }`}
          >
            <span className="block font-medium">Custom</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              Connect another supported API endpoint manually.
            </span>
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Display name</span>
            <Input value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="My Gateway" />
          </label>

          <label className="space-y-1 sm:col-span-2">
            <span className="text-xs text-muted-foreground">Service URL</span>
            <Input
              value={form.baseUrl}
              disabled={Boolean(activePreset)}
              onChange={(e) => updateConnection({ baseUrl: e.target.value })}
              placeholder="https://example.com/v1"
            />
          </label>

          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Connection type</span>
            <select
              value={form.api}
              disabled={Boolean(activePreset)}
              onChange={(e) => updateConnection({ api: e.target.value as ApiKind })}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2"
            >
              {API_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <div className="sm:col-span-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
            The internal provider key is assigned automatically and collision-safe.
            {!reservedComplete ? (
              <span className="mt-1 block text-amber-600 dark:text-amber-400">
                pi's bundled catalogue was not found — saving is blocked until it can be checked
              </span>
            ) : (
              <span className="mt-1 block">Next available key: <code>{generatedId}</code></span>
            )}
          </div>
        </div>

        <KeySourceFields value={form} onChange={updateConnection} />

        {pricingNotGuaranteed ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            {activePreset?.name ?? "This endpoint"} does not guarantee catalogue pricing. No unpriced model is assumed
            to be free: test the connection, review the list, and explicitly select every model you want to save.
            Selected models may incur charges.
          </div>
        ) : (
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={form.freeOnly}
              onChange={(e) => update({ freeOnly: e.target.checked })}
              className="mt-0.5 size-4"
            />
            <span className="text-xs">
              Free models only (zero-priced)
              {!form.freeOnly && (
                <span className="mt-0.5 block font-medium text-red-600 dark:text-red-400">
                  Paid models will be offered too — picking one spends real money on this endpoint.
                </span>
              )}
            </span>
          </label>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" disabled={busy || probing} onClick={() => void runProbe()}>
            {probing ? "Probing…" : "Test"}
          </Button>
          <Button
            size="sm"
            disabled={busy || probing || !keySource || !reservedComplete || (requiresExplicitModels && selected.size === 0)}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>

        {probe && (
          <div className="space-y-3 rounded-md border border-border p-3">
            {!probe.ok ? (
              <div className="text-xs text-red-600 dark:text-red-400">Probe failed: {probe.error}</div>
            ) : (
              <>
                <div className="text-xs">
                  HTTP {probe.httpStatus} · {probe.totalCount} compatible models · {pricingNotGuaranteed ? "pricing not guaranteed" : `${probe.freeCount} free`} ·{" "}
                  {probe.sampleCall ? (
                    probe.sampleCall.ok ? (
                      <StateBadge ok>live call OK ({probe.sampleCall.status})</StateBadge>
                    ) : (
                      <StateBadge ok={false}>
                        live call failed{probe.sampleCall.status ? ` (${probe.sampleCall.status})` : ""}: {probe.sampleCall.error?.slice(0, 160)}
                      </StateBadge>
                    )
                  ) : (
                    "nothing to live-test"
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {selected.size > 0
                      ? `${selected.size} selected explicitly`
                      : requiresExplicitModels
                        ? "select at least one model before Save"
                        : "everything free will be saved"}
                    {!requiresExplicitModels && " — narrow below if needed"}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelected(new Set(
                        selectableModels.filter((model) => requiresExplicitModels || model.free).map((model) => model.id),
                      ))}
                    >
                      {requiresExplicitModels ? "Select all listed" : "Select all free"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                      Clear
                    </Button>
                  </div>
                </div>
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {selectableModels.map((model) => (
                    <label key={model.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent">
                      <input type="checkbox" checked={selected.has(model.id)} onChange={() => toggleModel(model.id)} />
                      <span className="truncate font-mono">{model.id}</span>
                      {modelSizeSummary(model) && <span className="text-muted-foreground">{modelSizeSummary(model)}</span>}
                      <ModelPriceChip free={model.free} priceKnown={model.priceKnown} />
                    </label>
                  ))}
                  {selectableModels.length === 0 && (
                    <div className="py-2 text-xs text-muted-foreground">
                      Nothing selectable — either nothing is free or paid models are hidden while free-only is on.
                    </div>
                  )}
                </div>
                {probe.models.some((m) => !m.priceKnown) && (
                  <div className="text-xs text-muted-foreground">
                    {strictCataloguePricing
                      ? "* no published price: not classified as free"
                      : "* no published price: custom gateway compatibility treats it as free because some gateways list only what your credential may use"}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
