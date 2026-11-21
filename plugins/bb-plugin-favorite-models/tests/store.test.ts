import { describe, expect, it } from "vitest";
import {
  cleanModelText,
  dropLabels,
  isValidFavoritesPayload,
  normalizeProviderId,
  sanitizeFavoritesMap,
  sanitizeStore,
} from "../src/store.js";

describe("normalizeProviderId (M11)", () => {
  it("canonicalizes known provider names", () => {
    expect(normalizeProviderId("Codex")).toBe("codex");
    expect(normalizeProviderId("openai")).toBe("codex");
    expect(normalizeProviderId("Claude Code")).toBe("provider-claude-code");
    expect(normalizeProviderId("anthropic")).toBe("provider-claude-code");
    expect(normalizeProviderId("Antigravity")).toBe("agy");
    expect(normalizeProviderId("agy")).toBe("agy");
    expect(normalizeProviderId("OpenCode")).toBe("acp-opencode");
    expect(normalizeProviderId("Cursor")).toBe("acp-cursor");
  });

  it("does NOT pull 'openpipe' under Pi (substring bug)", () => {
    expect(normalizeProviderId("openpipe")).toBe("openpipe");
    expect(normalizeProviderId("pi")).toBe("provider-pi");
    expect(normalizeProviderId("provider-pi")).toBe("provider-pi");
    expect(normalizeProviderId("pi-4")).toBe("provider-pi");
    expect(normalizeProviderId("Inflection")).toBe("provider-pi");
  });

  it("keeps arbitrary acp-* ids instead of collapsing to acp-cursor", () => {
    expect(normalizeProviderId("acp-cursor")).toBe("acp-cursor");
    expect(normalizeProviderId("acp-gemini")).toBe("acp-gemini");
    expect(normalizeProviderId("acp-custom-agent")).toBe("acp-custom-agent");
  });

  it("reduces qualifier suffixes to the provider part", () => {
    expect(normalizeProviderId("Codex / gpt-5.4")).toBe("codex");
    expect(normalizeProviderId("Claude · something")).toBe("provider-claude-code");
  });

  it("returns 'default' for shortcut residue and empty input", () => {
    expect(normalizeProviderId("⇧-⌘-m")).toBe("default");
    expect(normalizeProviderId("Alt+M")).toBe("default");
    expect(normalizeProviderId("")).toBe("default");
    expect(normalizeProviderId("   ")).toBe("default");
  });

  it("is the same function on every path — DOM, manual input, storage", () => {
    // One shared implementation is the fix itself; spot-check parity on
    // inputs each old code path treated differently.
    expect(normalizeProviderId("  ACP-Cursor  ")).toBe("acp-cursor");
    expect(normalizeProviderId("OpenAI")).toBe("codex");
  });
});

describe("sanitizeStore (M11)", () => {
  it("rekeys model labels together with their provider keys", () => {
    const { favorites, modelLabels } = sanitizeStore(
      { OpenAI: ["gpt-5.4"], " ⇧-⌘-m": ["claude-3-7-sonnet"] },
      { "openai:gpt-5.4": "GPT 5.4", " ⇧-⌘-m:claude-3-7-sonnet": "Sonnet" }
    );
    expect(favorites).toEqual({
      codex: ["gpt-5.4"],
      "provider-claude-code": ["claude-3-7-sonnet"],
    });
    expect(modelLabels["codex:gpt-5.4"]).toBe("GPT 5.4");
    expect(modelLabels["provider-claude-code:claude-3-7-sonnet"]).toBe("Sonnet");
  });

  it("drops empty model lists and dedupes/cleans ids", () => {
    const out = sanitizeFavoritesMap({ codex: [" gpt-5.4 ", "gpt-5.4", ""] });
    expect(out).toEqual({ codex: ["gpt-5.4"] });
  });
});

describe("dropLabels (m3)", () => {
  it("removes a single model label or a whole provider prefix", () => {
    const labels = { "codex:a": "A", "codex:b": "B", "agy:c": "C" };
    expect(dropLabels(labels, "codex", "a")).toEqual({ "codex:b": "B", "agy:c": "C" });
    expect(dropLabels(labels, "codex")).toEqual({ "agy:c": "C" });
  });
});

describe("isValidFavoritesPayload (M12)", () => {
  it("rejects null/arrays/non-string entries", () => {
    expect(isValidFavoritesPayload(null)).toBe(false);
    expect(isValidFavoritesPayload({ favorites: null })).toBe(false);
    expect(isValidFavoritesPayload({ favorites: ["a"] })).toBe(false);
    expect(isValidFavoritesPayload({ favorites: { codex: { a: 1 } } })).toBe(false);
    expect(isValidFavoritesPayload({ favorites: { codex: [1] } })).toBe(false);
    expect(isValidFavoritesPayload({ favorites: {}, modelLabels: { k: 5 } })).toBe(false);
  });

  it("accepts the export shape", () => {
    expect(
      isValidFavoritesPayload({
        version: 2,
        exportedAt: "x",
        favorites: { codex: ["gpt-5.4"] },
        modelLabels: { "codex:gpt-5.4": "GPT" },
      })
    ).toBe(true);
  });
});

describe("cleanModelText", () => {
  it("strips shortcut residue", () => {
    expect(cleanModelText("gpt-5.4 ⇧-⌘-m")).toBe("gpt-5.4");
    expect(cleanModelText("model Alt+M")).toBe("model");
  });
});
