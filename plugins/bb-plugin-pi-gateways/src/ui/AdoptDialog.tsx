/**
 * Adoption of a provider block this plugin did not write. The whole point of
 * this panel is that the user can see, before pressing anything, exactly what
 * adoption will record — because for a key written literally into models.json
 * the honest answer is "nothing about the key at all, unless you ask us to
 * migrate it", and that choice must be made explicitly rather than defaulted.
 *
 * Rendered inline inside the expanded row of the provider list: content only,
 * no card or panel chrome of its own.
 */
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { AdoptOutput, ProviderRow } from "../contract.js";
import { SAVED_PROVIDER_PRESETS } from "../presets.js";
import {
  EMPTY_KEY_SOURCE,
  KeySourceFields,
  keySourceOf,
  type KeySourceState,
  type RpcCall,
  type RunBusy,
} from "./atoms.js";
import { ActionBar, Block, Choice, Mono, Note, Spacer, ToneText } from "./kit.js";

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
    <div className="space-y-4">
      <div className="space-y-1.5 rounded-md bg-surface-recessed px-3 py-2.5 text-xs">
        <h4 className="text-xs font-semibold text-foreground">What adoption records</h4>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
          <li>
            models.json is left exactly as it is — adoption writes nothing
            {canMigrate && mode === "migrate" ? ", except the key rewrite below" : ""}. Forgetting it later is a
            perfect undo.
          </li>
          <li>
            Its current models are kept verbatim as an explicit list; automatic free-model selection is never turned
            on.
          </li>
          <li>
            Key reference: <Mono>{row.keyRefDisplay}</Mono> (<code>{row.keyRefKind}</code>).
          </li>
          {row.hasHeaders && <li>Custom headers stay on the block, untouched and never displayed.</li>}
          {!row.apiSupported && (
            <li>
              <ToneText tone="warn">
                Its protocol ({row.api ?? "unset"}) is not one this plugin speaks: rename, manual model edits and
                delete will work; test and refresh will not.
              </ToneText>
            </li>
          )}
        </ul>
        <Note>{keyStorySummary(row)}</Note>
      </div>

      {canMigrate && (
        <Block title="How should the key be handled?">
          <Choice
            checked={mode === "in-place"}
            onSelect={() => {
              setMode("in-place");
              setMismatch(undefined);
            }}
            disabled={busy}
            title="Adopt in place"
            description="The key stays only in models.json. Nothing is copied, and rotating it by hand keeps working."
          />
          <Choice
            checked={mode === "migrate"}
            onSelect={() => {
              setMode("migrate");
              setMismatch(undefined);
            }}
            disabled={busy}
            title="Migrate to a reference"
            description="Rewrites the block so models.json holds a reference instead of the key. This is the one adoption path that writes to the file."
          />
          {migrating && (
            <KeySourceFields
              value={keyForm}
              onChange={(patch) => {
                setKeyForm((previous) => ({ ...previous, ...patch }));
                setMismatch(undefined);
              }}
              label="Where the key should live from now on"
            />
          )}
        </Block>
      )}

      {presetMatch && (
        <Choice
          type="checkbox"
          checked={linkPreset}
          onSelect={() => setLinkPreset(!linkPreset)}
          disabled={busy}
          title={`Treat as ${presetMatch.name}`}
          description={`Its URL matches this preset; linking inherits its pricing rules (${presetMatch.pricing === "unknown" ? "prices unknown, explicit selection required" : "catalogue pricing"}) for later refreshes.`}
        />
      )}

      {mismatch && (
        <Note tone="warn" boxed>
          {mismatch} Press Adopt again to rewrite the block with the new reference.
        </Note>
      )}

      <ActionBar>
        <Button size="sm" disabled={busy || (migrating && !keySource)} onClick={() => void adopt()}>
          {mismatch ? "Adopt anyway" : "Adopt"}
        </Button>
        <Spacer />
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </ActionBar>
    </div>
  );
}