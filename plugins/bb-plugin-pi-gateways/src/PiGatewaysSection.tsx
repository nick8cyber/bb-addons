/**
 * The "Pi Gateways" settings section: list gateways and user-defined
 * endpoints, add new OpenAI-compatible endpoints with a live probe, refresh
 * and delete them. All real work happens on the host via the plugin's RPC;
 * this component only orchestrates calls and renders their results.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type {
  CustomEndpointEntry,
  GatewayReport,
  ListCustomOutput,
  ProbeOutput,
  ReservedIdsOutput,
  SaveCustomInput,
  SaveCustomOutput,
} from "./contract.js";
import { rpc } from "../lib/rpc.js";

type ApiKind = "openai-completions" | "openai-responses" | "anthropic-messages";

const API_OPTIONS: Array<{ value: ApiKind; label: string }> = [
  { value: "openai-completions", label: "OpenAI chat completions (/chat/completions)" },
  { value: "openai-responses", label: "OpenAI responses (/responses)" },
  { value: "anthropic-messages", label: "Anthropic messages (/messages)" },
];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

/** Keep pi's internal provider key out of the normal setup flow. */
function availableProviderId(name: string, baseUrl: string, taken: ReadonlySet<string>): string {
  let root = slugify(name) || slugify(endpointHost(baseUrl)) || "custom-gateway";
  if (root.length < 2) root = root + "-gateway";
  root = root.slice(0, 63).replace(/-+$/g, "");
  if (!taken.has(root)) return root;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const marker = "-" + suffix;
    const candidate = root.slice(0, 63 - marker.length).replace(/-+$/g, "") + marker;
    if (!taken.has(candidate)) return candidate;
  }
  return "";
}

interface FormState {
  id: string;
  name: string;
  baseUrl: string;
  api: ApiKind;
  keyType: "file" | "env" | "command";
  keyFile: string;
  keyEnv: string;
  keyCommand: string;
  freeOnly: boolean;
}

const EMPTY_FORM: FormState = {
  id: "",
  name: "",
  baseUrl: "",
  api: "openai-completions",
  keyType: "env",
  keyFile: "",
  keyEnv: "",
  keyCommand: "",
  freeOnly: true,
};

/** What will actually be written into models.json — proof that no secret is stored. */
function keyRefPreview(form: FormState): string | undefined {
  switch (form.keyType) {
    case "file":
      return form.keyFile.trim() ? `!node …/readers/read-file.mjs "${form.keyFile.trim()}"` : undefined;
    case "env":
      return form.keyEnv.trim() ? `$${form.keyEnv.trim()}` : undefined;
    case "command":
      return form.keyCommand.trim() ? `!${form.keyCommand.trim()}` : undefined;
  }
}

function keySourceOf(form: FormState): SaveCustomInput["keySource"] | undefined {
  if (form.keyType === "file" && form.keyFile.trim()) return { type: "file", path: form.keyFile.trim() };
  if (form.keyType === "env" && form.keyEnv.trim()) return { type: "env", name: form.keyEnv.trim() };
  if (form.keyType === "command" && form.keyCommand.trim()) return { type: "command", command: form.keyCommand.trim() };
  return undefined;
}

function StateBadge({ ok, children }: { ok: boolean | undefined; children: React.ReactNode }) {
  const tone =
    ok === undefined
      ? "text-muted-foreground"
      : ok
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-red-600 dark:text-red-400";
  return <span className={`text-xs font-medium ${tone}`}>{children}</span>;
}

