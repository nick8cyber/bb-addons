import { describe, expect, it } from "vitest";
import {
  actualPlanLabel,
  codexAccountKey,
  selectAccountResources,
  type UsageIdentity,
} from "./usage-policy";

describe("codexAccountKey", () => {
  it("formats canonical key from nonempty accountId string", () => {
    expect(codexAccountKey("67628130-abcd")).toBe("openai:chatgpt:67628130-abcd");
    expect(codexAccountKey("d42622fa-1111")).toBe("openai:chatgpt:d42622fa-1111");
  });

  it("preserves already prefixed accountId without duplicating", () => {
    expect(codexAccountKey("openai:chatgpt:67628130-abcd")).toBe("openai:chatgpt:67628130-abcd");
  });

  it("trims whitespace around accountId", () => {
    expect(codexAccountKey("  67628130  ")).toBe("openai:chatgpt:67628130");
    expect(codexAccountKey("  openai:chatgpt:67628130  ")).toBe("openai:chatgpt:67628130");
  });

  it("returns null for empty, whitespace, or prefix-only strings", () => {
    expect(codexAccountKey("")).toBeNull();
    expect(codexAccountKey("   ")).toBeNull();
    expect(codexAccountKey("openai:chatgpt:")).toBeNull();
    expect(codexAccountKey("openai:chatgpt:   ")).toBeNull();
  });

  it("returns null for non-string or missing values", () => {
    expect(codexAccountKey(null)).toBeNull();
    expect(codexAccountKey(undefined)).toBeNull();
    expect(codexAccountKey(12345)).toBeNull();
    expect(codexAccountKey({})).toBeNull();
    expect(codexAccountKey([])).toBeNull();
    expect(codexAccountKey(true)).toBeNull();
    expect(codexAccountKey(Symbol("id"))).toBeNull();
  });
});

describe("actualPlanLabel", () => {
  it("normalizes known plan names case-insensitively per §2 table", () => {
    expect(actualPlanLabel("free")).toBe("Free");
    expect(actualPlanLabel("FREE")).toBe("Free");
    expect(actualPlanLabel("Free")).toBe("Free");

    expect(actualPlanLabel("go")).toBe("Go");
    expect(actualPlanLabel("GO")).toBe("Go");

    expect(actualPlanLabel("plus")).toBe("Plus");
    expect(actualPlanLabel("PLUS")).toBe("Plus");
    expect(actualPlanLabel("Plus")).toBe("Plus");

    expect(actualPlanLabel("pro")).toBe("Pro");
    expect(actualPlanLabel("PRO")).toBe("Pro");

    expect(actualPlanLabel("max")).toBe("Max");
    expect(actualPlanLabel("MAX")).toBe("Max");

    expect(actualPlanLabel("team")).toBe("Team");
    expect(actualPlanLabel("TEAM")).toBe("Team");
    expect(actualPlanLabel("Team")).toBe("Team");

    expect(actualPlanLabel("business")).toBe("Business");
    expect(actualPlanLabel("BUSINESS")).toBe("Business");

    expect(actualPlanLabel("enterprise")).toBe("Enterprise");
    expect(actualPlanLabel("ENTERPRISE")).toBe("Enterprise");

    expect(actualPlanLabel("education")).toBe("Education");
    expect(actualPlanLabel("EDUCATION")).toBe("Education");
    expect(actualPlanLabel("edu")).toBe("Education");
    expect(actualPlanLabel("EDU")).toBe("Education");
    expect(actualPlanLabel("Edu")).toBe("Education");
  });

  it("capitalizes first letter for unknown nonempty id without inventing tariffs", () => {
    expect(actualPlanLabel("custom")).toBe("Custom");
    expect(actualPlanLabel("developer")).toBe("Developer");
    expect(actualPlanLabel("starter")).toBe("Starter");
    expect(actualPlanLabel("custom_tier")).toBe("Custom_tier");
    expect(actualPlanLabel("partner-tier")).toBe("Partner-tier");
    expect(actualPlanLabel("tier1")).toBe("Tier1");
  });

  it("handles prototype properties safely (constructor, toString, valueOf regression)", () => {
    expect(actualPlanLabel("constructor")).toBe("Constructor");
    expect(actualPlanLabel("toString")).toBe("ToString");
    expect(actualPlanLabel("valueOf")).toBe("ValueOf");
    expect(actualPlanLabel(null, "constructor")).toBe("Constructor");
  });

  it("trims whitespace around planType", () => {
    expect(actualPlanLabel("  team  ")).toBe("Team");
    expect(actualPlanLabel("  custom  ")).toBe("Custom");
  });

  it("uses fallback when planType is empty, whitespace, or non-string", () => {
    expect(actualPlanLabel(null, "team")).toBe("Team");
    expect(actualPlanLabel(undefined, "plus")).toBe("Plus");
    expect(actualPlanLabel("", "education")).toBe("Education");
    expect(actualPlanLabel("   ", "edu")).toBe("Education");
    expect(actualPlanLabel(null, "Pi")).toBe("Pi");
    expect(actualPlanLabel(undefined, "Codex")).toBe("Codex");
    expect(actualPlanLabel("", "Pi/Codex")).toBe("Pi/Codex");
    expect(actualPlanLabel(1234, "free")).toBe("Free");
    expect(actualPlanLabel({}, "pro")).toBe("Pro");
  });

  it("returns null when both planType and fallback are empty or invalid", () => {
    expect(actualPlanLabel(null)).toBeNull();
    expect(actualPlanLabel(undefined)).toBeNull();
    expect(actualPlanLabel("")).toBeNull();
    expect(actualPlanLabel("   ")).toBeNull();
    expect(actualPlanLabel(null, null)).toBeNull();
    expect(actualPlanLabel(null, "")).toBeNull();
    expect(actualPlanLabel(null, "   ")).toBeNull();
    expect(actualPlanLabel(123, 456)).toBeNull();
    expect(actualPlanLabel({}, [])).toBeNull();
  });

  it("ignores fallback when planType is valid", () => {
    expect(actualPlanLabel("plus", "Team")).toBe("Plus");
    expect(actualPlanLabel("team", "Plus")).toBe("Team");
    expect(actualPlanLabel("custom", "Team")).toBe("Custom");
  });
});

