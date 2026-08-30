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
  keyKindLabel,
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
      return "The command itself is copied into this panel's own record. It already sits in models.json in clear text, so copying it exposes nothing new, and it runs only when pi starts a session.";
    case "env":
      return "Only the name of the variable is recorded. Its value is read by pi when it runs and never leaves your machine.";
    case "env-template":
      return "Nothing about the key is copied. The template stays in models.json and is filled in from memory whenever it is needed.";
    case "literal":
      return "The key is written out in models.json. This panel will not copy it anywhere — choose below whether it stays there or is replaced by a reference now.";
    case "none":
      return "This entry carries no key at all. Tests and refreshes will send no credential, which is what local gateways usually expect.";
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
            ? `${row.id} is now managed here — its key stays in models.json`
            : `${row.id} is now managed here`,
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
        <h4 className="text-xs font-semibold text-foreground">What this changes</h4>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
          <li>
            models.json is left exactly as it is — nothing is written
            {canMigrate && mode === "migrate" ? ", except the key change you pick below" : ""}. "Stop managing" undoes
            this completely.
          </li>
          <li>
            Its models are kept exactly as they are. The "every free model" mode is never switched on for you.
          </li>
          <li>
            Key: <Mono>{row.keyRefDisplay}</Mono> (<code>{keyKindLabel(row.keyRefKind)}</code>).
          </li>
          {row.hasHeaders && <li>Custom headers are kept as they are and never shown.</li>}
          {!row.apiSupported && (
            <li>
              <ToneText tone="warn">
                Its protocol ({row.api ?? "unset"}) is not one this panel speaks. Rename, model edits and delete will
                work; test and refresh will not.
              </ToneText>
            </li>
          )}
        </ul>
        <Note>{keyStorySummary(row)}</Note>
      </div>

      {canMigrate && (
        <Block title="What happens to the key?">
          <Choice
            checked={mode === "in-place"}
            onSelect={() => {
              setMode("in-place");
              setMismatch(undefined);
            }}
            disabled={busy}
            title="Leave the key in models.json"
            description="The key stays only in models.json. Nothing is copied, and rotating it by hand keeps working."
          />
          <Choice
            checked={mode === "migrate"}
            onSelect={() => {
              setMode("migrate");
              setMismatch(undefined);
            }}
            disabled={busy}
            title="Replace the key with a reference"
            description="models.json then holds a reference instead of the key itself. This is the only choice here that writes to the file."
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
          description={`Its URL matches this preset; linking inherits its pricing rules (${presetMatch.pricing === "unknown" ? "prices are not published, so you pick the models yourself" : "prices come from the catalogue"}) for later refreshes.`}
        />
      )}

      {mismatch && (
        <Note tone="warn" boxed>
          {mismatch} Press "Manage anyway" to write the new reference regardless.
        </Note>
      )}

      <ActionBar>
        <Button size="sm" disabled={busy || (migrating && !keySource)} onClick={() => void adopt()}>
          {mismatch ? "Manage anyway" : "Manage here"}
        </Button>
        <Spacer />
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </ActionBar>
    </div>
  );
}