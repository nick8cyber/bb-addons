/**
 * "Add a provider": preset picker, connection fields, key-source inputs, a live
 * probe and the save call. Rendered as a top-level Panel the shell opens on
 * demand; everything shared with the other screens lives in atoms.tsx, so this
 * module is only the flow itself.
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
  ChoiceTile,
  Field,
  MetaLine,
  ModelPicker,
  Mono,
  Note,
  Panel,
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
    <Panel
      title="Add a provider"
      subtitle={<span className="text-xs text-muted-foreground">Start from a known service, or connect another endpoint.</span>}
      onClose={onClose}
    >
      <Block title="Service">
        <div className="grid gap-2 sm:grid-cols-3">
          {SAVED_PROVIDER_PRESETS.map((preset) => (
            <ChoiceTile
              key={preset.id}
              selected={form.presetId === preset.id}
              title={preset.name}
              description={preset.description}
              onSelect={() => choosePreset(preset.id)}
            />
          ))}
          <ChoiceTile
            selected={form.presetId === "custom"}
            title="Custom"
            description="Another supported API endpoint."
            onSelect={() => choosePreset("custom")}
          />
        </div>
      </Block>

      <Block title="Connection">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Display name">
            <Input value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="My Gateway" />
          </Field>

          <Field label="Protocol">
            <Select
              value={form.api}
              disabled={Boolean(activePreset)}
              onChange={(e) => updateConnection({ api: e.target.value as ApiKind })}
            >
              {API_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Service URL" className="sm:col-span-2">
            <Input
              value={form.baseUrl}
              disabled={Boolean(activePreset)}
              onChange={(e) => updateConnection({ baseUrl: e.target.value })}
              placeholder="https://example.com/v1"
            />
          </Field>

          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md bg-surface-recessed px-3 py-2 text-2xs sm:col-span-2">
            {reservedComplete ? (
              <>
                <span className="text-subtle-foreground">Internal key</span>
                <Mono>{generatedId}</Mono>
                <span className="text-subtle-foreground">assigned automatically, collision-safe</span>
              </>
            ) : (
              <ToneText tone="warn">
                pi's bundled catalogue was not found — saving is blocked until it can be checked.
              </ToneText>
            )}
          </div>
        </div>
      </Block>

      <KeySourceFields value={form} onChange={updateConnection} />

      {pricingNotGuaranteed ? (
        <Note tone="warn" boxed>
          {activePreset?.name ?? "This endpoint"} does not publish reliable prices. Test the connection and tick every
          model you want — a ticked model may cost money.
        </Note>
      ) : (
        <Choice
          type="checkbox"
          checked={form.freeOnly}
          onSelect={() => update({ freeOnly: !form.freeOnly })}
          title="Free models only (zero-priced)"
          description={!form.freeOnly && "Paid models will be offered too — picking one spends real money."}
          tone="danger"
        />
      )}

      {probe &&
        (!probe.ok ? (
          <Note tone="danger" boxed>Probe failed: {probe.error}</Note>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-surface-recessed px-3 py-2 text-xs">
              <MetaLine
                items={[
                  `HTTP ${probe.httpStatus}`,
                  `${probe.totalCount} compatible models`,
                  pricingNotGuaranteed ? "pricing not guaranteed" : `${probe.freeCount} free`,
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
                    "nothing to live-test"
                  ),
                ]}
              />
            </div>

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
              {/* What Save will actually store, in the same place the detail view says it. */}
              <MetaLine
                items={[
                  selected.size > 0
                    ? `${selected.size} of ${selectableModels.length} selected`
                    : requiresExplicitModels
                      ? "Tick at least one model"
                      : "Everything free will be saved",
                ]}
              />
              {probe.models.some((m) => !m.priceKnown) && (
                <Note>
                  {strictCataloguePricing
                    ? "* no published price: not classified as free"
                    : "* no published price: custom gateway compatibility treats it as free because some gateways list only what your credential may use"}
                </Note>
              )}
            </Block>
          </>
        ))}

      <ActionBar>
        <Button variant="outline" size="sm" disabled={busy || probing} onClick={() => void runProbe()}>
          {probing ? (
            <>
              <SpinnerIcon /> Testing…
            </>
          ) : (
            "Test"
          )}
        </Button>
        <Button
          size="sm"
          disabled={busy || probing || !keySource || !reservedComplete || (requiresExplicitModels && selected.size === 0)}
          onClick={() => void save()}
        >
          Save
        </Button>
        <Spacer />
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </ActionBar>
    </Panel>
  );
}
