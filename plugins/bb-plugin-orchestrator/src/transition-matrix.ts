import { OrchestratorError } from "./errors.js";

export type TaskRoute = "feature" | "fix" | "simple" | "docs" | "research";

export type TaskNode =
  | "start"
  | "design"
  | "spec"
  | "spec_review"
  | "owner_gate"
  | "code"
  | "checks"
  | "review"
  | "design_check"
  | "release"
  | "research";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_release_note"
  | "pr_open"
  | "deferred"
  | "blocked"
  | "stalled"
  | "done"
  | "cancelled";

export type ConfirmationMode = "auto" | "manual";

export interface TransitionCounters {
  spec_attempts: number;
  spec_review_rounds: number;
  code_attempts: number;
  check_attempts: number;
  code_review_rounds: number;
  design_check_rounds: number;
  release_attempts: number;
}

export type TransitionEvent =
  | {
      type: "queue_take";
      branchExistsWithCommits?: boolean;
      acceptanceText?: string | null;
    }
  | {
      type: "design_delivered";
      acceptanceText?: string | null;
    }
  | {
      type: "design_failed";
      exhausted?: boolean;
      reason?: string;
    }
  | {
      type: "design_question_or_no_report";
    }
  | {
      type: "spec_delivered";
      specSha: string;
      acceptanceTampered?: boolean;
      filesOutsideDocs?: boolean;
    }
  | {
      type: "spec_failed";
      exhausted?: boolean;
      reason?: string;
    }
  | {
      type: "spec_question_or_no_report";
    }
  | {
      type: "spec_review_verdict";
      verdict: "OK" | "CHANGES";
      blockers?: number;
    }
  | {
      type: "spec_review_failed";
      exhausted?: boolean;
      reason?: string;
    }
  | {
      type: "spec_review_question_or_no_verdict";
    }
  | {
      type: "owner_approve";
      isOwner?: boolean;
      comment?: string;
    }
  | {
      type: "owner_reject";
      isOwner?: boolean;
      target?: TaskNode;
      reason: string;
    }
  | {
      type: "owner_enqueue_acceptance";
      isOwner?: boolean;
      acceptanceText: string;
    }
  | {
      type: "owner_defer";
      isOwner?: boolean;
      reason?: string;
    }
  | {
      type: "owner_gate_timeout";
    }
  | {
      type: "code_delivered";
      resultSha: string;
      commits: number;
      noCode?: boolean;
      acceptanceTampered?: boolean;
    }
  | {
      type: "code_failed";
      exhausted?: boolean;
      reason?: string;
    }
  | {
      type: "code_question_or_no_report";
    }
  | {
      type: "code_reject";
      reason: string;
      isOwnerOrCoordinator?: boolean;
    }
  | {
      type: "checks_result";
      exitCode: number;
      notRun?: boolean;
      output?: string;
    }
  | {
      type: "review_verdict";
      verdict: "OK" | "CHANGES";
      blockers?: number;
    }
  | {
      type: "review_failed";
      exhausted?: boolean;
      reason?: string;
    }
  | {
      type: "review_question_or_no_verdict";
    }
  | {
      type: "design_check_verdict";
      verdict: "OK" | "CHANGES";
      blockers?: number;
      target?: "code" | "design";
    }
  | {
      type: "design_check_failed";
      exhausted?: boolean;
      reason?: string;
    }
  | {
      type: "design_check_question_or_no_verdict";
    }
  | {
      type: "release_published";
      prMode?: boolean;
    }
  | {
      type: "pr_merged";
    }
  | {
      type: "pr_changes_requested";
    }
  | {
      type: "pr_closed";
    }
  | {
      type: "release_refused_kb";
    }
  | {
      type: "release_refused_ui";
    }
  | {
      type: "release_waiting_note";
    }
  | {
      type: "release_failed_checks_conflict_reject";
      reason?: string;
    }
  | {
      type: "release_failed_script";
      reason?: string;
    }
  | {
      type: "release_note_provided";
      note: string;
    }
  | {
      type: "resume";
      target?: TaskNode;
      isOwner?: boolean;
      reopen?: boolean;
      prClosedReason?: boolean;
    }
  | {
      type: "dequeue";
      isOwner?: boolean;
      reason?: string;
    }
  | {
      type: "research_delivered";
      report?: string;
    }
  | {
      type: "research_failed";
      exhausted?: boolean;
      reason?: string;
    }
  | {
      type: "research_question_or_no_report";
    };

export interface TransitionInput {
  route: TaskRoute;
  node: TaskNode;
  status: TaskStatus;
  event: TransitionEvent;
  mode: ConfirmationMode;
  counters: TransitionCounters;
}

export interface TransitionAction {
  createBranch?: boolean;
  commitAcceptance?: boolean;
  dispatchNode?: TaskNode;
  archiveBranch?: boolean;
  closePr?: boolean;
  escalateArchitect?: boolean;
  setPayload?: Record<string, unknown>;
  clearPayloadKeys?: string[];
}

export interface TransitionResolution {
  allowed: boolean;
  errorCode?: string;
  errorMessage?: string;
  toNode: TaskNode;
  toStatus: TaskStatus;
  reason: string;
  ruleId: string;
  counterUpdates?: Partial<TransitionCounters>;
  action?: TransitionAction;
}

export interface TransitionRule {
  readonly id: string;
  readonly rowNumber: number;
  readonly route: TaskRoute | readonly TaskRoute[] | "*";
  readonly node: TaskNode | readonly TaskNode[] | "*";
  readonly status: TaskStatus | readonly TaskStatus[] | "*";
  readonly eventType: string | readonly string[];
  readonly mode?: ConfirmationMode | "*";
  readonly description: string;
  readonly resolve: (input: TransitionInput) => TransitionResolution | null;
}

export function extractCounters(task: {
  spec_attempts?: number;
  spec_review_rounds?: number;
  code_attempts?: number;
  check_attempts?: number;
  code_review_rounds?: number;
  design_check_rounds?: number;
  release_attempts?: number;
}): TransitionCounters {
  return {
    spec_attempts: Number(task.spec_attempts) || 0,
    spec_review_rounds: Number(task.spec_review_rounds) || 0,
    code_attempts: Number(task.code_attempts) || 0,
    check_attempts: Number(task.check_attempts) || 0,
    code_review_rounds: Number(task.code_review_rounds) || 0,
    design_check_rounds: Number(task.design_check_rounds) || 0,
    release_attempts: Number(task.release_attempts) || 0,
  };
}

function matchesRoute(
  ruleRoute: TaskRoute | readonly TaskRoute[] | "*",
  route: TaskRoute,
): boolean {
  if (ruleRoute === "*") return true;
  if (Array.isArray(ruleRoute)) return ruleRoute.includes(route);
  return ruleRoute === route;
}

function matchesNode(
  ruleNode: TaskNode | readonly TaskNode[] | "*",
  node: TaskNode,
): boolean {
  if (ruleNode === "*") return true;
  if (Array.isArray(ruleNode)) return ruleNode.includes(node);
  return ruleNode === node;
}

function matchesStatus(
  ruleStatus: TaskStatus | readonly TaskStatus[] | "*",
  status: TaskStatus,
): boolean {
  if (ruleStatus === "*") return true;
  if (Array.isArray(ruleStatus)) return ruleStatus.includes(status);
  return ruleStatus === status;
}

function matchesMode(
  ruleMode: ConfirmationMode | "*" | undefined,
  mode: ConfirmationMode,
): boolean {
  if (!ruleMode || ruleMode === "*") return true;
  return ruleMode === mode;
}

function matchesEventType(
  ruleEventType: string | readonly string[],
  eventType: string,
): boolean {
  if (Array.isArray(ruleEventType)) return ruleEventType.includes(eventType);
  return ruleEventType === eventType;
}

// ─────────────────────────────────────────────────────────────────────────────
// §28.1 TRANSITION TABLE AS PURE DATA (73 rules matching spec §28.1 matrix)
// ─────────────────────────────────────────────────────────────────────────────

