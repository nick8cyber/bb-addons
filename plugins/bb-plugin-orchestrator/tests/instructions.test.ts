import assert from "node:assert/strict";
import test from "node:test";
import {
  generateRoutingRule,
  ROUTING_RULE_MAX,
} from "../src/instructions.js";
import type { Policy } from "../src/policy.js";
import { EN } from "../src/i18n/en.js";
import { RU } from "../src/i18n/ru.js";
import { createT } from "../src/i18n/index.js";
import { LEAK_HOME_PATH } from "./fixtures/leak-samples.js";

const POLICY: Policy = {
  version: 1,
  limits: { maxActive: 5, perLevel: { complex: 3 } },
  levels: {
    complex: {
      description: "архитектура, причины, многофайловые фичи",
      chain: ["complex"],
    },
    medium: { description: "обычные фичи по ясной спеке", chain: ["medium"] },
    simple: { description: "механические правки", chain: ["simple"] },
    review: { description: "ревью, только чтение", chain: ["review"] },
  },
  routes: {
    complex: { preset: "complex", provider: "acp-devin" },
    medium: { preset: "medium", provider: "agy" },
    simple: { preset: "simple", provider: "acp-opencode" },
    review: { preset: "review", provider: "claude-code" },
  },
};

test("the rule lists levels, limits, delegate and the skill, within 1500 chars", () => {
  const text = generateRoutingRule(POLICY);
  assert.ok(text.length <= ROUTING_RULE_MAX, `len=${text.length}`);
  for (const level of ["complex", "medium", "simple", "review"]) {
    assert.ok(text.includes(level), `missing level ${level}`);
  }
  assert.match(text, /delegate/);
  assert.match(text, /orchestrator-coordinator/);
  assert.match(text, /≤ 5/);
  assert.match(text, /complex ≤ 3/);
});

test("the rule contains no thread ids or filesystem paths", () => {
  const poisoned: Policy = {
    ...POLICY,
    levels: {
      simple: {
        description: `see thr_aaaaaaaaaa and ${LEAK_HOME_PATH}/file`,
        chain: ["simple"],
      },
    },
  };
  const text = generateRoutingRule(poisoned);
  assert.doesNotMatch(text, /thr_[a-z0-9]+/);
  assert.doesNotMatch(text, /\/\S+/);
});

test("inline slashes like «фичи/тесты» survive the sanitizer", () => {
  const withSlash: Policy = {
    ...POLICY,
    levels: {
      simple: {
        description: "механические фичи/тесты and/or документы",
        chain: ["simple"],
      },
      "../etc/passwd": { description: "x", chain: ["simple"] },
      "thr_aaaaaaaaaa": { description: "x", chain: ["simple"] },
    },
  };
  const text = generateRoutingRule(withSlash);
  assert.match(text, /фичи\/тесты/);
  assert.match(text, /and\/or/);
  // level names are sanitized too: ids and path-like names never render
  assert.doesNotMatch(text, /passwd|thr_[a-z0-9]+/);
  assert.match(text, /- level/); // sanitized names fall back to "level"
});

test("huge descriptions are truncated to the budget", () => {
  const huge: Policy = {
    ...POLICY,
    levels: Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `level${i}`,
        { description: "x".repeat(1200), chain: ["simple"] },
      ]),
    ),
  };
  const text = generateRoutingRule(huge);
  assert.ok(text.length <= ROUTING_RULE_MAX, `len=${text.length}`);
});

test("§2.3: auditor levels are tagged and reviewByLevel is surfaced", () => {
  const policy: Policy = {
    ...POLICY,
    reviewByLevel: { complex: "review-hard", medium: "review-mid" },
    levels: {
      ...POLICY.levels,
      "review-hard": { role: "auditor", chain: ["review"] },
      "review-mid": { role: "auditor", chain: ["review"] },
    },
  };
  const text = generateRoutingRule(policy);
  assert.ok(text.length <= ROUTING_RULE_MAX, `len=${text.length}`);
  assert.match(text, /review-hard \(проверка — только чтение\)/);
  assert.match(text, /complex → review-hard/);
  assert.match(text, /delegate --level review/);
});

test("the rule's last line is the footer text — for en and ru (§18.1)", () => {
  // PLUG-247b review: a missed `FOOTER(t)` call once shipped the
  // function source as the rule's tail — pin the real last line.
  for (const [lang, dict] of [
    ["en", EN],
    ["ru", RU],
  ] as const) {
    const text = generateRoutingRule(POLICY, createT(lang));
    const lines = text.trimEnd().split("\n");
    assert.equal(lines[lines.length - 1], dict["instr.ruleFooter"]);
    assert.doesNotMatch(text, /=>/);
  }
});
