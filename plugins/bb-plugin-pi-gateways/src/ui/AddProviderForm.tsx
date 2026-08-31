/**
 * "Add a provider": two steps, one at a time. Step one asks which service, step
 * two shows that service's own short form — one key field, a models choice, and
 * everything else folded into `Advanced`. A single `Test & add` probes and saves,
 * so a never-tested provider can no longer be created.
 *
 * The shell provides the chrome; nothing here renders a card. Everything shared
 * with the other screens lives in atoms.tsx.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ApiKind, ProbeOutput, SaveCustomOutput } from "../contract.js";
import {
  SAVED_PROVIDER_PRESETS,
  availableProviderId,
  findSavedProviderPreset,
  type SavedProviderPresetId,
} from "../presets.js";
import {
  API_OPTIONS,
  EMPTY_KEY_SOURCE,
  KeySourceFields,
  ModelPriceChip,
  endpointHost,
  keySourceOf,
  modelSizeSummary,
  type KeySourceState,
  type RpcCall,
  type RunBusy,
} from "./atoms.js";
import { SpinnerIcon } from "./icons.js";
import {
  ActionBar,
  Block,
  Choice,
  DetailsDisclosure,
  Field,
  MetaLine,
  ModelPicker,
  Mono,
  Note,
  Select,
  Spacer,
  ToneText,
} from "./kit.js";

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

/** Zed-style default: the variable a service's key is conventionally read from. */
const derivedKeyEnvName = (stem: string): string =>
  `${stem.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}_API_KEY`;

/** One quiet row per service on step one; the last one leads to a custom endpoint. */
const SERVICE_ROW_CLASS =
  "group -mx-2 flex w-full cursor-pointer items-start gap-3 rounded-md px-2 py-2 text-left transition-none hover:bg-state-hover";

export interface AddProviderFormProps {
  call: RpcCall;
  busy: boolean;
  runBusy: RunBusy;
  /** Ids already visible in models.json or the manifest, for the preview only. */
  takenIds: ReadonlySet<string>;
  /** False when pi's bundled catalogue could not be located: saving is refused. */
  reservedComplete: boolean;
  onSaved: () => Promise<void> | void;
  onClose: () => void;
}