export const TRANSITION_TABLE: readonly TransitionRule[] = [
  // ── Row 1: feature | start | queue_take -> design (running)
  {
    id: "rule-01-feature-start-take",
    rowNumber: 1,
    route: "feature",
    node: "start",
    status: "queued",
    eventType: "queue_take",
    description: "feature взята из очереди -> design (running)",
    resolve(input) {
      if (input.event.type !== "queue_take" || input.event.branchExistsWithCommits)
        return null;
      return {
        allowed: true,
        toNode: "design",
        toStatus: "running",
        reason: "task taken from queue -> design (running)",
        ruleId: "rule-01-feature-start-take",
        action: { createBranch: true, dispatchNode: "design" },
      };
    },
  },

  // ── Row 2: docs | start | queue_take -> spec (running)
  {
    id: "rule-02-docs-start-take",
    rowNumber: 2,
    route: "docs",
    node: "start",
    status: "queued",
    eventType: "queue_take",
    description: "docs взята из очереди -> spec (running)",
    resolve(input) {
      if (input.event.type !== "queue_take" || input.event.branchExistsWithCommits)
        return null;
      return {
        allowed: true,
        toNode: "spec",
        toStatus: "running",
        reason: "task taken from queue -> spec (running)",
        ruleId: "rule-02-docs-start-take",
        action: { createBranch: true, dispatchNode: "spec" },
      };
    },
  },

  // ── Row 3: fix, simple | start | queue_take manual -> owner_gate (waiting_approval)
  {
    id: "rule-03-fix-simple-start-take-manual",
    rowNumber: 3,
    route: ["fix", "simple"],
    node: "start",
    status: "queued",
    eventType: "queue_take",
    mode: "manual",
    description: "fix/simple взята в manual -> owner_gate (waiting_approval)",
    resolve(input) {
      if (input.event.type !== "queue_take" || input.event.branchExistsWithCommits)
        return null;
      return {
        allowed: true,
        toNode: "owner_gate",
        toStatus: "waiting_approval",
        reason: "task taken from queue -> owner_gate (waiting_approval)",
        ruleId: "rule-03-fix-simple-start-take-manual",
        action: { createBranch: true, commitAcceptance: true },
      };
    },
  },

  // ── Row 4: fix, simple | start | queue_take auto -> code (running)
  {
    id: "rule-04-fix-simple-start-take-auto",
    rowNumber: 4,
    route: ["fix", "simple"],
    node: "start",
    status: "queued",
    eventType: "queue_take",
    mode: "auto",
    description: "fix/simple взята в auto -> code (running)",
    resolve(input) {
      if (input.event.type !== "queue_take" || input.event.branchExistsWithCommits)
        return null;
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: "task taken from queue -> code (running)",
        ruleId: "rule-04-fix-simple-start-take-auto",
        action: {
          createBranch: true,
          commitAcceptance: true,
          dispatchNode: "code",
        },
      };
    },
  },

  // ── Row 5: feature, fix, docs, simple | start | branch-exists with commits -> stalled
  {
    id: "rule-05-start-branch-exists-with-commits",
    rowNumber: 5,
    route: ["feature", "fix", "docs", "simple"],
    node: "start",
    status: "queued",
    eventType: "queue_take",
    description: "ветка уже существует с коммитами вне базы -> stalled",
    resolve(input) {
      if (input.event.type !== "queue_take" || !input.event.branchExistsWithCommits)
        return null;
      return {
        allowed: true,
        toNode: "start",
        toStatus: "stalled",
        reason:
          "stalled: branch-exists: ветка уже существует и содержит коммиты; проверь состояние ветки или выполни dequeue",
        ruleId: "rule-05-start-branch-exists-with-commits",
      };
    },
  },

  // ── Row 6: research | start | queue_take -> research (running)
  {
    id: "rule-06-research-start-take",
    rowNumber: 6,
    route: "research",
    node: "start",
    status: "queued",
    eventType: "queue_take",
    description: "research взята из очереди -> research (running)",
    resolve(input) {
      if (input.event.type !== "queue_take") return null;
      return {
        allowed: true,
        toNode: "research",
        toStatus: "running",
        reason: "task taken from queue -> research (running)",
        ruleId: "rule-06-research-start-take",
        action: { dispatchNode: "research" },
      };
    },
  },

  // ── Row 7: feature | design | design_delivered -> spec (running)
  {
    id: "rule-07-feature-design-delivered",
    rowNumber: 7,
    route: "feature",
    node: "design",
    status: "running",
    eventType: "design_delivered",
    description: "сдан договор приёмки и дизайн -> spec (running)",
    resolve(input) {
      if (input.event.type !== "design_delivered") return null;
      return {
        allowed: true,
        toNode: "spec",
        toStatus: "running",
        reason: "architect delivered acceptance contract -> spec",
        ruleId: "rule-07-feature-design-delivered",
        action: { commitAcceptance: true, dispatchNode: "spec" },
      };
    },
  },

  // ── Row 8: feature | design | design_failed -> running (reissue) or stalled
  {
    id: "rule-08-feature-design-failed",
    rowNumber: 8,
    route: "feature",
    node: "design",
    status: "running",
    eventType: "design_failed",
    description: "сбой/квота на design -> running (перевыпуск) или stalled",
    resolve(input) {
      if (input.event.type !== "design_failed") return null;
      const isStalled = input.event.exhausted ?? true;
      return {
        allowed: true,
        toNode: "design",
        toStatus: isStalled ? "stalled" : "running",
        reason: `delegation exhausted level chain: status=${input.event.reason ?? "failed"}`,
        ruleId: "rule-08-feature-design-failed",
      };
    },
  },

  // ── Row 9: feature | design | question / no report -> design running (nudge)
  {
    id: "rule-09-feature-design-question",
    rowNumber: 9,
    route: "feature",
    node: "design",
    status: "running",
    eventType: "design_question_or_no_report",
    description: "ход завершился вопросом без отчёта -> nudge на design",
    resolve(input) {
      if (input.event.type !== "design_question_or_no_report") return null;
      return {
        allowed: true,
        toNode: "design",
        toStatus: "running",
        reason: "question without report: stay in design, nudge",
        ruleId: "rule-09-feature-design-question",
      };
    },
  },

  // ── Row 10: feature | spec | spec_delivered (untampered) -> spec_review (running)
  {
    id: "rule-10-feature-spec-delivered",
    rowNumber: 10,
    route: "feature",
    node: "spec",
    status: "running",
    eventType: "spec_delivered",
    description: "сдан коммит спеки, договор не затронут -> spec_review",
    resolve(input) {
      if (
        input.event.type !== "spec_delivered" ||
        input.event.acceptanceTampered ||
        input.event.filesOutsideDocs
      )
        return null;
      return {
        allowed: true,
        toNode: "spec_review",
        toStatus: "running",
        reason: "spec commit delivered -> spec_review",
        ruleId: "rule-10-feature-spec-delivered",
        action: { dispatchNode: "spec_review" },
      };
    },
  },

  // ── Row 11: docs | spec | spec_delivered -> spec_review (running)
  {
    id: "rule-11-docs-spec-delivered",
    rowNumber: 11,
    route: "docs",
    node: "spec",
    status: "running",
    eventType: "spec_delivered",
    description: "сдан коммит документации -> spec_review",
    resolve(input) {
      if (input.event.type !== "spec_delivered" || input.event.filesOutsideDocs)
        return null;
      return {
        allowed: true,
        toNode: "spec_review",
        toStatus: "running",
        reason: "spec commit delivered -> spec_review",
        ruleId: "rule-11-docs-spec-delivered",
        action: { dispatchNode: "spec_review" },
      };
    },
  },

  // ── Row 12: feature | spec | acceptance contract modified -> running (attempts < 3) / blocked (attempts >= 3)
  {
    id: "rule-12-feature-spec-acceptance-modified",
    rowNumber: 12,
    route: "feature",
    node: "spec",
    status: "running",
    eventType: "spec_delivered",
    description: "договор приёмки изменён -> отказ захода (до 3 раз, затем blocked)",
    resolve(input) {
      if (input.event.type !== "spec_delivered" || !input.event.acceptanceTampered)
        return null;
      const nextAttempts = input.counters.spec_attempts + 1;
      const blocked = nextAttempts >= 3;
      return {
        allowed: true,
        toNode: "spec",
        toStatus: blocked ? "blocked" : "running",
        reason: blocked
          ? "spec-refused: acceptance-contract-modified (attempts limit reached: 3/3)"
          : `spec-refused: acceptance-contract-modified (attempt ${nextAttempts}/3)`,
        ruleId: "rule-12-feature-spec-acceptance-modified",
        counterUpdates: { spec_attempts: nextAttempts },
        action: blocked
          ? { escalateArchitect: true }
          : { dispatchNode: "spec" },
      };
    },
  },

  // ── Row 13: feature, docs | spec | spec_failed -> running (reissue) or stalled
  {
    id: "rule-13-spec-failed",
    rowNumber: 13,
    route: ["feature", "docs"],
    node: "spec",
    status: "running",
    eventType: "spec_failed",
    description: "сбой/квота на spec -> перевыпуск или stalled",
    resolve(input) {
      if (input.event.type !== "spec_failed") return null;
      const isStalled = input.event.exhausted ?? true;
      return {
        allowed: true,
        toNode: "spec",
        toStatus: isStalled ? "stalled" : "running",
        reason: `delegation exhausted level chain: status=${input.event.reason ?? "failed"}`,
        ruleId: "rule-13-spec-failed",
      };
    },
  },

  // ── Row 14: feature, docs | spec | files outside docs or question -> attempts increment
  {
    id: "rule-14-spec-files-outside-docs",
    rowNumber: 14,
    route: ["feature", "docs"],
    node: "spec",
    status: "running",
    eventType: ["spec_delivered", "spec_question_or_no_report"],
    description: "коммит затрагивает файлы вне docs или вопрос -> инкремент spec_attempts",
    resolve(input) {
      const isQuestion = input.event.type === "spec_question_or_no_report";
      const isFilesOutside =
        input.event.type === "spec_delivered" && Boolean(input.event.filesOutsideDocs);
      if (!isQuestion && !isFilesOutside) return null;
      const nextAttempts = input.counters.spec_attempts + 1;
      const blocked = nextAttempts >= 3;
      const reasonCode = isQuestion
        ? "spec-question-or-no-report"
        : "files-outside-docs";
      return {
        allowed: true,
        toNode: "spec",
        toStatus: blocked ? "blocked" : "running",
        reason: blocked
          ? `spec-refused: ${reasonCode} (attempts limit reached: 3/3)`
          : `spec-refused: ${reasonCode} (attempt ${nextAttempts}/3)`,
        ruleId: "rule-14-spec-files-outside-docs",
        counterUpdates: { spec_attempts: nextAttempts },
        action: blocked
          ? { escalateArchitect: true }
          : { dispatchNode: "spec" },
      };
    },
  },

  // ── Row 15: feature, docs | spec_review | verdict OK manual mode -> owner_gate (waiting_approval)
  {
    id: "rule-15-spec-review-ok-manual",
    rowNumber: 15,
    route: ["feature", "docs"],
    node: "spec_review",
    status: "running",
    eventType: "spec_review_verdict",
    mode: "manual",
    description: "вердикт OK в manual -> owner_gate (waiting_approval)",
    resolve(input) {
      if (
        input.event.type !== "spec_review_verdict" ||
        input.event.verdict !== "OK" ||
        (input.event.blockers && input.event.blockers > 0)
      )
        return null;
      return {
        allowed: true,
        toNode: "owner_gate",
        toStatus: "waiting_approval",
        reason: "spec review passed OK -> owner_gate (manual mode)",
        ruleId: "rule-15-spec-review-ok-manual",
      };
    },
  },

  // ── Row 16: feature | spec_review | verdict OK auto mode -> code (running)
  {
    id: "rule-16-feature-spec-review-ok-auto",
    rowNumber: 16,
    route: "feature",
    node: "spec_review",
    status: "running",
    eventType: "spec_review_verdict",
    mode: "auto",
    description: "вердикт OK для feature в auto -> code (running)",
    resolve(input) {
      if (
        input.event.type !== "spec_review_verdict" ||
        input.event.verdict !== "OK" ||
        (input.event.blockers && input.event.blockers > 0)
      )
        return null;
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: "spec review passed OK -> code (auto mode)",
        ruleId: "rule-16-feature-spec-review-ok-auto",
        action: { dispatchNode: "code" },
      };
    },
  },

  // ── Row 17: docs | spec_review | verdict OK auto mode -> release (running)
  {
    id: "rule-17-docs-spec-review-ok-auto",
    rowNumber: 17,
    route: "docs",
    node: "spec_review",
    status: "running",
    eventType: "spec_review_verdict",
    mode: "auto",
    description: "вердикт OK для docs в auto -> release (running)",
    resolve(input) {
      if (
        input.event.type !== "spec_review_verdict" ||
        input.event.verdict !== "OK" ||
        (input.event.blockers && input.event.blockers > 0)
      )
        return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "running",
        reason: "spec review passed OK -> release (auto mode)",
        ruleId: "rule-17-docs-spec-review-ok-auto",
      };
    },
  },

  // ── Row 18: feature, docs | spec_review | CHANGES round < 3 -> spec (running)
  {
    id: "rule-18-spec-review-changes-loop",
    rowNumber: 18,
    route: ["feature", "docs"],
    node: "spec_review",
    status: "running",
    eventType: "spec_review_verdict",
    description: "замечания ревью спеки раунд < 3 -> spec (running)",
    resolve(input) {
      if (input.event.type !== "spec_review_verdict") return null;
      const isChanges =
        input.event.verdict === "CHANGES" ||
        (input.event.blockers && input.event.blockers > 0);
      if (!isChanges) return null;
      const nextRounds = input.counters.spec_review_rounds + 1;
      if (nextRounds >= 3) return null; // handled by row 19
      return {
        allowed: true,
        toNode: "spec",
        toStatus: "running",
        reason: `spec review requested changes (round ${nextRounds}/3: return to spec)`,
        ruleId: "rule-18-spec-review-changes-loop",
        counterUpdates: { spec_review_rounds: nextRounds },
        action: { dispatchNode: "spec" },
      };
    },
  },

  // ── Row 19: feature, docs | spec_review | CHANGES round >= 3 -> spec_review (blocked)
  {
    id: "rule-19-spec-review-changes-blocked",
    rowNumber: 19,
    route: ["feature", "docs"],
    node: "spec_review",
    status: "running",
    eventType: "spec_review_verdict",
    description: "замечания ревью спеки раунд >= 3 -> spec_review (blocked)",
    resolve(input) {
      if (input.event.type !== "spec_review_verdict") return null;
      const isChanges =
        input.event.verdict === "CHANGES" ||
        (input.event.blockers && input.event.blockers > 0);
      if (!isChanges) return null;
      const nextRounds = input.counters.spec_review_rounds + 1;
      if (nextRounds < 3) return null; // handled by row 18
      return {
        allowed: true,
        toNode: "spec_review",
        toStatus: "blocked",
        reason: `spec review requested changes (round limit reached: ${nextRounds}/3)`,
        ruleId: "rule-19-spec-review-changes-blocked",
        counterUpdates: { spec_review_rounds: nextRounds },
        action: { escalateArchitect: true },
      };
    },
  },

  // ── Row 20: feature, docs | spec_review | spec_review_failed -> running/stalled
  {
    id: "rule-20-spec-review-failed",
    rowNumber: 20,
    route: ["feature", "docs"],
    node: "spec_review",
    status: "running",
    eventType: "spec_review_failed",
    description: "сбой/квота ревьюера спеки -> перевыпуск или stalled",
    resolve(input) {
      if (input.event.type !== "spec_review_failed") return null;
      const isStalled = input.event.exhausted ?? true;
      return {
        allowed: true,
        toNode: "spec_review",
        toStatus: isStalled ? "stalled" : "running",
        reason: `delegation exhausted level chain: status=${input.event.reason ?? "failed"}`,
        ruleId: "rule-20-spec-review-failed",
      };
    },
  },

  // ── Row 21: feature, docs | spec_review | question / no verdict -> running (nudge)
  {
    id: "rule-21-spec-review-question",
    rowNumber: 21,
    route: ["feature", "docs"],
    node: "spec_review",
    status: "running",
    eventType: "spec_review_question_or_no_verdict",
    description: "ход без JSON-вердикта -> повторный nudge ревьюеру",
    resolve(input) {
      if (input.event.type !== "spec_review_question_or_no_verdict") return null;
      return {
        allowed: true,
        toNode: "spec_review",
        toStatus: "running",
        reason: "question without verdict: stay in spec_review, nudge",
        ruleId: "rule-21-spec-review-question",
      };
    },
  },

  // ── Row 22: feature, fix, simple, docs | owner_gate | approve -> code or release
  {
    id: "rule-22-owner-gate-approve",
    rowNumber: 22,
    route: ["feature", "fix", "simple", "docs"],
    node: "owner_gate",
    status: "waiting_approval",
    eventType: "owner_approve",
    description: "одобрено владельцем -> code (feature/fix/simple) или release (docs)",
    resolve(input) {
      if (input.event.type !== "owner_approve") return null;
      if (input.event.isOwner === false) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: owner-only",
          toNode: "owner_gate",
          toStatus: "waiting_approval",
          reason: "permission-denied: owner-only",
          ruleId: "rule-22-owner-gate-approve",
        };
      }
      const toNode: TaskNode = input.route === "docs" ? "release" : "code";
      return {
        allowed: true,
        toNode,
        toStatus: "running",
        reason: input.event.comment || "approved",
        ruleId: "rule-22-owner-gate-approve",
        action: { dispatchNode: toNode },
      };
    },
  },

  // ── Row 23: feature, docs | owner_gate | reject -> spec or design
  {
    id: "rule-23-feature-docs-owner-gate-reject",
    rowNumber: 23,
    route: ["feature", "docs"],
    node: "owner_gate",
    status: "waiting_approval",
    eventType: "owner_reject",
    description: "возврат владельцем feature (spec/design) или docs (spec) -> running",
    resolve(input) {
      if (input.event.type !== "owner_reject") return null;
      if (input.event.isOwner === false) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: owner-only",
          toNode: "owner_gate",
          toStatus: "waiting_approval",
          reason: "permission-denied: owner-only",
          ruleId: "rule-23-feature-docs-owner-gate-reject",
        };
      }
      const target = input.event.target ?? "spec";
      if (input.route === "feature") {
        if (target !== "spec" && target !== "design") {
          return {
            allowed: false,
            errorCode: "target-invalid",
            errorMessage: `недопустимая цель ${target} для маршрута feature (разрешены: spec, design)`,
            toNode: "owner_gate",
            toStatus: "waiting_approval",
            reason: "target-invalid",
            ruleId: "rule-23-feature-docs-owner-gate-reject",
          };
        }
      } else if (input.route === "docs") {
        if (target !== "spec") {
          return {
            allowed: false,
            errorCode: "target-invalid",
            errorMessage: `недопустимая цель ${target} для маршрута docs (разрешено только: spec)`,
            toNode: "owner_gate",
            toStatus: "waiting_approval",
            reason: "target-invalid",
            ruleId: "rule-23-feature-docs-owner-gate-reject",
          };
        }
      }
      return {
        allowed: true,
        toNode: target,
        toStatus: "running",
        reason: input.event.reason || "rejected",
        ruleId: "rule-23-feature-docs-owner-gate-reject",
        action: { dispatchNode: target },
      };
    },
  },

  // ── Row 24: fix, simple | owner_gate | reject -> owner_gate (deferred)
  {
    id: "rule-24-fix-simple-owner-gate-reject",
    rowNumber: 24,
    route: ["fix", "simple"],
    node: "owner_gate",
    status: "waiting_approval",
    eventType: "owner_reject",
    description: "возврат владельцем fix/simple -> owner_gate (deferred)",
    resolve(input) {
      if (input.event.type !== "owner_reject") return null;
      if (input.event.isOwner === false) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: owner-only",
          toNode: "owner_gate",
          toStatus: "waiting_approval",
          reason: "permission-denied: owner-only",
          ruleId: "rule-24-fix-simple-owner-gate-reject",
        };
      }
      if (input.event.target !== undefined) {
        return {
          allowed: false,
          errorCode: "target-invalid",
          errorMessage: "для маршрутов fix и simple цель --target не поддерживается",
          toNode: "owner_gate",
          toStatus: "waiting_approval",
          reason: "target-invalid",
          ruleId: "rule-24-fix-simple-owner-gate-reject",
        };
      }
      return {
        allowed: true,
        toNode: "owner_gate",
        toStatus: "deferred",
        reason: input.event.reason || "rejected at owner_gate",
        ruleId: "rule-24-fix-simple-owner-gate-reject",
        action: {
          setPayload: { deferred_by: "owner", deferred_reason: input.event.reason },
        },
      };
    },
  },

  // ── Row 25: fix, simple | owner_gate | update acceptance -> waiting_approval
  {
    id: "rule-25-fix-simple-owner-gate-update-acceptance",
    rowNumber: 25,
    route: ["fix", "simple"],
    node: "owner_gate",
    status: ["waiting_approval", "deferred"],
    eventType: "owner_enqueue_acceptance",
    description: "обновление договора владельцем -> waiting_approval",
    resolve(input) {
      if (input.event.type !== "owner_enqueue_acceptance") return null;
      if (input.event.isOwner === false) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: owner-only",
          toNode: "owner_gate",
          toStatus: input.status,
          reason: "permission-denied: owner-only",
          ruleId: "rule-25-fix-simple-owner-gate-update-acceptance",
        };
      }
      return {
        allowed: true,
        toNode: "owner_gate",
        toStatus: "waiting_approval",
        reason: "acceptance contract updated by owner",
        ruleId: "rule-25-fix-simple-owner-gate-update-acceptance",
        action: { commitAcceptance: true },
      };
    },
  },

  // ── Row 26: * | any node | defer -> deferred
  {
    id: "rule-26-owner-gate-defer",
    rowNumber: 26,
    route: "*",
    node: "*",
    status: "*",
    eventType: "owner_defer",
    description: "отложено владельцем -> deferred",
    resolve(input) {
      if (input.event.type !== "owner_defer") return null;
      if (input.status === "done" || input.status === "cancelled") {
        return {
          allowed: false,
          errorCode: "invalid-status",
          errorMessage: `task is already finished (${input.status})`,
          toNode: input.node,
          toStatus: input.status,
          reason: "invalid-status",
          ruleId: "rule-26-owner-gate-defer",
        };
      }
      if (input.status === "deferred") {
        return {
          allowed: false,
          errorCode: "invalid-status",
          errorMessage: "task is already deferred (status=deferred)",
          toNode: input.node,
          toStatus: input.status,
          reason: "invalid-status",
          ruleId: "rule-26-owner-gate-defer",
        };
      }
      if (input.event.isOwner === false) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: owner-only",
          toNode: input.node,
          toStatus: input.status,
          reason: "permission-denied: owner-only",
          ruleId: "rule-26-owner-gate-defer",
        };
      }
      return {
        allowed: true,
        toNode: input.node,
        toStatus: "deferred",
        reason: input.event.reason || "deferred by owner",
        ruleId: "rule-26-owner-gate-defer",
        action: {
          setPayload: { deferred_by: "owner", deferred_reason: input.event.reason },
        },
      };
    },
  },

  // ── Row 27: feature, fix, simple, docs | owner_gate | timeout -> waiting_approval
  {
    id: "rule-27-owner-gate-timeout",
    rowNumber: 27,
    route: ["feature", "fix", "simple", "docs"],
    node: "owner_gate",
    status: "waiting_approval",
    eventType: "owner_gate_timeout",
    description: "таймаут карточки одобрения -> waiting_approval (перевыпуск)",
    resolve(input) {
      if (input.event.type !== "owner_gate_timeout") return null;
      return {
        allowed: true,
        toNode: "owner_gate",
        toStatus: "waiting_approval",
        reason: "reissue owner interaction request",
        ruleId: "rule-27-owner-gate-timeout",
      };
    },
  },

  // ── Row 28: feature, fix, simple | code | code_delivered untampered -> checks
  {
    id: "rule-28-code-delivered-ok",
    rowNumber: 28,
    route: ["feature", "fix", "simple"],
    node: "code",
    status: "running",
    eventType: "code_delivered",
    description: "сдан коммит кода (commits > 0, договор цел) -> checks",
    resolve(input) {
      if (
        input.event.type !== "code_delivered" ||
        input.event.acceptanceTampered ||
        (input.event.commits === 0 && !input.event.noCode)
      )
        return null;
      return {
        allowed: true,
        toNode: "checks",
        toStatus: "running",
        reason: "code delivered (commits > 0, contract untampered) -> checks",
        ruleId: "rule-28-code-delivered-ok",
        action: { dispatchNode: "checks" },
      };
    },
  },

  // ── Row 29: feature, fix, simple | code | acceptance contract tampered -> attempts / blocked
  {
    id: "rule-29-code-acceptance-tampered",
    rowNumber: 29,
    route: ["feature", "fix", "simple"],
    node: "code",
    status: "running",
    eventType: "code_delivered",
    description: "договор приёмки изменён исполнителем -> отказ захода (до 3 раз)",
    resolve(input) {
      if (input.event.type !== "code_delivered" || !input.event.acceptanceTampered)
        return null;
      const nextAttempts = input.counters.code_attempts + 1;
      const blocked = nextAttempts >= 3;
      return {
        allowed: true,
        toNode: "code",
        toStatus: blocked ? "blocked" : "running",
        reason: blocked
          ? "acceptance-contract-tampered (attempts limit reached: 3/3)"
          : `acceptance-contract-tampered (attempt ${nextAttempts}/3)`,
        ruleId: "rule-29-code-acceptance-tampered",
        counterUpdates: { code_attempts: nextAttempts },
        action: blocked
          ? { escalateArchitect: true }
          : { dispatchNode: "code" },
      };
    },
  },

  // ── Row 30: feature, fix, simple | code | no commits delivery -> attempts / blocked
  {
    id: "rule-30-code-no-commits",
    rowNumber: 30,
    route: ["feature", "fix", "simple"],
    node: "code",
    status: "running",
    eventType: "code_delivered",
    description: "сдача со статусом done без коммитов -> отказ (до 3 раз)",
    resolve(input) {
      if (
        input.event.type !== "code_delivered" ||
        input.event.commits > 0 ||
        input.event.noCode
      )
        return null;
      const nextAttempts = input.counters.code_attempts + 1;
      const blocked = nextAttempts >= 3;
      return {
        allowed: true,
        toNode: "code",
        toStatus: blocked ? "blocked" : "running",
        reason: blocked
          ? "code-refused: no-commits (attempts limit reached: 3/3)"
          : `code-refused: no-commits (attempt ${nextAttempts}/3)`,
        ruleId: "rule-30-code-no-commits",
        counterUpdates: { code_attempts: nextAttempts },
        action: blocked
          ? { escalateArchitect: true }
          : { dispatchNode: "code" },
      };
    },
  },

  // ── Row 31: feature, fix, simple | code | code_failed -> running/stalled
  {
    id: "rule-31-code-failed",
    rowNumber: 31,
    route: ["feature", "fix", "simple"],
    node: "code",
    status: "running",
    eventType: "code_failed",
    description: "сбой/квота исполнителя кода -> перевыпуск или stalled",
    resolve(input) {
      if (input.event.type !== "code_failed") return null;
      const isStalled = input.event.exhausted ?? true;
      return {
        allowed: true,
        toNode: "code",
        toStatus: isStalled ? "stalled" : "running",
        reason: `delegation exhausted level chain: status=${input.event.reason ?? "failed"}`,
        ruleId: "rule-31-code-failed",
      };
    },
  },

  // ── Row 32: feature, fix, simple | code | question / no report -> code running (nudge)
  {
    id: "rule-32-code-question",
    rowNumber: 32,
    route: ["feature", "fix", "simple"],
    node: "code",
    status: "running",
    eventType: "code_question_or_no_report",
    description: "ход завершился вопросом без коммита -> nudge на code",
    resolve(input) {
      if (input.event.type !== "code_question_or_no_report") return null;
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: "question without artifact: stay in code, nudge",
        ruleId: "rule-32-code-question",
      };
    },
  },

  // ── Row 33: feature, fix, simple | code | reject command -> code (running)
  {
    id: "rule-33-code-reject",
    rowNumber: 33,
    route: ["feature", "fix", "simple"],
    node: "code",
    status: ["running", "stalled"],
    eventType: "code_reject",
    description: "ручной возврат на доработку кода координатором/владельцем",
    resolve(input) {
      if (input.event.type !== "code_reject") return null;
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: input.event.reason || "code rejected",
        ruleId: "rule-33-code-reject",
        action: { dispatchNode: "code" },
      };
    },
  },

  // ── Row 34: feature, fix, simple | checks | exit 0 -> review
  {
    id: "rule-34-checks-passed",
    rowNumber: 34,
    route: ["feature", "fix", "simple"],
    node: "checks",
    status: "running",
    eventType: "checks_result",
    description: "все проверки пройдены (exit 0) -> review, сброс check_attempts",
    resolve(input) {
      if (
        input.event.type !== "checks_result" ||
        input.event.notRun ||
        input.event.exitCode !== 0
      )
        return null;
      return {
        allowed: true,
        toNode: "review",
        toStatus: "running",
        reason: "all checks passed (exit 0) -> review",
        ruleId: "rule-34-checks-passed",
        counterUpdates: { check_attempts: 0 },
        action: { dispatchNode: "review" },
      };
    },
  },

  // ── Row 35: feature, fix, simple | checks | exit != 0 attempts < 3 -> code (running)
  {
    id: "rule-35-checks-failed-loop",
    rowNumber: 35,
    route: ["feature", "fix", "simple"],
    node: "checks",
    status: "running",
    eventType: "checks_result",
    description: "ошибка тестов attempts < 3 -> возврат в code с ошибкой",
    resolve(input) {
      if (
        input.event.type !== "checks_result" ||
        input.event.notRun ||
        input.event.exitCode === 0
      )
        return null;
      const nextAttempts = input.counters.check_attempts + 1;
      if (nextAttempts >= 3) return null; // handled by row 36
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: `checks failed: exit ${input.event.exitCode} (attempt ${nextAttempts}/3, returning to code)`,
        ruleId: "rule-35-checks-failed-loop",
        counterUpdates: { check_attempts: nextAttempts },
        action: { dispatchNode: "code" },
      };
    },
  },

  // ── Row 36: feature, fix, simple | checks | exit != 0 attempts >= 3 -> checks (blocked)
  {
    id: "rule-36-checks-failed-blocked",
    rowNumber: 36,
    route: ["feature", "fix", "simple"],
    node: "checks",
    status: "running",
    eventType: "checks_result",
    description: "ошибка тестов attempts >= 3 -> checks (blocked)",
    resolve(input) {
      if (
        input.event.type !== "checks_result" ||
        input.event.notRun ||
        input.event.exitCode === 0
      )
        return null;
      const nextAttempts = input.counters.check_attempts + 1;
      if (nextAttempts < 3) return null; // handled by row 35
      return {
        allowed: true,
        toNode: "checks",
        toStatus: "blocked",
        reason: `checks failed: exit ${input.event.exitCode} (attempts limit reached: ${nextAttempts}/3)`,
        ruleId: "rule-36-checks-failed-blocked",
        counterUpdates: { check_attempts: nextAttempts },
        action: { escalateArchitect: true },
      };
    },
  },

  // ── Row 37: feature, fix, simple | checks | not_run -> checks (stalled)
  {
    id: "rule-37-checks-not-run",
    rowNumber: 37,
    route: ["feature", "fix", "simple"],
    node: "checks",
    status: "running",
    eventType: "checks_result",
    description: "исход «не запускалось» (таймаут, запрещённая команда) -> stalled",
    resolve(input) {
      if (input.event.type !== "checks_result" || !input.event.notRun) return null;
      return {
        allowed: true,
        toNode: "checks",
        toStatus: "stalled",
        reason: input.event.output || "checks stalled: not_run or forbidden command",
        ruleId: "rule-37-checks-not-run",
      };
    },
  },

  // ── Row 38: feature | review | verdict OK -> design_check
  {
    id: "rule-38-feature-review-ok",
    rowNumber: 38,
    route: "feature",
    node: "review",
    status: "running",
    eventType: "review_verdict",
    description: "аудит кода feature OK -> design_check",
    resolve(input) {
      if (
        input.event.type !== "review_verdict" ||
        input.event.verdict !== "OK" ||
        (input.event.blockers && input.event.blockers > 0)
      )
        return null;
      return {
        allowed: true,
        toNode: "design_check",
        toStatus: "running",
        reason: "code review passed OK -> design_check",
        ruleId: "rule-38-feature-review-ok",
        action: { dispatchNode: "design_check" },
      };
    },
  },

  // ── Row 39: fix, simple | review | verdict OK -> release
  {
    id: "rule-39-fix-simple-review-ok",
    rowNumber: 39,
    route: ["fix", "simple"],
    node: "review",
    status: "running",
    eventType: "review_verdict",
    description: "аудит кода fix/simple OK -> release",
    resolve(input) {
      if (
        input.event.type !== "review_verdict" ||
        input.event.verdict !== "OK" ||
        (input.event.blockers && input.event.blockers > 0)
      )
        return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "running",
        reason: "code review passed OK -> release",
        ruleId: "rule-39-fix-simple-review-ok",
      };
    },
  },

  // ── Row 40: feature, fix, simple | review | CHANGES round < 3 -> code (running)
  {
    id: "rule-40-review-changes-loop",
    rowNumber: 40,
    route: ["feature", "fix", "simple"],
    node: "review",
    status: "running",
    eventType: "review_verdict",
    description: "замечания ревью кода раунд < 3 -> возврат в code",
    resolve(input) {
      if (input.event.type !== "review_verdict") return null;
      const isChanges =
        input.event.verdict === "CHANGES" ||
        (input.event.blockers && input.event.blockers > 0);
      if (!isChanges) return null;
      const nextRounds = input.counters.code_review_rounds + 1;
      if (nextRounds >= 3) return null; // handled by row 41
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: `code review requested changes (round ${nextRounds}/3: return to code)`,
        ruleId: "rule-40-review-changes-loop",
        counterUpdates: { code_review_rounds: nextRounds },
        action: { dispatchNode: "code" },
      };
    },
  },

  // ── Row 41: feature, fix, simple | review | CHANGES round >= 3 -> review (blocked)
  {
    id: "rule-41-review-changes-blocked",
    rowNumber: 41,
    route: ["feature", "fix", "simple"],
    node: "review",
    status: "running",
    eventType: "review_verdict",
    description: "замечания ревью кода раунд >= 3 -> review (blocked)",
    resolve(input) {
      if (input.event.type !== "review_verdict") return null;
      const isChanges =
        input.event.verdict === "CHANGES" ||
        (input.event.blockers && input.event.blockers > 0);
      if (!isChanges) return null;
      const nextRounds = input.counters.code_review_rounds + 1;
      if (nextRounds < 3) return null; // handled by row 40
      return {
        allowed: true,
        toNode: "review",
        toStatus: "blocked",
        reason: `code review requested changes (round limit reached: ${nextRounds}/3)`,
        ruleId: "rule-41-review-changes-blocked",
        counterUpdates: { code_review_rounds: nextRounds },
        action: { escalateArchitect: true },
      };
    },
  },

  // ── Row 42: feature, fix, simple | review | review_failed -> running/stalled
  {
    id: "rule-42-review-failed",
    rowNumber: 42,
    route: ["feature", "fix", "simple"],
    node: "review",
    status: "running",
    eventType: "review_failed",
    description: "сбой/квота ревьюера кода -> перевыпуск или stalled",
    resolve(input) {
      if (input.event.type !== "review_failed") return null;
      const isStalled = input.event.exhausted ?? true;
      return {
        allowed: true,
        toNode: "review",
        toStatus: isStalled ? "stalled" : "running",
        reason: `delegation exhausted level chain: status=${input.event.reason ?? "failed"}`,
        ruleId: "rule-42-review-failed",
      };
    },
  },

  // ── Row 43: feature, fix, simple | review | question / no verdict -> review running (nudge)
  {
    id: "rule-43-review-question",
    rowNumber: 43,
    route: ["feature", "fix", "simple"],
    node: "review",
    status: "running",
    eventType: "review_question_or_no_verdict",
    description: "ход без JSON-вердикта ревью -> nudge ревьюеру",
    resolve(input) {
      if (input.event.type !== "review_question_or_no_verdict") return null;
      return {
        allowed: true,
        toNode: "review",
        toStatus: "running",
        reason: "question without verdict: stay in review, nudge",
        ruleId: "rule-43-review-question",
      };
    },
  },

  // ── Row 44: feature | design_check | verdict OK -> release
  {
    id: "rule-44-feature-design-check-ok",
    rowNumber: 44,
    route: "feature",
    node: "design_check",
    status: "running",
    eventType: "design_check_verdict",
    description: "архитектура и договор подтверждены OK -> release",
    resolve(input) {
      if (
        input.event.type !== "design_check_verdict" ||
        input.event.verdict !== "OK" ||
        (input.event.blockers && input.event.blockers > 0)
      )
        return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "running",
        reason: "architecture and acceptance confirmed -> release",
        ruleId: "rule-44-feature-design-check-ok",
      };
    },
  },

  // ── Row 45: feature | design_check | CHANGES target: code round < 3 -> code
  {
    id: "rule-45-feature-design-check-changes-code",
    rowNumber: 45,
    route: "feature",
    node: "design_check",
    status: "running",
    eventType: "design_check_verdict",
    description: "замечания архитектора к коду (раунд < 3) -> code",
    resolve(input) {
      if (input.event.type !== "design_check_verdict") return null;
      const isChanges =
        input.event.verdict === "CHANGES" ||
        (input.event.blockers && input.event.blockers > 0);
      if (!isChanges || input.event.target === "design") return null;
      const nextRounds = input.counters.design_check_rounds + 1;
      if (nextRounds >= 3) return null; // handled by row 47
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: `design check requested changes to code (round ${nextRounds}/3)`,
        ruleId: "rule-45-feature-design-check-changes-code",
        counterUpdates: { design_check_rounds: nextRounds },
        action: { dispatchNode: "code" },
      };
    },
  },

  // ── Row 46: feature | design_check | CHANGES target: design round < 3 -> design (resets spec & code counters)
  {
    id: "rule-46-feature-design-check-changes-design",
    rowNumber: 46,
    route: "feature",
    node: "design_check",
    status: "running",
    eventType: "design_check_verdict",
    description: "замечания архитектора redesign (раунд < 3) -> design со сбросом счётчиков",
    resolve(input) {
      if (input.event.type !== "design_check_verdict") return null;
      const isChanges =
        input.event.verdict === "CHANGES" ||
        (input.event.blockers && input.event.blockers > 0);
      if (!isChanges || input.event.target !== "design") return null;
      const nextRounds = input.counters.design_check_rounds + 1;
      if (nextRounds >= 3) return null; // handled by row 47
      return {
        allowed: true,
        toNode: "design",
        toStatus: "running",
        reason: `design check requested redesign (round ${nextRounds}/3: reset downstream)`,
        ruleId: "rule-46-feature-design-check-changes-design",
        counterUpdates: {
          design_check_rounds: nextRounds,
          spec_attempts: 0,
          spec_review_rounds: 0,
          code_attempts: 0,
          check_attempts: 0,
          code_review_rounds: 0,
        },
        action: { dispatchNode: "design" },
      };
    },
  },

  // ── Row 47: feature | design_check | CHANGES round >= 3 -> design_check (blocked)
  {
    id: "rule-47-feature-design-check-changes-blocked",
    rowNumber: 47,
    route: "feature",
    node: "design_check",
    status: "running",
    eventType: "design_check_verdict",
    description: "замечания архитектора раунд >= 3 -> design_check (blocked)",
    resolve(input) {
      if (input.event.type !== "design_check_verdict") return null;
      const isChanges =
        input.event.verdict === "CHANGES" ||
        (input.event.blockers && input.event.blockers > 0);
      if (!isChanges) return null;
      const nextRounds = input.counters.design_check_rounds + 1;
      if (nextRounds < 3) return null; // handled by rows 45/46
      return {
        allowed: true,
        toNode: "design_check",
        toStatus: "blocked",
        reason: `design check rejected (round limit reached: ${nextRounds}/3)`,
        ruleId: "rule-47-feature-design-check-changes-blocked",
        counterUpdates: { design_check_rounds: nextRounds },
        action: { escalateArchitect: true },
      };
    },
  },

  // ── Row 48: feature | design_check | design_check_failed -> running/stalled
  {
    id: "rule-48-feature-design-check-failed",
    rowNumber: 48,
    route: "feature",
    node: "design_check",
    status: "running",
    eventType: "design_check_failed",
    description: "сбой/квота архитектора на design_check -> перевыпуск или stalled",
    resolve(input) {
      if (input.event.type !== "design_check_failed") return null;
      const isStalled = input.event.exhausted ?? true;
      return {
        allowed: true,
        toNode: "design_check",
        toStatus: isStalled ? "stalled" : "running",
        reason: `delegation exhausted level chain: status=${input.event.reason ?? "failed"}`,
        ruleId: "rule-48-feature-design-check-failed",
      };
    },
  },

  // ── Row 49: feature | design_check | question / no verdict -> running (nudge)
  {
    id: "rule-49-feature-design-check-question",
    rowNumber: 49,
    route: "feature",
    node: "design_check",
    status: "running",
    eventType: "design_check_question_or_no_verdict",
    description: "ход без JSON-вердикта design_check -> nudge архитектору",
    resolve(input) {
      if (input.event.type !== "design_check_question_or_no_verdict") return null;
      return {
        allowed: true,
        toNode: "design_check",
        toStatus: "running",
        reason: "question without verdict: stay in design_check, nudge",
        ruleId: "rule-49-feature-design-check-question",
      };
    },
  },

  // ── Row 50: * | release | published (push-mode) -> release (done)
  {
    id: "rule-50-release-published-push",
    rowNumber: 50,
    route: "*",
    node: "release",
    status: "running",
    eventType: "release_published",
    description: "публикация успешна (push-режим) -> release (done)",
    resolve(input) {
      if (input.event.type !== "release_published" || input.event.prMode)
        return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "done",
        reason: "task released and published successfully -> done",
        ruleId: "rule-50-release-published-push",
      };
    },
  },

  // ── Row 51: * | release | published (pr-mode) -> release (pr_open)
  {
    id: "rule-51-release-published-pr",
    rowNumber: 51,
    route: "*",
    node: "release",
    status: "running",
    eventType: "release_published",
    description: "PR успешно открыт (pr-режим) -> release (pr_open)",
    resolve(input) {
      if (input.event.type !== "release_published" || !input.event.prMode)
        return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "pr_open",
        reason: "PR created successfully -> pr_open",
        ruleId: "rule-51-release-published-pr",
      };
    },
  },

  // ── Row 52: * | release | pr_merged -> release (done)
  {
    id: "rule-52-release-pr-merged",
    rowNumber: 52,
    route: "*",
    node: "release",
    status: "pr_open",
    eventType: "pr_merged",
    description: "PR слит в целевую ветку -> release (done)",
    resolve(input) {
      if (input.event.type !== "pr_merged") return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "done",
        reason: "PR merged -> done",
        ruleId: "rule-52-release-pr-merged",
      };
    },
  },

  // ── Row 53: feature, fix, simple | release | pr_changes_requested -> code (running)
  {
    id: "rule-53-release-pr-changes-requested-code",
    rowNumber: 53,
    route: ["feature", "fix", "simple"],
    node: "release",
    status: "pr_open",
    eventType: "pr_changes_requested",
    description: "замечания ревью в PR для кода -> code со сбросом счётчиков",
    resolve(input) {
      if (input.event.type !== "pr_changes_requested") return null;
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: "PR review requested changes -> code (counters reset)",
        ruleId: "rule-53-release-pr-changes-requested-code",
        counterUpdates: {
          code_attempts: 0,
          check_attempts: 0,
          code_review_rounds: 0,
          design_check_rounds: 0,
          release_attempts: 0,
        },
        action: { dispatchNode: "code" },
      };
    },
  },

  // ── Row 54: docs | release | pr_changes_requested -> spec (running)
  {
    id: "rule-54-release-pr-changes-requested-docs",
    rowNumber: 54,
    route: "docs",
    node: "release",
    status: "pr_open",
    eventType: "pr_changes_requested",
    description: "замечания ревью в PR для docs -> spec со сбросом счётчиков",
    resolve(input) {
      if (input.event.type !== "pr_changes_requested") return null;
      return {
        allowed: true,
        toNode: "spec",
        toStatus: "running",
        reason: "PR review requested changes for docs -> spec (counters reset)",
        ruleId: "rule-54-release-pr-changes-requested-docs",
        counterUpdates: {
          spec_attempts: 0,
          spec_review_rounds: 0,
          release_attempts: 0,
        },
        action: { dispatchNode: "spec" },
      };
    },
  },

  // ── Row 55: * | release | pr_closed -> release (stalled)
  {
    id: "rule-55-release-pr-closed",
    rowNumber: 55,
    route: "*",
    node: "release",
    status: "pr_open",
    eventType: "pr_closed",
    description: "PR закрыт без слияния -> release (stalled)",
    resolve(input) {
      if (input.event.type !== "pr_closed") return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "stalled",
        reason: "PR closed without merge -> stalled",
        ruleId: "rule-55-release-pr-closed",
        action: { setPayload: { stalled_reason: "pr_closed" } },
      };
    },
  },

  // ── Row 56: feature, fix, simple | release | resume --target code (pr_closed) -> code
  {
    id: "rule-56-release-resume-pr-closed-code",
    rowNumber: 56,
    route: ["feature", "fix", "simple"],
    node: "release",
    status: "stalled",
    eventType: "resume",
    description: "resume --target code после pr_closed -> code",
    resolve(input) {
      if (
        input.event.type !== "resume" ||
        !input.event.prClosedReason ||
        input.event.target !== "code"
      )
        return null;
      if (input.event.isOwner === false) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: owner-only",
          toNode: "release",
          toStatus: "stalled",
          reason: "permission-denied: owner-only",
          ruleId: "rule-56-release-resume-pr-closed-code",
        };
      }
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: "resume to code after pr_closed",
        ruleId: "rule-56-release-resume-pr-closed-code",
        counterUpdates: {
          code_attempts: 0,
          check_attempts: 0,
          code_review_rounds: 0,
          design_check_rounds: 0,
          release_attempts: 0,
        },
        action: { dispatchNode: "code" },
      };
    },
  },

  // ── Row 57: docs | release | resume --target spec (pr_closed) -> spec
  {
    id: "rule-57-release-resume-pr-closed-docs",
    rowNumber: 57,
    route: "docs",
    node: "release",
    status: "stalled",
    eventType: "resume",
    description: "resume --target spec после pr_closed -> spec",
    resolve(input) {
      if (
        input.event.type !== "resume" ||
        !input.event.prClosedReason ||
        input.event.target !== "spec"
      )
        return null;
      if (input.event.isOwner === false) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: owner-only",
          toNode: "release",
          toStatus: "stalled",
          reason: "permission-denied: owner-only",
          ruleId: "rule-57-release-resume-pr-closed-docs",
        };
      }
      return {
        allowed: true,
        toNode: "spec",
        toStatus: "running",
        reason: "resume to spec after pr_closed",
        ruleId: "rule-57-release-resume-pr-closed-docs",
        counterUpdates: {
          spec_attempts: 0,
          spec_review_rounds: 0,
          release_attempts: 0,
        },
        action: { dispatchNode: "spec" },
      };
    },
  },

  // ── Row 58: * | release | uncommitted-kb -> release (stalled)
  {
    id: "rule-58-release-refused-uncommitted-kb",
    rowNumber: 58,
    route: "*",
    node: "release",
    status: "running",
    eventType: "release_refused_kb",
    description: "отказ release-refused: uncommitted-kb -> stalled",
    resolve(input) {
      if (input.event.type !== "release_refused_kb") return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "stalled",
        reason: "release-refused: uncommitted-kb",
        ruleId: "rule-58-release-refused-uncommitted-kb",
      };
    },
  },

  // ── Row 59: * | release | unmerged-ui -> release (stalled)
  {
    id: "rule-59-release-refused-unmerged-ui",
    rowNumber: 59,
    route: "*",
    node: "release",
    status: "running",
    eventType: "release_refused_ui",
    description: "отказ release-refused: unmerged-ui -> stalled",
    resolve(input) {
      if (input.event.type !== "release_refused_ui") return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "stalled",
        reason: "release-refused: unmerged-ui",
        ruleId: "rule-59-release-refused-unmerged-ui",
      };
    },
  },

  // ── Row 60: * | release | requireNote -> release (waiting_release_note)
  {
    id: "rule-60-release-waiting-note",
    rowNumber: 60,
    route: "*",
    node: "release",
    status: "running",
    eventType: "release_waiting_note",
    description: "требуется заметка релиза -> waiting_release_note",
    resolve(input) {
      if (input.event.type !== "release_waiting_note") return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "waiting_release_note",
        reason: "waiting for release note",
        ruleId: "rule-60-release-waiting-note",
      };
    },
  },

  // ── Row 61: feature, fix, simple | release | release failure attempts < 3 -> code
  {
    id: "rule-61-release-failed-code-loop",
    rowNumber: 61,
    route: ["feature", "fix", "simple"],
    node: "release",
    status: "running",
    eventType: "release_failed_checks_conflict_reject",
    description: "отказ выкладки кода attempts < 3 -> возврат в code",
    resolve(input) {
      if (input.event.type !== "release_failed_checks_conflict_reject")
        return null;
      const nextAttempts = input.counters.release_attempts + 1;
      if (nextAttempts >= 3) return null; // handled by row 62
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: `release failed: ${input.event.reason ?? "rejected"} (attempt ${nextAttempts}/3, returning to code)`,
        ruleId: "rule-61-release-failed-code-loop",
        counterUpdates: { release_attempts: nextAttempts },
        action: { dispatchNode: "code" },
      };
    },
  },

  // ── Row 62: feature, fix, simple | release | release failure attempts >= 3 -> release (blocked)
  {
    id: "rule-62-release-failed-code-blocked",
    rowNumber: 62,
    route: ["feature", "fix", "simple"],
    node: "release",
    status: "running",
    eventType: "release_failed_checks_conflict_reject",
    description: "отказ выкладки кода attempts >= 3 -> release (blocked)",
    resolve(input) {
      if (input.event.type !== "release_failed_checks_conflict_reject")
        return null;
      const nextAttempts = input.counters.release_attempts + 1;
      if (nextAttempts < 3) return null; // handled by row 61
      return {
        allowed: true,
        toNode: "release",
        toStatus: "blocked",
        reason: `release failed: ${input.event.reason ?? "rejected"} (attempts limit reached: ${nextAttempts}/3)`,
        ruleId: "rule-62-release-failed-code-blocked",
        counterUpdates: { release_attempts: nextAttempts },
        action: { escalateArchitect: true },
      };
    },
  },

  // ── Row 63: docs | release | release failure attempts < 3 -> spec
  {
    id: "rule-63-release-failed-docs-loop",
    rowNumber: 63,
    route: "docs",
    node: "release",
    status: "running",
    eventType: "release_failed_checks_conflict_reject",
    description: "отказ выкладки документации attempts < 3 -> возврат в spec",
    resolve(input) {
      if (input.event.type !== "release_failed_checks_conflict_reject")
        return null;
      const nextAttempts = input.counters.release_attempts + 1;
      if (nextAttempts >= 3) return null; // handled by row 64
      return {
        allowed: true,
        toNode: "spec",
        toStatus: "running",
        reason: `release docs failed: ${input.event.reason ?? "rejected"} (attempt ${nextAttempts}/3, returning to spec)`,
        ruleId: "rule-63-release-failed-docs-loop",
        counterUpdates: { release_attempts: nextAttempts },
        action: { dispatchNode: "spec" },
      };
    },
  },

  // ── Row 64: docs | release | release failure attempts >= 3 -> release (blocked)
  {
    id: "rule-64-release-failed-docs-blocked",
    rowNumber: 64,
    route: "docs",
    node: "release",
    status: "running",
    eventType: "release_failed_checks_conflict_reject",
    description: "отказ выкладки документации attempts >= 3 -> release (blocked)",
    resolve(input) {
      if (input.event.type !== "release_failed_checks_conflict_reject")
        return null;
      const nextAttempts = input.counters.release_attempts + 1;
      if (nextAttempts < 3) return null; // handled by row 63
      return {
        allowed: true,
        toNode: "release",
        toStatus: "blocked",
        reason: `release docs failed: ${input.event.reason ?? "rejected"} (attempts limit reached: ${nextAttempts}/3)`,
        ruleId: "rule-64-release-failed-docs-blocked",
        counterUpdates: { release_attempts: nextAttempts },
        action: { escalateArchitect: true },
      };
    },
  },

  // ── Row 65: * | release | release script failure -> release (stalled)
  {
    id: "rule-65-release-failed-script",
    rowNumber: 65,
    route: "*",
    node: "release",
    status: "running",
    eventType: "release_failed_script",
    description: "сбой выполнения скрипта выкладки -> release (stalled)",
    resolve(input) {
      if (input.event.type !== "release_failed_script") return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "stalled",
        reason: `release script failure: ${input.event.reason ?? "failed"}`,
        ruleId: "rule-65-release-failed-script",
      };
    },
  },

  // ── Row 66: * | release | release_note_provided -> release (running)
  {
    id: "rule-66-release-note-provided",
    rowNumber: 66,
    route: "*",
    node: "release",
    status: "waiting_release_note",
    eventType: "release_note_provided",
    description: "передана заметка релиза -> перезапуск release (running)",
    resolve(input) {
      if (input.event.type !== "release_note_provided") return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "running",
        reason: "release note provided -> restart release",
        ruleId: "rule-66-release-note-provided",
        action: { setPayload: { release_note: input.event.note } },
      };
    },
  },

  // ── Row 67: * | any node | resume from stalled (no target) -> current node running
  {
    id: "rule-67-resume-stalled",
    rowNumber: 67,
    route: "*",
    node: "*",
    status: "stalled",
    eventType: "resume",
    description: "возобновление из stalled без target -> текущий узел (running)",
    resolve(input) {
      if (input.event.type !== "resume" || input.event.target !== undefined)
        return null;
      return {
        allowed: true,
        toNode: input.node,
        toStatus: "running",
        reason: "resumed from stalled",
        ruleId: "rule-67-resume-stalled",
        action: { dispatchNode: input.node },
      };
    },
  },

  // ── Row 68: * | any node | dequeue -> cancelled
  {
    id: "rule-68-dequeue",
    rowNumber: 68,
    route: "*",
    node: "*",
    status: "*",
    eventType: "dequeue",
    description: "снятие задачи с очереди владельцем -> cancelled",
    resolve(input) {
      if (input.event.type !== "dequeue") return null;
      if (input.status === "done" || input.status === "cancelled") {
        return {
          allowed: false,
          errorCode: "invalid-status",
          errorMessage: `task is already finished (${input.status})`,
          toNode: input.node,
          toStatus: input.status,
          reason: "invalid-status",
          ruleId: "rule-68-dequeue",
        };
      }
      if (input.event.isOwner === false) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: owner-only",
          toNode: input.node,
          toStatus: input.status,
          reason: "permission-denied: owner-only",
          ruleId: "rule-68-dequeue",
        };
      }
      return {
        allowed: true,
        toNode: input.node,
        toStatus: "cancelled",
        reason: input.event.reason || "dequeued by owner",
        ruleId: "rule-68-dequeue",
        action: {
          archiveBranch: true,
          closePr: true,
          setPayload: { cancelled_reason: input.event.reason },
        },
      };
    },
  },

  // ── Row 69: * | any node | resume from blocked -> target node running
  {
    id: "rule-69-resume-blocked",
    rowNumber: 69,
    route: "*",
    node: "*",
    status: "blocked",
    eventType: "resume",
    description: "возобновление из blocked владельцем -> целевой узел со сбросом счётчиков",
    resolve(input) {
      if (input.event.type !== "resume") return null;
      if (input.event.isOwner === false) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: owner-only",
          toNode: input.node,
          toStatus: "blocked",
          reason: "permission-denied: owner-only",
          ruleId: "rule-69-resume-blocked",
        };
      }

      // Default target based on blocked node
      let targetNode = input.event.target;
      if (!targetNode) {
        if (input.node === "checks" || input.node === "review") {
          targetNode = "code";
        } else if (input.node === "spec_review") {
          targetNode = "spec";
        } else if (input.node === "design_check") {
          targetNode = "design";
        } else if (input.node === "release") {
          targetNode = "release";
        } else {
          targetNode = input.node;
        }
      }

      // Validate allowed targets by route
      const allowedByRoute: Record<TaskRoute, TaskNode[]> = {
        feature: ["code", "spec", "design", "release"],
        fix: ["code", "release"],
        simple: ["code", "release"],
        docs: ["spec", "release"],
        research: ["research"],
      };

      if (!allowedByRoute[input.route]?.includes(targetNode)) {
        return {
          allowed: false,
          errorCode: "target-invalid",
          errorMessage: `target-invalid: target ${targetNode} is not allowed for route ${input.route}`,
          toNode: input.node,
          toStatus: "blocked",
          reason: "target-invalid",
          ruleId: "rule-69-resume-blocked",
        };
      }

      // Release target strictly only allowed if task was blocked directly at release
      if (targetNode === "release" && input.node !== "release") {
        return {
          allowed: false,
          errorCode: "target-invalid",
          errorMessage:
            "target-invalid: cannot resume to release from unreviewed or unverified code",
          toNode: input.node,
          toStatus: "blocked",
          reason: "target-invalid",
          ruleId: "rule-69-resume-blocked",
        };
      }

      // Counter resets based on target
      const counterUpdates: Partial<TransitionCounters> = {};
      if (targetNode === "design") {
        counterUpdates.design_check_rounds = 0;
        counterUpdates.spec_attempts = 0;
        counterUpdates.spec_review_rounds = 0;
        counterUpdates.code_attempts = 0;
        counterUpdates.check_attempts = 0;
        counterUpdates.code_review_rounds = 0;
        counterUpdates.release_attempts = 0;
      } else if (targetNode === "spec") {
        counterUpdates.spec_attempts = 0;
        counterUpdates.spec_review_rounds = 0;
        counterUpdates.code_attempts = 0;
        counterUpdates.check_attempts = 0;
        counterUpdates.code_review_rounds = 0;
        counterUpdates.design_check_rounds = 0;
        counterUpdates.release_attempts = 0;
      } else if (targetNode === "code") {
        counterUpdates.code_attempts = 0;
        counterUpdates.check_attempts = 0;
        counterUpdates.code_review_rounds = 0;
        counterUpdates.design_check_rounds = 0;
        counterUpdates.release_attempts = 0;
      } else if (targetNode === "release") {
        counterUpdates.release_attempts = 0;
      }

      return {
        allowed: true,
        toNode: targetNode,
        toStatus: "running",
        reason: `resumed from blocked -> target: ${targetNode}`,
        ruleId: "rule-69-resume-blocked",
        counterUpdates,
        action: { dispatchNode: targetNode },
      };
    },
  },

  // ── Row 70: * | any node | resume from deferred -> running / waiting_approval
  {
    id: "rule-70-resume-deferred",
    rowNumber: 70,
    route: "*",
    node: "*",
    status: "deferred",
    eventType: "resume",
    description: "возобновление из deferred владельцем -> running/waiting_approval",
    resolve(input) {
      if (input.event.type !== "resume") return null;
      if (input.event.isOwner === false) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: owner-only",
          toNode: input.node,
          toStatus: "deferred",
          reason: "permission-denied: owner-only",
          ruleId: "rule-70-resume-deferred",
        };
      }
      const targetStatus: TaskStatus =
        input.node === "owner_gate" ? "waiting_approval" : "running";
      return {
        allowed: true,
        toNode: input.node,
        toStatus: targetStatus,
        reason: "resumed from deferred",
        ruleId: "rule-70-resume-deferred",
        action: targetStatus === "running" ? { dispatchNode: input.node } : undefined,
      };
    },
  },

  // ── Row 71: research | research | research_delivered -> research (done)
  {
    id: "rule-71-research-delivered",
    rowNumber: 71,
    route: "research",
    node: "research",
    status: "running",
    eventType: "research_delivered",
    description: "отчёт исследователя сдан -> research (done)",
    resolve(input) {
      if (input.event.type !== "research_delivered") return null;
      return {
        allowed: true,
        toNode: "research",
        toStatus: "done",
        reason: "research report delivered -> done",
        ruleId: "rule-71-research-delivered",
      };
    },
  },

  // ── Row 72: research | research | research_failed -> running/stalled
  {
    id: "rule-72-research-failed",
    rowNumber: 72,
    route: "research",
    node: "research",
    status: "running",
    eventType: "research_failed",
    description: "сбой исследователя -> перевыпуск или stalled",
    resolve(input) {
      if (input.event.type !== "research_failed") return null;
      const isStalled = input.event.exhausted ?? true;
      return {
        allowed: true,
        toNode: "research",
        toStatus: isStalled ? "stalled" : "running",
        reason: `delegation exhausted level chain: status=${input.event.reason ?? "failed"}`,
        ruleId: "rule-72-research-failed",
      };
    },
  },

  // ── Row 73: research | research | question / no report -> research running (nudge)
  {
    id: "rule-73-research-question",
    rowNumber: 73,
    route: "research",
    node: "research",
    status: "running",
    eventType: "research_question_or_no_report",
    description: "ход исследователя без отчёта -> nudge на research",
    resolve(input) {
      if (input.event.type !== "research_question_or_no_report") return null;
      return {
        allowed: true,
        toNode: "research",
        toStatus: "running",
        reason: "question without report: stay in research, nudge",
        ruleId: "rule-73-research-question",
      };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// PURE FUNCTION resolveTransition
// ─────────────────────────────────────────────────────────────────────────────

export function resolveTransition(input: TransitionInput): TransitionResolution {
  for (const rule of TRANSITION_TABLE) {
    if (!matchesRoute(rule.route, input.route)) continue;
    if (!matchesNode(rule.node, input.node)) continue;
    if (!matchesStatus(rule.status, input.status)) continue;
    if (!matchesMode(rule.mode, input.mode)) continue;
    if (!matchesEventType(rule.eventType, input.event.type)) continue;

    const resolution = rule.resolve(input);
    if (resolution !== null) {
      return resolution;
    }
  }

  return {
    allowed: false,
    errorCode: "invalid-transition",
    errorMessage: `нет перехода в матрице §28.1 для: route=${input.route}, node=${input.node}, status=${input.status}, event=${input.event.type}, mode=${input.mode}`,
    toNode: input.node,
    toStatus: input.status,
    reason: `no matching transition in matrix for event ${input.event.type} at ${input.node}/${input.status}`,
    ruleId: "none",
  };
}
