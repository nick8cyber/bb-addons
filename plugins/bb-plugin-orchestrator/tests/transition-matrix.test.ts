import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  TRANSITION_TABLE,
  resolveTransition,
  extractCounters,
  type TransitionCounters,
} from "../src/transition-matrix.js";

function defaultCounters(): TransitionCounters {
  return {
    spec_attempts: 0,
    spec_review_rounds: 0,
    code_attempts: 0,
    check_attempts: 0,
    code_review_rounds: 0,
    design_check_rounds: 0,
    release_attempts: 0,
  };
}

test("TRANSITION_TABLE contains exactly 82 rules matching §28.1 matrix", () => {
  const specPath = new URL("../../../docs/specs/orchestrator.md", import.meta.url).pathname;
  const specContent = fs.readFileSync(specPath, "utf-8");
  const startIdx = specContent.indexOf("### 28.1 Полная матрица переходов");
  const endIdx = specContent.indexOf("### 28.2", startIdx);
  const tableLines = specContent
    .slice(startIdx, endIdx)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && !l.startsWith("| Маршрут") && !l.startsWith("|:---") && !l.startsWith("|---"));

  assert.equal(TRANSITION_TABLE.length, tableLines.length);
  assert.equal(TRANSITION_TABLE.length, 82);

  const ids = new Set<string>();
  const rowNumbers = new Set<number>();
  for (const rule of TRANSITION_TABLE) {
    assert.ok(rule.id, "rule must have an id");
    assert.ok(rule.rowNumber >= 1 && rule.rowNumber <= 82, `valid rowNumber: ${rule.rowNumber}`);
    assert.ok(!ids.has(rule.id), `duplicate id: ${rule.id}`);
    assert.ok(!rowNumbers.has(rule.rowNumber), `duplicate rowNumber: ${rule.rowNumber}`);
    ids.add(rule.id);
    rowNumbers.add(rule.rowNumber);
  }
});

