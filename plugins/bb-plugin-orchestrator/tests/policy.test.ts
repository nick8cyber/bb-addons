import assert from "node:assert/strict";
import test from "node:test";
import {
  levelRole,
  parsePolicy,
  pickRoute,
  quotaGroupsForOneOff,
} from "../src/policy.js";

const VALID = JSON.stringify({
  version: 1,
  limits: { maxActive: 5, perLevel: { complex: 3 } },
  firstResponseSeconds: 90,
  maxRunSeconds: 7200,
  levels: {
    complex: { description: "hard", chain: ["complex", "complex-alt"] },
    simple: { description: "easy", chain: ["simple"], autoFallback: true },
  },
  routes: {
    complex: { preset: "complex", provider: "acp-devin" },
    "complex-alt": { preset: "complex-alt", provider: "agy" },
    simple: {
      preset: "simple",
      provider: "acp-opencode",
      quotaGroup: "zen",
      quotaPatterns: ["Free usage limit reached"],
    },
  },
});

const presets = new Set(["complex", "complex-alt", "simple"]);

test("valid policy parses", () => {
  const load = parsePolicy(VALID, presets);
  assert.equal(load.errors.length, 0);
  assert.ok(load.policy);
  assert.equal(load.policy.limits?.maxActive, 5);
  assert.equal(load.policy.levels.complex?.chain.length, 2);
  assert.deepEqual(load.unavailableRoutes, []);
});

test("empty policy is a needs-configuration error", () => {
  const load = parsePolicy("", presets);
  assert.equal(load.policy, null);
  assert.equal(load.errors[0]?.path, "policy");
  assert.match(load.errors[0]?.message ?? "", /orchestrator-setup/);
});

test("broken JSON reports a path error", () => {
  const load = parsePolicy("{nope", presets);
  assert.equal(load.errors[0]?.path, "$");
});

test("rule 1: version must be 1", () => {
  const bad = JSON.parse(VALID);
  bad.version = 2;
  const load = parsePolicy(JSON.stringify(bad), presets);
  assert.ok(load.errors.some((e) => e.path === "version"));
});

test("rule 2: every chain route must exist in routes", () => {
  const bad = JSON.parse(VALID);
  bad.levels.complex.chain = ["complex", "ghost"];
  const load = parsePolicy(JSON.stringify(bad), presets);
  assert.ok(
    load.errors.some(
      (e) => e.path === "levels.complex.chain[1]" && /ghost/.test(e.message),
    ),
  );
});

test("rule 2: a missing preset is a warning and marks the route unavailable", () => {
  const load = parsePolicy(VALID, new Set(["complex", "simple"]));
  assert.equal(load.errors.length, 0);
  assert.deepEqual(load.unavailableRoutes, ["complex-alt"]);
  assert.ok(
    load.warnings.some((w) => w.path === "routes.complex-alt.preset"),
  );
});

test("rule 3: maxActive ≥ 1 and perLevel ≤ maxActive", () => {
  const bad = JSON.parse(VALID);
  bad.limits = { maxActive: 0 };
  let load = parsePolicy(JSON.stringify(bad), presets);
  assert.ok(load.errors.some((e) => e.path === "limits.maxActive"));

  bad.limits = { maxActive: 2, perLevel: { complex: 3 } };
  load = parsePolicy(JSON.stringify(bad), presets);
  assert.ok(load.errors.some((e) => e.path === "limits.perLevel.complex"));

  bad.limits = { maxActive: 5, perLevel: { complex: 0 } };
  load = parsePolicy(JSON.stringify(bad), presets);
  assert.ok(load.errors.some((e) => e.path === "limits.perLevel.complex"));
});

