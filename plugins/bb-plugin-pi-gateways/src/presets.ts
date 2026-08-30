import type { ApiKind, PricingPolicy } from "./contract.js";

/**
 * Shared provider catalogue used by the settings UI, CLI, and host save path.
 * OpenCode and Kilo remain built-ins; they are metadata here rather than
 * duplicate saved-provider presets.
 */
export interface SavedProviderPreset {
  readonly id: string;
  readonly kind: "saved";
  readonly name: string;
  readonly description: string;
  readonly baseUrl: string;
  readonly api: ApiKind;
  readonly keyEnv: string;
  readonly idStem: string;
  readonly pricing: Extract<PricingPolicy, "catalogue" | "unknown">;
  readonly requiresExplicitModels: boolean;
}

export interface BuiltinProviderMetadata {
  readonly id: string;
  readonly kind: "builtin";
  readonly name: string;
  readonly description: string;
}

export type ProviderPreset = SavedProviderPreset | BuiltinProviderMetadata;

export const PROVIDER_PRESETS = [
  {
    id: "google-ai-studio",
    kind: "saved",
    name: "Google AI Studio",
    description: "Use Gemini models directly with a Google AI Studio API key.",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    api: "google-generative-ai",
    keyEnv: "GEMINI_API_KEY",
    idStem: "google-ai-studio",
    pricing: "unknown",
    requiresExplicitModels: true,
  },
  {
    id: "tokenrouter",
    kind: "saved",
    name: "TokenRouter",
    description: "Connect to TokenRouter's OpenAI-compatible model gateway.",
    baseUrl: "https://api.tokenrouter.com/v1",
    api: "openai-completions",
    keyEnv: "TOKENROUTER_API_KEY",
    idStem: "tokenrouter",
    pricing: "catalogue",
    requiresExplicitModels: false,
  },
  {
    id: "openrouter",
    kind: "saved",
    name: "OpenRouter",
    description: "Access hundreds of models through OpenRouter's OpenAI-compatible gateway.",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    keyEnv: "OPENROUTER_API_KEY",
    idStem: "openrouter",
    pricing: "catalogue",
    requiresExplicitModels: false,
  },
  {
    id: "nvidia-build",
    kind: "saved",
    name: "NVIDIA Build",
    description: "Use NVIDIA's OpenAI-compatible API for foundation models (prices unknown; explicit model selection required).",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    api: "openai-completions",
    keyEnv: "NVIDIA_API_KEY",
    idStem: "nvidia-build",
    pricing: "unknown",
    requiresExplicitModels: true,
  },
  {
    id: "opencode-zen",
    kind: "builtin",
    name: "OpenCode Zen",
    description: "Existing built-in that reads the OpenCode CLI credential.",
  },
  {
    id: "kilo",
    kind: "builtin",
    name: "Kilo Code",
    description: "Existing built-in that reads the Kilo CLI credential.",
  },
] as const satisfies readonly ProviderPreset[];

export type SavedProviderPresetId = Extract<(typeof PROVIDER_PRESETS)[number], { kind: "saved" }>["id"];

export const SAVED_PROVIDER_PRESETS = PROVIDER_PRESETS.filter(
  (preset): preset is Extract<(typeof PROVIDER_PRESETS)[number], { kind: "saved" }> =>
    preset.kind === "saved",
);

export function findSavedProviderPreset(id: string | undefined): SavedProviderPreset | undefined {
  if (!id) return undefined;
  return SAVED_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function slugifyProviderId(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

export function availableProviderId(stem: string, taken: ReadonlySet<string>): string {
  let root = slugifyProviderId(stem) || "custom-gateway";
  if (root.length < 2) root = `${root}-gateway`;
  root = root.slice(0, 63).replace(/-+$/g, "");
  if (!taken.has(root)) return root;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const marker = `-${suffix}`;
    const candidate = `${root.slice(0, 63 - marker.length).replace(/-+$/g, "")}${marker}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("could not allocate a non-colliding internal provider key");
}
