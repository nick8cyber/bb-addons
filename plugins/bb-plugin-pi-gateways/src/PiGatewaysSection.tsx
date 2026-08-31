/**
 * The "Pi Gateways" settings section. It owns only the frame: which machine to
 * talk to, the one call that loads the provider inventory, and which row is
 * currently open. Everything with an opinion about providers lives in src/ui.
 *
 * Layout-wise the frame is deliberately thin — a header row, any standing
 * notice, then the list and one quiet footer line. Adding opens above the
 * list; editing opens inside the row it belongs to, so the page never asks the
 * user to look somewhere else to find out what they just clicked.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { ListProvidersOutput, ProviderRow } from "./contract.js";
import { AddProviderForm } from "./ui/AddProviderForm.js";
import { ProviderDetail } from "./ui/ProviderDetail.js";
import { ProviderList } from "./ui/ProviderList.js";
import type { RpcCall } from "./ui/atoms.js";
import { PlusIcon } from "./ui/icons.js";
import { Mono, Note, Select } from "./ui/kit.js";
import { rpc } from "../lib/rpc.js";
import { formatHomePathForDisplay } from "../lib/utils.js";

export function PiGatewaysSection() {
  const [hosts, setHosts] = useState<Array<{ id: string; name: string }>>([]);
  const [host, setHost] = useState<string | undefined>(undefined);
  const [inventory, setInventory] = useState<ListProvidersOutput | undefined>(undefined);
  /** The id of the row whose editor is expanded, if any. */
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showPickerNotice, setShowPickerNotice] = useState(false);

  /** Every call goes through here so the host picker applies uniformly. */
  const call = useCallback<RpcCall>(
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
  const reservedComplete = inventory?.reservedComplete ?? false;
  const takenIds = useMemo(() => new Set(providers.map((provider) => provider.id)), [providers]);
  const modelTotal = useMemo(
    () => providers.reduce((total, provider) => total + provider.modelCount, 0),
    [providers],
  );
  const armPickerNotice = useCallback(() => setShowPickerNotice(true), []);
  const modelsJsonPath = inventory?.modelsJsonPath ?? "";

  /** The expanded half of a row: always the editor, which also handles take-over. */
  const renderPanel = (row: ProviderRow) => {
    if (open !== row.id) return null;
    return (
      <ProviderDetail
        key={row.id}
        id={row.id}
        call={call}
        busy={busy}
        runBusy={runBusy}
        onClose={() => setOpen(undefined)}
        onChanged={reload}
        onWrote={armPickerNotice}
      />
    );
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h4 className="text-xs font-semibold text-foreground">Providers</h4>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {hosts.length > 1 && (
            <Select
              value={host ?? ""}
              aria-label="Machine"
              className="h-8 w-auto text-xs"
              onChange={(event) => {
                setHost(event.target.value || undefined);
                setOpen(undefined);
                setAdding(false);
              }}
            >
              <option value="">This machine</option>
              {hosts.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
          )}
          <Button
            size="sm"
            disabled={busy || !reservedComplete}
            onClick={() => {
              setOpen(undefined);
              setAdding(true);
            }}
          >
            <PlusIcon />
            Add provider
          </Button>
        </div>
      </div>

      {!reservedComplete && (
        <Note tone="warn" boxed>
          pi's own catalogue could not be found, so a name clash cannot be ruled out. Adding a provider stays
          blocked until it can be checked.
        </Note>
      )}

      {showPickerNotice && (
        <Note tone="neutral" boxed onDismiss={() => setShowPickerNotice(false)}>
          A pi worker that is already running keeps the catalogue it loaded at startup; the next one to start reads this
          change. To apply it now, restart bb while no pi turn is in flight —{" "}
          <code className="rounded-sm bg-card px-1 py-0.5 font-mono text-2xs">systemctl --user restart bb.service</code>{" "}
          — restarting during a turn interrupts that turn.
        </Note>
      )}

      {adding && (
        <div className="rounded-md border border-border bg-card px-3 py-3">
          <AddProviderForm
            call={call}
            busy={busy}
            runBusy={runBusy}
            takenIds={takenIds}
            reservedComplete={reservedComplete}
            onClose={() => setAdding(false)}
            onSaved={async () => {
              armPickerNotice();
              setAdding(false);
              await reload();
            }}
          />
        </div>
      )}

      <ProviderList
        providers={providers}
        reservedComplete={reservedComplete}
        busy={busy}
        call={call}
        runBusy={runBusy}
        openId={open}
        onToggle={(id) => {
          setAdding(false);
          setOpen((previous) => (previous === id ? undefined : id));
        }}
        onChanged={reload}
        onWrote={armPickerNotice}
        renderPanel={renderPanel}
      />

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-2xs text-subtle-foreground">
        <span>
          {providers.length} {providers.length === 1 ? "provider" : "providers"} · {modelTotal}{" "}
          {modelTotal === 1 ? "model" : "models"}
        </span>
        <span className="min-w-0 truncate" title={modelsJsonPath}>
          <Mono>{formatHomePathForDisplay(modelsJsonPath)}</Mono>
        </span>
      </div>
    </div>
  );
}
