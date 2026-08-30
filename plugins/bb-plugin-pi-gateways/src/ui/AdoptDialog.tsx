/**
 * Adoption of a provider block this plugin did not write. The whole point of
 * this panel is that the user can see, before pressing anything, exactly what
 * adoption will record — because for a key written literally into models.json
 * the honest answer is "nothing about the key at all, unless you ask us to
 * migrate it", and that choice must be made explicitly rather than defaulted.
 */
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { AdoptOutput, ProviderRow } from "../contract.js";
import { SAVED_PROVIDER_PRESETS } from "../presets.js";
import {
  EMPTY_KEY_SOURCE,
  KeySourceFields,
  apiLabel,
  keySourceOf,
  type KeySourceState,
  type RpcCall,
  type RunBusy,
} from "./AddProviderForm.js";

/** What the manifest ends up holding for each way a key can be referenced. */
function keyStorySummary(row: ProviderRow): string {
  switch (row.keyRefKind) {
    case "command":
      return "The command string is copied into the plugin's own record. It is configuration that already sits in models.json in clear text — copying it exposes nothing new — and it keeps running only when pi starts a session.";
    case "env":
      return "Only the environment variable's name is recorded. The value is read by pi at run time and never leaves your machine's environment.";
    case "env-template":
      return "Nothing about the key is copied. The template stays only in models.json and is resolved in memory whenever a probe or refresh needs it.";
    case "literal":
      return "The key is written literally in models.json. This plugin will not copy it anywhere — choose below whether it stays exactly where it is, or is replaced by a reference now.";
    case "none":
      return "This block carries no key at all. Probes and refreshes will send no credential, which is what local gateways usually expect.";
  }
}

export interface AdoptDialogProps {
  row: ProviderRow;
  call: RpcCall;
  busy: boolean;
  runBusy: RunBusy;
  onClose: () => void;
  /** Reload the inventory once adoption lands. */
  onChanged: () => Promise<void> | void;
  /** Only a key migration writes models.json; that arms the picker-restart notice. */
  onWrote: () => void;
}

export function AdoptDialog({ row, call, busy, runBusy, onClose, onChanged, onWrote }: AdoptDialogProps) {
  const [mode, setMode] = useState<"in-place" | "migrate">("in-place");
  const [keyForm, setKeyForm] = useState<KeySourceState>(EMPTY_KEY_SOURCE);
  const [linkPreset, setLinkPreset] = useState(false);
  // A token mismatch is reported by the host and confirmed with a second press of
  // the same button, matching the two-press pattern used for destructive actions.
  const [mismatch, setMismatch] = useState<string | undefined>(undefined);

  const presetMatch = SAVED_PROVIDER_PRESETS.find((preset) => preset.baseUrl === row.baseUrl);
  const canMigrate = row.keyRefKind === "literal";
  const migrating = canMigrate && mode === "migrate";
  const keySource = keySourceOf(keyForm);

  const adopt = () =>
    runBusy(async () => {
      if (migrating && !keySource) throw new Error("fill in where the key should live before migrating");
      try {
        const result = await call<AdoptOutput>("adopt", {
          id: row.id,
          keyMigration: migrating ? keySource : undefined,
          confirmMismatch: mismatch ? true : undefined,
          linkPresetId: linkPreset && presetMatch ? presetMatch.id : undefined,
        });
        for (const warning of result.warnings) toast.warning(warning);
        if (migrating) onWrote();
        toast.success(
          result.inPlaceKey
            ? `${row.id} adopted — its key stays only in models.json`
            : `${row.id} adopted`,
        );
        setMismatch(undefined);
        await onChanged();
        onClose();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The host refuses a migration whose new source resolves to a different
        // token; re-sending with confirmMismatch is the user's explicit override.
        if (migrating && !mismatch && /mismatch|different token/i.test(message)) {
          setMismatch(message);
          return;
        }
        throw error;
      }
    });

  return (
    <Card className="border-primary">
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-medium">Adopt {row.name ?? row.id}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              <code>{row.id}</code>
              {row.baseUrl ? ` · ${row.baseUrl}` : ""} · {apiLabel(row.api)} · {row.modelCount} models
            </div>
          </div>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="space-y-2 rounded-md border border-border p-3 text-xs">
          <div className="font-medium">What adoption records</div>
          <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
            <li>
              The provider stays exactly as it is in models.json — adoption itself writes nothing to the file
              {canMigrate && mode === "migrate" ? ", except the key rewrite you chose below" : ""}. Forgetting it later
              is a perfect undo.
            </li>
            <li>
              Its current models are kept verbatim as an explicit list. Adoption never turns on automatic free-model
              selection: this plugin cannot know what the gateway charges for.
            </li>
            <li>
              Key reference: <span className="font-mono text-foreground">{row.keyRefDisplay}</span> ({row.keyRefKind}).
            </li>
            {row.hasHeaders && <li>Custom headers stay on the block untouched and are never copied or displayed.</li>}
            {!row.apiSupported && (
              <li className="text-amber-600 dark:text-amber-400">
                Its protocol ({row.api ?? "unset"}) is not one this plugin can speak. It will be adopted with limited
                capability: rename, manual model edits and delete work; probe and refresh do not.
              </li>
            )}
          </ul>
          <div className="text-muted-foreground">{keyStorySummary(row)}</div>
        </div>

        {canMigrate && (
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="text-xs font-medium">How should the key be handled?</div>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="radio"
                className="mt-0.5"
                checked={mode === "in-place"}
                onChange={() => {
                  setMode("in-place");
                  setMismatch(undefined);
                }}
              />
              <span className="text-xs">
                Adopt in place (key stays only in models.json)
                <span className="mt-0.5 block text-muted-foreground">
                  Nothing is copied. Probes, refreshes and every later write re-read the value from the file and carry
                  it forward unchanged, so rotating it by hand keeps working.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="radio"
                className="mt-0.5"
                checked={mode === "migrate"}
                onChange={() => {
                  setMode("migrate");
                  setMismatch(undefined);
                }}
              />
              <span className="text-xs">
                Migrate to a reference now
                <span className="mt-0.5 block text-muted-foreground">
                  Rewrites the block so models.json holds a reference instead of the key itself. This is the one
                  adoption path that writes to the file.
                </span>
              </span>
            </label>
            {migrating && (
              <KeySourceFields
                value={keyForm}
                onChange={(patch) => {
                  setKeyForm((previous) => ({ ...previous, ...patch }));
                  setMismatch(undefined);
                }}
                label="Where the key should live from now on — the current literal value is replaced by this reference:"
              />
            )}
          </div>
        )}

        {presetMatch && (
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={linkPreset}
              onChange={(e) => setLinkPreset(e.target.checked)}
            />
            <span className="text-xs">
              Treat as {presetMatch.name}
              <span className="mt-0.5 block text-muted-foreground">
                Its URL matches the {presetMatch.name} preset. Linking inherits that preset's pricing rules
                ({presetMatch.pricing === "unknown" ? "prices unknown, explicit selection required" : "catalogue pricing"})
                for later refreshes.
              </span>
            </span>
          </label>
        )}

        {mismatch && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            {mismatch}
            <div className="mt-1 text-muted-foreground">
              Press Adopt again to rewrite the block with the new reference anyway.
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy || (migrating && !keySource)} onClick={() => void adopt()}>
            {mismatch ? "Adopt anyway" : "Adopt"}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
