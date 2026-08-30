/**
 * The "Pi Gateways" settings section. It owns only the frame: which machine to
 * talk to, the one call that loads the provider inventory, and which panel is
 * currently open. Everything with an opinion about providers lives in src/ui.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import type { ListProvidersOutput, ProviderRow } from "./contract.js";
import { AddProviderForm } from "./ui/AddProviderForm.js";
import { AdoptDialog } from "./ui/AdoptDialog.js";
import { ProviderDetail } from "./ui/ProviderDetail.js";
import { ProviderList } from "./ui/ProviderList.js";
import { rpc } from "../lib/rpc.js";

export function PiGatewaysSection() {
  const [hosts, setHosts] = useState<Array<{ id: string; name: string }>>([]);
  const [host, setHost] = useState<string | undefined>(undefined);
  const [inventory, setInventory] = useState<ListProvidersOutput | undefined>(undefined);
  const [detailId, setDetailId] = useState<string | undefined>(undefined);
  const [adopting, setAdopting] = useState<ProviderRow | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [showPickerNotice, setShowPickerNotice] = useState(false);

  /** Every call goes through here so the host picker applies uniformly. */
  const call = useCallback(
    async <T,>(method: string, input: object = {}): Promise<T> => rpc<T>(method, { ...input, host }),
    [host],
  );

  const reload = useCallback(async () => {
    try {
      // One listProviders call covers the whole inventory: built-ins, everything
      // this plugin manages, and every foreign block already in models.json.
      const [providers, hostsResult] = await Promise.all([
        call<ListProvidersOutput>("listProviders"),
        rpc<{ hosts: Array<{ id: string; name: string }> }>("hosts", null),
      ]);
      setHosts(hostsResult.hosts);
      setInventory(providers);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [call]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runBusy = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const providers = inventory?.providers ?? [];
  const takenIds = useMemo(() => new Set(providers.map((provider) => provider.id)), [providers]);
  const armPickerNotice = useCallback(() => setShowPickerNotice(true), []);

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
            onChange={(event) => {
              setHost(event.target.value || undefined);
              setDetailId(undefined);
              setAdopting(undefined);
            }}
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

      <ProviderList
        providers={providers}
        modelsJsonPath={inventory?.modelsJsonPath ?? ""}
        reservedComplete={inventory?.reservedComplete ?? false}
        busy={busy}
        call={call}
        runBusy={runBusy}
        openId={detailId}
        onDetails={(id) => {
          setAdopting(undefined);
          setDetailId((previous) => (previous === id ? undefined : id));
        }}
        onAdopt={(row) => {
          setDetailId(undefined);
          setAdopting(row);
        }}
        onChanged={reload}
        onWrote={armPickerNotice}
      />

      {adopting && (
        <AdoptDialog
          row={adopting}
          call={call}
          busy={busy}
          runBusy={runBusy}
          onClose={() => setAdopting(undefined)}
          onChanged={reload}
          onWrote={armPickerNotice}
        />
      )}

      {detailId && (
        <ProviderDetail
          key={detailId}
          id={detailId}
          call={call}
          busy={busy}
          runBusy={runBusy}
          onClose={() => setDetailId(undefined)}
          onChanged={reload}
          onWrote={armPickerNotice}
        />
      )}

      <AddProviderForm
        call={call}
        busy={busy}
        runBusy={runBusy}
        takenIds={takenIds}
        reservedComplete={inventory?.reservedComplete ?? false}
        onSaved={async () => {
          armPickerNotice();
          await reload();
        }}
      />
    </div>
  );
}
