/**
 * The pieces every screen in this section needs that know what a provider is:
 * the call signatures, how a protocol and a catalogue entry are worded, and the
 * key-source editor.
 *
 * They used to live inside the add form, which made the add form a dependency
 * of the list and the detail view. Keeping them here lets each screen depend on
 * the kit and on this file, and on nothing else.
 */
import type { ReactNode } from "react";

import { Input } from "@/components/ui/input";
import type { ApiKind, EditableKeySource, ProviderRow } from "../contract.js";
import { Field, Mono, Note, Segmented, ToneText, type Tone } from "./kit.js";

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

/** How a key is referenced, in words — the raw enum must never reach the screen. */
export function keyKindLabel(kind: string): string {
  switch (kind) {
    case "env":
      return "environment variable";
    case "command":
      return "shell command";
    case "env-template":
      return "variable inside a template";
    case "literal":
      return "written in the file";
    case "none":
      return "no key";
    default:
      return kind;
  }
}

/** Where a provider's prices come from, in words — the raw enum must never reach the screen. */
export function pricingLabel(policy: string): string {
  switch (policy) {
    case "catalogue":
      return "taken from the catalogue";
    case "gateway-default":
      return "whatever this gateway charges";
    case "unknown":
      return "not published";
    default:
      return policy;
  }
}

export function endpointHost(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Context/output sizes of a catalogue entry, rendered compactly or not at all. */
export function modelSizeSummary(model: { contextWindow?: number; maxTokens?: number }): string {
  const parts: string[] = [];
  if (model.contextWindow) parts.push(`${Math.round(model.contextWindow / 1000)}k ctx`);
  if (model.maxTokens) parts.push(`${Math.round(model.maxTokens / 1000)}k out`);
  return parts.join(" · ");
}

/**
 * The free/paid/price-unknown wording on a catalogue row. `priceKnown === false`
 * means the catalogue carries no pricing block at all, which is never silently
 * read as "free" for providers whose pricing semantics we cannot verify.
 */
export function ModelPriceChip({ free, priceKnown }: { free?: boolean; priceKnown?: boolean }) {
  const [tone, label]: [Tone, string] =
    priceKnown === false
      ? ["warn", "price not listed*"]
      : free === undefined
        ? ["neutral", "price unknown"]
        : free
          ? ["ok", "free"]
          : ["danger", "paid"];
  return (
    <ToneText tone={tone} className="w-20 shrink-0 text-right text-2xs">
      {label}
    </ToneText>
  );
}

/** How a row's overall health reads at a glance, before anything is expanded. */
export function providerTone(row: ProviderRow): Tone {
  if (row.error) return "danger";
  if (row.drifted || row.warnings.length > 0 || row.ownership === "orphaned") return "warn";
  if (!row.inModelsJson) return "neutral";
  return "ok";
}

/* -- key sources ----------------------------------------------------------- */

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

const KEY_TYPES: ReadonlyArray<{ value: KeySourceState["keyType"]; label: string }> = [
  { value: "env", label: "Variable" },
  { value: "file", label: "File" },
  { value: "command", label: "Command" },
];

const KEY_PLACEHOLDER: Record<KeySourceState["keyType"], string> = {
  env: "MY_GATEWAY_API_KEY",
  file: "/home/me/.config/mygateway.key",
  command: "pass show mygateway/token",
};

/**
 * Where the key lives, in one field. The three sources are a switch rather than
 * three radios because they are alternatives of the same answer, and the line
 * underneath shows the literal text that will land in models.json — the whole
 * promise of this section is that the secret itself never does.
 */
export function KeySourceFields({
  value,
  onChange,
  label = "Where the API key lives",
  disabled,
}: {
  value: KeySourceState;
  onChange: (patch: Partial<KeySourceState>) => void;
  label?: ReactNode;
  disabled?: boolean;
}) {
  const preview = keyRefPreview(value);
  const field = value.keyType === "env" ? "keyEnv" : value.keyType === "file" ? "keyFile" : "keyCommand";
  return (
    <Field label={label} hint="Only a reference is saved — the value stays where it is today.">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={value.keyType}
          options={KEY_TYPES}
          disabled={disabled}
          onChange={(keyType) => onChange({ keyType })}
        />
      </div>
      <Input
        value={value[field]}
        disabled={disabled}
        onChange={(event) => onChange({ [field]: event.target.value } as Partial<KeySourceState>)}
        placeholder={KEY_PLACEHOLDER[value.keyType]}
        className="font-mono text-xs"
      />
      {value.keyType === "command" && (
        <Note tone="warn">
          The command is stored verbatim and runs whenever pi starts a session — make sure it prints only the token.
        </Note>
      )}
      {preview && (
        <div className="flex items-baseline gap-2 rounded-md bg-surface-recessed px-2.5 py-1.5">
          <span className="shrink-0 text-2xs text-subtle-foreground">writes</span>
          <Mono className="min-w-0 break-all text-foreground">{preview}</Mono>
        </div>
      )}
    </Field>
  );
}
