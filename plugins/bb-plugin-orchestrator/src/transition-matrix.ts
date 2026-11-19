// plugins/bb-plugin-orchestrator/src/transition-matrix.ts
// Pure Transition Matrix & Engine for bb-plugin-orchestrator
// Spec: docs/specs/orchestrator.md §28.1 (Revision 34.2)
// Exactly 80 rules matching §28.1 matrix rows 1..80.

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
      branch?: string;
      acceptanceText?: string | null;
      gitError?: string;
    }
  | {
      type: "git_failure";
      reason?: string;
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
      exhausted?: boolean;
      nudgeCount?: number;
      reason?: string;
    }
  | {
      type: "spec_delivered";
      specSha?: string;
      acceptanceTampered?: boolean;
      filesOutsideDocs?: boolean;
      invalidCodebaseReference?: boolean;
    }
  | {
      type: "spec_invalid_reference";
      reason?: string;
    }
  | {
      type: "spec_failed";
      exhausted?: boolean;
      reason?: string;
    }
  | {
      type: "spec_question_or_no_report";
      exhausted?: boolean;
      nudgeCount?: number;
      reason?: string;
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
      exhausted?: boolean;
      nudgeCount?: number;
      reason?: string;
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
      resultSha?: string;
      commits?: number;
      noCode?: boolean;
      acceptanceTampered?: boolean;
      routeViolation?: boolean;
    }
  | {
      type: "code_route_violation";
      reason?: string;
    }
  | {
      type: "code_failed";
      exhausted?: boolean;
      reason?: string;
    }
  | {
      type: "code_question_or_no_report";
      exhausted?: boolean;
      nudgeCount?: number;
      reason?: string;
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
      exhausted?: boolean;
      nudgeCount?: number;
      reason?: string;
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
      exhausted?: boolean;
      nudgeCount?: number;
      reason?: string;
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
      prevStatus?: string;
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
      exhausted?: boolean;
      nudgeCount?: number;
      reason?: string;
    };

export interface TransitionInput {
  route: TaskRoute;
  node: TaskNode;
  status: TaskStatus;
  event: TransitionEvent;
  mode: ConfirmationMode;
  counters: TransitionCounters;
  gateStage?: "pre_code" | "pre_release";
}

export interface TransitionAction {
  createBranch?: boolean;
  commitAcceptance?: boolean;
  dispatchNode?: TaskNode;
  retryDispatch?: boolean;
  nudgeThread?: boolean;
  archiveBranch?: boolean;
  closePr?: boolean;
  escalateArchitect?: boolean;
  incrementCounter?: keyof TransitionCounters;
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
  id: string;
  rowNumber: number;
  route: TaskRoute | readonly TaskRoute[] | "*";
  node: TaskNode | readonly TaskNode[] | "*";
  status: TaskStatus | readonly TaskStatus[] | "*";
  eventType: string | readonly string[];
  mode?: ConfirmationMode;
  description: string;
  resolve(input: TransitionInput): TransitionResolution | null;
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
  actual: TaskRoute,
): boolean {
  if (ruleRoute === "*") return true;
  if (Array.isArray(ruleRoute)) return ruleRoute.includes(actual);
  return ruleRoute === actual;
}

function matchesNode(
  ruleNode: TaskNode | readonly TaskNode[] | "*",
  actual: TaskNode,
): boolean {
  if (ruleNode === "*") return true;
  if (Array.isArray(ruleNode)) return ruleNode.includes(actual);
  return ruleNode === actual;
}

function matchesStatus(
  ruleStatus: TaskStatus | readonly TaskStatus[] | "*",
  actual: TaskStatus,
): boolean {
  if (ruleStatus === "*") return true;
  if (Array.isArray(ruleStatus)) return ruleStatus.includes(actual);
  return ruleStatus === actual;
}

function matchesMode(
  ruleMode: ConfirmationMode | undefined,
  actual: ConfirmationMode,
): boolean {
  if (ruleMode === undefined) return true;
  return ruleMode === actual;
}

function matchesEventType(
  ruleEventType: string | readonly string[],
  eventType: string,
): boolean {
  if (Array.isArray(ruleEventType)) return ruleEventType.includes(eventType);
  return ruleEventType === eventType;
}

