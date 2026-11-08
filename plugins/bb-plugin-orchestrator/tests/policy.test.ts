import assert from "node:assert/strict";
import test from "node:test";
import { parsePolicy } from "../src/policy.js";

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