test("rule 4: firstResponseSeconds 30–600, maxRunSeconds ≥ 300", () => {
  const bad = JSON.parse(VALID);
  bad.firstResponseSeconds = 10;
  let load = parsePolicy(JSON.stringify(bad), presets);
  assert.ok(load.errors.some((e) => e.path === "firstResponseSeconds"));

  bad.firstResponseSeconds = 601;
  load = parsePolicy(JSON.stringify(bad), presets);
  assert.ok(load.errors.some((e) => e.path === "firstResponseSeconds"));

  bad.firstResponseSeconds = 90;
  bad.maxRunSeconds = 120;
  load = parsePolicy(JSON.stringify(bad), presets);
  assert.ok(load.errors.some((e) => e.path === "maxRunSeconds"));
});

test("rule 5: quotaPatterns is an array of ≤20 non-empty strings", () => {
  const bad = JSON.parse(VALID);
  bad.routes.simple.quotaPatterns = "nope";
  let load = parsePolicy(JSON.stringify(bad), presets);
  assert.ok(load.errors.some((e) => e.path === "routes.simple.quotaPatterns"));

  bad.routes.simple.quotaPatterns = ["ok", ""];
  load = parsePolicy(JSON.stringify(bad), presets);
  assert.ok(
    load.errors.some((e) => e.path === "routes.simple.quotaPatterns[1]"),
  );

  bad.routes.simple.quotaPatterns = Array.from({ length: 21 }, (_, i) => `p${i}`);
  load = parsePolicy(JSON.stringify(bad), presets);
  assert.ok(load.errors.some((e) => e.path === "routes.simple.quotaPatterns"));
});

test("rule 6: unavailablePatterns is an array of ≤20 non-empty strings", () => {
  const ok = JSON.parse(VALID);
  ok.routes.simple.unavailablePatterns = ["model retired"];
  let load = parsePolicy(JSON.stringify(ok), presets);
  assert.equal(load.errors.length, 0);
  assert.deepEqual(load.policy?.routes.simple?.unavailablePatterns, [
    "model retired",
  ]);

  const bad = JSON.parse(VALID);
  bad.routes.simple.unavailablePatterns = "nope";
  load = parsePolicy(JSON.stringify(bad), presets);
  assert.ok(
    load.errors.some((e) => e.path === "routes.simple.unavailablePatterns"),
  );

  bad.routes.simple.unavailablePatterns = ["ok", ""];
  load = parsePolicy(JSON.stringify(bad), presets);
  assert.ok(
    load.errors.some(
      (e) => e.path === "routes.simple.unavailablePatterns[1]",
    ),
  );

  bad.routes.simple.unavailablePatterns = Array.from(
    { length: 21 },
    (_, i) => `p${i}`,
  );
  load = parsePolicy(JSON.stringify(bad), presets);
  assert.ok(
    load.errors.some((e) => e.path === "routes.simple.unavailablePatterns"),
  );
});

test("pickRoute: a route NAME on hold is skipped, not just its quota group", () => {
  const load = parsePolicy(VALID, presets);
  // name-hold on "simple" while its quotaGroup "zen" is free
  const unavailable = (e: unknown) =>
    (e as { code?: string }).code === "route-unavailable";
  const nameHold = new Set(["simple"]);
  assert.throws(
    () => pickRoute(load.policy!, "simple", { heldGroups: nameHold }),
    unavailable,
  );
  // sanity: the quota-group hold refuses it too
  assert.throws(
    () => pickRoute(load.policy!, "simple", { heldGroups: new Set(["zen"]) }),
    unavailable,
  );
  // and a non-held route still picks
  const { name } = pickRoute(load.policy!, "complex", {
    heldGroups: nameHold,
  });
  assert.equal(name, "complex");
});


// ── §2.3 r24: level roles, reviewByLevel, arbitrary --route, §16.8 ────