export function AddProviderForm({ call, busy, runBusy, takenIds, reservedComplete, onSaved, onClose }: AddProviderFormProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [probe, setProbe] = useState<ProbeOutput | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [probing, setProbing] = useState(false);
  // Saving an endpoint whose live call failed on every model confirms on a second
  // press of the same button: the first press explains the risk, the second goes through.
  const [confirmDeadSave, setConfirmDeadSave] = useState(false);
  const [step, setStep] = useState<"service" | "form">("service");
  const [modelsMode, setModelsMode] = useState<"all-free" | "choose">("all-free");
  // Once the user edits the variable name themselves, a changed URL stops rewriting it.
  const [keyEnvTouched, setKeyEnvTouched] = useState(false);

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
            keyEnv: preset.keyEnv || derivedKeyEnvName(preset.idStem),
            freeOnly: preset.pricing !== "unknown",
          }
        : { ...EMPTY_FORM, keyEnv: derivedKeyEnvName("custom_gateway") },
    );
    // A previous provider's discovery result and pinned models are never valid
    // for the next preset, even when both happen to speak the same protocol.
    setProbe(undefined);
    setSelected(new Set());
    setConfirmDeadSave(false);
    setModelsMode("all-free");
    setKeyEnvTouched(false);
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
  // Derived rather than stored, so a custom endpoint switched to the Google API is
  // forced into choose-mode without anyone having to remember to set the state.
  const chooseModels = requiresExplicitModels || modelsMode === "choose";

  const keySource = keySourceOf(form);

  const probeConnection = async (): Promise<ProbeOutput> => {
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
        return result;
      }
      toast.success(
        pricingNotGuaranteed
          ? `${result.totalCount} compatible models; catalogue pricing is not guaranteed`
          : `${result.totalCount} models, ${result.freeCount} free`,
      );
      return result;
    } finally {
      setProbing(false);
    }
  };

  const saveProvider = async (freshProbe: ProbeOutput): Promise<void> => {
    if (!form.name.trim() || !form.baseUrl.trim() || !keySource) {
      throw new Error("name, base URL and a key source are required");
    }
    if ((requiresExplicitModels || chooseModels) && selected.size === 0) {
      throw new Error("test the connection and explicitly select at least one model before saving");
    }
    // A failing smoke test with no explicit narrowing almost guarantees a dead
    // picker entry, so the first Save only arms the button and says why.
    if (freshProbe.ok && freshProbe.sampleCall && !freshProbe.sampleCall.ok && selected.size === 0 && !confirmDeadSave) {
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
    setStep("service");
    setModelsMode("all-free");
    setKeyEnvTouched(false);
    await onSaved();
  };

  const testAndAdd = () =>
    runBusy(async () => {
      let result = probe?.ok ? probe : undefined; // a successful probe for the current details is never repeated
      if (!result) {
        result = await probeConnection();
        if (!result.ok) return; // stay in the form; the failure renders under Advanced
      }
      await saveProvider(result);
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

  if (step === "service") {
    return (
      <div className="space-y-4">
        <div className="divide-y divide-border">
          {SAVED_PROVIDER_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={SERVICE_ROW_CLASS}
              onClick={() => {
                choosePreset(preset.id);
                setStep("form");
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{preset.name}</span>
                <span className="line-clamp-2 block text-xs text-muted-foreground">{preset.description}</span>
              </span>
            </button>
          ))}
          <button
            type="button"
            className={SERVICE_ROW_CLASS}
            onClick={() => {
              choosePreset("custom");
              setStep("form");
            }}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">Custom endpoint…</span>
              <span className="line-clamp-2 block text-xs text-muted-foreground">Another supported API endpoint.</span>
            </span>
          </button>
        </div>
      </div>
    );
  }

  const probeError = probe && !probe.ok ? (probe.error ?? "unknown error") : undefined;
  const probeErrorSummary = probeError
    ? (() => {
        const line = probeError.split("\n", 1)[0] ?? probeError;
        return line.length > 160 ? `${line.slice(0, 160)}…` : line;
      })()
    : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {activePreset?.name ?? "Custom endpoint"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            choosePreset(form.presetId);
            setStep("service");
          }}
        >
          Change
        </Button>
      </div>

      <KeySourceFields
        value={form}
        onChange={(patch) => {
          if ("keyEnv" in patch) setKeyEnvTouched(true);
          updateConnection(patch);
        }}
      />

      <div className="space-y-1">
        <Choice
          type="radio"
          checked={!chooseModels}
          disabled={requiresExplicitModels}
          onSelect={() => {
            setModelsMode("all-free");
            setSelected(new Set());
            // Plain update: switching the mode must not throw away a probe.
            update({ freeOnly: true });
          }}
          title="Every free model"
        />
        <Choice
          type="radio"
          checked={chooseModels}
          onSelect={() => {
            setModelsMode("choose");
            update({ freeOnly: false });
          }}
          title="Choose models"
          description={
            chooseModels && !pricingNotGuaranteed && "Paid models will be offered too — picking one spends real money."
          }
          tone="danger"
        />

        {pricingNotGuaranteed && (
          <Note tone="warn" boxed>
            {activePreset?.name ?? "This endpoint"} does not publish reliable prices. Test the connection and tick every
            model you want — a ticked model may cost money.
          </Note>
        )}

        {chooseModels && !probe?.ok && (
          <p className="text-xs text-muted-foreground">Press "Test &amp; add" to list this service's models.</p>
        )}
      </div>

      <DetailsDisclosure summary="Advanced">
        <Field label="Display name" layout="beside">
          <Input value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="My Gateway" />
        </Field>

        <Field label="Service URL" layout="beside">
          <Input
            value={form.baseUrl}
            disabled={Boolean(activePreset)}
            onChange={(e) => {
              const baseUrl = e.target.value;
              updateConnection(
                form.presetId === "custom" && !keyEnvTouched
                  ? { baseUrl, keyEnv: derivedKeyEnvName(endpointHost(baseUrl) || "custom_gateway") }
                  : { baseUrl },
              );
            }}
            placeholder="https://example.com/v1"
          />
        </Field>

        {form.presetId === "custom" && (
          <Field label="API format" layout="beside">
            <Select value={form.api} onChange={(e) => updateConnection({ api: e.target.value as ApiKind })}>
              {API_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md bg-surface-recessed px-3 py-2 text-2xs">
          {reservedComplete ? (
            <>
              <span className="text-subtle-foreground">Saved as</span>
              <Mono>{generatedId}</Mono>
              <span className="text-subtle-foreground">chosen automatically so it cannot clash</span>
            </>
          ) : (
            <ToneText tone="warn">
              pi's own catalogue was not found — saving is blocked until it can be checked.
            </ToneText>
          )}
        </div>
      </DetailsDisclosure>

      {probe &&
        (!probe.ok ? (
          <div className="space-y-2">
            <Note tone="danger" boxed>Probe failed: {probeErrorSummary}</Note>
            <DetailsDisclosure summary="Show details">
              <Mono className="block break-all text-foreground">{probeError}</Mono>
            </DetailsDisclosure>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-surface-recessed px-3 py-2 text-xs">
              <MetaLine
                items={[
                  `HTTP ${probe.httpStatus}`,
                  `${probe.totalCount} compatible models`,
                  pricingNotGuaranteed ? "prices not published" : `${probe.freeCount} free`,
                  probe.sampleCall ? (
                    probe.sampleCall.ok ? (
                      <ToneText tone="ok">live call OK ({probe.sampleCall.status})</ToneText>
                    ) : (
                      <ToneText tone="danger">
                        live call failed{probe.sampleCall.status ? ` (${probe.sampleCall.status})` : ""}:{" "}
                        {probe.sampleCall.error?.slice(0, 160)}
                      </ToneText>
                    )
                  ) : (
                    "no model to test with"
                  ),
                ]}
              />
            </div>

            {chooseModels && (
              <Block
                title="Models"
                actions={
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setSelected(
                          new Set(
                            selectableModels
                              .filter((model) => requiresExplicitModels || model.free)
                              .map((model) => model.id),
                          ),
                        )
                      }
                    >
                      {requiresExplicitModels ? "Select all listed" : "Select all free"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                      Clear
                    </Button>
                  </>
                }
              >
                <ModelPicker
                  rows={selectableModels.map((model) => ({
                    id: model.id,
                    size: modelSizeSummary(model),
                    price: <ModelPriceChip free={model.free} priceKnown={model.priceKnown} />,
                  }))}
                  selected={selected}
                  onToggle={toggleModel}
                  empty="Nothing selectable — either nothing is free, or paid models are hidden while free-only is on."
                />
                {/* What Test & add will actually store, in the same place the detail view says it. */}
                <MetaLine
                  items={[
                    selected.size > 0
                      ? `${selected.size} of ${selectableModels.length} selected`
                      : requiresExplicitModels
                        ? "Tick at least one model"
                        : "Every free model will be saved",
                  ]}
                />
                {probe.models.some((m) => !m.priceKnown) && (
                  <Note>
                    {strictCataloguePricing
                      ? "* no price published, so it does not count as free."
                      : "* no price published. Treated as free here, because some gateways list only what your key may already use."}
                  </Note>
                )}
              </Block>
            )}
          </>
        ))}

      <ActionBar>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Spacer />
        <Button size="sm" disabled={busy || probing || !reservedComplete} onClick={() => void testAndAdd()}>
          {probing ? (
            <>
              <SpinnerIcon /> Testing…
            </>
          ) : (
            "Test & add"
          )}
        </Button>
      </ActionBar>
    </div>
  );
}
