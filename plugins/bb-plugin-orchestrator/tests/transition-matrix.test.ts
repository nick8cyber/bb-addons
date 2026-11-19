import test from "node:test";
import assert from "node:assert/strict";
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

test("TRANSITION_TABLE contains exactly 73 rules matching §28.1 matrix", () => {
  assert.equal(TRANSITION_TABLE.length, 73);
  const ids = new Set<string>();
  const rowNumbers = new Set<number>();
  for (const rule of TRANSITION_TABLE) {
    assert.ok(rule.id, "rule must have an id");
    assert.ok(rule.rowNumber >= 1 && rule.rowNumber <= 73, "valid rowNumber");
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

  const resReissue = resolveTransition({
    route: "feature",
    node: "design",
    status: "running",
    event: { type: "design_failed", exhausted: false },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resReissue.toStatus, "running");
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
});

test("Row 12: feature | spec | acceptance contract modified -> retry or blocked", () => {
  const resRetry = resolveTransition({
    route: "feature",
    node: "spec",
    status: "running",
    event: { type: "spec_delivered", specSha: "sha1", acceptanceTampered: true },
    mode: "manual",
    counters: { ...defaultCounters(), spec_attempts: 1 },
  });
  assert.equal(resRetry.toStatus, "running");
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
  assert.equal(resBlocked.counterUpdates?.spec_attempts, 3);
  assert.equal(resBlocked.action?.escalateArchitect, true);
});

test("Row 13: feature/docs | spec | spec_failed -> running or stalled", () => {
  const res = resolveTransition({
    route: "feature",
    node: "spec",
    status: "running",
    event: { type: "spec_failed", exhausted: true },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(res.toStatus, "stalled");
});

test("Row 14: feature/docs | spec | filesOutsideDocs -> retry or blocked", () => {
  const res = resolveTransition({
    route: "feature",
    node: "spec",
    status: "running",
    event: { type: "spec_delivered", specSha: "sha1", filesOutsideDocs: true },
    mode: "manual",
    counters: { ...defaultCounters(), spec_attempts: 2 },
  });
  assert.equal(res.toStatus, "blocked");
  assert.equal(res.counterUpdates?.spec_attempts, 3);
});

test("Row 15: feature/docs | spec_review | OK manual mode -> owner_gate (waiting_approval)", () => {
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
});

test("Row 16: feature | spec_review | OK auto mode -> code (running)", () => {
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
});

test("Row 17: docs | spec_review | OK auto mode -> release (running)", () => {
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
});

test("Row 18 & 19: spec_review | CHANGES loop (<3 rounds) and blocked (>=3 rounds)", () => {
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
  assert.equal(resBlocked.counterUpdates?.spec_review_rounds, 3);
  assert.equal(resBlocked.action?.escalateArchitect, true);
});

test("Row 20 & 21: spec_review | failed or question", () => {
  const resFailed = resolveTransition({
    route: "feature",
    node: "spec_review",
    status: "running",
    event: { type: "spec_review_failed", exhausted: true },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resFailed.toStatus, "stalled");

  const resQ = resolveTransition({
    route: "feature",
    node: "spec_review",
    status: "running",
    event: { type: "spec_review_question_or_no_verdict" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resQ.toStatus, "running");
});

test("Row 22: owner_gate | approve -> code or release (rejects non-owner)", () => {
  const resDeny = resolveTransition({
    route: "feature",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_approve", isOwner: false },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resDeny.allowed, false);
  assert.equal(resDeny.errorCode, "permission-denied");

  const resFeature = resolveTransition({
    route: "feature",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_approve", isOwner: true },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resFeature.toNode, "code");
  assert.equal(resFeature.toStatus, "running");

  const resDocs = resolveTransition({
    route: "docs",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_approve", isOwner: true },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resDocs.toNode, "release");
  assert.equal(resDocs.toStatus, "running");
});

test("Row 23 & 24: owner_gate | reject (feature/docs -> spec/design; fix/simple -> deferred)", () => {
  const resFeat = resolveTransition({
    route: "feature",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_reject", isOwner: true, target: "design", reason: "redesign" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resFeat.toNode, "design");
  assert.equal(resFeat.toStatus, "running");

  const resFix = resolveTransition({
    route: "fix",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_reject", isOwner: true, reason: "wait" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resFix.toNode, "owner_gate");
  assert.equal(resFix.toStatus, "deferred");
});

test("Row 25 & 26 & 27: owner_gate | update acceptance, defer, timeout", () => {
  const resUpdate = resolveTransition({
    route: "fix",
    node: "owner_gate",
    status: "deferred",
    event: { type: "owner_enqueue_acceptance", isOwner: true, acceptanceText: "new text" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resUpdate.toStatus, "waiting_approval");

  const resDefer = resolveTransition({
    route: "feature",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_defer", isOwner: true },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resDefer.toStatus, "deferred");

  const resTimeout = resolveTransition({
    route: "feature",
    node: "owner_gate",
    status: "waiting_approval",
    event: { type: "owner_gate_timeout" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resTimeout.toStatus, "waiting_approval");
});

test("Row 28, 29, 30: code | delivered OK, acceptance tampered, no commits", () => {
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
  assert.equal(resNoCommits.counterUpdates?.code_attempts, 2);
});

test("Row 31, 32, 33: code | failed, question, code_reject", () => {
  const resFail = resolveTransition({
    route: "feature",
    node: "code",
    status: "running",
    event: { type: "code_failed", exhausted: true },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resFail.toStatus, "stalled");

  const resQ = resolveTransition({
    route: "feature",
    node: "code",
    status: "running",
    event: { type: "code_question_or_no_report" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resQ.toStatus, "running");

  const resRej = resolveTransition({
    route: "feature",
    node: "code",
    status: "running",
    event: { type: "code_reject", reason: "fix bug" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resRej.toStatus, "running");
});

test("Row 34, 35, 36, 37: checks | exit 0, exit != 0 loop, exit != 0 blocked, not_run", () => {
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
});

test("Row 38, 39, 40, 41, 42, 43: review | OK feature -> design_check, OK fix -> release, CHANGES loop/blocked", () => {
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

  const resFix = resolveTransition({
    route: "fix",
    node: "review",
    status: "running",
    event: { type: "review_verdict", verdict: "OK" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resFix.toNode, "release");
  assert.equal(resFix.toStatus, "running");

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
  assert.equal(resBlocked.counterUpdates?.code_review_rounds, 3);
});

test("Row 44, 45, 46, 47, 48, 49: design_check | OK -> release, CHANGES target code / design, blocked", () => {
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

  const resCode = resolveTransition({
    route: "feature",
    node: "design_check",
    status: "running",
    event: { type: "design_check_verdict", verdict: "CHANGES", target: "code" },
    mode: "auto",
    counters: { ...defaultCounters(), design_check_rounds: 0 },
  });
  assert.equal(resCode.toNode, "code");
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
  assert.equal(resBlocked.counterUpdates?.design_check_rounds, 3);
});

test("Row 50 to 55: release | published push, published PR, pr_merged, pr_changes_requested, pr_closed", () => {
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

  const resMerged = resolveTransition({
    route: "feature",
    node: "release",
    status: "pr_open",
    event: { type: "pr_merged" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resMerged.toStatus, "done");

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
});

test("Row 56 & 57: release | resume from pr_closed (code or spec)", () => {
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
});

test("Row 58, 59, 60: release | refused KB, refused UI, waiting note", () => {
  const resKb = resolveTransition({
    route: "feature",
    node: "release",
    status: "running",
    event: { type: "release_refused_kb" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resKb.toStatus, "stalled");

  const resUi = resolveTransition({
    route: "feature",
    node: "release",
    status: "running",
    event: { type: "release_refused_ui" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resUi.toStatus, "stalled");

  const resNote = resolveTransition({
    route: "feature",
    node: "release",
    status: "running",
    event: { type: "release_waiting_note" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resNote.toStatus, "waiting_release_note");
});

test("Row 61, 62, 63, 64: release failures (code/docs loop & blocked)", () => {
  const resCodeLoop = resolveTransition({
    route: "feature",
    node: "release",
    status: "running",
    event: { type: "release_failed_checks_conflict_reject", reason: "conflict" },
    mode: "auto",
    counters: { ...defaultCounters(), release_attempts: 1 },
  });
  assert.equal(resCodeLoop.toNode, "code");
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
  assert.equal(resDocsBlocked.counterUpdates?.release_attempts, 3);
});

test("Row 65 & 66: release script failure & release note provided", () => {
  const resFail = resolveTransition({
    route: "feature",
    node: "release",
    status: "running",
    event: { type: "release_failed_script", reason: "crash" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resFail.toStatus, "stalled");

  const resNote = resolveTransition({
    route: "feature",
    node: "release",
    status: "waiting_release_note",
    event: { type: "release_note_provided", note: "v1.0.0" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resNote.toStatus, "running");
});

test("Row 67 & 68: resume stalled (no target) & dequeue", () => {
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

  const resDeq = resolveTransition({
    route: "feature",
    node: "code",
    status: "running",
    event: { type: "dequeue", isOwner: true, reason: "cancelled by user" },
    mode: "auto",
    counters: defaultCounters(),
  });
  assert.equal(resDeq.toStatus, "cancelled");
  assert.equal(resDeq.action?.archiveBranch, true);
});

test("Row 69 & 70: resume blocked & resume deferred", () => {
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
});

test("Row 71, 72, 73: research delivered, failed, question", () => {
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

  const resFailed = resolveTransition({
    route: "research",
    node: "research",
    status: "running",
    event: { type: "research_failed", exhausted: true },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resFailed.toStatus, "stalled");

  const resQ = resolveTransition({
    route: "research",
    node: "research",
    status: "running",
    event: { type: "research_question_or_no_report" },
    mode: "manual",
    counters: defaultCounters(),
  });
  assert.equal(resQ.toStatus, "running");
});