const ROLE_POLICY = JSON.stringify({
  version: 1,
  reviewByLevel: { complex: "review-complex", medium: "review-mid" },
  levels: {
    complex: { chain: ["r1"] },
    medium: { chain: ["r2"] },
    "review-complex": { role: "auditor", chain: ["r3"] },
    "review-mid": { role: "auditor", chain: ["r3"] },
  },
  routes: {
    r1: { preset: "p1", provider: "acp-devin" },
    r2: { preset: "p2", provider: "agy" },
    r3: { preset: "p3", provider: "acp-opencode" },
  },
});
const ROLE_PRESETS = new Set(["p1", "p2", "p3"]);

test("§2.3: level role — auditor parses, default executor, review stays auditor", () => {
  const load = parsePolicy(ROLE_POLICY, ROLE_PRESETS);
  assert.equal(load.errors.length, 0);
  assert.equal(load.policy?.levels["review-complex"]?.role, "auditor");
  assert.equal(levelRole(load.policy, "complex"), "executor");
  assert.equal(levelRole(load.policy, "review-complex"), "auditor");
  // Compatibility: a level named `review` with no field stays auditor.
  const legacy = parsePolicy(VALID, presets);
  assert.equal(levelRole(legacy.policy, "review"), "auditor");
  // Invalid value is a validation error.
  const bad = JSON.parse(ROLE_POLICY);
  bad.levels.complex.role = "boss";
  const load2 = parsePolicy(JSON.stringify(bad), ROLE_PRESETS);
  assert.ok(load2.errors.some((e) => e.path === "levels.complex.role"));
});

test("§2.3 reviewByLevel: parses; values must name declared auditor levels", () => {
  const load = parsePolicy(ROLE_POLICY, ROLE_PRESETS);
  assert.deepEqual(load.policy?.reviewByLevel, {
    complex: "review-complex",
    medium: "review-mid",
  });

  const bad = JSON.parse(ROLE_POLICY);
  // Unknown target level → error.
  bad.reviewByLevel = { complex: "ghost" };
  let l2 = parsePolicy(JSON.stringify(bad), ROLE_PRESETS);
  assert.ok(l2.errors.some((e) => e.path === "reviewByLevel.complex"));

  // Executor-level target → error.
  bad.reviewByLevel = { complex: "medium" };
  l2 = parsePolicy(JSON.stringify(bad), ROLE_PRESETS);
  assert.ok(
    l2.errors.some(
      (e) => e.path === "reviewByLevel.complex" && /auditor/.test(e.message),
    ),
  );
});

test("§2.3 pickRoute: --route names any policy route, not only the chain", () => {
  const load = parsePolicy(VALID, presets);
  // "simple" is outside the complex chain but declared in routes.
  const { name } = pickRoute(load.policy!, "complex", {
    requested: "simple",
  });
  assert.equal(name, "simple");
  // An undeclared name is still refused.
  assert.throws(
    () => pickRoute(load.policy!, "complex", { requested: "ghost" }),
    (e: unknown) => (e as { code?: string }).code === "unknown-route",
  );
});

test("§16.8: executor-level preset without a worktree warns; auditor exempt", () => {
  const policy = JSON.stringify({
    version: 1,
    levels: {
      simple: { chain: ["nowt"] },
      review: { role: "auditor", chain: ["nowt2"] },
    },
    routes: {
      nowt: { preset: "nowt", provider: "p" },
      nowt2: { preset: "nowt2", provider: "p" },
    },
  });
  const details = new Map([
    ["nowt", { environmentKind: "current" }],
    ["nowt2", { environmentKind: "current" }],
  ]);
  const load = parsePolicy(policy, new Set(["nowt", "nowt2"]), details);
  const hits = load.warnings.filter((w) => /worktree|копи/i.test(w.message));
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.path, "routes.nowt.preset");
});