test("Row 1: feature | start | queued | queue_take -> design (running)", () => {
  const res = resolveTransition({
    route: "feature",
    node: "start",
    status: "queued",
    event: { type: "queue_take" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(res.allowed, true);
  assert.equal(res.toNode, "design");
  assert.equal(res.toStatus, "running");
  assert.equal(res.ruleId, "rule-01-feature-start-take");
  assert.equal(res.action?.createBranch, true);
  assert.equal(res.action?.dispatchNode, "design");
});

test("Row 2: docs | start | queued | queue_take -> spec (running)", () => {
  const res = resolveTransition({
    route: "docs",
    node: "start",
    status: "queued",
    event: { type: "queue_take" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(res.allowed, true);
  assert.equal(res.toNode, "spec");
  assert.equal(res.toStatus, "running");
  assert.equal(res.ruleId, "rule-02-docs-start-take");
  assert.equal(res.action?.createBranch, true);
  assert.equal(res.action?.dispatchNode, "spec");
});

test("Row 3: fix/simple | start | queued | queue_take manual -> owner_gate (waiting_approval)", () => {
  for (const route of ["fix", "simple"] as const) {
    const res = resolveTransition({
      route,
      node: "start",
      status: "queued",
      event: { type: "queue_take" },
      mode: "manual",
      counters: defaultCounters(),
    });
    assert.equal(res.allowed, true);
    assert.equal(res.toNode, "owner_gate");
    assert.equal(res.toStatus, "waiting_approval");
    assert.equal(res.ruleId, "rule-03-fix-simple-start-take-manual");
    assert.equal(res.action?.commitAcceptance, true);
  }
});

test("Row 4: fix/simple | start | queued | queue_take auto -> code (running)", () => {
  for (const route of ["fix", "simple"] as const) {
    const res = resolveTransition({
      route,
      node: "start",
      status: "queued",
      event: { type: "queue_take" },
      mode: "auto",
      counters: defaultCounters(),
    });
    assert.equal(res.allowed, true);
    assert.equal(res.toNode, "code");
    assert.equal(res.toStatus, "running");
    assert.equal(res.ruleId, "rule-04-fix-simple-start-take-auto");
    assert.equal(res.action?.dispatchNode, "code");
  }
});

test("Row 5: * | start | branch-exists with commits -> stalled", () => {
  for (const route of ["feature", "fix", "docs", "simple"] as const) {
    const res = resolveTransition({
      route,
      node: "start",
      status: "queued",
      event: { type: "queue_take", branchExistsWithCommits: true },
      mode: "manual",
      counters: defaultCounters(),
    });
    assert.equal(res.allowed, true);
    assert.equal(res.toNode, "start");
    assert.equal(res.toStatus, "stalled");
    assert.equal(res.ruleId, "rule-05-start-branch-exists-with-commits");
    assert.match(res.reason, /branch-exists/);
  }
});

test("Row 6: research | start | queue_take -> research (running)", () => {
  const res = resolveTransition({
    route: "research",
    node: "start",
    status: "queued",
    event: { type: "queue_take" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(res.allowed, true);
  assert.equal(res.toNode, "research");
  assert.equal(res.toStatus, "running");
  assert.equal(res.ruleId, "rule-06-research-start-take");
});

test("Row 7: feature | design | design_delivered -> spec (running)", () => {
  const res = resolveTransition({
    route: "feature",
    node: "design",
    status: "running",
    event: { type: "design_delivered", acceptanceText: "contract" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(res.allowed, true);
  assert.equal(res.toNode, "spec");
  assert.equal(res.toStatus, "running");
  assert.equal(res.ruleId, "rule-07-feature-design-delivered");
  assert.equal(res.action?.commitAcceptance, true);
});

test("Row 8: feature | design | design_failed -> running (reissue) or stalled", () => {
  const resExhausted = resolveTransition({
    route: "feature",
    node: "design",
    status: "running",
    event: { type: "design_failed", exhausted: true, reason: "exhausted" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resExhausted.toStatus, "stalled");
  assert.equal(resExhausted.ruleId, "rule-08-feature-design-failed");

  const resReissue = resolveTransition({
    route: "feature",
    node: "design",
    status: "running",
    event: { type: "design_failed", exhausted: false },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resReissue.toStatus, "running");
  assert.equal(resReissue.ruleId, "rule-08-feature-design-failed");
});

test("Row 9: feature | design | design_question_or_no_report -> design (running)", () => {
  const res = resolveTransition({
    route: "feature",
    node: "design",
    status: "running",
    event: { type: "design_question_or_no_report" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(res.toNode, "design");
  assert.equal(res.toStatus, "running");
  assert.equal(res.ruleId, "rule-09-feature-design-question");
});

test("Row 10: feature | spec | spec_delivered (untampered) -> spec_review (running)", () => {
  const res = resolveTransition({
    route: "feature",
    node: "spec",
    status: "running",
    event: { type: "spec_delivered", specSha: "sha1" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(res.toNode, "spec_review");
  assert.equal(res.toStatus, "running");
  assert.equal(res.ruleId, "rule-10-feature-spec-delivered");
  assert.equal(res.action?.dispatchNode, "spec_review");
});

test("Row 11: docs | spec | spec_delivered -> spec_review (running)", () => {
  const res = resolveTransition({
    route: "docs",
    node: "spec",
    status: "running",
    event: { type: "spec_delivered", specSha: "sha1" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(res.toNode, "spec_review");
  assert.equal(res.toStatus, "running");
  assert.equal(res.ruleId, "rule-11-docs-spec-delivered");
});

test("Row 12: feature/docs | spec | spec_invalid_reference -> retry or blocked", () => {
  const resRetry = resolveTransition({
    route: "feature",
    node: "spec",
    status: "running",
    event: { type: "spec_invalid_reference", reason: "unknown symbol foo" },
    mode: "manual",
    counters: { ...defaultCounters(), spec_attempts: 1 },
  });
  assert.equal(resRetry.toStatus, "running");
  assert.equal(resRetry.ruleId, "rule-12-spec-invalid-codebase-reference");
  assert.equal(resRetry.counterUpdates?.spec_attempts, 2);

  const resBlocked = resolveTransition({
    route: "feature",
    node: "spec",
    status: "running",
    event: { type: "spec_invalid_reference", reason: "unknown symbol foo" },
    mode: "manual",
    counters: { ...defaultCounters(), spec_attempts: 2 },
  });
  assert.equal(resBlocked.toStatus, "blocked");
  assert.equal(resBlocked.ruleId, "rule-12-spec-invalid-codebase-reference");
  assert.equal(resBlocked.counterUpdates?.spec_attempts, 3);
});

test("Row 13: feature | spec | acceptance contract modified -> retry or blocked", () => {
  const resRetry = resolveTransition({
    route: "feature",
    node: "spec",
    status: "running",
    event: { type: "spec_delivered", specSha: "sha1", acceptanceTampered: true },
    mode: "manual",
    counters: { ...defaultCounters(), spec_attempts: 1 },
  });
  assert.equal(resRetry.toStatus, "running");
  assert.equal(resRetry.ruleId, "rule-13-feature-spec-acceptance-modified");
  assert.equal(resRetry.counterUpdates?.spec_attempts, 2);

  const resBlocked = resolveTransition({
    route: "feature",
    node: "spec",
    status: "running",
    event: { type: "spec_delivered", specSha: "sha1", acceptanceTampered: true },
    mode: "manual",
    counters: { ...defaultCounters(), spec_attempts: 2 },
  });
  assert.equal(resBlocked.toStatus, "blocked");
  assert.equal(resBlocked.ruleId, "rule-13-feature-spec-acceptance-modified");
  assert.equal(resBlocked.counterUpdates?.spec_attempts, 3);
  assert.equal(resBlocked.action?.escalateArchitect, true);
});

test("Row 14: feature/docs | spec | spec_failed -> running or stalled", () => {
  const res = resolveTransition({
    route: "feature",
    node: "spec",
    status: "running",
    event: { type: "spec_failed", exhausted: true },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(res.toStatus, "stalled");
  assert.equal(res.ruleId, "rule-14-spec-failed");
});

test("Row 15: feature/docs | spec | filesOutsideDocs or question -> retry or running", () => {
  const resBlocked = resolveTransition({
    route: "feature",
    node: "spec",
    status: "running",
    event: { type: "spec_delivered", specSha: "sha1", filesOutsideDocs: true },
    mode: "manual",
    counters: { ...defaultCounters(), spec_attempts: 2 },
  });
  assert.equal(resBlocked.toStatus, "blocked");
  assert.equal(resBlocked.ruleId, "rule-15-spec-question-or-files-outside-docs");
  assert.equal(resBlocked.counterUpdates?.spec_attempts, 3);

  const resQ = resolveTransition({
    route: "feature",
    node: "spec",
    status: "running",
    event: { type: "spec_question_or_no_report" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resQ.toStatus, "running");
  assert.equal(resQ.ruleId, "rule-15-spec-question-or-files-outside-docs");
});

test("Row 16: feature | spec_review | OK manual mode -> owner_gate (waiting_approval)", () => {
  const res = resolveTransition({
    route: "feature",
    node: "spec_review",
    status: "running",
    event: { type: "spec_review_verdict", verdict: "OK" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(res.toNode, "owner_gate");
  assert.equal(res.toStatus, "waiting_approval");
  assert.equal(res.ruleId, "rule-16-feature-spec-review-ok-manual");
});

test("Row 17: feature | spec_review | OK auto mode -> code (running)", () => {
  const res = resolveTransition({
    route: "feature",
    node: "spec_review",
    status: "running",
    event: { type: "spec_review_verdict", verdict: "OK" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(res.toNode, "code");
  assert.equal(res.toStatus, "running");
  assert.equal(res.ruleId, "rule-17-feature-spec-review-ok-auto");
});

test("Row 18: docs | spec_review | OK manual mode -> owner_gate (waiting_approval)", () => {
  const res = resolveTransition({
    route: "docs",
    node: "spec_review",
    status: "running",
    event: { type: "spec_review_verdict", verdict: "OK" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(res.toNode, "owner_gate");
  assert.equal(res.toStatus, "waiting_approval");
  assert.equal(res.ruleId, "rule-18-docs-spec-review-ok-manual");
});

test("Row 19: docs | spec_review | OK auto mode -> release (running)", () => {
  const res = resolveTransition({
    route: "docs",
    node: "spec_review",
    status: "running",
    event: { type: "spec_review_verdict", verdict: "OK" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(res.toNode, "release");
  assert.equal(res.toStatus, "running");
  assert.equal(res.ruleId, "rule-19-docs-spec-review-ok-auto");
});

test("Row 20 & 21: spec_review | CHANGES loop (<3 rounds) and blocked (>=3 rounds)", () => {
  const resLoop = resolveTransition({
    route: "feature",
    node: "spec_review",
    status: "running",
    event: { type: "spec_review_verdict", verdict: "CHANGES" },
    mode: "auto",
    counters: { ...defaultCounters(), spec_review_rounds: 1 },
  });
  assert.equal(resLoop.toNode, "spec");
  assert.equal(resLoop.toStatus, "running");
  assert.equal(resLoop.ruleId, "rule-20-spec-review-changes-loop");
  assert.equal(resLoop.counterUpdates?.spec_review_rounds, 2);

  const resBlocked = resolveTransition({
    route: "feature",
    node: "spec_review",
    status: "running",
    event: { type: "spec_review_verdict", verdict: "CHANGES" },
    mode: "auto",
    counters: { ...defaultCounters(), spec_review_rounds: 2 },
  });
  assert.equal(resBlocked.toNode, "spec_review");
  assert.equal(resBlocked.toStatus, "blocked");
  assert.equal(resBlocked.ruleId, "rule-21-spec-review-changes-blocked");
  assert.equal(resBlocked.counterUpdates?.spec_review_rounds, 3);
  assert.equal(resBlocked.action?.escalateArchitect, true);
});

test("Row 22 & 23: spec_review | failed or question", () => {
  const resFailed = resolveTransition({
    route: "feature",
    node: "spec_review",
    status: "running",
    event: { type: "spec_review_failed", exhausted: true },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resFailed.toStatus, "stalled");
  assert.equal(resFailed.ruleId, "rule-22-spec-review-failed");

  const resQ = resolveTransition({
    route: "feature",
    node: "spec_review",
    status: "running",
    event: { type: "spec_review_question_or_no_verdict" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resQ.toStatus, "running");
  assert.equal(resQ.ruleId, "rule-23-spec-review-question");
});

test("Row 24 & 25: owner_gate | approve pre_code -> code, pre_release -> release", () => {
  const resDeny = resolveTransition({
    route: "feature",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_approve", isOwner: false },
    mode: "manual",
    counters: defaultCounters(),
    gateStage: "pre_code",
  });
  assert.equal(resDeny.allowed, false);
  assert.equal(resDeny.errorCode, "permission-denied");

  const resCode = resolveTransition({
    route: "feature",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_approve", isOwner: true },
    mode: "manual",
    counters: defaultCounters(),
    gateStage: "pre_code",
  });
  assert.equal(resCode.toNode, "code");
  assert.equal(resCode.toStatus, "running");
  assert.equal(resCode.ruleId, "rule-24-owner-gate-approve-pre-code");

  const resRel = resolveTransition({
    route: "feature",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_approve", isOwner: true },
    mode: "manual",
    counters: defaultCounters(),
    gateStage: "pre_release",
  });
  assert.equal(resRel.toNode, "release");
  assert.equal(resRel.toStatus, "running");
  assert.equal(resRel.ruleId, "rule-25-owner-gate-approve-pre-release");
});

test("Row 26, 27, 28: owner_gate | reject (pre_code feature, pre_code fix/simple, pre_release)", () => {
  const resFeat = resolveTransition({
    route: "feature",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_reject", isOwner: true, target: "design", reason: "redesign" },
    mode: "manual",
    counters: defaultCounters(),
    gateStage: "pre_code",
  });
  assert.equal(resFeat.toNode, "design");
  assert.equal(resFeat.toStatus, "running");
  assert.equal(resFeat.ruleId, "rule-26-feature-owner-gate-reject-pre-code");

  const resFix = resolveTransition({
    route: "fix",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_reject", isOwner: true, reason: "wait" },
    mode: "manual",
    counters: defaultCounters(),
    gateStage: "pre_code",
  });
  assert.equal(resFix.toNode, "owner_gate");
  assert.equal(resFix.toStatus, "deferred");
  assert.equal(resFix.ruleId, "rule-27-fix-simple-owner-gate-reject-pre-code");

  const resPreRel = resolveTransition({
    route: "feature",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_reject", isOwner: true, target: "code", reason: "rework" },
    mode: "manual",
    counters: defaultCounters(),
    gateStage: "pre_release",
  });
  assert.equal(resPreRel.toNode, "code");
  assert.equal(resPreRel.toStatus, "running");
  assert.equal(resPreRel.ruleId, "rule-28-owner-gate-reject-pre-release");
});

test("Row 29, 30, 31: owner_gate | update acceptance, defer, timeout", () => {
  const resUpdate = resolveTransition({
    route: "fix",
    node: "owner_gate",
    status: "deferred",
    event: { type: "owner_enqueue_acceptance", isOwner: true, acceptanceText: "new text" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resUpdate.toStatus, "waiting_approval");
  assert.equal(resUpdate.ruleId, "rule-29-fix-simple-owner-gate-update-acceptance");

  const resDefer = resolveTransition({
    route: "feature",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_defer", isOwner: true },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resDefer.toStatus, "deferred");
  assert.equal(resDefer.ruleId, "rule-30-owner-gate-defer");

  const resTimeout = resolveTransition({
    route: "feature",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_gate_timeout" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resTimeout.toStatus, "waiting_approval");
  assert.equal(resTimeout.ruleId, "rule-31-owner-gate-timeout");
});

test("Row 32: fix/simple | code | route violation -> design (running on feature route)", () => {
  const res = resolveTransition({
    route: "fix",
    node: "code",
    status: "running",
    event: { type: "code_route_violation", reason: "diff too large" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(res.toNode, "design");
  assert.equal(res.toStatus, "running");
  assert.equal(res.ruleId, "rule-32-code-route-violation");
});

test("Row 33, 34, 35: code | delivered OK, acceptance tampered, no commits", () => {
  const resOk = resolveTransition({
    route: "feature",
    node: "code",
    status: "running",
    event: { type: "code_delivered", resultSha: "sha-res", commits: 2 },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resOk.toNode, "checks");
  assert.equal(resOk.toStatus, "running");
  assert.equal(resOk.ruleId, "rule-33-code-delivered-ok");

  const resTampered = resolveTransition({
    route: "feature",
    node: "code",
    status: "running",
    event: { type: "code_delivered", resultSha: "sha-res", commits: 1, acceptanceTampered: true },
    mode: "auto",
    counters: { ...defaultCounters(), code_attempts: 2 },
  });
  assert.equal(resTampered.toNode, "code");
  assert.equal(resTampered.toStatus, "blocked");
  assert.equal(resTampered.ruleId, "rule-34-code-acceptance-tampered");
  assert.equal(resTampered.counterUpdates?.code_attempts, 3);

  const resNoCommits = resolveTransition({
    route: "feature",
    node: "code",
    status: "running",
    event: { type: "code_delivered", resultSha: "sha-res", commits: 0 },
    mode: "auto",
    counters: { ...defaultCounters(), code_attempts: 1 },
  });
  assert.equal(resNoCommits.toNode, "code");
  assert.equal(resNoCommits.toStatus, "running");
  assert.equal(resNoCommits.ruleId, "rule-35-code-no-commits");
  assert.equal(resNoCommits.counterUpdates?.code_attempts, 2);
});

test("Row 36, 37, 38: code | failed, question, code_reject", () => {
  const resFail = resolveTransition({
    route: "feature",
    node: "code",
    status: "running",
    event: { type: "code_failed", exhausted: true },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resFail.toStatus, "stalled");
  assert.equal(resFail.ruleId, "rule-36-code-failed");

  const resQ = resolveTransition({
    route: "feature",
    node: "code",
    status: "running",
    event: { type: "code_question_or_no_report" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resQ.toStatus, "running");
  assert.equal(resQ.ruleId, "rule-37-code-question");

  const resRej = resolveTransition({
    route: "feature",
    node: "code",
    status: "running",
    event: { type: "code_reject", reason: "fix bug" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resRej.toStatus, "running");
  assert.equal(resRej.ruleId, "rule-38-code-reject");
});

test("Row 39, 40, 41, 42: checks | exit 0, exit != 0 loop, exit != 0 blocked, not_run", () => {
  const resPass = resolveTransition({
    route: "feature",
    node: "checks",
    status: "running",
    event: { type: "checks_result", exitCode: 0 },
    mode: "auto",
    counters: { ...defaultCounters(), check_attempts: 2 },
  });
  assert.equal(resPass.toNode, "review");
  assert.equal(resPass.toStatus, "running");
  assert.equal(resPass.ruleId, "rule-39-checks-passed");
  assert.equal(resPass.counterUpdates?.check_attempts, 0);

  const resFailLoop = resolveTransition({
    route: "feature",
    node: "checks",
    status: "running",
    event: { type: "checks_result", exitCode: 1 },
    mode: "auto",
    counters: { ...defaultCounters(), check_attempts: 1 },
  });
  assert.equal(resFailLoop.toNode, "code");
  assert.equal(resFailLoop.toStatus, "running");
  assert.equal(resFailLoop.ruleId, "rule-40-checks-failed-loop");
  assert.equal(resFailLoop.counterUpdates?.check_attempts, 2);

  const resFailBlocked = resolveTransition({
    route: "feature",
    node: "checks",
    status: "running",
    event: { type: "checks_result", exitCode: 1 },
    mode: "auto",
    counters: { ...defaultCounters(), check_attempts: 2 },
  });
  assert.equal(resFailBlocked.toNode, "checks");
  assert.equal(resFailBlocked.toStatus, "blocked");
  assert.equal(resFailBlocked.ruleId, "rule-41-checks-failed-blocked");
  assert.equal(resFailBlocked.counterUpdates?.check_attempts, 3);
  assert.equal(resFailBlocked.action?.escalateArchitect, true);

  const resNotRun = resolveTransition({
    route: "feature",
    node: "checks",
    status: "running",
    event: { type: "checks_result", exitCode: 1, notRun: true },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resNotRun.toNode, "checks");
  assert.equal(resNotRun.toStatus, "stalled");
  assert.equal(resNotRun.ruleId, "rule-42-checks-not-run");
});

test("Row 43, 44, 45: review | OK feature -> design_check, OK fix manual -> owner_gate, OK fix auto -> release", () => {
  const resFeat = resolveTransition({
    route: "feature",
    node: "review",
    status: "running",
    event: { type: "review_verdict", verdict: "OK" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resFeat.toNode, "design_check");
  assert.equal(resFeat.toStatus, "running");
  assert.equal(resFeat.ruleId, "rule-43-feature-review-ok");

  const resFixManual = resolveTransition({
    route: "fix",
    node: "review",
    status: "running",
    event: { type: "review_verdict", verdict: "OK" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resFixManual.toNode, "owner_gate");
  assert.equal(resFixManual.toStatus, "waiting_approval");
  assert.equal(resFixManual.ruleId, "rule-44-fix-simple-review-ok-manual");

  const resFixAuto = resolveTransition({
    route: "fix",
    node: "review",
    status: "running",
    event: { type: "review_verdict", verdict: "OK" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resFixAuto.toNode, "release");
  assert.equal(resFixAuto.toStatus, "running");
  assert.equal(resFixAuto.ruleId, "rule-45-fix-simple-review-ok-auto");
});

test("Row 46, 47, 48, 49: review | CHANGES loop/blocked, failed, question", () => {
  const resLoop = resolveTransition({
    route: "feature",
    node: "review",
    status: "running",
    event: { type: "review_verdict", verdict: "CHANGES" },
    mode: "auto",
    counters: { ...defaultCounters(), code_review_rounds: 1 },
  });
  assert.equal(resLoop.toNode, "code");
  assert.equal(resLoop.toStatus, "running");
  assert.equal(resLoop.ruleId, "rule-46-review-changes-loop");
  assert.equal(resLoop.counterUpdates?.code_review_rounds, 2);

  const resBlocked = resolveTransition({
    route: "feature",
    node: "review",
    status: "running",
    event: { type: "review_verdict", verdict: "CHANGES" },
    mode: "auto",
    counters: { ...defaultCounters(), code_review_rounds: 2 },
  });
  assert.equal(resBlocked.toNode, "review");
  assert.equal(resBlocked.toStatus, "blocked");
  assert.equal(resBlocked.ruleId, "rule-47-review-changes-blocked");
  assert.equal(resBlocked.counterUpdates?.code_review_rounds, 3);

  const resFail = resolveTransition({
    route: "feature",
    node: "review",
    status: "running",
    event: { type: "review_failed", exhausted: true },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resFail.toStatus, "stalled");
  assert.equal(resFail.ruleId, "rule-48-review-failed");

  const resQ = resolveTransition({
    route: "feature",
    node: "review",
    status: "running",
    event: { type: "review_question_or_no_verdict" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resQ.toStatus, "running");
  assert.equal(resQ.ruleId, "rule-49-review-question");
});

test("Row 50 to 56: design_check | OK manual/auto, CHANGES code/design, blocked, failed, question", () => {
  const resManual = resolveTransition({
    route: "feature",
    node: "design_check",
    status: "running",
    event: { type: "design_check_verdict", verdict: "OK" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resManual.toNode, "owner_gate");
  assert.equal(resManual.toStatus, "waiting_approval");
  assert.equal(resManual.ruleId, "rule-50-feature-design-check-ok-manual");

  const resOk = resolveTransition({
    route: "feature",
    node: "design_check",
    status: "running",
    event: { type: "design_check_verdict", verdict: "OK" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resOk.toNode, "release");
  assert.equal(resOk.toStatus, "running");
  assert.equal(resOk.ruleId, "rule-51-feature-design-check-ok-auto");

  const resCode = resolveTransition({
    route: "feature",
    node: "design_check",
    status: "running",
    event: { type: "design_check_verdict", verdict: "CHANGES", target: "code" },
    mode: "auto",
    counters: { ...defaultCounters(), design_check_rounds: 0 },
  });
  assert.equal(resCode.toNode, "code");
  assert.equal(resCode.ruleId, "rule-52-feature-design-check-changes-code");
  assert.equal(resCode.counterUpdates?.design_check_rounds, 1);

  const resDesign = resolveTransition({
    route: "feature",
    node: "design_check",
    status: "running",
    event: { type: "design_check_verdict", verdict: "CHANGES", target: "design" },
    mode: "auto",
    counters: {
      ...defaultCounters(),
      design_check_rounds: 1,
      spec_attempts: 2,
      code_attempts: 2,
    },
  });
  assert.equal(resDesign.toNode, "design");
  assert.equal(resDesign.ruleId, "rule-53-feature-design-check-changes-design");
  assert.equal(resDesign.counterUpdates?.design_check_rounds, 2);
  assert.equal(resDesign.counterUpdates?.spec_attempts, 0);
  assert.equal(resDesign.counterUpdates?.code_attempts, 0);

  const resBlocked = resolveTransition({
    route: "feature",
    node: "design_check",
    status: "running",
    event: { type: "design_check_verdict", verdict: "CHANGES" },
    mode: "auto",
    counters: { ...defaultCounters(), design_check_rounds: 2 },
  });
  assert.equal(resBlocked.toNode, "design_check");
  assert.equal(resBlocked.toStatus, "blocked");
  assert.equal(resBlocked.ruleId, "rule-54-feature-design-check-changes-blocked");
  assert.equal(resBlocked.counterUpdates?.design_check_rounds, 3);

  const resFail = resolveTransition({
    route: "feature",
    node: "design_check",
    status: "running",
    event: { type: "design_check_failed", exhausted: true },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resFail.toStatus, "stalled");
  assert.equal(resFail.ruleId, "rule-55-feature-design-check-failed");

  const resQ = resolveTransition({
    route: "feature",
    node: "design_check",
    status: "running",
    event: { type: "design_check_question_or_no_verdict" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resQ.toStatus, "running");
  assert.equal(resQ.ruleId, "rule-56-feature-design-check-question");
});

test("Row 57 to 62: release | published push, published PR, pr_merged, pr_changes_requested, pr_closed", () => {
  const resPush = resolveTransition({
    route: "feature",
    node: "release",
    status: "running",
    event: { type: "release_published", prMode: false },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resPush.toNode, "release");
  assert.equal(resPush.toStatus, "done");
  assert.equal(resPush.ruleId, "rule-57-release-published-push");

  const resPr = resolveTransition({
    route: "feature",
    node: "release",
    status: "running",
    event: { type: "release_published", prMode: true },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resPr.toNode, "release");
  assert.equal(resPr.toStatus, "pr_open");
  assert.equal(resPr.ruleId, "rule-58-release-published-pr");

  const resMerged = resolveTransition({
    route: "feature",
    node: "release",
    status: "pr_open",
    event: { type: "pr_merged" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resMerged.toStatus, "done");
  assert.equal(resMerged.ruleId, "rule-59-release-pr-merged");

  const resChangesCode = resolveTransition({
    route: "feature",
    node: "release",
    status: "pr_open",
    event: { type: "pr_changes_requested" },
    mode: "auto",
    counters: { ...defaultCounters(), code_attempts: 2, release_attempts: 1 },
  });
  assert.equal(resChangesCode.toNode, "code");
  assert.equal(resChangesCode.toStatus, "running");
  assert.equal(resChangesCode.ruleId, "rule-60-release-pr-changes-requested-code");
  assert.equal(resChangesCode.counterUpdates?.release_attempts, 0);

  const resChangesDocs = resolveTransition({
    route: "docs",
    node: "release",
    status: "pr_open",
    event: { type: "pr_changes_requested" },
    mode: "auto",
    counters: { ...defaultCounters(), spec_attempts: 2 },
  });
  assert.equal(resChangesDocs.toNode, "spec");
  assert.equal(resChangesDocs.ruleId, "rule-61-release-pr-changes-requested-docs");
  assert.equal(resChangesDocs.counterUpdates?.spec_attempts, 0);

  const resClosed = resolveTransition({
    route: "feature",
    node: "release",
    status: "pr_open",
    event: { type: "pr_closed" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resClosed.toStatus, "stalled");
  assert.equal(resClosed.ruleId, "rule-62-release-pr-closed");
});

test("Row 63 & 64: release | resume from pr_closed (code or spec)", () => {
  const resCode = resolveTransition({
    route: "feature",
    node: "release",
    status: "stalled",
    event: { type: "resume", prClosedReason: true, target: "code", isOwner: true },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resCode.toNode, "code");
  assert.equal(resCode.toStatus, "running");
  assert.equal(resCode.ruleId, "rule-63-release-resume-pr-closed-code");

  const resDocs = resolveTransition({
    route: "docs",
    node: "release",
    status: "stalled",
    event: { type: "resume", prClosedReason: true, target: "spec", isOwner: true },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resDocs.toNode, "spec");
  assert.equal(resDocs.toStatus, "running");
  assert.equal(resDocs.ruleId, "rule-64-release-resume-pr-closed-docs");
});

test("Row 65, 66, 67: release | refused KB, refused UI, waiting note", () => {
  const resKb = resolveTransition({
    route: "feature",
    node: "release",
    status: "running",
    event: { type: "release_refused_kb" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resKb.toStatus, "stalled");
  assert.equal(resKb.ruleId, "rule-65-release-refused-uncommitted-kb");

  const resUi = resolveTransition({
    route: "feature",
    node: "release",
    status: "running",
    event: { type: "release_refused_ui" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resUi.toStatus, "stalled");
  assert.equal(resUi.ruleId, "rule-66-release-refused-unmerged-ui");

  const resNote = resolveTransition({
    route: "feature",
    node: "release",
    status: "running",
    event: { type: "release_waiting_note" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resNote.toStatus, "waiting_release_note");
  assert.equal(resNote.ruleId, "rule-67-release-waiting-note");
});

test("Row 68, 69, 70, 71: release failures (code/docs loop & blocked)", () => {
  const resCodeLoop = resolveTransition({
    route: "feature",
    node: "release",
    status: "running",
    event: { type: "release_failed_checks_conflict_reject", reason: "conflict" },
    mode: "auto",
    counters: { ...defaultCounters(), release_attempts: 1 },
  });
  assert.equal(resCodeLoop.toNode, "code");
  assert.equal(resCodeLoop.ruleId, "rule-68-release-failed-code-loop");
  assert.equal(resCodeLoop.counterUpdates?.release_attempts, 2);

  const resCodeBlocked = resolveTransition({
    route: "feature",
    node: "release",
    status: "running",
    event: { type: "release_failed_checks_conflict_reject", reason: "conflict" },
    mode: "auto",
    counters: { ...defaultCounters(), release_attempts: 2 },
  });
  assert.equal(resCodeBlocked.toNode, "release");
  assert.equal(resCodeBlocked.toStatus, "blocked");
  assert.equal(resCodeBlocked.ruleId, "rule-69-release-failed-code-blocked");
  assert.equal(resCodeBlocked.counterUpdates?.release_attempts, 3);

  const resDocsLoop = resolveTransition({
    route: "docs",
    node: "release",
    status: "running",
    event: { type: "release_failed_checks_conflict_reject", reason: "conflict" },
    mode: "auto",
    counters: { ...defaultCounters(), release_attempts: 1 },
  });
  assert.equal(resDocsLoop.toNode, "spec");
  assert.equal(resDocsLoop.ruleId, "rule-70-release-failed-docs-loop");
  assert.equal(resDocsLoop.counterUpdates?.release_attempts, 2);

  const resDocsBlocked = resolveTransition({
    route: "docs",
    node: "release",
    status: "running",
    event: { type: "release_failed_checks_conflict_reject", reason: "conflict" },
    mode: "auto",
    counters: { ...defaultCounters(), release_attempts: 2 },
  });
  assert.equal(resDocsBlocked.toNode, "release");
  assert.equal(resDocsBlocked.toStatus, "blocked");
  assert.equal(resDocsBlocked.ruleId, "rule-71-release-failed-docs-blocked");
  assert.equal(resDocsBlocked.counterUpdates?.release_attempts, 3);
});

test("Row 72 & 73: release script failure & release note provided", () => {
  const resFail = resolveTransition({
    route: "feature",
    node: "release",
    status: "running",
    event: { type: "release_failed_script", reason: "crash" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resFail.toStatus, "stalled");
  assert.equal(resFail.ruleId, "rule-72-release-failed-script");

  const resNote = resolveTransition({
    route: "feature",
    node: "release",
    status: "waiting_release_note",
    event: { type: "release_note_provided", note: "v1.0.0" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resNote.toStatus, "running");
  assert.equal(resNote.ruleId, "rule-73-release-note-provided");
});

test("Row 74 & 75: resume stalled (no target) & dequeue", () => {
  const resResume = resolveTransition({
    route: "feature",
    node: "code",
    status: "stalled",
    event: { type: "resume" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resResume.toNode, "code");
  assert.equal(resResume.toStatus, "running");
  assert.equal(resResume.ruleId, "rule-74-resume-stalled");

  const resDeq = resolveTransition({
    route: "feature",
    node: "code",
    status: "running",
    event: { type: "dequeue", isOwner: true, reason: "cancelled by user" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resDeq.toStatus, "cancelled");
  assert.equal(resDeq.ruleId, "rule-75-dequeue");
  assert.equal(resDeq.action?.archiveBranch, true);
});

test("Row 76 & 77: resume blocked & resume deferred", () => {
  const resBlockedCode = resolveTransition({
    route: "feature",
    node: "review",
    status: "blocked",
    event: { type: "resume", target: "code", isOwner: true },
    mode: "auto",
    counters: { ...defaultCounters(), code_attempts: 3, check_attempts: 3 },
  });
  assert.equal(resBlockedCode.toNode, "code");
  assert.equal(resBlockedCode.toStatus, "running");
  assert.equal(resBlockedCode.ruleId, "rule-76-resume-blocked");
  assert.equal(resBlockedCode.counterUpdates?.code_attempts, 0);
  assert.equal(resBlockedCode.counterUpdates?.check_attempts, 0);

  // Resume to release from code review is refused
  const resBadRel = resolveTransition({
    route: "feature",
    node: "review",
    status: "blocked",
    event: { type: "resume", target: "release", isOwner: true },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resBadRel.allowed, false);
  assert.equal(resBadRel.errorCode, "target-invalid");

  const resDeferred = resolveTransition({
    route: "feature",
    node: "owner_gate",
    status: "deferred",
    event: { type: "resume", isOwner: true },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resDeferred.toNode, "owner_gate");
  assert.equal(resDeferred.toStatus, "waiting_approval");
  assert.equal(resDeferred.ruleId, "rule-77-resume-deferred");

  const resDeferredStart = resolveTransition({
    route: "feature",
    node: "start",
    status: "deferred",
    event: { type: "resume", isOwner: true },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resDeferredStart.toNode, "start");
  assert.equal(resDeferredStart.toStatus, "queued");
  assert.equal(resDeferredStart.ruleId, "rule-77-resume-deferred");
});

test("Row 78, 79, 80: research delivered, failed, question", () => {
  const resDelivered = resolveTransition({
    route: "research",
    node: "research",
    status: "running",
    event: { type: "research_delivered", report: "done" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resDelivered.toNode, "research");
  assert.equal(resDelivered.toStatus, "done");
  assert.equal(resDelivered.ruleId, "rule-78-research-delivered");

  const resFailed = resolveTransition({
    route: "research",
    node: "research",
    status: "running",
    event: { type: "research_failed", exhausted: true },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resFailed.toStatus, "stalled");
  assert.equal(resFailed.ruleId, "rule-79-research-failed");

  const resQ = resolveTransition({
    route: "research",
    node: "research",
    status: "running",
    event: { type: "research_question_or_no_report" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resQ.toStatus, "running");
  assert.equal(resQ.ruleId, "rule-80-research-question");
});

test("Row 81 & 82: acceptance_vacuous -> design / owner_gate", () => {
  // Row 81: feature | spec_review | acceptance_vacuous -> design running
  const res81 = resolveTransition({
    route: "feature",
    node: "spec_review",
    status: "running",
    event: { type: "acceptance_vacuous" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(res81.allowed, true);
  assert.equal(res81.toNode, "design");
  assert.equal(res81.toStatus, "running");
  assert.equal(res81.ruleId, "rule-81-acceptance-vacuous-feature");
  assert.equal(res81.counters?.design_check_rounds, 1);

  // Row 81: feature ceiling -> blocked
  const res81b = resolveTransition({
    route: "feature",
    node: "spec_review",
    status: "running",
    event: { type: "acceptance_vacuous" },
    mode: "auto",
    counters: { ...defaultCounters(), design_check_rounds: 2 },
  });
  assert.equal(res81b.allowed, true);
  assert.equal(res81b.toNode, "spec_review");
  assert.equal(res81b.toStatus, "blocked");

  // Row 82: fix | start | acceptance_vacuous -> owner_gate waiting_approval
  const res82 = resolveTransition({
    route: "fix",
    node: "start",
    status: "queued",
    event: { type: "acceptance_vacuous" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(res82.allowed, true);
  assert.equal(res82.toNode, "owner_gate");
  assert.equal(res82.toStatus, "waiting_approval");
  assert.equal(res82.ruleId, "rule-82-acceptance-vacuous-fix-simple");
  assert.equal(res82.counters?.check_attempts, 1);

  // Row 82: simple ceiling -> blocked
  const res82b = resolveTransition({
    route: "simple",
    node: "start",
    status: "queued",
    event: { type: "acceptance_vacuous" },
    mode: "auto",
    counters: { ...defaultCounters(), check_attempts: 2 },
  });
  assert.equal(res82b.allowed, true);
  assert.equal(res82b.toNode, "start");
  assert.equal(res82b.toStatus, "blocked");

  // Row 82 from owner_gate node: fix | owner_gate | acceptance_vacuous -> owner_gate waiting_approval
  const res82og = resolveTransition({
    route: "fix",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "acceptance_vacuous" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(res82og.allowed, true);
  assert.equal(res82og.toNode, "owner_gate");
  assert.equal(res82og.toStatus, "waiting_approval");
  assert.equal(res82og.ruleId, "rule-82-acceptance-vacuous-fix-simple");
  assert.equal(res82og.counters?.check_attempts, 1);
});

test("Coverage: all 82 rules in TRANSITION_TABLE are exercised and verified", () => {
  const allRuleIds = new Set<string>();
  for (const rule of TRANSITION_TABLE) {
    allRuleIds.add(rule.id);
  }
  assert.equal(allRuleIds.size, 82);

  // Execute every rule explicitly and verify ruleId matches
  const exercisedRuleIds = new Set<string>();

  function check(res: ReturnType<typeof resolveTransition>, expectedRuleId: string) {
    assert.equal(res.allowed, true, `rule ${expectedRuleId} must allow`);
    assert.equal(res.ruleId, expectedRuleId, `expected ruleId ${expectedRuleId}, got ${res.ruleId}`);
    exercisedRuleIds.add(res.ruleId);
  }

  // Row 1
  check(resolveTransition({ route: "feature", node: "start", status: "queued", event: { type: "queue_take" }, mode: "manual", counters: defaultCounters() }), "rule-01-feature-start-take");
  // Row 2
  check(resolveTransition({ route: "docs", node: "start", status: "queued", event: { type: "queue_take" }, mode: "manual", counters: defaultCounters() }), "rule-02-docs-start-take");
  // Row 3
  check(resolveTransition({ route: "fix", node: "start", status: "queued", event: { type: "queue_take" }, mode: "manual", counters: defaultCounters() }), "rule-03-fix-simple-start-take-manual");
  // Row 4
  check(resolveTransition({ route: "fix", node: "start", status: "queued", event: { type: "queue_take" }, mode: "auto", counters: defaultCounters() }), "rule-04-fix-simple-start-take-auto");
  // Row 5
  check(resolveTransition({ route: "feature", node: "start", status: "queued", event: { type: "queue_take", branchExistsWithCommits: true }, mode: "manual", counters: defaultCounters() }), "rule-05-start-branch-exists-with-commits");
  // Row 6
  check(resolveTransition({ route: "research", node: "start", status: "queued", event: { type: "queue_take" }, mode: "manual", counters: defaultCounters() }), "rule-06-research-start-take");
  // Row 7
  check(resolveTransition({ route: "feature", node: "design", status: "running", event: { type: "design_delivered", acceptanceText: "contract" }, mode: "manual", counters: defaultCounters() }), "rule-07-feature-design-delivered");
  // Row 8
  check(resolveTransition({ route: "feature", node: "design", status: "running", event: { type: "design_failed", exhausted: true }, mode: "manual", counters: defaultCounters() }), "rule-08-feature-design-failed");
  // Row 9
  check(resolveTransition({ route: "feature", node: "design", status: "running", event: { type: "design_question_or_no_report" }, mode: "manual", counters: defaultCounters() }), "rule-09-feature-design-question");
  // Row 10
  check(resolveTransition({ route: "feature", node: "spec", status: "running", event: { type: "spec_delivered", specSha: "sha1" }, mode: "manual", counters: defaultCounters() }), "rule-10-feature-spec-delivered");
  // Row 11
  check(resolveTransition({ route: "docs", node: "spec", status: "running", event: { type: "spec_delivered", specSha: "sha1" }, mode: "manual", counters: defaultCounters() }), "rule-11-docs-spec-delivered");
  // Row 12
  check(resolveTransition({ route: "feature", node: "spec", status: "running", event: { type: "spec_invalid_reference", reason: "missing" }, mode: "manual", counters: defaultCounters() }), "rule-12-spec-invalid-codebase-reference");
  // Row 13
  check(resolveTransition({ route: "feature", node: "spec", status: "running", event: { type: "spec_delivered", specSha: "sha1", acceptanceTampered: true }, mode: "manual", counters: defaultCounters() }), "rule-13-feature-spec-acceptance-modified");
  // Row 14
  check(resolveTransition({ route: "feature", node: "spec", status: "running", event: { type: "spec_failed", exhausted: true }, mode: "manual", counters: defaultCounters() }), "rule-14-spec-failed");
  // Row 15
  check(resolveTransition({ route: "feature", node: "spec", status: "running", event: { type: "spec_question_or_no_report" }, mode: "manual", counters: defaultCounters() }), "rule-15-spec-question-or-files-outside-docs");
  // Row 16
  check(resolveTransition({ route: "feature", node: "spec_review", status: "running", event: { type: "spec_review_verdict", verdict: "OK" }, mode: "manual", counters: defaultCounters() }), "rule-16-feature-spec-review-ok-manual");
  // Row 17
  check(resolveTransition({ route: "feature", node: "spec_review", status: "running", event: { type: "spec_review_verdict", verdict: "OK" }, mode: "auto", counters: defaultCounters() }), "rule-17-feature-spec-review-ok-auto");
  // Row 18
  check(resolveTransition({ route: "docs", node: "spec_review", status: "running", event: { type: "spec_review_verdict", verdict: "OK" }, mode: "manual", counters: defaultCounters() }), "rule-18-docs-spec-review-ok-manual");
  // Row 19
  check(resolveTransition({ route: "docs", node: "spec_review", status: "running", event: { type: "spec_review_verdict", verdict: "OK" }, mode: "auto", counters: defaultCounters() }), "rule-19-docs-spec-review-ok-auto");
  // Row 20
  check(resolveTransition({ route: "feature", node: "spec_review", status: "running", event: { type: "spec_review_verdict", verdict: "CHANGES" }, mode: "auto", counters: { ...defaultCounters(), spec_review_rounds: 0 } }), "rule-20-spec-review-changes-loop");
  // Row 21
  check(resolveTransition({ route: "feature", node: "spec_review", status: "running", event: { type: "spec_review_verdict", verdict: "CHANGES" }, mode: "auto", counters: { ...defaultCounters(), spec_review_rounds: 2 } }), "rule-21-spec-review-changes-blocked");
  // Row 22
  check(resolveTransition({ route: "feature", node: "spec_review", status: "running", event: { type: "spec_review_failed", exhausted: true }, mode: "auto", counters: defaultCounters() }), "rule-22-spec-review-failed");
  // Row 23
  check(resolveTransition({ route: "feature", node: "spec_review", status: "running", event: { type: "spec_review_question_or_no_verdict" }, mode: "auto", counters: defaultCounters() }), "rule-23-spec-review-question");
  // Row 24
  check(resolveTransition({ route: "feature", node: "owner_gate", status: "waiting_approval", event: { type: "owner_approve", isOwner: true }, mode: "manual", counters: defaultCounters(), gateStage: "pre_code" }), "rule-24-owner-gate-approve-pre-code");
  // Row 25
  check(resolveTransition({ route: "feature", node: "owner_gate", status: "waiting_approval", event: { type: "owner_approve", isOwner: true }, mode: "manual", counters: defaultCounters(), gateStage: "pre_release" }), "rule-25-owner-gate-approve-pre-release");
  // Row 26
  check(resolveTransition({ route: "feature", node: "owner_gate", status: "waiting_approval", event: { type: "owner_reject", isOwner: true, target: "spec", reason: "r" }, mode: "manual", counters: defaultCounters(), gateStage: "pre_code" }), "rule-26-feature-owner-gate-reject-pre-code");
  // Row 27
  check(resolveTransition({ route: "fix", node: "owner_gate", status: "waiting_approval", event: { type: "owner_reject", isOwner: true, reason: "r" }, mode: "manual", counters: defaultCounters(), gateStage: "pre_code" }), "rule-27-fix-simple-owner-gate-reject-pre-code");
  // Row 28
  check(resolveTransition({ route: "feature", node: "owner_gate", status: "waiting_approval", event: { type: "owner_reject", isOwner: true, target: "code", reason: "r" }, mode: "manual", counters: defaultCounters(), gateStage: "pre_release" }), "rule-28-owner-gate-reject-pre-release");
  // Row 29
  check(resolveTransition({ route: "fix", node: "owner_gate", status: "waiting_approval", event: { type: "owner_enqueue_acceptance", isOwner: true, acceptanceText: "t" }, mode: "manual", counters: defaultCounters() }), "rule-29-fix-simple-owner-gate-update-acceptance");
  // Row 30
  check(resolveTransition({ route: "feature", node: "owner_gate", status: "waiting_approval", event: { type: "owner_defer", isOwner: true }, mode: "manual", counters: defaultCounters() }), "rule-30-owner-gate-defer");
  // Row 31
  check(resolveTransition({ route: "feature", node: "owner_gate", status: "waiting_approval", event: { type: "owner_gate_timeout" }, mode: "manual", counters: defaultCounters() }), "rule-31-owner-gate-timeout");
  // Row 32
  check(resolveTransition({ route: "fix", node: "code", status: "running", event: { type: "code_route_violation", reason: "diff too large" }, mode: "auto", counters: defaultCounters() }), "rule-32-code-route-violation");
  // Row 33
  check(resolveTransition({ route: "feature", node: "code", status: "running", event: { type: "code_delivered", resultSha: "sha1", commits: 1 }, mode: "auto", counters: defaultCounters() }), "rule-33-code-delivered-ok");
  // Row 34
  check(resolveTransition({ route: "feature", node: "code", status: "running", event: { type: "code_delivered", resultSha: "sha1", commits: 1, acceptanceTampered: true }, mode: "auto", counters: { ...defaultCounters(), code_attempts: 2 } }), "rule-34-code-acceptance-tampered");
  // Row 35
  check(resolveTransition({ route: "feature", node: "code", status: "running", event: { type: "code_delivered", resultSha: "sha1", commits: 0 }, mode: "auto", counters: { ...defaultCounters(), code_attempts: 0 } }), "rule-35-code-no-commits");
  // Row 36
  check(resolveTransition({ route: "feature", node: "code", status: "running", event: { type: "code_failed", exhausted: true }, mode: "auto", counters: defaultCounters() }), "rule-36-code-failed");
  // Row 37
  check(resolveTransition({ route: "feature", node: "code", status: "running", event: { type: "code_question_or_no_report" }, mode: "auto", counters: defaultCounters() }), "rule-37-code-question");
  // Row 38
  check(resolveTransition({ route: "feature", node: "code", status: "running", event: { type: "code_reject", reason: "r" }, mode: "auto", counters: defaultCounters() }), "rule-38-code-reject");
  // Row 39
  check(resolveTransition({ route: "feature", node: "checks", status: "running", event: { type: "checks_result", exitCode: 0 }, mode: "auto", counters: defaultCounters() }), "rule-39-checks-passed");
  // Row 40
  check(resolveTransition({ route: "feature", node: "checks", status: "running", event: { type: "checks_result", exitCode: 1 }, mode: "auto", counters: { ...defaultCounters(), check_attempts: 1 } }), "rule-40-checks-failed-loop");
  // Row 41
  check(resolveTransition({ route: "feature", node: "checks", status: "running", event: { type: "checks_result", exitCode: 1 }, mode: "auto", counters: { ...defaultCounters(), check_attempts: 2 } }), "rule-41-checks-failed-blocked");
  // Row 42
  check(resolveTransition({ route: "feature", node: "checks", status: "running", event: { type: "checks_result", exitCode: 1, notRun: true }, mode: "auto", counters: defaultCounters() }), "rule-42-checks-not-run");
  // Row 43
  check(resolveTransition({ route: "feature", node: "review", status: "running", event: { type: "review_verdict", verdict: "OK" }, mode: "auto", counters: defaultCounters() }), "rule-43-feature-review-ok");
  // Row 44
  check(resolveTransition({ route: "fix", node: "review", status: "running", event: { type: "review_verdict", verdict: "OK" }, mode: "manual", counters: defaultCounters() }), "rule-44-fix-simple-review-ok-manual");
  // Row 45
  check(resolveTransition({ route: "fix", node: "review", status: "running", event: { type: "review_verdict", verdict: "OK" }, mode: "auto", counters: defaultCounters() }), "rule-45-fix-simple-review-ok-auto");
  // Row 46
  check(resolveTransition({ route: "feature", node: "review", status: "running", event: { type: "review_verdict", verdict: "CHANGES" }, mode: "auto", counters: { ...defaultCounters(), code_review_rounds: 0 } }), "rule-46-review-changes-loop");
  // Row 47
  check(resolveTransition({ route: "feature", node: "review", status: "running", event: { type: "review_verdict", verdict: "CHANGES" }, mode: "auto", counters: { ...defaultCounters(), code_review_rounds: 2 } }), "rule-47-review-changes-blocked");
  // Row 48
  check(resolveTransition({ route: "feature", node: "review", status: "running", event: { type: "review_failed", exhausted: true }, mode: "auto", counters: defaultCounters() }), "rule-48-review-failed");
  // Row 49
  check(resolveTransition({ route: "feature", node: "review", status: "running", event: { type: "review_question_or_no_verdict" }, mode: "auto", counters: defaultCounters() }), "rule-49-review-question");
  // Row 50
  check(resolveTransition({ route: "feature", node: "design_check", status: "running", event: { type: "design_check_verdict", verdict: "OK" }, mode: "manual", counters: defaultCounters() }), "rule-50-feature-design-check-ok-manual");
  // Row 51
  check(resolveTransition({ route: "feature", node: "design_check", status: "running", event: { type: "design_check_verdict", verdict: "OK" }, mode: "auto", counters: defaultCounters() }), "rule-51-feature-design-check-ok-auto");
  // Row 52
  check(resolveTransition({ route: "feature", node: "design_check", status: "running", event: { type: "design_check_verdict", verdict: "CHANGES", target: "code" }, mode: "auto", counters: { ...defaultCounters(), design_check_rounds: 0 } }), "rule-52-feature-design-check-changes-code");
  // Row 53
  check(resolveTransition({ route: "feature", node: "design_check", status: "running", event: { type: "design_check_verdict", verdict: "CHANGES", target: "design" }, mode: "auto", counters: { ...defaultCounters(), design_check_rounds: 0 } }), "rule-53-feature-design-check-changes-design");
  // Row 54
  check(resolveTransition({ route: "feature", node: "design_check", status: "running", event: { type: "design_check_verdict", verdict: "CHANGES" }, mode: "auto", counters: { ...defaultCounters(), design_check_rounds: 2 } }), "rule-54-feature-design-check-changes-blocked");
  // Row 55
  check(resolveTransition({ route: "feature", node: "design_check", status: "running", event: { type: "design_check_failed", exhausted: true }, mode: "auto", counters: defaultCounters() }), "rule-55-feature-design-check-failed");
  // Row 56
  check(resolveTransition({ route: "feature", node: "design_check", status: "running", event: { type: "design_check_question_or_no_verdict" }, mode: "auto", counters: defaultCounters() }), "rule-56-feature-design-check-question");
  // Row 57
  check(resolveTransition({ route: "feature", node: "release", status: "running", event: { type: "release_published", prMode: false }, mode: "auto", counters: defaultCounters() }), "rule-57-release-published-push");
  // Row 58
  check(resolveTransition({ route: "feature", node: "release", status: "running", event: { type: "release_published", prMode: true }, mode: "auto", counters: defaultCounters() }), "rule-58-release-published-pr");
  // Row 59
  check(resolveTransition({ route: "feature", node: "release", status: "pr_open", event: { type: "pr_merged" }, mode: "auto", counters: defaultCounters() }), "rule-59-release-pr-merged");
  // Row 60
  check(resolveTransition({ route: "feature", node: "release", status: "pr_open", event: { type: "pr_changes_requested" }, mode: "auto", counters: defaultCounters() }), "rule-60-release-pr-changes-requested-code");
  // Row 61
  check(resolveTransition({ route: "docs", node: "release", status: "pr_open", event: { type: "pr_changes_requested" }, mode: "auto", counters: defaultCounters() }), "rule-61-release-pr-changes-requested-docs");
  // Row 62
  check(resolveTransition({ route: "feature", node: "release", status: "pr_open", event: { type: "pr_closed" }, mode: "auto", counters: defaultCounters() }), "rule-62-release-pr-closed");
  // Row 63
  check(resolveTransition({ route: "feature", node: "release", status: "stalled", event: { type: "resume", target: "code", prClosedReason: true, isOwner: true }, mode: "auto", counters: defaultCounters() }), "rule-63-release-resume-pr-closed-code");
  // Row 64
  check(resolveTransition({ route: "docs", node: "release", status: "stalled", event: { type: "resume", target: "spec", prClosedReason: true, isOwner: true }, mode: "auto", counters: defaultCounters() }), "rule-64-release-resume-pr-closed-docs");
  // Row 65
  check(resolveTransition({ route: "feature", node: "release", status: "running", event: { type: "release_refused_kb" }, mode: "auto", counters: defaultCounters() }), "rule-65-release-refused-uncommitted-kb");
  // Row 66
  check(resolveTransition({ route: "feature", node: "release", status: "running", event: { type: "release_refused_ui" }, mode: "auto", counters: defaultCounters() }), "rule-66-release-refused-unmerged-ui");
  // Row 67
  check(resolveTransition({ route: "feature", node: "release", status: "running", event: { type: "release_waiting_note" }, mode: "auto", counters: defaultCounters() }), "rule-67-release-waiting-note");
  // Row 68
  check(resolveTransition({ route: "feature", node: "release", status: "running", event: { type: "release_failed_checks_conflict_reject", reason: "conflict" }, mode: "auto", counters: { ...defaultCounters(), release_attempts: 1 } }), "rule-68-release-failed-code-loop");
  // Row 69
  check(resolveTransition({ route: "feature", node: "release", status: "running", event: { type: "release_failed_checks_conflict_reject", reason: "conflict" }, mode: "auto", counters: { ...defaultCounters(), release_attempts: 2 } }), "rule-69-release-failed-code-blocked");
  // Row 70
  check(resolveTransition({ route: "docs", node: "release", status: "running", event: { type: "release_failed_checks_conflict_reject", reason: "conflict" }, mode: "auto", counters: { ...defaultCounters(), release_attempts: 1 } }), "rule-70-release-failed-docs-loop");
  // Row 71
  check(resolveTransition({ route: "docs", node: "release", status: "running", event: { type: "release_failed_checks_conflict_reject", reason: "conflict" }, mode: "auto", counters: { ...defaultCounters(), release_attempts: 2 } }), "rule-71-release-failed-docs-blocked");
  // Row 72
  check(resolveTransition({ route: "feature", node: "release", status: "running", event: { type: "release_failed_script", reason: "crash" }, mode: "auto", counters: defaultCounters() }), "rule-72-release-failed-script");
  // Row 73
  check(resolveTransition({ route: "feature", node: "release", status: "waiting_release_note", event: { type: "release_note_provided", note: "v1" }, mode: "auto", counters: defaultCounters() }), "rule-73-release-note-provided");
  // Row 74
  check(resolveTransition({ route: "feature", node: "code", status: "stalled", event: { type: "resume" }, mode: "auto", counters: defaultCounters() }), "rule-74-resume-stalled");
  // Row 75
  check(resolveTransition({ route: "feature", node: "code", status: "running", event: { type: "dequeue", isOwner: true, reason: "stop" }, mode: "auto", counters: defaultCounters() }), "rule-75-dequeue");
  // Row 76
  check(resolveTransition({ route: "feature", node: "review", status: "blocked", event: { type: "resume", target: "code", isOwner: true }, mode: "auto", counters: defaultCounters() }), "rule-76-resume-blocked");
  // Row 77
  check(resolveTransition({ route: "feature", node: "owner_gate", status: "deferred", event: { type: "resume", isOwner: true }, mode: "manual", counters: defaultCounters() }), "rule-77-resume-deferred");
  // Row 78
  check(resolveTransition({ route: "research", node: "research", status: "running", event: { type: "research_delivered", report: "done" }, mode: "manual", counters: defaultCounters() }), "rule-78-research-delivered");
  // Row 79
  check(resolveTransition({ route: "research", node: "research", status: "running", event: { type: "research_failed", exhausted: true }, mode: "manual", counters: defaultCounters() }), "rule-79-research-failed");
  // Row 80
  check(resolveTransition({ route: "research", node: "research", status: "running", event: { type: "research_question_or_no_report" }, mode: "manual", counters: defaultCounters() }), "rule-80-research-question");
  // Row 81
  check(resolveTransition({ route: "feature", node: "spec_review", status: "running", event: { type: "acceptance_vacuous" }, mode: "auto", counters: defaultCounters() }), "rule-81-acceptance-vacuous-feature");
  // Row 82
  check(resolveTransition({ route: "fix", node: "start", status: "queued", event: { type: "acceptance_vacuous" }, mode: "auto", counters: defaultCounters() }), "rule-82-acceptance-vacuous-fix-simple");

  assert.equal(exercisedRuleIds.size, 82, `all 82 rules must be exercised, exercised count: ${exercisedRuleIds.size}`);
  for (const id of allRuleIds) {
    assert.ok(exercisedRuleIds.has(id), `rule ${id} must be exercised`);
  }
});