// ─────────────────────────────────────────────────────────────────────────────
// §28.1 TRANSITION TABLE AS PURE DATA (80 rules matching spec §28.1 matrix)
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
    mode: "manual",
    eventType: "queue_take",
    description: "fix/simple взята в manual -> owner_gate (waiting_approval)",
    resolve(input) {
      if (input.event.type !== "queue_take" || input.event.branchExistsWithCommits)
        return null;
      return {
        allowed: true,
        toNode: "owner_gate",
        toStatus: "waiting_approval",
        reason: "task taken in manual mode -> owner_gate (waiting_approval)",
        ruleId: "rule-03-fix-simple-start-take-manual",
        action: {
          createBranch: true,
          commitAcceptance: true,
          setPayload: { gate_stage: "pre_code" },
        },
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
    mode: "auto",
    eventType: "queue_take",
    description: "fix/simple взята в auto -> code (running)",
    resolve(input) {
      if (input.event.type !== "queue_take" || input.event.branchExistsWithCommits)
        return null;
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: "task taken in auto mode -> code (running)",
        ruleId: "rule-04-fix-simple-start-take-auto",
        action: { createBranch: true, commitAcceptance: true, dispatchNode: "code" },
      };
    },
  },

  // ── Row 5: feature, fix, docs, simple | start | branch_exists / git_failure -> start (stalled)
  {
    id: "rule-05-start-branch-exists-with-commits",
    rowNumber: 5,
    route: ["feature", "fix", "docs", "simple"],
    node: "start",
    status: "queued",
    eventType: ["queue_take", "git_failure"],
    description: "ветка уже существует с коммитами вне базы / сбой git -> stalled",
    resolve(input) {
      if (input.event.type === "git_failure") {
        return {
          allowed: true,
          toNode: "start",
          toStatus: "stalled",
          reason: input.event.reason ?? "git-failed on start -> stalled",
          ruleId: "rule-05-start-branch-exists-with-commits",
        };
      }
      if (input.event.type === "queue_take") {
        if (input.event.gitError) {
          return {
            allowed: true,
            toNode: "start",
            toStatus: "stalled",
            reason: input.event.gitError,
            ruleId: "rule-05-start-branch-exists-with-commits",
          };
        }
        if (input.event.branchExistsWithCommits) {
          return {
            allowed: true,
            toNode: "start",
            toStatus: "stalled",
            reason:
              "stalled: branch-exists: ветка уже существует и содержит коммиты вне базы",
            ruleId: "rule-05-start-branch-exists-with-commits",
          };
        }
      }
      return null;
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
        reason: "research task taken -> research (running)",
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
        reason: "acceptance contract and architecture delivered -> spec",
        ruleId: "rule-07-feature-design-delivered",
        action: { commitAcceptance: true, dispatchNode: "spec" },
      };
    },
  },

  // ── Row 8: feature | design | design_failed / git_failure -> running (reissue) or stalled
  {
    id: "rule-08-feature-design-failed",
    rowNumber: 8,
    route: "feature",
    node: "design",
    status: "running",
    eventType: ["design_failed", "git_failure"],
    description: "сбой/квота на design / сбой git -> running (перевыпуск) или stalled",
    resolve(input) {
      if (input.event.type === "git_failure") {
        return {
          allowed: true,
          toNode: "design",
          toStatus: "stalled",
          reason: input.event.reason ?? "git-failed on design -> stalled",
          ruleId: "rule-08-feature-design-failed",
        };
      }
      if (input.event.type !== "design_failed") return null;
      if (input.event.exhausted) {
        return {
          allowed: true,
          toNode: "design",
          toStatus: "stalled",
          reason: input.event.reason ?? "design attempts exhausted -> stalled",
          ruleId: "rule-08-feature-design-failed",
        };
      }
      return {
        allowed: true,
        toNode: "design",
        toStatus: "running",
        reason: input.event.reason ?? "design retry -> running",
        ruleId: "rule-08-feature-design-failed",
        action: { retryDispatch: true, dispatchNode: "design" },
      };
    },
  },

  // ── Row 9: feature | design | design_question_or_no_report -> design (running / stalled)
  {
    id: "rule-09-feature-design-question",
    rowNumber: 9,
    route: "feature",
    node: "design",
    status: "running",
    eventType: "design_question_or_no_report",
    description: "ход завершился вопросом без отчёта -> nudge на design / stalled при исчерпании",
    resolve(input) {
      if (input.event.type !== "design_question_or_no_report") return null;
      if (input.event.exhausted || (typeof input.event.nudgeCount === "number" && input.event.nudgeCount >= 3)) {
        return {
          allowed: true,
          toNode: "design",
          toStatus: "stalled",
          reason: input.event.reason ?? "design-no-report: exhausted design nudges -> stalled",
          ruleId: "rule-09-feature-design-question",
        };
      }
      return {
        allowed: true,
        toNode: "design",
        toStatus: "running",
        reason: "question without report: stay in design, nudge",
        ruleId: "rule-09-feature-design-question",
        action: { nudgeThread: true },
      };
    },
  },

  // ── Row 10: feature | spec | spec_delivered -> spec_review (running)
  {
    id: "rule-10-feature-spec-delivered",
    rowNumber: 10,
    route: "feature",
    node: "spec",
    status: "running",
    eventType: "spec_delivered",
    description: "сдан коммит спеки, договор не затронут -> spec_review",
    resolve(input) {
      if (input.event.type !== "spec_delivered") return null;
      if (
        input.event.acceptanceTampered ||
        input.event.filesOutsideDocs ||
        input.event.invalidCodebaseReference
      )
        return null;
      return {
        allowed: true,
        toNode: "spec_review",
        toStatus: "running",
        reason: "spec commit delivered, contract untouched -> spec_review",
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
      if (input.event.type !== "spec_delivered") return null;
      if (input.event.filesOutsideDocs || input.event.invalidCodebaseReference)
        return null;
      return {
        allowed: true,
        toNode: "spec_review",
        toStatus: "running",
        reason: "docs spec delivered -> spec_review",
        ruleId: "rule-11-docs-spec-delivered",
        action: { dispatchNode: "spec_review" },
      };
    },
  },

  // ── Row 12: feature, docs | spec | invalid_codebase_reference -> retry or blocked (§31.6, r34.2)
  {
    id: "rule-12-spec-invalid-codebase-reference",
    rowNumber: 12,
    route: ["feature", "docs"],
    node: "spec",
    status: "running",
    eventType: ["spec_delivered", "spec_invalid_reference"],
    description: "спецификация ссылается на непомеченные несуществующие файлы/символы -> отказ захода (до 3 раз, затем blocked)",
    resolve(input) {
      const isInvalid =
        input.event.type === "spec_invalid_reference" ||
        (input.event.type === "spec_delivered" && input.event.invalidCodebaseReference === true);
      if (!isInvalid) return null;

      const attempts = input.counters.spec_attempts + 1;
      if (attempts >= 3) {
        return {
          allowed: true,
          toNode: "spec",
          toStatus: "blocked",
          reason:
            "spec-refused: invalid-codebase-reference: непомеченные несуществующие файлы/символы (попытка " +
            attempts +
            " >= 3) -> blocked",
          ruleId: "rule-12-spec-invalid-codebase-reference",
          counterUpdates: { spec_attempts: attempts },
          action: { escalateArchitect: true },
        };
      }
      return {
        allowed: true,
        toNode: "spec",
        toStatus: "running",
        reason:
          "spec-refused: invalid-codebase-reference: непомеченные несуществующие файлы или символы (попытка " +
          attempts +
          " < 3) -> retry",
        ruleId: "rule-12-spec-invalid-codebase-reference",
        counterUpdates: { spec_attempts: attempts },
        action: { retryDispatch: true, dispatchNode: "spec" },
      };
    },
  },

  // ── Row 13: feature | spec | spec_delivered acceptance tampered -> retry or blocked
  {
    id: "rule-13-feature-spec-acceptance-modified",
    rowNumber: 13,
    route: "feature",
    node: "spec",
    status: "running",
    eventType: "spec_delivered",
    description: "договор приёмки изменён -> отказ захода (до 3 раз, затем blocked)",
    resolve(input) {
      if (input.event.type !== "spec_delivered" || !input.event.acceptanceTampered)
        return null;
      const attempts = input.counters.spec_attempts + 1;
      if (attempts >= 3) {
        return {
          allowed: true,
          toNode: "spec",
          toStatus: "blocked",
          reason:
            "spec-refused: acceptance-contract-modified: изменение договора приёмки запрещено (попытка " +
            attempts +
            " >= 3) -> blocked",
          ruleId: "rule-13-feature-spec-acceptance-modified",
          counterUpdates: { spec_attempts: attempts },
          action: { escalateArchitect: true },
        };
      }
      return {
        allowed: true,
        toNode: "spec",
        toStatus: "running",
        reason:
          "spec-refused: acceptance-contract-modified: договор приёмки изменён (попытка " +
          attempts +
          " < 3) -> retry",
        ruleId: "rule-13-feature-spec-acceptance-modified",
        counterUpdates: { spec_attempts: attempts },
        action: { retryDispatch: true, dispatchNode: "spec" },
      };
    },
  },

  // ── Row 14: feature, docs | spec | spec_failed -> running (reissue) or stalled
  {
    id: "rule-14-spec-failed",
    rowNumber: 14,
    route: ["feature", "docs"],
    node: "spec",
    status: "running",
    eventType: "spec_failed",
    description: "сбой/квота на spec -> перевыпуск или stalled",
    resolve(input) {
      if (input.event.type !== "spec_failed") return null;
      if (input.event.exhausted) {
        return {
          allowed: true,
          toNode: "spec",
          toStatus: "stalled",
          reason: input.event.reason ?? "spec attempts exhausted -> stalled",
          ruleId: "rule-14-spec-failed",
        };
      }
      return {
        allowed: true,
        toNode: "spec",
        toStatus: "running",
        reason: input.event.reason ?? "spec retry -> running",
        ruleId: "rule-14-spec-failed",
        action: { retryDispatch: true, dispatchNode: "spec" },
      };
    },
  },

  // ── Row 15: feature, docs | spec | filesOutsideDocs / question -> retry/blocked/nudge/stalled
  {
    id: "rule-15-spec-question-or-files-outside-docs",
    rowNumber: 15,
    route: ["feature", "docs"],
    node: "spec",
    status: "running",
    eventType: ["spec_delivered", "spec_question_or_no_report"],
    description: "коммит затрагивает файлы вне docs или вопрос -> инкремент spec_attempts / nudge / stalled",
    resolve(input) {
      if (input.event.type === "spec_question_or_no_report") {
        if (input.event.exhausted || (typeof input.event.nudgeCount === "number" && input.event.nudgeCount >= 3)) {
          return {
            allowed: true,
            toNode: "spec",
            toStatus: "stalled",
            reason: input.event.reason ?? "spec-no-report: exhausted spec nudges -> stalled",
            ruleId: "rule-15-spec-question-or-files-outside-docs",
          };
        }
        return {
          allowed: true,
          toNode: "spec",
          toStatus: "running",
          reason: "question without report: stay in spec, nudge",
          ruleId: "rule-15-spec-question-or-files-outside-docs",
          action: { nudgeThread: true },
        };
      }

      if (input.event.type === "spec_delivered" && input.event.filesOutsideDocs) {
        const attempts = input.counters.spec_attempts + 1;
        if (attempts >= 3) {
          return {
            allowed: true,
            toNode: "spec",
            toStatus: "blocked",
            reason:
              "spec-refused: files outside docs (attempt " +
              attempts +
              " >= 3) -> blocked",
            ruleId: "rule-15-spec-question-or-files-outside-docs",
            counterUpdates: { spec_attempts: attempts },
            action: { escalateArchitect: true },
          };
        }
        return {
          allowed: true,
          toNode: "spec",
          toStatus: "running",
          reason: "spec-refused: changes outside docs/ -> retry",
          ruleId: "rule-15-spec-question-or-files-outside-docs",
          counterUpdates: { spec_attempts: attempts },
          action: { retryDispatch: true, dispatchNode: "spec" },
        };
      }
      return null;
    },
  },

  // ── Row 16: feature | spec_review | verdict OK manual mode -> owner_gate (waiting_approval)
  {
    id: "rule-16-feature-spec-review-ok-manual",
    rowNumber: 16,
    route: "feature",
    node: "spec_review",
    status: "running",
    mode: "manual",
    eventType: "spec_review_verdict",
    description: "feature вердикт OK в manual -> owner_gate (pre_code, waiting_approval)",
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
        reason: "feature spec review passed OK -> owner_gate (manual mode, pre_code)",
        ruleId: "rule-16-feature-spec-review-ok-manual",
        action: { setPayload: { gate_stage: "pre_code" } },
      };
    },
  },

  // ── Row 17: feature | spec_review | verdict OK auto mode -> code (running)
  {
    id: "rule-17-feature-spec-review-ok-auto",
    rowNumber: 17,
    route: "feature",
    node: "spec_review",
    status: "running",
    mode: "auto",
    eventType: "spec_review_verdict",
    description: "feature вердикт OK в auto -> code (running)",
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
        reason: "feature spec review passed OK -> code (auto mode)",
        ruleId: "rule-17-feature-spec-review-ok-auto",
        action: { dispatchNode: "code" },
      };
    },
  },

  // ── Row 18: docs | spec_review | verdict OK manual mode -> owner_gate (pre_release, waiting_approval)
  {
    id: "rule-18-docs-spec-review-ok-manual",
    rowNumber: 18,
    route: "docs",
    node: "spec_review",
    status: "running",
    mode: "manual",
    eventType: "spec_review_verdict",
    description: "docs вердикт OK в manual -> owner_gate (pre_release, waiting_approval)",
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
        reason: "docs spec review passed OK -> owner_gate (manual mode, pre_release)",
        ruleId: "rule-18-docs-spec-review-ok-manual",
        action: { setPayload: { gate_stage: "pre_release" } },
      };
    },
  },

  // ── Row 19: docs | spec_review | verdict OK auto mode -> release (running)
  {
    id: "rule-19-docs-spec-review-ok-auto",
    rowNumber: 19,
    route: "docs",
    node: "spec_review",
    status: "running",
    mode: "auto",
    eventType: "spec_review_verdict",
    description: "docs вердикт OK в auto -> release (running)",
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
        reason: "docs spec review passed OK -> release (auto mode)",
        ruleId: "rule-19-docs-spec-review-ok-auto",
        action: { dispatchNode: "release" },
      };
    },
  },

  // ── Row 20: feature, docs | spec_review | verdict CHANGES round < 3 -> spec (running loop)
  {
    id: "rule-20-spec-review-changes-loop",
    rowNumber: 20,
    route: ["feature", "docs"],
    node: "spec_review",
    status: "running",
    eventType: "spec_review_verdict",
    description: "замечания ревьюера (раунд < 3) -> возврат в spec",
    resolve(input) {
      if (
        input.event.type !== "spec_review_verdict" ||
        (input.event.verdict === "OK" && (!input.event.blockers || input.event.blockers === 0))
      )
        return null;
      const rounds = input.counters.spec_review_rounds + 1;
      if (rounds >= 3) return null;
      return {
        allowed: true,
        toNode: "spec",
        toStatus: "running",
        reason: `spec review CHANGES: round ${rounds} < 3 -> return to spec`,
        ruleId: "rule-20-spec-review-changes-loop",
        counterUpdates: { spec_review_rounds: rounds },
        action: { retryDispatch: true, dispatchNode: "spec" },
      };
    },
  },

  // ── Row 21: feature, docs | spec_review | verdict CHANGES round >= 3 -> blocked
  {
    id: "rule-21-spec-review-changes-blocked",
    rowNumber: 21,
    route: ["feature", "docs"],
    node: "spec_review",
    status: "running",
    eventType: "spec_review_verdict",
    description: "замечания ревьюера (раунд >= 3) -> blocked / эскалация архитектору",
    resolve(input) {
      if (
        input.event.type !== "spec_review_verdict" ||
        (input.event.verdict === "OK" && (!input.event.blockers || input.event.blockers === 0))
      )
        return null;
      const rounds = input.counters.spec_review_rounds + 1;
      if (rounds < 3) return null;
      return {
        allowed: true,
        toNode: "spec_review",
        toStatus: "blocked",
        reason: `spec review CHANGES: round ${rounds} >= 3 reached -> blocked`,
        ruleId: "rule-21-spec-review-changes-blocked",
        counterUpdates: { spec_review_rounds: rounds },
        action: { escalateArchitect: true },
      };
    },
  },

  // ── Row 22: feature, docs | spec_review | spec_review_failed -> running (reissue) or stalled
  {
    id: "rule-22-spec-review-failed",
    rowNumber: 22,
    route: ["feature", "docs"],
    node: "spec_review",
    status: "running",
    eventType: "spec_review_failed",
    description: "сбой ревьюера спек -> перевыпуск или stalled",
    resolve(input) {
      if (input.event.type !== "spec_review_failed") return null;
      if (input.event.exhausted) {
        return {
          allowed: true,
          toNode: "spec_review",
          toStatus: "stalled",
          reason: input.event.reason ?? "spec review attempts exhausted -> stalled",
          ruleId: "rule-22-spec-review-failed",
        };
      }
      return {
        allowed: true,
        toNode: "spec_review",
        toStatus: "running",
        reason: input.event.reason ?? "spec review retry -> running",
        ruleId: "rule-22-spec-review-failed",
        action: { retryDispatch: true, dispatchNode: "spec_review" },
      };
    },
  },

  // ── Row 23: feature, docs | spec_review | spec_review_question_or_no_verdict -> nudge or stalled
  {
    id: "rule-23-spec-review-question",
    rowNumber: 23,
    route: ["feature", "docs"],
    node: "spec_review",
    status: "running",
    eventType: "spec_review_question_or_no_verdict",
    description: "ход без JSON-вердикта -> повторный nudge ревьюеру / stalled при исчерпании",
    resolve(input) {
      if (input.event.type !== "spec_review_question_or_no_verdict") return null;
      if (input.event.exhausted || (typeof input.event.nudgeCount === "number" && input.event.nudgeCount >= 3)) {
        return {
          allowed: true,
          toNode: "spec_review",
          toStatus: "stalled",
          reason: input.event.reason ?? "no-verdict: exhausted spec_review nudges -> stalled",
          ruleId: "rule-23-spec-review-question",
        };
      }
      return {
        allowed: true,
        toNode: "spec_review",
        toStatus: "running",
        reason: "question without verdict: stay in spec_review, nudge",
        ruleId: "rule-23-spec-review-question",
        action: { nudgeThread: true },
      };
    },
  },

  // ── Row 24: feature, fix, simple | owner_gate (pre_code) | approve -> code (running)
  {
    id: "rule-24-owner-gate-approve-pre-code",
    rowNumber: 24,
    route: ["feature", "fix", "simple"],
    node: "owner_gate",
    status: "waiting_approval",
    eventType: "owner_approve",
    description: "одобрено владельцем на pre_code -> code (running)",
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
          ruleId: "rule-24-owner-gate-approve-pre-code",
        };
      }
      if (input.gateStage === "pre_release") return null;
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: input.event.comment || "approved (pre_code)",
        ruleId: "rule-24-owner-gate-approve-pre-code",
        action: { dispatchNode: "code" },
      };
    },
  },

  // ── Row 25: feature, fix, simple, docs | owner_gate (pre_release) | approve -> release (running)
  {
    id: "rule-25-owner-gate-approve-pre-release",
    rowNumber: 25,
    route: ["feature", "fix", "simple", "docs"],
    node: "owner_gate",
    status: "waiting_approval",
    eventType: "owner_approve",
    description: "одобрено владельцем на pre_release -> release (running)",
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
          ruleId: "rule-25-owner-gate-approve-pre-release",
        };
      }
      if (input.route !== "docs" && input.gateStage !== "pre_release") return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "running",
        reason: input.event.comment || "approved (pre_release)",
        ruleId: "rule-25-owner-gate-approve-pre-release",
        action: { dispatchNode: "release" },
      };
    },
  },

  // ── Row 26: feature | owner_gate (pre_code) | reject -> spec or design
  {
    id: "rule-26-feature-owner-gate-reject-pre-code",
    rowNumber: 26,
    route: "feature",
    node: "owner_gate",
    status: "waiting_approval",
    eventType: "owner_reject",
    description: "возврат владельцем feature на pre_code (spec/design) -> running",
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
          ruleId: "rule-26-feature-owner-gate-reject-pre-code",
        };
      }
      if (input.gateStage === "pre_release") return null;
      const target: TaskNode = input.event.target === "design" ? "design" : "spec";
      return {
        allowed: true,
        toNode: target,
        toStatus: "running",
        reason: input.event.reason || "rejected by owner -> return to " + target,
        ruleId: "rule-26-feature-owner-gate-reject-pre-code",
        action: { dispatchNode: target },
      };
    },
  },

  // ── Row 27: fix, simple | owner_gate (pre_code) | reject -> deferred
  {
    id: "rule-27-fix-simple-owner-gate-reject-pre-code",
    rowNumber: 27,
    route: ["fix", "simple"],
    node: "owner_gate",
    status: "waiting_approval",
    eventType: "owner_reject",
    description: "отклонение договора владельцем fix/simple -> deferred",
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
          ruleId: "rule-27-fix-simple-owner-gate-reject-pre-code",
        };
      }
      if (input.gateStage === "pre_release") return null;
      if (input.event.target) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: reject --target запрещён для fix/simple при шлюзе договора",
          toNode: "owner_gate",
          toStatus: "waiting_approval",
          reason: "permission-denied: target not allowed for fix/simple at contract gate",
          ruleId: "rule-27-fix-simple-owner-gate-reject-pre-code",
        };
      }
      return {
        allowed: true,
        toNode: "owner_gate",
        toStatus: "deferred",
        reason: input.event.reason || "rejected contract by owner -> deferred",
        ruleId: "rule-27-fix-simple-owner-gate-reject-pre-code",
      };
    },
  },

  // ── Row 28: feature, fix, simple, docs | owner_gate (pre_release) | reject -> target node
  {
    id: "rule-28-owner-gate-reject-pre-release",
    rowNumber: 28,
    route: ["feature", "fix", "simple", "docs"],
    node: "owner_gate",
    status: "waiting_approval",
    eventType: "owner_reject",
    description: "возврат владельцем на pre_release -> допустимый узел возврата (code/spec/design)",
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
          ruleId: "rule-28-owner-gate-reject-pre-release",
        };
      }
      if (input.route !== "docs" && input.gateStage !== "pre_release") return null;

      let target: TaskNode = input.event.target ?? (input.route === "docs" ? "spec" : "code");
      if (input.route === "feature" && !["code", "spec", "design"].includes(target)) target = "code";
      if ((input.route === "fix" || input.route === "simple") && target !== "code") target = "code";
      if (input.route === "docs" && target !== "spec") target = "spec";

      return {
        allowed: true,
        toNode: target,
        toStatus: "running",
        reason: input.event.reason || "rejected on pre_release by owner -> return to " + target,
        ruleId: "rule-28-owner-gate-reject-pre-release",
        action: { dispatchNode: target },
      };
    },
  },

  // ── Row 29: fix, simple | owner_gate | owner_enqueue_acceptance -> waiting_approval
  {
    id: "rule-29-fix-simple-owner-gate-update-acceptance",
    rowNumber: 29,
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
          ruleId: "rule-29-fix-simple-owner-gate-update-acceptance",
        };
      }
      if (input.gateStage === "pre_release") {
        return {
          allowed: false,
          errorCode: "acceptance-contract-immutable",
          errorMessage:
            "acceptance-contract-immutable: договор приёмки неизменяем на этапе pre_release",
          toNode: "owner_gate",
          toStatus: input.status,
          reason: "acceptance-contract-immutable: gate_stage is pre_release",
          ruleId: "rule-29-fix-simple-owner-gate-update-acceptance",
        };
      }
      return {
        allowed: true,
        toNode: "owner_gate",
        toStatus: "waiting_approval",
        reason: "update-acceptance",
        ruleId: "rule-29-fix-simple-owner-gate-update-acceptance",
        action: { commitAcceptance: true },
      };
    },
  },

  // ── Row 30: * | [любой узел] | owner_defer -> deferred
  {
    id: "rule-30-owner-gate-defer",
    rowNumber: 30,
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
          ruleId: "rule-30-owner-gate-defer",
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
          ruleId: "rule-30-owner-gate-defer",
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
          ruleId: "rule-30-owner-gate-defer",
        };
      }
      return {
        allowed: true,
        toNode: input.node,
        toStatus: "deferred",
        reason: input.event.reason || "deferred by owner",
        ruleId: "rule-30-owner-gate-defer",
      };
    },
  },

  // ── Row 31: feature, fix, simple, docs | owner_gate | owner_gate_timeout -> waiting_approval
  {
    id: "rule-31-owner-gate-timeout",
    rowNumber: 31,
    route: ["feature", "fix", "simple", "docs"],
    node: "owner_gate",
    status: "waiting_approval",
    eventType: "owner_gate_timeout",
    description: "таймаут карточки взаимодействия / рестарт сервера -> остаётся в waiting_approval",
    resolve(input) {
      if (input.event.type !== "owner_gate_timeout") return null;
      return {
        allowed: true,
        toNode: "owner_gate",
        toStatus: "waiting_approval",
        reason:
          "gate-timeout: card timed out / server restart, awaiting owner action",
        ruleId: "rule-31-owner-gate-timeout",
      };
    },
  },

  // ── Row 32: fix, simple | code | route_violation -> design (running, feature) (§31.7, r34.2)
  {
    id: "rule-32-code-route-violation",
    rowNumber: 32,
    route: ["fix", "simple"],
    node: "code",
    status: "running",
    eventType: ["code_delivered", "code_route_violation"],
    description: "выход за рамки fix/simple (лимиты файлов/строк, миграции, спеки, API) -> эскалация в feature/design",
    resolve(input) {
      const isViolation =
        input.event.type === "code_route_violation" ||
        (input.event.type === "code_delivered" && input.event.routeViolation === true);
      if (!isViolation) return null;

      return {
        allowed: true,
        toNode: "design",
        toStatus: "running",
        reason: "route_violation: fix/simple exceeded boundaries -> escalate to feature/design",
        ruleId: "rule-32-code-route-violation",
        action: {
          dispatchNode: "design",
          setPayload: { route_escalated: "feature" },
        },
      };
    },
  },

  // ── Row 33: feature, fix, simple | code | code_delivered OK -> checks (running)
  {
    id: "rule-33-code-delivered-ok",
    rowNumber: 33,
    route: ["feature", "fix", "simple"],
    node: "code",
    status: "running",
    eventType: "code_delivered",
    description: "сдан коммит кода -> checks (running)",
    resolve(input) {
      if (input.event.type !== "code_delivered") return null;
      if (input.event.routeViolation || input.event.acceptanceTampered) return null;
      if (!input.event.noCode && (input.event.commits === undefined || input.event.commits <= 0)) return null;
      return {
        allowed: true,
        toNode: "checks",
        toStatus: "running",
        reason: "code delivered ok -> advance to checks",
        ruleId: "rule-33-code-delivered-ok",
        action: { dispatchNode: "checks" },
      };
    },
  },

  // ── Row 34: feature, fix, simple | code | code_delivered acceptance tampered -> retry or blocked
  {
    id: "rule-34-code-acceptance-tampered",
    rowNumber: 34,
    route: ["feature", "fix", "simple"],
    node: "code",
    status: "running",
    eventType: "code_delivered",
    description: "изменён договор приёмки -> отказ сдачи (до 3 раз, затем blocked)",
    resolve(input) {
      if (input.event.type !== "code_delivered" || !input.event.acceptanceTampered)
        return null;
      const attempts = input.counters.code_attempts + 1;
      if (attempts >= 3) {
        return {
          allowed: true,
          toNode: "code",
          toStatus: "blocked",
          reason:
            "acceptance-contract-tampered: изменение договора приёмки запрещено (попытка " +
            attempts +
            " >= 3) -> blocked",
          ruleId: "rule-34-code-acceptance-tampered",
          counterUpdates: { code_attempts: attempts },
          action: { escalateArchitect: true },
        };
      }
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason:
          "acceptance-contract-tampered: договор приёмки изменён (попытка " +
          attempts +
          " < 3) -> retry",
        ruleId: "rule-34-code-acceptance-tampered",
        counterUpdates: { code_attempts: attempts },
        action: { retryDispatch: true, dispatchNode: "code" },
      };
    },
  },

  // ── Row 35: feature, fix, simple | code | code_delivered no commits -> code (retry or blocked)
  {
    id: "rule-35-code-no-commits",
    rowNumber: 35,
    route: ["feature", "fix", "simple"],
    node: "code",
    status: "running",
    eventType: "code_delivered",
    description: "сдача со статусом done без коммитов -> отказ (до 3 раз, затем blocked)",
    resolve(input) {
      if (
        input.event.type !== "code_delivered" ||
        (input.event.commits !== undefined && input.event.commits > 0) ||
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
        ruleId: "rule-35-code-no-commits",
        counterUpdates: { code_attempts: nextAttempts },
        action: blocked
          ? { escalateArchitect: true }
          : { dispatchNode: "code" },
      };
    },
  },

  // ── Row 36: feature, fix, simple | code | code_failed -> running (reissue) or stalled
  {
    id: "rule-36-code-failed",
    rowNumber: 36,
    route: ["feature", "fix", "simple"],
    node: "code",
    status: "running",
    eventType: "code_failed",
    description: "сбой исполнителя кода -> перевыпуск или stalled",
    resolve(input) {
      if (input.event.type !== "code_failed") return null;
      if (input.event.exhausted) {
        return {
          allowed: true,
          toNode: "code",
          toStatus: "stalled",
          reason: input.event.reason ?? "code executor attempts exhausted -> stalled",
          ruleId: "rule-36-code-failed",
        };
      }
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: input.event.reason ?? "code retry -> running",
        ruleId: "rule-36-code-failed",
        action: { retryDispatch: true, dispatchNode: "code" },
      };
    },
  },

  // ── Row 37: feature, fix, simple | code | code_question_or_no_report -> nudge or stalled
  {
    id: "rule-37-code-question",
    rowNumber: 37,
    route: ["feature", "fix", "simple"],
    node: "code",
    status: "running",
    eventType: "code_question_or_no_report",
    description: "ход завершился вопросом без коммита -> nudge на code / stalled при исчерпании",
    resolve(input) {
      if (input.event.type !== "code_question_or_no_report") return null;
      if (input.event.exhausted || (typeof input.event.nudgeCount === "number" && input.event.nudgeCount >= 3)) {
        return {
          allowed: true,
          toNode: "code",
          toStatus: "stalled",
          reason: input.event.reason ?? "code-no-commits: exhausted nudges without commits -> stalled",
          ruleId: "rule-37-code-question",
        };
      }
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: "question without artifact: stay in code, nudge",
        ruleId: "rule-37-code-question",
        action: { nudgeThread: true },
      };
    },
  },

  // ── Row 38: feature, fix, simple | code | code_reject -> code (running retry)
  {
    id: "rule-38-code-reject",
    rowNumber: 38,
    route: ["feature", "fix", "simple"],
    node: "code",
    status: ["running", "stalled"],
    eventType: "code_reject",
    description: "ручной возврат на доработку владельцем/координатором -> code (running)",
    resolve(input) {
      if (input.event.type !== "code_reject") return null;
      if (input.event.isOwnerOrCoordinator === false) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: owner-or-coordinator-only",
          toNode: "code",
          toStatus: input.status,
          reason: "permission-denied: owner-or-coordinator-only",
          ruleId: "rule-38-code-reject",
        };
      }
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: input.event.reason || "code rejected for rework -> retry code",
        ruleId: "rule-38-code-reject",
        action: { retryDispatch: true, dispatchNode: "code" },
      };
    },
  },

  // ── Row 39: feature, fix, simple | checks | exit 0 -> review (running)
  {
    id: "rule-39-checks-passed",
    rowNumber: 39,
    route: ["feature", "fix", "simple"],
    node: "checks",
    status: "running",
    eventType: "checks_result",
    description: "все тесты прошли (exit 0) -> review (running)",
    resolve(input) {
      if (input.event.type !== "checks_result") return null;
      if (input.event.notRun || input.event.exitCode !== 0) return null;
      return {
        allowed: true,
        toNode: "review",
        toStatus: "running",
        reason: "all checks passed (exit 0) -> review",
        ruleId: "rule-39-checks-passed",
        counterUpdates: { check_attempts: 0 },
        action: { dispatchNode: "review" },
      };
    },
  },

  // ── Row 40: feature, fix, simple | checks | exit != 0 attempts < 3 -> code (running loop)
  {
    id: "rule-40-checks-failed-loop",
    rowNumber: 40,
    route: ["feature", "fix", "simple"],
    node: "checks",
    status: "running",
    eventType: "checks_result",
    description: "ошибка тестов (попытка < 3) -> возврат в code",
    resolve(input) {
      if (input.event.type !== "checks_result") return null;
      if (input.event.notRun || input.event.exitCode === 0) return null;
      const attempts = input.counters.check_attempts + 1;
      if (attempts >= 3) return null;
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: `checks failed (exit ${input.event.exitCode}): attempt ${attempts} < 3 -> return to code`,
        ruleId: "rule-40-checks-failed-loop",
        counterUpdates: { check_attempts: attempts },
        action: { retryDispatch: true, dispatchNode: "code" },
      };
    },
  },

  // ── Row 41: feature, fix, simple | checks | exit != 0 attempts >= 3 -> blocked
  {
    id: "rule-41-checks-failed-blocked",
    rowNumber: 41,
    route: ["feature", "fix", "simple"],
    node: "checks",
    status: "running",
    eventType: "checks_result",
    description: "ошибка тестов (попытка >= 3) -> blocked / эскалация архитектору",
    resolve(input) {
      if (input.event.type !== "checks_result") return null;
      if (input.event.notRun || input.event.exitCode === 0) return null;
      const attempts = input.counters.check_attempts + 1;
      if (attempts < 3) return null;
      return {
        allowed: true,
        toNode: "checks",
        toStatus: "blocked",
        reason: `checks failed (exit ${input.event.exitCode}): attempt ${attempts} >= 3 reached -> blocked`,
        ruleId: "rule-41-checks-failed-blocked",
        counterUpdates: { check_attempts: attempts },
        action: { escalateArchitect: true },
      };
    },
  },

  // ── Row 42: feature, fix, simple | checks | not_run -> stalled
  {
    id: "rule-42-checks-not-run",
    rowNumber: 42,
    route: ["feature", "fix", "simple"],
    node: "checks",
    status: "running",
    eventType: "checks_result",
    description: "тесты не запустились (таймаут/запрещённая команда) -> stalled",
    resolve(input) {
      if (input.event.type !== "checks_result" || !input.event.notRun) return null;
      return {
        allowed: true,
        toNode: "checks",
        toStatus: "stalled",
        reason:
          "stalled: checks-not-run: таймаут / недопустимая команда проверки",
        ruleId: "rule-42-checks-not-run",
      };
    },
  },

  // ── Row 43: feature | review | verdict OK -> design_check (running)
  {
    id: "rule-43-feature-review-ok",
    rowNumber: 43,
    route: "feature",
    node: "review",
    status: "running",
    eventType: "review_verdict",
    description: "feature вердикт ревью OK -> design_check (running)",
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
        reason: "code review passed OK (feature) -> design_check",
        ruleId: "rule-43-feature-review-ok",
        action: { dispatchNode: "design_check" },
      };
    },
  },

  // ── Row 44: fix, simple | review | verdict OK manual mode -> owner_gate (waiting_approval) (Б1)
  {
    id: "rule-44-fix-simple-review-ok-manual",
    rowNumber: 44,
    route: ["fix", "simple"],
    node: "review",
    status: "running",
    mode: "manual",
    eventType: "review_verdict",
    description: "fix/simple вердикт ревью OK в manual -> owner_gate (pre_release, waiting_approval)",
    resolve(input) {
      if (
        input.event.type !== "review_verdict" ||
        input.event.verdict !== "OK" ||
        (input.event.blockers && input.event.blockers > 0)
      )
        return null;
      return {
        allowed: true,
        toNode: "owner_gate",
        toStatus: "waiting_approval",
        reason: "code review passed OK (fix/simple, manual mode) -> owner_gate (pre_release)",
        ruleId: "rule-44-fix-simple-review-ok-manual",
        action: { setPayload: { gate_stage: "pre_release" } },
      };
    },
  },

  // ── Row 45: fix, simple | review | verdict OK auto mode -> release (running)
  {
    id: "rule-45-fix-simple-review-ok-auto",
    rowNumber: 45,
    route: ["fix", "simple"],
    node: "review",
    status: "running",
    mode: "auto",
    eventType: "review_verdict",
    description: "fix/simple вердикт ревью OK в auto -> release (running)",
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
        reason: "code review passed OK (fix/simple, auto mode) -> release",
        ruleId: "rule-45-fix-simple-review-ok-auto",
        action: { dispatchNode: "release" },
      };
    },
  },

  // ── Row 46: feature, fix, simple | review | verdict CHANGES round < 3 -> code (running loop)
  {
    id: "rule-46-review-changes-loop",
    rowNumber: 46,
    route: ["feature", "fix", "simple"],
    node: "review",
    status: "running",
    eventType: "review_verdict",
    description: "замечания ревьюера (раунд < 3) -> возврат в code",
    resolve(input) {
      if (
        input.event.type !== "review_verdict" ||
        (input.event.verdict === "OK" && (!input.event.blockers || input.event.blockers === 0))
      )
        return null;
      const rounds = input.counters.code_review_rounds + 1;
      if (rounds >= 3) return null;
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: `code review CHANGES: round ${rounds} < 3 -> return to code`,
        ruleId: "rule-46-review-changes-loop",
        counterUpdates: { code_review_rounds: rounds },
        action: { retryDispatch: true, dispatchNode: "code" },
      };
    },
  },

  // ── Row 47: feature, fix, simple | review | verdict CHANGES round >= 3 -> blocked
  {
    id: "rule-47-review-changes-blocked",
    rowNumber: 47,
    route: ["feature", "fix", "simple"],
    node: "review",
    status: "running",
    eventType: "review_verdict",
    description: "замечания ревьюера (раунд >= 3) -> blocked / эскалация архитектору",
    resolve(input) {
      if (
        input.event.type !== "review_verdict" ||
        (input.event.verdict === "OK" && (!input.event.blockers || input.event.blockers === 0))
      )
        return null;
      const rounds = input.counters.code_review_rounds + 1;
      if (rounds < 3) return null;
      return {
        allowed: true,
        toNode: "review",
        toStatus: "blocked",
        reason: `code review CHANGES: round ${rounds} >= 3 reached -> blocked`,
        ruleId: "rule-47-review-changes-blocked",
        counterUpdates: { code_review_rounds: rounds },
        action: { escalateArchitect: true },
      };
    },
  },

  // ── Row 48: feature, fix, simple | review | review_failed -> running (reissue) or stalled
  {
    id: "rule-48-review-failed",
    rowNumber: 48,
    route: ["feature", "fix", "simple"],
    node: "review",
    status: "running",
    eventType: "review_failed",
    description: "сбой ревьюера кода -> перевыпуск или stalled",
    resolve(input) {
      if (input.event.type !== "review_failed") return null;
      if (input.event.exhausted) {
        return {
          allowed: true,
          toNode: "review",
          toStatus: "stalled",
          reason: input.event.reason ?? "code review attempts exhausted -> stalled",
          ruleId: "rule-48-review-failed",
        };
      }
      return {
        allowed: true,
        toNode: "review",
        toStatus: "running",
        reason: input.event.reason ?? "code review retry -> running",
        ruleId: "rule-48-review-failed",
        action: { retryDispatch: true, dispatchNode: "review" },
      };
    },
  },

  // ── Row 49: feature, fix, simple | review | review_question_or_no_verdict -> nudge or stalled
  {
    id: "rule-49-review-question",
    rowNumber: 49,
    route: ["feature", "fix", "simple"],
    node: "review",
    status: "running",
    eventType: "review_question_or_no_verdict",
    description: "ход без JSON-вердикта ревью -> nudge ревьюеру / stalled при исчерпании",
    resolve(input) {
      if (input.event.type !== "review_question_or_no_verdict") return null;
      if (input.event.exhausted || (typeof input.event.nudgeCount === "number" && input.event.nudgeCount >= 3)) {
        return {
          allowed: true,
          toNode: "review",
          toStatus: "stalled",
          reason: input.event.reason ?? "no-verdict: exhausted review nudges -> stalled",
          ruleId: "rule-49-review-question",
        };
      }
      return {
        allowed: true,
        toNode: "review",
        toStatus: "running",
        reason: "question without verdict: stay in review, nudge",
        ruleId: "rule-49-review-question",
        action: { nudgeThread: true },
      };
    },
  },

  // ── Row 50: feature | design_check | verdict OK manual mode -> owner_gate (waiting_approval) (Б1)
  {
    id: "rule-50-feature-design-check-ok-manual",
    rowNumber: 50,
    route: "feature",
    node: "design_check",
    status: "running",
    mode: "manual",
    eventType: "design_check_verdict",
    description: "feature вердикт design_check OK в manual -> owner_gate (pre_release, waiting_approval)",
    resolve(input) {
      if (
        input.event.type !== "design_check_verdict" ||
        input.event.verdict !== "OK" ||
        (input.event.blockers && input.event.blockers > 0)
      )
        return null;
      return {
        allowed: true,
        toNode: "owner_gate",
        toStatus: "waiting_approval",
        reason: "design_check passed OK (manual mode) -> owner_gate (pre_release)",
        ruleId: "rule-50-feature-design-check-ok-manual",
        action: { setPayload: { gate_stage: "pre_release" } },
      };
    },
  },

  // ── Row 51: feature | design_check | verdict OK auto mode -> release (running)
  {
    id: "rule-51-feature-design-check-ok-auto",
    rowNumber: 51,
    route: "feature",
    node: "design_check",
    status: "running",
    mode: "auto",
    eventType: "design_check_verdict",
    description: "feature вердикт design_check OK в auto -> release (running)",
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
        reason: "design_check passed OK (auto mode) -> release",
        ruleId: "rule-51-feature-design-check-ok-auto",
        action: { dispatchNode: "release" },
      };
    },
  },

  // ── Row 52: feature | design_check | verdict CHANGES target=code -> code (running loop)
  {
    id: "rule-52-feature-design-check-changes-code",
    rowNumber: 52,
    route: "feature",
    node: "design_check",
    status: "running",
    eventType: "design_check_verdict",
    description: "замечания по кодовой части (target: code) -> возврат в code",
    resolve(input) {
      if (
        input.event.type !== "design_check_verdict" ||
        (input.event.verdict === "OK" && (!input.event.blockers || input.event.blockers === 0)) ||
        input.event.target === "design"
      )
        return null;
      const rounds = input.counters.design_check_rounds + 1;
      if (rounds >= 3) return null;
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: `design_check CHANGES target=code: round ${rounds} < 3 -> return to code`,
        ruleId: "rule-52-feature-design-check-changes-code",
        counterUpdates: { design_check_rounds: rounds },
        action: { retryDispatch: true, dispatchNode: "code" },
      };
    },
  },

  // ── Row 53: feature | design_check | verdict CHANGES target=design -> design (running loop)
  {
    id: "rule-53-feature-design-check-changes-design",
    rowNumber: 53,
    route: "feature",
    node: "design_check",
    status: "running",
    eventType: "design_check_verdict",
    description: "замечания по архитектуре (target: design) -> возврат в design",
    resolve(input) {
      if (
        input.event.type !== "design_check_verdict" ||
        (input.event.verdict === "OK" && (!input.event.blockers || input.event.blockers === 0)) ||
        input.event.target !== "design"
      )
        return null;
      const rounds = input.counters.design_check_rounds + 1;
      if (rounds >= 3) return null;
      return {
        allowed: true,
        toNode: "design",
        toStatus: "running",
        reason: `design_check CHANGES target=design: round ${rounds} < 3 -> return to design`,
        ruleId: "rule-53-feature-design-check-changes-design",
        counterUpdates: {
          design_check_rounds: rounds,
          spec_attempts: 0,
          spec_review_rounds: 0,
          code_attempts: 0,
          check_attempts: 0,
          code_review_rounds: 0,
        },
        action: { retryDispatch: true, dispatchNode: "design" },
      };
    },
  },

  // ── Row 54: feature | design_check | verdict CHANGES round >= 3 -> blocked
  {
    id: "rule-54-feature-design-check-changes-blocked",
    rowNumber: 54,
    route: "feature",
    node: "design_check",
    status: "running",
    eventType: "design_check_verdict",
    description: "замечания design_check (раунд >= 3) -> blocked / эскалация архитектору",
    resolve(input) {
      if (
        input.event.type !== "design_check_verdict" ||
        (input.event.verdict === "OK" && (!input.event.blockers || input.event.blockers === 0))
      )
        return null;
      const rounds = input.counters.design_check_rounds + 1;
      if (rounds < 3) return null;
      return {
        allowed: true,
        toNode: "design_check",
        toStatus: "blocked",
        reason: `design_check CHANGES: round ${rounds} >= 3 reached -> blocked`,
        ruleId: "rule-54-feature-design-check-changes-blocked",
        counterUpdates: { design_check_rounds: rounds },
        action: { escalateArchitect: true },
      };
    },
  },

  // ── Row 55: feature | design_check | design_check_failed -> running (reissue) or stalled
  {
    id: "rule-55-feature-design-check-failed",
    rowNumber: 55,
    route: "feature",
    node: "design_check",
    status: "running",
    eventType: "design_check_failed",
    description: "сбой архитектора design_check -> перевыпуск или stalled",
    resolve(input) {
      if (input.event.type !== "design_check_failed") return null;
      if (input.event.exhausted) {
        return {
          allowed: true,
          toNode: "design_check",
          toStatus: "stalled",
          reason: input.event.reason ?? "design_check attempts exhausted -> stalled",
          ruleId: "rule-55-feature-design-check-failed",
        };
      }
      return {
        allowed: true,
        toNode: "design_check",
        toStatus: "running",
        reason: input.event.reason ?? "design_check retry -> running",
        ruleId: "rule-55-feature-design-check-failed",
        action: { retryDispatch: true, dispatchNode: "design_check" },
      };
    },
  },

  // ── Row 56: feature | design_check | design_check_question_or_no_verdict -> nudge or stalled
  {
    id: "rule-56-feature-design-check-question",
    rowNumber: 56,
    route: "feature",
    node: "design_check",
    status: "running",
    eventType: "design_check_question_or_no_verdict",
    description: "ход без JSON-вердикта design_check -> nudge архитектору / stalled при исчерпании",
    resolve(input) {
      if (input.event.type !== "design_check_question_or_no_verdict") return null;
      if (input.event.exhausted || (typeof input.event.nudgeCount === "number" && input.event.nudgeCount >= 3)) {
        return {
          allowed: true,
          toNode: "design_check",
          toStatus: "stalled",
          reason: input.event.reason ?? "no-verdict: exhausted design_check nudges -> stalled",
          ruleId: "rule-56-feature-design-check-question",
        };
      }
      return {
        allowed: true,
        toNode: "design_check",
        toStatus: "running",
        reason: "question without verdict: stay in design_check, nudge",
        ruleId: "rule-56-feature-design-check-question",
        action: { nudgeThread: true },
      };
    },
  },

  // ── Row 57: * (push-режим) | release | release_published -> release (done)
  {
    id: "rule-57-release-published-push",
    rowNumber: 57,
    route: "*",
    node: "release",
    status: "running",
    eventType: "release_published",
    description: "успешная публикация в push-режиме -> done",
    resolve(input) {
      if (input.event.type !== "release_published" || input.event.prMode)
        return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "done",
        reason: "release published to main (push mode) -> done",
        ruleId: "rule-57-release-published-push",
      };
    },
  },

  // ── Row 58: * (pr-режим) | release | release_published -> release (pr_open)
  {
    id: "rule-58-release-published-pr",
    rowNumber: 58,
    route: "*",
    node: "release",
    status: "running",
    eventType: "release_published",
    description: "PR успешно открыт -> pr_open",
    resolve(input) {
      if (input.event.type !== "release_published" || !input.event.prMode)
        return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "pr_open",
        reason: "PR opened successfully -> pr_open",
        ruleId: "rule-58-release-published-pr",
      };
    },
  },

  // ── Row 59: * (pr-режим) | release | pr_merged -> release (done)
  {
    id: "rule-59-release-pr-merged",
    rowNumber: 59,
    route: "*",
    node: "release",
    status: "pr_open",
    eventType: "pr_merged",
    description: "PR слит в целевую ветку -> done",
    resolve(input) {
      if (input.event.type !== "pr_merged") return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "done",
        reason: "PR merged into target branch -> done",
        ruleId: "rule-59-release-pr-merged",
      };
    },
  },

  // ── Row 60: feature, fix, simple (pr-режим) | release | pr_changes_requested -> code (running)
  {
    id: "rule-60-release-pr-changes-requested-code",
    rowNumber: 60,
    route: ["feature", "fix", "simple"],
    node: "release",
    status: "pr_open",
    eventType: "pr_changes_requested",
    description: "замечания ревью в PR -> возврат в code (running)",
    resolve(input) {
      if (input.event.type !== "pr_changes_requested") return null;
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: "PR changes requested -> return to code",
        ruleId: "rule-60-release-pr-changes-requested-code",
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

  // ── Row 61: docs (pr-режим) | release | pr_changes_requested -> spec (running)
  {
    id: "rule-61-release-pr-changes-requested-docs",
    rowNumber: 61,
    route: "docs",
    node: "release",
    status: "pr_open",
    eventType: "pr_changes_requested",
    description: "замечания ревью в PR для docs -> возврат в spec (running)",
    resolve(input) {
      if (input.event.type !== "pr_changes_requested") return null;
      return {
        allowed: true,
        toNode: "spec",
        toStatus: "running",
        reason: "PR changes requested (docs) -> return to spec",
        ruleId: "rule-61-release-pr-changes-requested-docs",
        counterUpdates: {
          spec_attempts: 0,
          spec_review_rounds: 0,
          release_attempts: 0,
        },
        action: { dispatchNode: "spec" },
      };
    },
  },

  // ── Row 62: * (pr-режим) | release | pr_closed -> release (stalled)
  {
    id: "rule-62-release-pr-closed",
    rowNumber: 62,
    route: "*",
    node: "release",
    status: "pr_open",
    eventType: "pr_closed",
    description: "PR закрыт без слияния -> stalled",
    resolve(input) {
      if (input.event.type !== "pr_closed") return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "stalled",
        reason: "stalled: pr_closed: PR closed without merge",
        ruleId: "rule-62-release-pr-closed",
      };
    },
  },

  // ── Row 63: feature, fix, simple (pr-режим) | release | resume --target code -> code (running)
  {
    id: "rule-63-release-resume-pr-closed-code",
    rowNumber: 63,
    route: ["feature", "fix", "simple"],
    node: "release",
    status: "stalled",
    eventType: "resume",
    description: "resume --target code после закрытия PR -> code (running)",
    resolve(input) {
      if (input.event.type !== "resume") return null;
      if (input.event.isOwner === false) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: owner-only",
          toNode: "release",
          toStatus: "stalled",
          reason: "permission-denied: owner-only",
          ruleId: "rule-63-release-resume-pr-closed-code",
        };
      }
      if (input.event.target !== "code" || !input.event.prClosedReason)
        return null;
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: "resumed from pr_closed stalled -> code",
        ruleId: "rule-63-release-resume-pr-closed-code",
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

  // ── Row 64: docs (pr-режим) | release | resume --target spec -> spec (running)
  {
    id: "rule-64-release-resume-pr-closed-docs",
    rowNumber: 64,
    route: "docs",
    node: "release",
    status: "stalled",
    eventType: "resume",
    description: "resume --target spec после закрытия PR -> spec (running)",
    resolve(input) {
      if (input.event.type !== "resume") return null;
      if (input.event.isOwner === false) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: owner-only",
          toNode: "release",
          toStatus: "stalled",
          reason: "permission-denied: owner-only",
          ruleId: "rule-64-release-resume-pr-closed-docs",
        };
      }
      if (input.event.target !== "spec" || !input.event.prClosedReason)
        return null;
      return {
        allowed: true,
        toNode: "spec",
        toStatus: "running",
        reason: "resumed from pr_closed stalled -> spec",
        ruleId: "rule-64-release-resume-pr-closed-docs",
        counterUpdates: {
          spec_attempts: 0,
          spec_review_rounds: 0,
          release_attempts: 0,
        },
        action: { dispatchNode: "spec" },
      };
    },
  },

  // ── Row 65: * | release | release_refused_kb -> release (stalled)
  {
    id: "rule-65-release-refused-uncommitted-kb",
    rowNumber: 65,
    route: "*",
    node: "release",
    status: "running",
    eventType: "release_refused_kb",
    description: "отказ release-refused: uncommitted-kb -> release (stalled)",
    resolve(input) {
      if (input.event.type !== "release_refused_kb") return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "stalled",
        reason: "release-refused: uncommitted-kb -> stalled",
        ruleId: "rule-65-release-refused-uncommitted-kb",
      };
    },
  },

  // ── Row 66: * | release | release_refused_ui -> release (stalled)
  {
    id: "rule-66-release-refused-unmerged-ui",
    rowNumber: 66,
    route: "*",
    node: "release",
    status: "running",
    eventType: "release_refused_ui",
    description: "отказ release-refused: unmerged-ui -> release (stalled)",
    resolve(input) {
      if (input.event.type !== "release_refused_ui") return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "stalled",
        reason: "release-refused: unmerged-ui -> stalled",
        ruleId: "rule-66-release-refused-unmerged-ui",
      };
    },
  },

  // ── Row 67: * | release | release_waiting_note -> release (waiting_release_note)
  {
    id: "rule-67-release-waiting-note",
    rowNumber: 67,
    route: "*",
    node: "release",
    status: "running",
    eventType: "release_waiting_note",
    description: "пустая заметка при requireNote: true -> waiting_release_note",
    resolve(input) {
      if (input.event.type !== "release_waiting_note") return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "waiting_release_note",
        reason: "release note required -> waiting_release_note",
        ruleId: "rule-67-release-waiting-note",
      };
    },
  },

  // ── Row 68: feature, fix, simple | release | release_failed attempts < 3 -> code (running)
  {
    id: "rule-68-release-failed-code-loop",
    rowNumber: 68,
    route: ["feature", "fix", "simple"],
    node: "release",
    status: "running",
    eventType: "release_failed_checks_conflict_reject",
    description: "отказ выкладки кода attempts < 3 -> возврат в code",
    resolve(input) {
      if (input.event.type !== "release_failed_checks_conflict_reject")
        return null;
      const attempts = input.counters.release_attempts + 1;
      if (attempts >= 3) return null;
      return {
        allowed: true,
        toNode: "code",
        toStatus: "running",
        reason: `release failed: ${input.event.reason ?? "checks/conflict/reject"} (attempt ${attempts} < 3) -> code`,
        ruleId: "rule-68-release-failed-code-loop",
        counterUpdates: { release_attempts: attempts },
        action: { retryDispatch: true, dispatchNode: "code" },
      };
    },
  },

  // ── Row 69: feature, fix, simple | release | release_failed attempts >= 3 -> release (blocked)
  {
    id: "rule-69-release-failed-code-blocked",
    rowNumber: 69,
    route: ["feature", "fix", "simple"],
    node: "release",
    status: "running",
    eventType: "release_failed_checks_conflict_reject",
    description: "отказ выкладки кода attempts >= 3 -> release (blocked)",
    resolve(input) {
      if (input.event.type !== "release_failed_checks_conflict_reject")
        return null;
      const attempts = input.counters.release_attempts + 1;
      if (attempts < 3) return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "blocked",
        reason: `release failed: ${input.event.reason ?? "checks/conflict/reject"} (attempt ${attempts} >= 3) -> blocked`,
        ruleId: "rule-69-release-failed-code-blocked",
        counterUpdates: { release_attempts: attempts },
        action: { escalateArchitect: true },
      };
    },
  },

  // ── Row 70: docs | release | release_failed docs attempts < 3 -> spec (running)
  {
    id: "rule-70-release-failed-docs-loop",
    rowNumber: 70,
    route: "docs",
    node: "release",
    status: "running",
    eventType: "release_failed_checks_conflict_reject",
    description: "отказ выкладки документации attempts < 3 -> возврат в spec",
    resolve(input) {
      if (input.event.type !== "release_failed_checks_conflict_reject")
        return null;
      const attempts = input.counters.release_attempts + 1;
      if (attempts >= 3) return null;
      return {
        allowed: true,
        toNode: "spec",
        toStatus: "running",
        reason: `release failed docs: ${input.event.reason ?? "audit/reject"} (attempt ${attempts} < 3) -> spec`,
        ruleId: "rule-70-release-failed-docs-loop",
        counterUpdates: { release_attempts: attempts },
        action: { retryDispatch: true, dispatchNode: "spec" },
      };
    },
  },

  // ── Row 71: docs | release | release_failed docs attempts >= 3 -> release (blocked)
  {
    id: "rule-71-release-failed-docs-blocked",
    rowNumber: 71,
    route: "docs",
    node: "release",
    status: "running",
    eventType: "release_failed_checks_conflict_reject",
    description: "отказ выкладки документации attempts >= 3 -> release (blocked)",
    resolve(input) {
      if (input.event.type !== "release_failed_checks_conflict_reject")
        return null;
      const attempts = input.counters.release_attempts + 1;
      if (attempts < 3) return null;
      return {
        allowed: true,
        toNode: "release",
        toStatus: "blocked",
        reason: `release failed docs: ${input.event.reason ?? "audit/reject"} (attempt ${attempts} >= 3) -> blocked`,
        ruleId: "rule-71-release-failed-docs-blocked",
        counterUpdates: { release_attempts: attempts },
        action: { escalateArchitect: true },
      };
    },
  },

  // ── Row 72: * | release | release_failed_script -> release (stalled)
  {
    id: "rule-72-release-failed-script",
    rowNumber: 72,
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
        reason: `release script failure: ${input.event.reason ?? "unknown"} -> stalled`,
        ruleId: "rule-72-release-failed-script",
      };
    },
  },

  // ── Row 73: * | release | release_note_provided -> release (running)
  {
    id: "rule-73-release-note-provided",
    rowNumber: 73,
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
        ruleId: "rule-73-release-note-provided",
        action: { dispatchNode: "release" },
      };
    },
  },

  // ── Row 74: * | [любой узел] | resume from stalled (no target) -> current node (running)
  {
    id: "rule-74-resume-stalled",
    rowNumber: 74,
    route: "*",
    node: "*",
    status: "stalled",
    eventType: "resume",
    description: "возобновление из stalled без target -> текущий узел (running)",
    resolve(input) {
      if (input.event.type !== "resume") return null;
      if (input.event.target) return null;
      return {
        allowed: true,
        toNode: input.node,
        toStatus: "running",
        reason: "resumed from stalled to current node",
        ruleId: "rule-74-resume-stalled",
        action: { dispatchNode: input.node },
      };
    },
  },

  // ── Row 75: * | [любой узел] | dequeue -> cancelled
  {
    id: "rule-75-dequeue",
    rowNumber: 75,
    route: "*",
    node: "*",
    status: "*",
    eventType: "dequeue",
    description: "снятие задачи с очереди владельцем -> cancelled",
    resolve(input) {
      if (input.event.type !== "dequeue") return null;
      if (input.event.isOwner === false) {
        return {
          allowed: false,
          errorCode: "permission-denied",
          errorMessage: "permission-denied: owner-only",
          toNode: input.node,
          toStatus: input.status,
          reason: "permission-denied: owner-only",
          ruleId: "rule-75-dequeue",
        };
      }
      if (input.status === "done" || input.status === "cancelled") {
        return {
          allowed: false,
          errorCode: "invalid-status",
          errorMessage: `cannot dequeue task in status ${input.status}`,
          toNode: input.node,
          toStatus: input.status,
          reason: `task is already ${input.status}`,
          ruleId: "rule-75-dequeue",
        };
      }
      return {
        allowed: true,
        toNode: input.node,
        toStatus: "cancelled",
        reason: input.event.reason || "dequeue by owner",
        ruleId: "rule-75-dequeue",
        action: { archiveBranch: true, closePr: true },
      };
    },
  },

  // ── Row 76: * | [любой узел] | resume from blocked -> allowed target node (running)
  {
    id: "rule-76-resume-blocked",
    rowNumber: 76,
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
          ruleId: "rule-76-resume-blocked",
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
          errorMessage: `target-invalid: target ${targetNode} not allowed for route ${input.route}`,
          toNode: input.node,
          toStatus: "blocked",
          reason: `target-invalid: ${targetNode} not allowed for ${input.route}`,
          ruleId: "rule-76-resume-blocked",
        };
      }

      if (targetNode === "release" && input.node !== "release") {
        return {
          allowed: false,
          errorCode: "target-invalid",
          errorMessage:
            "target-invalid: cannot resume to release from unreviewed or unverified code",
          toNode: input.node,
          toStatus: "blocked",
          reason: "target-invalid: cannot resume to release unless blocked at release",
          ruleId: "rule-76-resume-blocked",
        };
      }

      // Counter resets depending on target
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
        reason: `resumed from blocked to ${targetNode}`,
        ruleId: "rule-76-resume-blocked",
        counterUpdates,
        action: { dispatchNode: targetNode },
      };
    },
  },

  // ── Row 77: * | [любой узел] | resume from deferred -> queued / running / waiting_approval
  {
    id: "rule-77-resume-deferred",
    rowNumber: 77,
    route: "*",
    node: "*",
    status: "deferred",
    eventType: "resume",
    description: "возобновление из deferred владельцем -> queued/running/waiting_approval",
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
          ruleId: "rule-77-resume-deferred",
        };
      }
      let targetStatus: TaskStatus = "running";
      if (input.node === "start") {
        targetStatus = "queued";
      } else if (input.node === "owner_gate") {
        targetStatus = "waiting_approval";
      } else if (input.node === "release") {
        if (
          input.event.prevStatus === "waiting_release_note" ||
          input.event.prevStatus === "pr_open"
        ) {
          targetStatus = input.event.prevStatus as TaskStatus;
        }
      }
      return {
        allowed: true,
        toNode: input.node,
        toStatus: targetStatus,
        reason: "resumed from deferred",
        ruleId: "rule-77-resume-deferred",
        action: targetStatus === "running" ? { dispatchNode: input.node } : undefined,
      };
    },
  },

  // ── Row 78: research | research | research_delivered -> research (done)
  {
    id: "rule-78-research-delivered",
    rowNumber: 78,
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
        ruleId: "rule-78-research-delivered",
      };
    },
  },

  // ── Row 79: research | research | research_failed -> running (reissue) or stalled
  {
    id: "rule-79-research-failed",
    rowNumber: 79,
    route: "research",
    node: "research",
    status: "running",
    eventType: "research_failed",
    description: "сбой исследователя -> перевыпуск или stalled",
    resolve(input) {
      if (input.event.type !== "research_failed") return null;
      if (input.event.exhausted) {
        return {
          allowed: true,
          toNode: "research",
          toStatus: "stalled",
          reason: input.event.reason ?? "research attempts exhausted -> stalled",
          ruleId: "rule-79-research-failed",
        };
      }
      return {
        allowed: true,
        toNode: "research",
        toStatus: "running",
        reason: input.event.reason ?? "research retry -> running",
        ruleId: "rule-79-research-failed",
        action: { retryDispatch: true, dispatchNode: "research" },
      };
    },
  },

  // ── Row 80: research | research | research_question_or_no_report -> nudge or stalled
  {
    id: "rule-80-research-question",
    rowNumber: 80,
    route: "research",
    node: "research",
    status: "running",
    eventType: "research_question_or_no_report",
    description: "ход исследователя без отчёта -> nudge на research / stalled при исчерпании",
    resolve(input) {
      if (input.event.type !== "research_question_or_no_report") return null;
      if (input.event.exhausted || (typeof input.event.nudgeCount === "number" && input.event.nudgeCount >= 3)) {
        return {
          allowed: true,
          toNode: "research",
          toStatus: "stalled",
          reason: input.event.reason ?? "research-no-report: exhausted nudges -> stalled",
          ruleId: "rule-80-research-question",
        };
      }
      return {
        allowed: true,
        toNode: "research",
        toStatus: "running",
        reason: "question without report: stay in research, nudge",
        ruleId: "rule-80-research-question",
        action: { nudgeThread: true },
      };
    },
  },
];

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