test("§2.3 reviewByLevel: keys must name declared executor levels", () => {
  const bad = JSON.parse(ROLE_POLICY);
  // Unknown key level → error.
  bad.reviewByLevel = { ghost: "review-mid" };
  let l2 = parsePolicy(JSON.stringify(bad), ROLE_PRESETS);
  assert.ok(
    l2.errors.some(
      (e) => e.path === "reviewByLevel.ghost" && /not declared/.test(e.message),
    ),
  );
  // Auditor-level key → error.
  bad.reviewByLevel = { "review-mid": "review-complex" };
  l2 = parsePolicy(JSON.stringify(bad), ROLE_PRESETS);
  assert.ok(
    l2.errors.some(
      (e) =>
        e.path === "reviewByLevel.review-mid" && /executor/.test(e.message),
    ),
  );
  // The level named `review` (implicit auditor) as a key → error too.
  const legacy = JSON.parse(VALID);
  legacy.levels.review = { chain: ["simple"] };
  legacy.reviewByLevel = { review: "review" };
  l2 = parsePolicy(JSON.stringify(legacy), presets);
  assert.ok(
    l2.errors.some(
      (e) => e.path === "reviewByLevel.review" && /executor/.test(e.message),
    ),
  );
});

test("§2.3 quotaGroupsForOneOff: same provider AND model, plus the one-off name", () => {
  const policy = parsePolicy(
    JSON.stringify({
      version: 1,
      levels: { x: { chain: ["a", "b", "c"] } },
      routes: {
        a: { preset: "pa", provider: "acp-opencode", quotaGroup: "g-a" },
        b: { preset: "pb", provider: "acp-opencode" },
        c: { preset: "pc", provider: "agy" },
      },
    }),
  ).policy;
  const models = new Map([
    ["pa", "m1"],
    ["pb", "m2"],
    ["pc", "m1"],
  ]);
  // provider acp-opencode + model m1 → only route a's group + own name.
  assert.deepEqual(
    quotaGroupsForOneOff(
      policy,
      { route: "preset:x", provider: "acp-opencode", modelId: "m1" },
      models,
    ).sort(),
    ["g-a", "preset:x"],
  );
  // Same provider, model m2 → route b (no quotaGroup → its name).
  assert.deepEqual(
    quotaGroupsForOneOff(
      policy,
      { route: "preset:x", provider: "acp-opencode", modelId: "m2" },
      models,
    ).sort(),
    ["b", "preset:x"],
  );
  // Unknown model → name only, no mass hold.
  assert.deepEqual(
    quotaGroupsForOneOff(
      policy,
      { route: "preset:x", provider: "acp-opencode" },
      models,
    ),
    ["preset:x"],
  );
  // No policy → name only.
  assert.deepEqual(
    quotaGroupsForOneOff(
      null,
      { route: "preset:x", provider: "p", modelId: "m1" },
      models,
    ),
    ["preset:x"],
  );
});

test("§2.3 quotaGroupsForOneOff: bracketed model variant shares the quota", () => {
  // PLUG-186 (spec 6797550): `claude-opus-5-5[1m]` and
  // `claude-opus-5-5` are one quota — the bracketed variant suffix is
  // stripped before comparing, on BOTH sides.
  const policy = parsePolicy(
    JSON.stringify({
      version: 1,
      levels: { x: { chain: ["a", "b"] } },
      routes: {
        a: { preset: "pa", provider: "claude-code" },
        b: { preset: "pb", provider: "claude-code" },
      },
    }),
  ).policy;
  const models = new Map([
    ["pa", "claude-opus-5-5[1m]"],
    ["pb", "gemini-3-8"],
  ]);
  // One-off without the suffix still joins the variant's group.
  assert.deepEqual(
    quotaGroupsForOneOff(
      policy,
      { route: "preset:x", provider: "claude-code", modelId: "claude-opus-5-5" },
      models,
    ).sort(),
    ["a", "preset:x"],
  );
  // And the other way around — the one-off carries the suffix.
  assert.deepEqual(
    quotaGroupsForOneOff(
      policy,
      {
        route: "preset:x",
        provider: "claude-code",
        modelId: "claude-opus-5-5[1m]",
      },
      models,
    ).sort(),
    ["a", "preset:x"],
  );
});