describe("selectAccountResources", () => {
  type TestResource = {
    id: string;
    email?: string | null;
    identity: UsageIdentity;
  };

  const createResource = (
    id: string,
    identityOverrides: Partial<UsageIdentity> = {},
    email?: string | null,
  ): TestResource => ({
    id,
    email,
    identity: {
      machineId: "host-1",
      providerId: "codex",
      accountKey: "openai:chatgpt:67628130",
      scopeKind: "host",
      usageStatus: "ok",
      observedAt: 100_000,
      route: "native",
      ...identityOverrides,
    },
  });

  it("returns empty array when input is empty", () => {
    const result = selectAccountResources([], (r: TestResource) => r.identity);
    expect(result).toEqual([]);
  });

  it("returns single resource as is", () => {
    const r = createResource("r1");
    const result = selectAccountResources([r], (x) => x.identity);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("r1");
  });

  describe("account identity, email coincidence and unknown IDs", () => {
    it("deduplicates same accountKey within same host", () => {
      const native = createResource("native", { route: "native", observedAt: 100_000 }, "user@work.com");
      const pi = createResource("pi", { route: "pi", observedAt: 98_000 }, "user@work.com");

      const result = selectAccountResources([native, pi], (r) => r.identity);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("native");
    });

    it("does NOT deduplicate distinct accountKeys even with identical email and percentages", () => {
      const r1 = createResource("acc-1", { accountKey: "openai:chatgpt:1111" }, "shared@work.com");
      const r2 = createResource("acc-2", { accountKey: "openai:chatgpt:2222" }, "shared@work.com");

      const result = selectAccountResources([r1, r2], (r) => r.identity);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.id)).toEqual(["acc-1", "acc-2"]);
    });

    it("treats accountKey as opaque and does not collapse different casings or spaces", () => {
      const r1 = createResource("exact-upper", { accountKey: "Key-A" });
      const r2 = createResource("exact-lower", { accountKey: "key-a" });

      const result = selectAccountResources([r1, r2], (r) => r.identity);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.id)).toEqual(["exact-upper", "exact-lower"]);
    });

    it("does NOT deduplicate unknown (null/empty) accountKeys even with identical email", () => {
      const u1 = createResource("u1", { accountKey: null }, "same@work.com");
      const u2 = createResource("u2", { accountKey: null }, "same@work.com");
      const u3 = createResource("u3", { accountKey: "   " }, "same@work.com");

      const result = selectAccountResources([u1, u2, u3], (r) => r.identity);
      expect(result).toHaveLength(3);
      expect(result.map((r) => r.id)).toEqual(["u1", "u2", "u3"]);
    });

    it("keeps unknown accountKey separate from known accountKey with same email", () => {
      const known = createResource("known", { accountKey: "openai:chatgpt:1111" }, "user@work.com");
      const unknown = createResource("unknown", { accountKey: null }, "user@work.com");

      const result = selectAccountResources([known, unknown], (r) => r.identity);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.id)).toEqual(["known", "unknown"]);
    });
  });

  describe("host and provider scoping", () => {
    it("does NOT deduplicate across different machineId (hosts)", () => {
      const host1 = createResource("r-host1", { machineId: "host-dubai" });
      const host2 = createResource("r-host2", { machineId: "host-stockholm" });

      const result = selectAccountResources([host1, host2], (r) => r.identity);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.id)).toEqual(["r-host1", "r-host2"]);
    });

    it("does NOT deduplicate across different providerId", () => {
      const codex = createResource("r-codex", { providerId: "codex" });
      const claude = createResource("r-claude", { providerId: "claude" });

      const result = selectAccountResources([codex, claude], (r) => r.identity);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.id)).toEqual(["r-codex", "r-claude"]);
    });

    it("uses exact providerId === 'codex' match", () => {
      // Non-exact providerId does not use Codex route priority
      const nonCodexHost = createResource("p1", { providerId: "CODEX", scopeKind: "host" });
      const nonCodexShared = createResource("p2", { providerId: "CODEX", scopeKind: "shared" });

      const result = selectAccountResources([nonCodexHost, nonCodexShared], (r) => r.identity);
      expect(result).toHaveLength(1);
      // Evaluated under other provider rules (shared preferred)
      expect(result[0].id).toBe("p2");
    });
  });

  describe("Codex status hierarchy (ok > expired > unauthenticated > error > not_installed > null)", () => {
    it("prefers ok over expired, unauthenticated, error, and not_installed", () => {
      const ok = createResource("ok", { usageStatus: "ok", route: "other", observedAt: 10_000 });
      const expired = createResource("expired", { usageStatus: "expired", route: "native", observedAt: 99_000 });
      const unauth = createResource("unauth", { usageStatus: "unauthenticated", route: "native", observedAt: 99_000 });
      const err = createResource("err", { usageStatus: "error", route: "native", observedAt: 99_000 });
      const notInstalled = createResource("not_installed", { usageStatus: "not_installed", route: "native", observedAt: 99_000 });

      expect(selectAccountResources([expired, ok], (r) => r.identity)[0].id).toBe("ok");
      expect(selectAccountResources([unauth, ok], (r) => r.identity)[0].id).toBe("ok");
      expect(selectAccountResources([err, ok], (r) => r.identity)[0].id).toBe("ok");
      expect(selectAccountResources([notInstalled, ok], (r) => r.identity)[0].id).toBe("ok");
    });

    it("prefers expired over unauthenticated, error, not_installed, and null", () => {
      const expired = createResource("expired", { usageStatus: "expired", observedAt: 10_000 });
      const unauth = createResource("unauth", { usageStatus: "unauthenticated", observedAt: 99_000 });
      const err = createResource("err", { usageStatus: "error", observedAt: 99_000 });

      expect(selectAccountResources([unauth, expired], (r) => r.identity)[0].id).toBe("expired");
      expect(selectAccountResources([err, expired], (r) => r.identity)[0].id).toBe("expired");
    });

    it("prefers unauthenticated over error and not_installed", () => {
      const unauth = createResource("unauth", { usageStatus: "unauthenticated", observedAt: 10_000 });
      const err = createResource("err", { usageStatus: "error", observedAt: 99_000 });
      const notInstalled = createResource("not_installed", { usageStatus: "not_installed", observedAt: 99_000 });

      expect(selectAccountResources([err, unauth], (r) => r.identity)[0].id).toBe("unauth");
      expect(selectAccountResources([notInstalled, unauth], (r) => r.identity)[0].id).toBe("unauth");
    });

    it("prefers error over not_installed and null status", () => {
      const err = createResource("err", { usageStatus: "error", observedAt: 10_000 });
      const notInstalled = createResource("not_installed", { usageStatus: "not_installed", observedAt: 99_000 });
      const missing = createResource("missing", { usageStatus: null, observedAt: 99_000 });

      expect(selectAccountResources([notInstalled, err], (r) => r.identity)[0].id).toBe("err");
      expect(selectAccountResources([missing, err], (r) => r.identity)[0].id).toBe("err");
    });

    it("prefers not_installed over missing (null/unknown) measurement", () => {
      const notInstalled = createResource("not_installed", { usageStatus: "not_installed", observedAt: 10_000 });
      const missing = createResource("missing", { usageStatus: null, observedAt: 99_000 });
      const unknown = createResource("unknown", { usageStatus: "something_else", observedAt: 99_000 });
      const ctorStatus = createResource("ctor", { usageStatus: "constructor", observedAt: 99_000 });

      expect(selectAccountResources([missing, notInstalled], (r) => r.identity)[0].id).toBe("not_installed");
      expect(selectAccountResources([unknown, notInstalled], (r) => r.identity)[0].id).toBe("not_installed");
      expect(selectAccountResources([ctorStatus, notInstalled], (r) => r.identity)[0].id).toBe("not_installed");
    });
  });

  describe("Codex freshness and 5000 ms tolerance window", () => {
    it("treats null, NaN, and non-finite observedAt as older than any known timestamp", () => {
      const known = createResource("known", { observedAt: 1_000, route: "other" });
      const nullTime = createResource("nullTime", { observedAt: null, route: "native" });
      const nanTime = createResource("nanTime", { observedAt: Number.NaN, route: "native" });
      const infTime = createResource("infTime", { observedAt: Number.POSITIVE_INFINITY, route: "native" });

      expect(selectAccountResources([nullTime, known], (r) => r.identity)[0].id).toBe("known");
      expect(selectAccountResources([nanTime, known], (r) => r.identity)[0].id).toBe("known");
      expect(selectAccountResources([infTime, known], (r) => r.identity)[0].id).toBe("known");
      expect(selectAccountResources([known, nullTime], (r) => r.identity)[0].id).toBe("known");
    });

    it("treats differences up to 5000 ms as equal freshness and breaks tie by route (native > Pi > other)", () => {
      // native at 100_000 vs pi at 103_000 (diff 3000 ms <= 5000 ms): freshness equal -> native wins
      const native = createResource("native", { route: "native", observedAt: 100_000 });
      const pi = createResource("pi", { route: "pi", observedAt: 103_000 });

      const res1 = selectAccountResources([pi, native], (r) => r.identity);
      expect(res1[0].id).toBe("native");

      // pi at 100_000 vs other at 104_000 (diff 4000 ms <= 5000 ms): freshness equal -> pi wins
      const other = createResource("other", { route: "other", observedAt: 104_000 });
      const res2 = selectAccountResources([other, pi], (r) => r.identity);
      expect(res2[0].id).toBe("pi");
    });

    it("strictly prefers newer timestamp when difference exceeds 5000 ms", () => {
      // pi at 120_000 vs native at 100_000 (diff 20_000 ms > 5000 ms): pi wins because it's significantly fresher
      const native = createResource("native", { route: "native", observedAt: 100_000 });
      const piFresh = createResource("piFresh", { route: "pi", observedAt: 120_000 });

      const res = selectAccountResources([native, piFresh], (r) => r.identity);
      expect(res[0].id).toBe("piFresh");
    });

    it("considers exact 5000 ms boundary as equality", () => {
      const native = createResource("native", { route: "native", observedAt: 100_000 });
      const pi = createResource("pi", { route: "pi", observedAt: 105_000 }); // diff exactly 5000

      const res = selectAccountResources([pi, native], (r) => r.identity);
      expect(res[0].id).toBe("native");
    });
  });

  describe("Codex stability, tie-breaking and slot preservation", () => {
    it("preserves first candidate when everything is equal (complete tie)", () => {
      const first = createResource("first", { route: "native", observedAt: 100_000 });
      const second = createResource("second", { route: "native", observedAt: 100_000 });

      const res = selectAccountResources([first, second], (r) => r.identity);
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe("first");
    });

    it("preserves first candidate when observedAt is null for both and routes match", () => {
      const first = createResource("first", { route: "native", observedAt: null });
      const second = createResource("second", { route: "native", observedAt: null });

      const res = selectAccountResources([first, second], (r) => r.identity);
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe("first");
    });

    it("places the winner at the initial position of the first card of identity", () => {
      // Stale native card for acc1 at index 0
      const acc1Old = createResource("acc1Old", { accountKey: "openai:chatgpt:1111", observedAt: 10_000, route: "other" });
      // Distinct acc2 card at index 1
      const acc2 = createResource("acc2", { accountKey: "openai:chatgpt:2222", observedAt: 50_000, route: "native" });
      // Fresh pi card for acc1 at index 2 (beats acc1Old by 50s)
      const acc1New = createResource("acc1New", { accountKey: "openai:chatgpt:1111", observedAt: 60_000, route: "pi" });
      // Unknown card at index 3
      const accUnknown = createResource("accUnknown", { accountKey: null });

      const result = selectAccountResources([acc1Old, acc2, acc1New, accUnknown], (r) => r.identity);
      expect(result).toHaveLength(3);
      // Winner acc1New occupies index 0 (original position of acc1Old)
      expect(result.map((r) => r.id)).toEqual(["acc1New", "acc2", "accUnknown"]);
    });
  });

  describe("other providers (preserving shared-source preference)", () => {
    it("prefers shared scopeKind over host scopeKind for non-codex providers", () => {
      const hostScoped = createResource("hostScoped", {
        providerId: "claude",
        accountKey: "claude-org-1",
        scopeKind: "host",
      });
      const sharedScoped = createResource("sharedScoped", {
        providerId: "claude",
        accountKey: "claude-org-1",
        scopeKind: "shared",
      });

      const res1 = selectAccountResources([hostScoped, sharedScoped], (r) => r.identity);
      expect(res1).toHaveLength(1);
      expect(res1[0].id).toBe("sharedScoped");

      const res2 = selectAccountResources([sharedScoped, hostScoped], (r) => r.identity);
      expect(res2).toHaveLength(1);
      expect(res2[0].id).toBe("sharedScoped");
    });

    it("preserves first candidate when both are shared or both are host for other providers", () => {
      const shared1 = createResource("shared1", {
        providerId: "google",
        accountKey: "google-1",
        scopeKind: "shared",
      });
      const shared2 = createResource("shared2", {
        providerId: "google",
        accountKey: "google-1",
        scopeKind: "shared",
      });

      const res = selectAccountResources([shared1, shared2], (r) => r.identity);
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe("shared1");
    });

    it("places non-codex winner at initial position of the first card", () => {
      const gHost = createResource("gHost", { providerId: "google", accountKey: "g1", scopeKind: "host" });
      const other = createResource("other", { providerId: "other", accountKey: "o1", scopeKind: "host" });
      const gShared = createResource("gShared", { providerId: "google", accountKey: "g1", scopeKind: "shared" });

      const result = selectAccountResources([gHost, other, gShared], (r) => r.identity);
      expect(result.map((r) => r.id)).toEqual(["gShared", "other"]);
    });
  });
});