export function PiGatewaysSection() {
  const [hosts, setHosts] = useState<Array<{ id: string; name: string }>>([]);
  const [host, setHost] = useState<string | undefined>(undefined);
  const [builtin, setBuiltin] = useState<GatewayReport[]>([]);
  const [endpoints, setEndpoints] = useState<CustomEndpointEntry[]>([]);
  const [reserved, setReserved] = useState<ReservedIdsOutput | undefined>(undefined);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [probe, setProbe] = useState<ProbeOutput | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [showPickerNotice, setShowPickerNotice] = useState(false);
  // Destructive actions confirm on a second press of the same button rather than
  // through window.confirm: a native dialog is suppressed in some host contexts,
  // where the click then silently does nothing, and it cannot be styled.
  const [pendingDelete, setPendingDelete] = useState<string | undefined>(undefined);
  // Same for saving an endpoint whose live call failed on every model: the first
  // press explains the risk, the second one goes through.
  const [confirmDeadSave, setConfirmDeadSave] = useState(false);

  /** Every call goes through here so the host picker applies uniformly. */
  const call = useCallback(
    async <T,>(method: string, input: object = {}): Promise<T> => rpc<T>(method, { ...input, host }),
    [host],
  );

  const reload = useCallback(async () => {
    try {
      const [status, custom, hostsResult, reservedIds] = await Promise.all([
        call<{ gateways: GatewayReport[] }>("status"),
        call<ListCustomOutput>("listCustom"),
        rpc<{ hosts: Array<{ id: string; name: string }> }>("hosts", null),
        call<ReservedIdsOutput>("reservedIds"),
      ]);
      setHosts(hostsResult.hosts);
      setBuiltin(status.gateways);
      setEndpoints(custom.endpoints);
      setReserved(reservedIds);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [call]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const update = (patch: Partial<FormState>) => setForm((previous) => ({ ...previous, ...patch }));

  const takenIds = useMemo(
    () => new Set([...(reserved?.ids ?? []), ...builtin.map((item) => item.id), ...endpoints.map((item) => item.id)]),
    [builtin, endpoints, reserved],
  );
  const generatedId = useMemo(
    () => availableProviderId(form.name, form.baseUrl, takenIds),
    [form.baseUrl, form.name, takenIds],
  );
  const providerId = form.id.trim() || generatedId;

  const idProblem = useMemo(() => {
    const id = providerId;
    if (!id) return undefined;
    if (!ID_PATTERN.test(id)) return "2–63 lowercase letters, digits or dashes";
    if ((reserved?.ids ?? []).includes(id)) return "pi already ships a catalogue under this id — it would merge every paid model in";
    if (builtin.some((item) => item.id === id) || endpoints.some((item) => item.id === id)) return "this internal id is already in use";
    return undefined;
  }, [builtin, endpoints, providerId, reserved]);

  const keySource = keySourceOf(form);
  const preview = keyRefPreview(form);

  const runBusy = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const refreshBuiltin = (only?: string) =>
    runBusy(async () => {
      await call("refresh", only ? { only: [only] } : {});
      setShowPickerNotice(true);
      toast.success(only ? `${only} refreshed` : "built-in gateways refreshed");
      await reload();
    });

  const refreshEndpoint = (id: string) =>
    runBusy(async () => {
      const result = await call<{ results: Array<{ id: string; ok: boolean; error?: string }> }>("refreshCustom", {
        ids: [id],
      });
      const outcome = result.results[0];
      if (outcome?.ok) {
        setShowPickerNotice(true);
        toast.success(`${id} refreshed`);
      } else {
        toast.error(outcome?.error ?? `${id} could not be refreshed`);
      }
      await reload();
    });

  const deleteEndpoint = (id: string) => {
    if (pendingDelete !== id) {
      setPendingDelete(id);
      return;
    }
    setPendingDelete(undefined);
    void runBusy(async () => {
      await call("deleteCustom", { id });
      if (form.id.trim() === id) setForm(EMPTY_FORM);
      toast.success(`${id} deleted`);
      await reload();
    });
  };

  const runProbe = () =>
    runBusy(async () => {
      if (!form.baseUrl.trim() || !keySource) throw new Error("fill the base URL and the key source first");
      setProbing(true);
      setProbe(undefined);
      setSelected(new Set());
      try {
        const result = await call<ProbeOutput>("probe", {
          baseUrl: form.baseUrl.trim(),
          api: form.api,
          keySource,
        });
        setProbe(result);
        if (!result.ok) {
          toast.error(`probe failed: ${result.error ?? "unknown error"}`);
          return;
        }
        toast.success(`${result.totalCount} models, ${result.freeCount} free`);
      } finally {
        setProbing(false);
      }
    });

  const save = () =>
    runBusy(async () => {
      if (!providerId || !form.name.trim() || !form.baseUrl.trim() || !keySource) {
        throw new Error("name, base URL and a key source are required");
      }
      if (idProblem) throw new Error(idProblem);
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
        id: providerId,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        api: form.api,
        keySource,
        freeOnly: form.freeOnly,
        selectionMode: selected.size > 0 ? "explicit" : "all-free",
        selectedModelIds: selected.size > 0 ? [...selected].sort() : undefined,
      });
      if (result.warning) toast.warning(result.warning);
      setShowPickerNotice(true);
      toast.success(`${form.name.trim()} saved`);
      setForm(EMPTY_FORM);
      setProbe(undefined);
      setSelected(new Set());
      await reload();
    });

  const toggleModel = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectableModels = (probe?.models ?? []).filter(
    (model) => model.free || !form.freeOnly,
  );

  return (
    <div className="space-y-6 text-sm">
      {showPickerNotice && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-foreground">
          Existing pi bridge workers keep the catalogue they loaded at startup. A newly started worker reads the updated file.
          For an immediate refresh, restart bb only when no pi turn is running:
          <code className="ml-1 rounded bg-background/60 px-1 py-0.5">systemctl --user restart bb.service</code>
          <div className="mt-2">
            <button className="text-muted-foreground underline hover:text-foreground" onClick={() => setShowPickerNotice(false)}>
              dismiss
            </button>
          </div>
          <div className="mt-1 text-muted-foreground">Restarting or terminating the bridge during an active pi turn interrupts that turn.</div>
        </div>
      )}

      {hosts.length > 1 && (
        <label className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Machine:</span>
          <select
            value={host ?? ""}
            onChange={(event) => setHost(event.target.value || undefined)}
            className="rounded-md border border-input bg-transparent px-2 py-1 text-xs"
          >
            <option value="">default</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* ---- Existing gateways ------------------------------------------------ */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center justify-between">
            <div className="font-medium">Gateways served through pi</div>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => refreshBuiltin()}>
              Refresh all built-ins
            </Button>
          </div>

          <div className="space-y-2">
            {builtin.map((gateway) => (
              <div key={gateway.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{gateway.label}</div>
                  <div className="text-xs text-muted-foreground">
                    built-in · {gateway.modelCount} models ·{" "}
                    {!gateway.credentialFound ? (
                      <StateBadge ok={false}>credential missing</StateBadge>
                    ) : gateway.inModelsJson ? (
                      gateway.error ? (
                        <StateBadge ok={false}>{gateway.error}</StateBadge>
                      ) : (
                        <StateBadge ok>configured</StateBadge>
                      )
                    ) : (
                      <span>{gateway.error ?? "detected, not written yet"}</span>
                    )}
                  </div>
                </div>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => refreshBuiltin(gateway.id)}>
                  Refresh
                </Button>
              </div>
            ))}

            {endpoints.map((endpoint) => (
              <div key={endpoint.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{endpoint.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {endpoint.baseUrl} · {endpoint.freeOnly ? "free-only" : "paid included"} · {endpoint.modelCount} models ·{" "}
                    {endpoint.inModelsJson ? <StateBadge ok>configured</StateBadge> : <StateBadge ok={false}>not in models.json</StateBadge>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => refreshEndpoint(endpoint.id)}>
                    Refresh
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    className="text-red-600 dark:text-red-400"
                    onClick={() => deleteEndpoint(endpoint.id)}
                  >
                    {pendingDelete === endpoint.id ? "Confirm delete" : "Delete"}
                  </Button>
                  {pendingDelete === endpoint.id && (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPendingDelete(undefined)}>
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {endpoints.length === 0 && (
              <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                No custom endpoints yet — add one below. The token stays wherever it lives today; only a reference is written.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---- Add endpoint ------------------------------------------------------ */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="font-medium">Add an OpenAI-compatible endpoint</div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Display name</span>
              <Input value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="My Gateway" />
            </label>

            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">API root (no routes)</span>
              <Input value={form.baseUrl} onChange={(e) => update({ baseUrl: e.target.value })} placeholder="https://example.com/v1" />
            </label>

            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Wire format</span>
              <select
                value={form.api}
                onChange={(e) => update({ api: e.target.value as ApiKind })}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2"
              >
                {API_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <details className="sm:col-span-2 rounded-md border border-border px-3 py-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">Advanced settings</summary>
              <label className="mt-3 block space-y-1">
                <span className="text-xs text-muted-foreground">Internal provider key</span>
                <Input
                  value={form.id}
                  onChange={(e) => update({ id: e.target.value.toLowerCase() })}
                  placeholder={generatedId || "generated automatically"}
                />
                <span className="block text-xs text-muted-foreground">
                  Generated automatically. Override it only when another configuration must refer to a specific key.
                </span>
                {idProblem ? (
                  <span className="block text-xs text-red-600 dark:text-red-400">{idProblem}</span>
                ) : reserved && !reserved.complete ? (
                  <span className="block text-xs text-amber-600 dark:text-amber-400">
                    pi's bundled catalogue was not found ({reserved.source}) — saving is blocked until it can be checked against
                  </span>
                ) : (
                  providerId && <StateBadge ok>internal key: {providerId}</StateBadge>
                )}
              </label>
            </details>
          </div>

          <div className="space-y-2">
            <span className="text-xs text-muted-foreground">Where the API key lives — only a reference to it gets saved:</span>
            <div className="flex flex-wrap gap-4">
              {(["env", "file", "command"] as const).map((kind) => (
                <label key={kind} className="flex cursor-pointer items-center gap-1.5 text-xs">
                  <input type="radio" checked={form.keyType === kind} onChange={() => update({ keyType: kind })} />
                  {kind === "env" ? "environment variable" : kind === "file" ? "file path" : "shell command"}
                </label>
              ))}
            </div>
            {form.keyType === "env" && (
              <Input value={form.keyEnv} onChange={(e) => update({ keyEnv: e.target.value })} placeholder="MY_GATEWAY_API_KEY" />
            )}
            {form.keyType === "file" && (
              <Input value={form.keyFile} onChange={(e) => update({ keyFile: e.target.value })} placeholder="/home/me/.config/mygateway.key" />
            )}
            {form.keyType === "command" && (
              <>
                <Input value={form.keyCommand} onChange={(e) => update({ keyCommand: e.target.value })} placeholder="pass show mygateway/token" />
                <span className="block text-xs text-muted-foreground">
                  the command itself is stored verbatim and runs whenever pi starts a session — make sure it prints only the token
                </span>
              </>
            )}
            {preview && (
              <div className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">will be written as: {preview}</div>
            )}
          </div>

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

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" disabled={busy || probing} onClick={() => void runProbe()}>
              {probing ? "Probing…" : "Test"}
            </Button>
            <Button size="sm" disabled={busy || probing || !providerId || Boolean(idProblem) || !keySource} onClick={() => void save()}>
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
                    HTTP {probe.httpStatus} · {probe.totalCount} models · {probe.freeCount} free ·{" "}
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
                      {selected.size > 0 ? `${selected.size} pinned explicitly` : "everything free will be saved"} — narrow below if needed
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelected(new Set(selectableModels.filter((m) => m.free).map((m) => m.id)))}
                      >
                        Select all free
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
                        {model.contextWindow && <span className="text-muted-foreground">{Math.round(model.contextWindow / 1000)}k</span>}
                        {model.free ? (
                          model.priceKnown ? (
                            <span className="ml-auto text-emerald-600 dark:text-emerald-400">free</span>
                          ) : (
                            <span className="ml-auto text-amber-600 dark:text-amber-400">price not listed*</span>
                          )
                        ) : (
                          <span className="ml-auto text-red-600 dark:text-red-400">paid</span>
                        )}
                      </label>
                    ))}
                    {selectableModels.length === 0 && (
                      <div className="py-2 text-xs text-muted-foreground">
                        Nothing selectable — either nothing is free or paid models are hidden while free-only is on.
                      </div>
                    )}
                  </div>
                  {(probe.models.some((m) => !m.priceKnown) ?? false) && (
                    <div className="text-xs text-muted-foreground">* this catalogue publishes no prices; treated as free because such gateways list only what your credential may use</div>
                  )}
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
