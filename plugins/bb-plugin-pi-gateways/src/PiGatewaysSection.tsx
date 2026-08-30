/**
 * The "Pi Gateways" settings section. It owns only the frame: which machine to
 * talk to, the one call that loads the provider inventory, and which panel is
 * currently open. Everything with an opinion about providers lives in src/ui.
 *
 * Layout-wise the frame is deliberately thin — a summary bar, any standing
 * notice, then the list. Adding opens a panel above the list; inspecting and
 * adopting open inside the row they belong to, so the page never asks the user
 * to look somewhere else to find out what they just clicked.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { ListProvidersOutput, ProviderRow } from "./contract.js";
import { AddProviderForm } from "./ui/AddProviderForm.js";
import { AdoptDialog } from "./ui/AdoptDialog.js";
import { ProviderDetail } from "./ui/ProviderDetail.js";
import { ProviderList } from "./ui/ProviderList.js";
import type { RpcCall } from "./ui/atoms.js";
import { PlusIcon, RefreshIcon } from "./ui/icons.js";
import { MetaLine, Mono, Note, Select } from "./ui/kit.js";
import { rpc } from "../lib/rpc.js";
import { formatHomePathForDisplay } from "../lib/utils.js";

/** Which row is expanded, and what it is showing. */
interface OpenPanel {
  id: string;
  mode: "detail" | "adopt";
}

export function PiGatewaysSection() {
  const [hosts, setHosts] = useState<Array<{ id: string; name: string }>>([]);
  const [host, setHost] = useState<string | undefined>(undefined);
  const [inventory, setInventory] = useState<ListProvidersOutput | undefined>(undefined);
  const [open, setOpen] = useState<OpenPanel | undefined>(undefined);
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

  const refreshBuiltins = () =>
    runBusy(async () => {
      await call("refresh");
      armPickerNotice();
      toast.success("built-in gateways refreshed");
      await reload();
    });

  /**
   * The expanded half of a row. Adoption and inspection are the same gesture as
   * far as the list is concerned, so the shell decides which one a row shows and
   * the list only makes room for it.
   */
  const renderPanel = (row: ProviderRow) => {
    if (open?.id !== row.id) return null;
    if (open.mode === "adopt") {
      return (
        <AdoptDialog
          row={row}
          call={call}
          busy={busy}
          runBusy={runBusy}
          onClose={() => setOpen(undefined)}
          onChanged={reload}
          onWrote={armPickerNotice}
        />
      );
    }
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
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <MetaLine
            items={[
              `${providers.length} ${providers.length === 1 ? "provider" : "providers"}`,
              `${modelTotal} ${modelTotal === 1 ? "model" : "models"}`,
            ]}
          />
          <div className="mt-0.5 min-w-0 truncate" title={modelsJsonPath}>
            <Mono className="text-subtle-foreground">{formatHomePathForDisplay(modelsJsonPath)}</Mono>
          </div>
        </div>

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
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void refreshBuiltins()}>
            <RefreshIcon />
            Refresh built-ins
          </Button>
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
          pi's own catalogue could not be found, so a name clash cannot be ruled out. Adding and taking over entries
          stays blocked until it can be checked.
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
      )}

      <ProviderList
        providers={providers}
        reservedComplete={reservedComplete}
        busy={busy}
        call={call}
        runBusy={runBusy}
        openId={open?.id}
        onToggle={(id) => {
          setAdding(false);
          setOpen((previous) => (previous?.id === id && previous.mode === "detail" ? undefined : { id, mode: "detail" }));
        }}
        onAdopt={(row) => {
          setAdding(false);
          setOpen((previous) =>
            previous?.id === row.id && previous.mode === "adopt" ? undefined : { id: row.id, mode: "adopt" },
          );
        }}
        onChanged={reload}
        onWrote={armPickerNotice}
        renderPanel={renderPanel}
      />
    </div>
  );
}
