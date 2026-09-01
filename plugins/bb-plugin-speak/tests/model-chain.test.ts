/**
 * The quota chain, without a plugin host.
 *
 *   node --experimental-strip-types --test tests/model-chain.test.ts
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, format: "module-typescript", shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const { planModels, nextQuotaReset, isQuotaFailure, cooldownUntil } = await import("../src/model-chain.js");
const { readQuotaScope } = await import("../src/gemini-tts.js");
const { DEFAULT_MODEL, FALLBACK_MODEL } = await import("../src/contract.js");

const never = () => false;

test("both models are offered, primary first", () => {
  assert.deepEqual(planModels(DEFAULT_MODEL, FALLBACK_MODEL, never), [DEFAULT_MODEL, FALLBACK_MODEL]);
});

test("a model in cooldown is skipped", () => {
  assert.deepEqual(
    planModels(DEFAULT_MODEL, FALLBACK_MODEL, (m) => m === DEFAULT_MODEL),
    [FALLBACK_MODEL],
  );
});

test("everything in cooldown still tries, rather than refusing to speak", () => {
  // The cooldown is a guess about Google's clock, not a fact about it.
  assert.deepEqual(planModels(DEFAULT_MODEL, FALLBACK_MODEL, () => true), [
    DEFAULT_MODEL,
    FALLBACK_MODEL,
  ]);
});

test("an empty fallback means there is only one model", () => {
  assert.deepEqual(planModels(DEFAULT_MODEL, "", never), [DEFAULT_MODEL]);
  assert.deepEqual(planModels(DEFAULT_MODEL, "   ", never), [DEFAULT_MODEL]);
});

test("the same model named twice is tried once", () => {
  assert.deepEqual(planModels(DEFAULT_MODEL, DEFAULT_MODEL, never), [DEFAULT_MODEL]);
});

test("only a spent quota changes model", () => {
  assert.equal(isQuotaFailure("rate_limited"), true);
  for (const code of ["auth", "request_failed", "not_configured", "empty", "too_long"]) {
    assert.equal(isQuotaFailure(code), false, `${code} must not switch model`);
  }
});

test("the cooldown ends at the next Pacific midnight", () => {
  // 2026-03-02T00:30:00Z is 16:30 on 2026-03-01 in Pacific (UTC-8), so the
  // reset is 7.5 hours away.
  const at = new Date("2026-03-02T00:30:00Z");
  const hours = (nextQuotaReset(at) - at.getTime()) / 3_600_000;
  assert.ok(Math.abs(hours - 7.5) < 0.01, `expected 7.5 hours, got ${hours}`);
});

test("the cooldown is always in the future and never more than a day", () => {
  for (const iso of [
    "2026-03-02T07:59:00Z", // a minute before Pacific midnight
    "2026-03-02T08:01:00Z", // a minute after it
    "2026-07-15T12:00:00Z", // daylight saving, UTC-7
    "2026-11-05T09:00:00Z",
  ]) {
    const at = new Date(iso);
    const delta = nextQuotaReset(at) - at.getTime();
    assert.ok(delta > 0, `${iso}: cooldown must be in the future`);
    assert.ok(delta <= 86_400_000, `${iso}: cooldown must not exceed a day`);
  }
});

// --- how long a 429 benches a model ----------------------------------------
// This is the part with teeth: the player fires five chunks at once, which is
// exactly what trips a per-minute limit, and benching 3.1 until midnight over
// one busy second would be worse than the problem the fallback exists to fix.

const AT = new Date("2026-03-02T00:30:00Z"); // 16:30 Pacific; midnight is 7.5h off

test("a per-day 429 benches the model until the Pacific rollover", () => {
  const until = cooldownUntil({ quotaScope: "day" }, AT);
  assert.equal(until, nextQuotaReset(AT));
});

test("a burst 429 benches it for a minute and a half, not a day", () => {
  const minutes = (cooldownUntil({ quotaScope: "burst" }, AT) - AT.getTime()) / 60_000;
  assert.equal(minutes, 1.5);
});

test("Google's own retryDelay wins when it gives one", () => {
  const seconds = (cooldownUntil({ quotaScope: "burst", retryAfterMs: 21_000 }, AT) - AT.getTime()) / 1000;
  assert.equal(seconds, 21);
});

test("a burst cooldown never outlives the daily rollover", () => {
  const justBefore = new Date("2026-03-02T07:59:00Z"); // one minute to midnight Pacific
  const until = cooldownUntil({ quotaScope: "burst", retryAfterMs: 3_600_000 }, justBefore);
  assert.ok(until <= nextQuotaReset(justBefore));
});

test("an unlabelled 429 is read as a burst, the cheaper of the two guesses", () => {
  const minutes = (cooldownUntil({}, AT) - AT.getTime()) / 60_000;
  assert.equal(minutes, 1.5);
});

test("the scope is read out of Google's own error body", () => {
  const perDay = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [
      { quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
        quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }]}]}});
  assert.equal(readQuotaScope(perDay).quotaScope, "day");

  const perMinute = JSON.stringify({ error: { code: 429, details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [
      { quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }]},
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "34s" }]}});
  const read = readQuotaScope(perMinute);
  assert.equal(read.quotaScope, "burst");
  assert.equal(read.retryAfterMs, 34_000);

  assert.equal(readQuotaScope("plain 429, no detail at all").quotaScope, "burst");
});

test("what mapStatus puts on the failure is what cooldownUntil reads", () => {
  // The names drifted once: readQuotaScope returned `scope`, the failure type
  // declared `quotaScope`, and a spread carried the wrong one through — so a
  // spent day was benched for ninety seconds. A spread does not get excess
  // property checking, so only this catches it.
  const body = JSON.stringify({ error: { details: [{ violations: [
    { quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }]}]}});
  const read = readQuotaScope(body);
  assert.ok("quotaScope" in read, "the field must be named as the failure declares it");
  const at = new Date("2026-03-02T00:30:00Z");
  assert.equal(cooldownUntil(read, at), nextQuotaReset(at), "a spent day must reach the rollover");
});

test("a real Google 429 for a spent day is read as a day, not a burst", () => {
  // Captured from the live API, not written by hand — and the thing it taught
  // us is the asymmetry: at a limit of zero every meter reports, so a genuine
  // daily exhaustion names the per-minute quotas too. The first version of
  // this parser required "day and not minute" and therefore classified the
  // real thing as a burst, benching a spent day for fifty-six seconds.
  const body = readFileSync(new URL("./fixtures/google-429-day-exhausted.json", import.meta.url), "utf8");
  const ids = JSON.parse(body).error.details
    .flatMap((d: { violations?: Array<{ quotaId?: string }> }) => d.violations ?? [])
    .map((v: { quotaId?: string }) => v.quotaId);
  assert.ok(ids.some((id: string) => /PerDay/i.test(id)), "fixture must name a per-day quota");
  assert.ok(ids.some((id: string) => /PerMinute/i.test(id)), "and a per-minute one alongside it");

  const read = readQuotaScope(body);
  assert.equal(read.quotaScope, "day");
  assert.equal(read.retryAfterMs, 56_000, "Google's retryDelay is still read");

  const at = new Date("2026-03-02T00:30:00Z");
  assert.equal(
    cooldownUntil(read, at),
    nextQuotaReset(at),
    "and it is ignored for a spent day, which waits for the rollover",
  );
});

test("a burst names the minute alone", () => {
  const body = JSON.stringify({ error: { code: 429, details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [
      { quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" },
      { quotaId: "GenerateContentInputTokensPerModelPerMinute-FreeTier" }]},
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "9s" }]}});
  const read = readQuotaScope(body);
  assert.equal(read.quotaScope, "burst");
  assert.equal(read.retryAfterMs, 9_000);
});

test("the rollover survives both DST transitions", () => {
  // The Pacific day is 23 hours long on 8 March and 25 on 1 November 2026, so
  // "now plus a day minus what has elapsed" lands an hour off on each. Found
  // by an independent audit, which is the only reason these two dates are
  // here rather than a vague property check.
  assert.equal(
    new Date(nextQuotaReset(new Date("2026-03-08T09:00:00Z"))).toISOString(),
    "2026-03-09T07:00:00.000Z",
    "spring forward",
  );
  assert.equal(
    new Date(nextQuotaReset(new Date("2026-11-01T08:30:00Z"))).toISOString(),
    "2026-11-02T08:00:00.000Z",
    "fall back",
  );
});
