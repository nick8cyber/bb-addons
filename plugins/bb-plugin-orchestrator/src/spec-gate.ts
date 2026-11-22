/**
 * Spec-before-code gate (§31.9, orchestrator-release §2, ADR-0032).
 *
 * Unified verification before dispatching code executors (CLI, RPC, run-queue,
 * reissues, route fallbacks) and before publishing releases.
 */

import { OrchestratorError } from "./errors.js";
import type { CmdRunner } from "./cmd.js";
import type {
  DelegationStore,
  TaskQueueRow,
  TaskSpecContractRow,
  TaskNode,
} from "./store.js";
import { normalizeTaskKey } from "./store.js";
import type { WorkGraphMode } from "./workgraph.js";
import type { Policy } from "./policy.js";
import type { ResolvedProject } from "./release-config.js";

export type SpecWorkKind = "behavior_change" | "bugfix" | "mechanical";

export function splitDocPaths(paths?: string | null): string[] {
  if (!paths) return [];
  return paths.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
}

export function sectionExistsInMarkdown(content: string, section?: string): boolean {
  if (!section || !content) return false;
  const cleanSection = section.replace(/^§\s*/, "").trim();
  if (!cleanSection) return false;
  const escapedClean = cleanSection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionSymbolRegex = new RegExp(`§\\s*${escapedClean}(?![\\d.])`, "m");
  if (sectionSymbolRegex.test(content)) return true;
  const headingRegex = new RegExp(`(^|\\n)#+\\s*(?:§\\s*)?${escapedClean}(?![\\d.])`, "m");
  return headingRegex.test(content);
}

export interface SpecContract {
  kind: SpecWorkKind;
  projectId?: string;
  specPath?: string;
  specSha?: string;
  specSection?: string;
  adrPath?: string;
  isArchitectural?: boolean;
  altersContract?: boolean;
  mechanicalBasis?: string;
  approvalId?: string;
  preparedBaseSha?: string;
}

export interface VerifySpecGateInput {
  taskKey: string;
  role?: string;
  noCode?: boolean;
  level?: string;
  contract?: SpecContract | null;
  store: DelegationStore;
  cmd?: CmdRunner;
  repoRoot?: string;
  baseSha?: string;
  preparedBaseSha?: string;
  workGraphMode?: WorkGraphMode;
  policy?: Policy | null;
  project?: ResolvedProject | null;
  task?: TaskQueueRow | null;
  payload?: any;
  specBeforeCode?: boolean;
}

export interface VerifyReleaseDocumentsInput {
  taskKey: string;
  store: DelegationStore;
  cmd?: CmdRunner;
  repoRoot: string;
  publishedSha: string;
  contract?: SpecContract | null;
  project?: ResolvedProject | null;
  policy?: Policy | null;
  workGraphMode?: WorkGraphMode;
  task?: any;
}

/** Check if spec-before-code enforcement is active for this invocation */
export function isSpecBeforeCodeEnforced(params: {
  workGraphMode?: WorkGraphMode;
  project?: ResolvedProject | null;
  policy?: Policy | null;
  specBeforeCode?: boolean;
}): boolean {
  if (params.specBeforeCode === false) return false;
  if ((params.policy as any)?.specBeforeCode === false) return false;
  if ((params.project as any)?.specBeforeCode === false) return false;
  if ((params.project as any)?.orchestrator?.specBeforeCode === false) return false;

  if (params.specBeforeCode === true) return true;
  if ((params.policy as any)?.specBeforeCode === true) return true;
  if ((params.project as any)?.specBeforeCode === true) return true;
  if ((params.project as any)?.orchestrator?.specBeforeCode === true) return true;

  if (params.workGraphMode === "shadow" || params.workGraphMode === "strict") {
    return true;
  }
  return false;
}

/** Parse / resolve a spec contract from all possible locations */
export function resolveTaskSpecContract(
  taskKey: string,
  store: DelegationStore,
  payload?: any,
  params?: any,
): SpecContract | null {
  // 1. Explicit in params
  if (params?.contract && typeof params.contract === "object") {
    return normalizeContract(params.contract);
  }

  const normKey = normalizeTaskKey(taskKey);

  // 2. Persisted in task_spec_contracts table
  const row = store.getSpecContract(taskKey);
  if (row) {
    const taskRow = params?.task ?? store.getTask(taskKey);
    const pl = payload ?? (() => {
      if (!taskRow?.payload) return null;
      try {
        return JSON.parse(taskRow.payload);
      } catch {
        return null;
      }
    })();
    const freshSha = taskRow?.spec_sha ?? pl?.spec_sha ?? pl?.specSha;
    const freshPath = pl?.spec_path ?? pl?.specPath;
    const freshSection = pl?.spec_section ?? pl?.specSection;
    const freshAdr = pl?.adr_path ?? pl?.adrPath;
    const freshMechBasis = pl?.mechanical_basis ?? pl?.mechanicalBasis;
    const isArch = Boolean(row.is_architectural || row.adr_path || freshAdr);
    return {
      kind: row.kind,
      projectId: row.project_id ?? undefined,
      specPath: (row.approval_id ? row.spec_path : (freshPath ?? row.spec_path)) ?? undefined,
      specSha: (row.approval_id ? row.spec_sha : (freshSha ?? row.spec_sha)) ?? undefined,
      specSection: (row.approval_id ? row.spec_section : (freshSection ?? row.spec_section)) ?? undefined,
      adrPath: (row.approval_id ? row.adr_path : (freshAdr ?? row.adr_path)) ?? undefined,
      isArchitectural: isArch,
      altersContract: Boolean(row.alters_contract),
      mechanicalBasis: (row.approval_id ? row.mechanical_basis : (freshMechBasis ?? row.mechanical_basis)) ?? undefined,
      approvalId: row.approval_id ?? undefined,
      preparedBaseSha: row.prepared_base_sha ?? undefined,
    };
  }

  const taskRow = params?.task ?? store.getTask(taskKey);
  const pl = payload ?? (() => {
    if (!taskRow?.payload) return null;
    try {
      return JSON.parse(taskRow.payload);
    } catch {
      return null;
    }
  })();

  // 3. For release: transitional contract for in-flight legacy tasks (without stored contract in DB)
  if (params?.forRelease && taskRow) {
    const isAcceptedOrInFlight =
      taskRow.node === "release" ||
      taskRow.node === "review" ||
      taskRow.node === "checks" ||
      taskRow.node === "design_check" ||
      pl?.review_verdict === "OK" ||
      pl?.code_done === true;

    // Use task's spec_sha or payload's spec_sha first, then acceptance_sha (falling back to "base" if accepted/in-flight)
    const accSha =
      taskRow.spec_sha ??
      pl?.spec_sha ??
      pl?.specSha ??
      taskRow.acceptance_sha ??
      (isAcceptedOrInFlight ? "base" : undefined);
    if (accSha) {
      const apprId = pl?.approval_id ?? pl?.approvalId ?? (isAcceptedOrInFlight ? `appr:transition:${taskRow.project_id ?? "proj"}:${normKey}:${accSha}:${taskRow.created_at || 1}` : undefined);
      if (taskRow.route === "fix") {
        return {
          kind: "bugfix",
          specPath: (pl?.spec_path ?? pl?.specPath) || `docs/specs/acceptance/${normKey}.md`,
          specSection: (pl?.spec_section ?? pl?.specSection) || undefined,
          specSha: accSha,
          altersContract: false,
          approvalId: apprId,
        };
      }
      if (taskRow.route === "simple") {
        return {
          kind: "mechanical",
          mechanicalBasis: pl?.mechanical_basis ?? pl?.mechanicalBasis ?? pl?.acceptance_text ?? `Transition contract for task ${normKey}`,
          approvalId: apprId,
        };
      }
      if (taskRow.route === "feature" || !taskRow.route) {
        return {
          kind: "behavior_change",
          specPath: (pl?.spec_path ?? pl?.specPath) || `docs/specs/acceptance/${normKey}.md`,
          specSha: accSha,
          adrPath: (pl?.adr_path ?? pl?.adrPath),
          isArchitectural: Boolean(pl?.is_architectural || pl?.isArchitectural || pl?.adr_path || pl?.adrPath),
          approvalId: apprId,
        };
      }
    }
  }

  // 4. From task payload (for pre-code gate and active task resolution)
  if (pl) {
    if (pl.spec_contract && typeof pl.spec_contract === "object") {
      return normalizeContract(pl.spec_contract);
    }
    if (pl.specContract && typeof pl.specContract === "object") {
      return normalizeContract(pl.specContract);
    }

    // Parse from acceptance_text if formatted
    if (typeof pl.acceptance_text === "string" && pl.acceptance_text.trim()) {
      const parsed = parseContractFromText(pl.acceptance_text);
      if (parsed) {
        return {
          ...parsed,
          approvalId: parsed.approvalId ?? pl.approval_id ?? pl.approvalId,
        };
      }
    }

    // Mechanical basis in payload OR simple route
    if (typeof pl.mechanical_basis === "string" || typeof pl.mechanicalBasis === "string" || taskRow?.route === "simple") {
      const basis = (pl.mechanical_basis ?? pl.mechanicalBasis ?? pl.acceptance_text) as string | undefined;
      if (basis) {
        return {
          kind: "mechanical",
          mechanicalBasis: basis,
          approvalId: pl.approval_id ?? pl.approvalId,
        };
      }
    }

    // Fix route with spec section or fix route
    if (typeof pl.spec_section === "string" || typeof pl.specSection === "string" || taskRow?.route === "fix") {
      return {
        kind: "bugfix",
        specPath: (pl.spec_path ?? pl.specPath) as string | undefined,
        specSection: ((pl.spec_section ?? pl.specSection) || "§31.9") as string,
        altersContract: Boolean(pl.alters_contract ?? pl.altersContract),
        approvalId: pl.approval_id ?? pl.approvalId,
      };
    }

    // In feature route, spec node deliverables
    if (typeof pl.spec_path === "string" || typeof pl.specPath === "string") {
      const sp = (pl.spec_path ?? pl.specPath) as string;
      const sha = (taskRow?.spec_sha ?? pl.spec_sha ?? pl.specSha) as string | undefined;
      const adr = (pl.adr_path ?? pl.adrPath) as string | undefined;
      const isArch = Boolean(pl.is_architectural ?? pl.isArchitectural ?? adr);
      return {
        kind: "behavior_change",
        specPath: sp,
        specSha: sha,
        adrPath: adr,
        isArchitectural: isArch,
        approvalId: pl.approval_id ?? pl.approvalId,
      };
    }

    if (taskRow?.route === "feature" || taskRow?.spec_sha) {
      const sha = (taskRow?.spec_sha ?? pl.spec_sha ?? pl.specSha) as string | undefined;
      const adr = (pl.adr_path ?? pl.adrPath) as string | undefined;
      return {
        kind: "behavior_change",
        specPath: `docs/specs/acceptance/${normKey}.md`,
        specSha: sha,
        adrPath: adr,
        isArchitectural: Boolean(pl.is_architectural ?? pl.isArchitectural ?? adr),
        approvalId: pl.approval_id ?? pl.approvalId,
      };
    }
  }

  // 5. From existing delegations and review evidence (legacy / manual tasks where task_queue row doesn't exist)
  // Only allowed during release verification, never for code execution (§31.9)
  if (params?.forRelease) {
    const normKey = normalizeTaskKey(taskKey);
    const targetSha =
      params?.targetSha ??
      params?.publishedSha ??
      params?.preparedBaseSha ??
      params?.baseSha;
    const acceptedReview = (store as any).getLatestAcceptedReview?.(normKey, targetSha);
    if (acceptedReview) {
      const revSha = acceptedReview.reviewedSha;
      const projId = acceptedReview.delegation.project_id ?? "proj";
      const approvalId = `appr:transition:${projId}:${normKey}:${revSha}:${acceptedReview.delegation.created_at || 1}`;
      return {
        kind: "mechanical",
        projectId: projId,
        mechanicalBasis: `Accepted review on ${revSha} (delegation #${acceptedReview.delegation.id})`,
        specSha: revSha,
        approvalId,
      };
    }
  }

  return null;
}

function normalizeContract(raw: any): SpecContract {
  let kind: SpecWorkKind = raw.kind;
  if ((raw.kind as string) === "feature" || (raw.kind as string) === "behavior-change") {
    kind = "behavior_change";
  } else if ((raw.kind as string) === "fix") {
    kind = "bugfix";
  }
  return {
    kind,
    projectId: raw.projectId ?? raw.project_id,
    specPath: raw.specPath ?? raw.spec_path,
    specSha: raw.specSha ?? raw.spec_sha,
    specSection: raw.specSection ?? raw.spec_section,
    adrPath: raw.adrPath ?? raw.adr_path,
    isArchitectural: Boolean(raw.isArchitectural ?? raw.is_architectural),
    altersContract: Boolean(raw.altersContract ?? raw.alters_contract),
    mechanicalBasis: raw.mechanicalBasis ?? raw.mechanical_basis,
    approvalId: raw.approvalId ?? raw.approval_id,
    preparedBaseSha: raw.preparedBaseSha ?? raw.prepared_base_sha,
  };
}

export function parseContractFromText(text: string): SpecContract | null {
  const lines = text.split("\n");
  const dict: Record<string, string> = {};
  for (const line of lines) {
    const match = line.match(/^[-*#\s]*([a-zA-Z0-9_\sа-яА-ЯёЁ§]+)[:=]\s*(.+)$/);
    if (match && match[1] && match[2]) {
      const key = match[1].trim().toLowerCase();
      dict[key] = match[2].trim();
    }
  }

  const kindVal = dict["kind"] ?? dict["work kind"] ?? dict["тип"] ?? dict["назначение"];
  let kind: SpecWorkKind | undefined;
  if (kindVal) {
    const k = kindVal.toLowerCase();
    if (k.includes("behavior") || k.includes("поведение") || k.includes("feature")) {
      kind = "behavior_change";
    } else if (k.includes("bugfix") || k.includes("fix") || k.includes("исправление")) {
      kind = "bugfix";
    } else if (k.includes("mechanical") || k.includes("механическ")) {
      kind = "mechanical";
    }
  }

  const specPath = dict["spec"] ?? dict["specpath"] ?? dict["спецификация"] ?? dict["спека"];
  const specSha = dict["specsha"] ?? dict["spec_sha"] ?? dict["sha"] ?? dict["коммит"];
  const specSection = dict["section"] ?? dict["specsection"] ?? dict["пункт"] ?? dict["раздел"];
  const adrPath = dict["adr"] ?? dict["adrpath"];
  const isArch =
    dict["architectural"] === "true" ||
    dict["is_architectural"] === "true" ||
    dict["архитектура"] === "да" ||
    Boolean(adrPath);
  const alters =
    dict["alters_contract"] === "true" ||
    dict["изменяет_договор"] === "да";
  const mechanicalBasis =
    dict["mechanical_basis"] ?? dict["basis"] ?? dict["основание"];

  if (!kind && (specSection || alters)) kind = "bugfix";
  if (!kind && mechanicalBasis) kind = "mechanical";
  if (!kind && (specPath || specSha || adrPath)) kind = "behavior_change";

  if (!kind) return null;

  return {
    kind,
    specPath,
    specSha,
    specSection,
    adrPath,
    isArchitectural: isArch,
    altersContract: alters,
    mechanicalBasis,
  };
}

/**
 * §31.9: Unified verification before code launch.
 * Throws OrchestratorError("spec-gate-violation", ...) if any requirement fails.
 */
export async function verifySpecBeforeCodeGate(
  input: VerifySpecGateInput,
): Promise<void> {
  // 1. Is enforcement active?
  const enforced = isSpecBeforeCodeEnforced({
    workGraphMode: input.workGraphMode,
    project: input.project,
    policy: input.policy,
    specBeforeCode: input.specBeforeCode,
  });
  if (!enforced) {
    return;
  }

  // 2. Only code executors are subject to the gate (§31.9)
  // Non-code tasks, auditors, architects, reviewers, researchers, and post-code release verifiers bypass
  if (input.noCode === true) return;
  if (input.role && input.role !== "executor") return;
  if (
    input.level === "review" ||
    input.level === "research" ||
    input.level === "spec" ||
    input.level === "architect" ||
    input.level === "design"
  ) {
    return;
  }

  // §31.9: Task waiting at owner_gate cannot launch code before owner decision
  if (input.task?.status === "waiting_approval" || input.task?.node === "owner_gate") {
    throw new OrchestratorError(
      "spec-gate-violation",
      `spec-gate-violation: задача ${input.taskKey} ожидает одобрения владельца (owner_gate); запуск кода до решения владельца запрещён`,
      "Одобри спецификацию через команду approve до запуска кода",
    );
  }

  // 3. Resolve contract
  const contract =
    input.contract ??
    resolveTaskSpecContract(
      input.taskKey,
      input.store,
      input.payload,
      input,
    );

  if (!contract) {
    throw new OrchestratorError(
      "spec-gate-violation",
      `spec-gate-violation: задача ${input.taskKey} изменяет кодовую базу, но принятая спецификация или договор приёмки отсутствует (§31.9)`,
      "Прими спецификацию (spec) или зафиксируй ссылку на существующий пункт/основание до запуска кода",
    );
  }

  // 4. Verify approval linkage (§31.9: "привязано к той же редакции")
  if (!contract.approvalId || !contract.approvalId.trim() || !contract.approvalId.startsWith("appr:")) {
    throw new OrchestratorError(
      "spec-gate-violation",
      `spec-gate-violation: принятие спецификации или договора приёмки для задачи ${input.taskKey} отсутствует или было отозвано (approvalId отсутствует или неверный формат: ${contract.approvalId})`,
      "Одобри спецификацию через команду approve или дождись подтверждения ревью до запуска кода",
    );
  }
  if (contract.approvalId.startsWith("appr:")) {
    const parts = contract.approvalId.split(":");
    const isTransition = parts[1] === "transition";
    const apprProj = isTransition ? parts[2] : parts[1];
    const apprKey = isTransition ? parts[3] : parts[2];
    const normInputKey = normalizeTaskKey(input.taskKey);
    if (apprKey && apprKey !== normInputKey) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: принятие ${contract.approvalId} принадлежит другой задаче (${apprKey} !== ${normInputKey})`,
      );
    }
    const effectiveProj = (input.task as any)?.project_id ?? contract.projectId;
    if (apprProj && apprProj !== "proj" && apprProj !== "transition" && effectiveProj && apprProj !== effectiveProj) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: принятие ${contract.approvalId} принадлежит другому проекту (${apprProj} !== ${effectiveProj})`,
      );
    }
    const apprSha = isTransition ? parts[4] : parts[3];
    if (
      apprSha &&
      contract.specSha &&
      apprSha !== "base" &&
      apprSha !== "sha" &&
      /^[0-9a-fA-F]{4,40}$/.test(apprSha)
    ) {
      const cleanAppr = apprSha.toLowerCase();
      const cleanSpec = contract.specSha.toLowerCase();
      if (cleanAppr !== cleanSpec) {
        if (cleanAppr.length === 40 && cleanSpec.length === 40) {
          throw new OrchestratorError(
            "spec-gate-violation",
            `spec-gate-violation: принятие ${contract.approvalId} привязано к другой редакции спецификации (${apprSha} !== ${contract.specSha})`,
          );
        }
        if (!cleanSpec.startsWith(cleanAppr) && !cleanAppr.startsWith(cleanSpec)) {
          throw new OrchestratorError(
            "spec-gate-violation",
            `spec-gate-violation: принятие ${contract.approvalId} привязано к другой редакции спецификации (${apprSha} !== ${contract.specSha})`,
          );
        }
      }
    }
  }

  // If stored contract exists in DB or task is manual, ensure approvalId matches and is not revoked
  const storedContract = input.store.getSpecContract(input.taskKey);
  const taskConfMode = (input.task as any)?.confirmation_mode ?? (input.task as any)?.confirmationMode;
  if (taskConfMode === "manual" || storedContract) {
    if (!storedContract || !storedContract.approval_id) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: задача ${input.taskKey} требует одобрения владельца в task_spec_contracts, но запись отсутствует или была отозвана`,
        "Одобри спецификацию через команду approve до запуска кода",
      );
    }
    if (
      storedContract.approval_id !== contract.approvalId &&
      !contract.approvalId.startsWith("appr:transition:")
    ) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: принятие ${contract.approvalId} не совпадает с сохранённым в базе (${storedContract.approval_id})`,
      );
    }
  }

  const cmd = input.cmd;
  if (!input.repoRoot || !input.repoRoot.trim()) {
    throw new OrchestratorError(
      "spec-gate-violation",
      `spec-gate-violation: репозиторий задачи ${input.taskKey} не определён или недоступен для проверки спецификации`,
      "Убедись, что репозиторий проекта доступен на текущем хосте",
    );
  }
  const cwd = input.repoRoot;
  if (!cmd) {
    throw new OrchestratorError(
      "spec-gate-violation",
      `spec-gate-violation: git-команды недоступны для проверки спецификации задачи ${input.taskKey}`,
    );
  }

  // Resolve base commit SHA if possible
  let currentBaseSha = input.baseSha;
  if (!currentBaseSha) {
    const res = await cmd.run("git", ["rev-parse", "HEAD"], { cwd });
    if (res.exitCode !== 0) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: не удалось разрешить базовый коммит в репозитории ${cwd}: ${(res.stderr || res.stdout).trim() || "git rev-parse HEAD failed"}`,
      );
    }
    currentBaseSha = res.stdout.trim();
  }

  // 5. Validate according to work kind
  if (contract.kind === "mechanical") {
    if (!contract.mechanicalBasis || !contract.mechanicalBasis.trim()) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: для механической задачи ${input.taskKey} отсутствует явное основание (mechanicalBasis)`,
        "Укажи основание механической работы без изменения поведения",
      );
    }
    return;
  }

  if (contract.kind === "behavior_change") {
    if (!currentBaseSha) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: не удалось разрешить базовый коммит в репозитории ${cwd}: git rev-parse HEAD returned empty`,
      );
    }
    if (!contract.specPath || !contract.specPath.trim()) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: для изменения нового поведения в задаче ${input.taskKey} не указан путь к спецификации (specPath)`,
        "Укажи specPath принятой спецификации в договоре приёмки",
      );
    }
    if (!contract.specSha || !contract.specSha.trim()) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: для изменения поведения в задаче ${input.taskKey} не указан коммит принятой спецификации (specSha)`,
        "Укажи точный SHA коммита принятой спецификации (specSha)",
      );
    }
    if (contract.isArchitectural && (!contract.adrPath || !contract.adrPath.trim())) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: архитектурное изменение в задаче ${input.taskKey} требует наличия принятого ADR (adrPath отсутствует)`,
        "Создай и согласуй ADR перед запуском реализации",
      );
    }

    // Git plumbing checks
    if (cmd && currentBaseSha) {
      // 1. Verify specSha commit exists and is reachable in repository
      const catCommit = await cmd.run(
        "git",
        ["cat-file", "-e", `${contract.specSha}^{commit}`],
        { cwd },
      );
      if (catCommit.exitCode !== 0) {
        throw new OrchestratorError(
          "spec-gate-violation",
          `spec-gate-violation: коммит спецификации ${contract.specSha} не найден в репозитории (чужой или недоступный SHA)`,
        );
      }

      // Check if specSha is ancestor of baseSha
      const ancestorRes = await cmd.run(
        "git",
        ["merge-base", "--is-ancestor", contract.specSha, currentBaseSha],
        { cwd },
      );
      if (ancestorRes.exitCode !== 0) {
        throw new OrchestratorError(
          "spec-gate-violation",
          `spec-gate-violation: коммит спецификации ${contract.specSha} не найден в истории базовой ветки (${currentBaseSha})`,
          "Влей коммит спецификации в базовую ветку перед запуском кода",
        );
      }

      // 2. Verify all spec documents exist in base commit
      const specFiles = splitDocPaths(contract.specPath);
      const adrFiles = splitDocPaths(contract.adrPath);

      if (specFiles.length === 0) {
        throw new OrchestratorError(
          "spec-gate-violation",
          `spec-gate-violation: для изменения поведения в задаче ${input.taskKey} не указан путь к спецификации (specPath)`,
        );
      }

      for (const sp of specFiles) {
        const catSpec = await cmd.run(
          "git",
          ["cat-file", "-e", `${currentBaseSha}:${sp}`],
          { cwd },
        );
        if (catSpec.exitCode !== 0) {
          throw new OrchestratorError(
            "spec-gate-violation",
            `spec-gate-violation: файл спецификации ${sp} отсутствует в базовом коммите ${currentBaseSha}`,
          );
        }
      }

      // 2b. Race condition: base branch moved between preparation and spawn
      let prepSha = contract.preparedBaseSha ?? input.preparedBaseSha;
      if (prepSha && !/^[0-9a-fA-F]{40}$/.test(prepSha)) {
        const rev = await cmd.run("git", ["rev-parse", prepSha], { cwd });
        if (rev.exitCode === 0 && rev.stdout.trim().length === 40) {
          prepSha = rev.stdout.trim();
        }
      }
      if (prepSha && prepSha !== currentBaseSha) {
        const diffPaths = [...specFiles, ...adrFiles];
        const diffRes = await cmd.run(
          "git",
          ["diff", "--name-only", prepSha, currentBaseSha, "--", ...diffPaths],
          { cwd },
        );
        if (diffRes.exitCode === 0 && diffRes.stdout.trim()) {
          const changed = diffRes.stdout.trim().split("\n").map((s) => s.trim()).filter(Boolean);
          throw new OrchestratorError(
            "spec-gate-violation",
            `spec-gate-violation: целевая базовая ветка изменилась (${prepSha.slice(0, 7)} -> ${currentBaseSha.slice(0, 7)}), спецификация была изменена: ${changed.join(", ")}; требуется новая сверка`,
          );
        }
      }

      // 2c. Verify all spec documents have not drifted between accepted specSha and currentBaseSha
      if (contract.specSha) {
        for (const sp of specFiles) {
          const specDiff = await cmd.run(
            "git",
            ["diff", "--quiet", contract.specSha, currentBaseSha, "--", sp],
            { cwd },
          );
          if (specDiff.exitCode !== 0) {
            throw new OrchestratorError(
              "spec-gate-violation",
              `spec-gate-violation: спецификация ${sp} в базовом коммите ${currentBaseSha.slice(0, 7)} была изменена по сравнению с принятой версией (${contract.specSha.slice(0, 7)})`,
              "Согласуй изменения спецификации заново перед запуском реализации",
            );
          }
        }
      }

      // 3. If architectural or ADR files exist, verify adrPath exists in base commit and has not drifted
      if (contract.isArchitectural || adrFiles.length > 0) {
        for (const ap of adrFiles) {
          const catAdr = await cmd.run(
            "git",
            ["cat-file", "-e", `${currentBaseSha}:${ap}`],
            { cwd },
          );
          if (catAdr.exitCode !== 0) {
            throw new OrchestratorError(
              "spec-gate-violation",
              `spec-gate-violation: файл ADR ${ap} отсутствует в базовом коммите ${currentBaseSha}`,
            );
          }
          if (contract.specSha) {
            const adrDiff = await cmd.run(
              "git",
              ["diff", "--quiet", contract.specSha, currentBaseSha, "--", ap],
              { cwd },
            );
            if (adrDiff.exitCode !== 0) {
              throw new OrchestratorError(
                "spec-gate-violation",
                `spec-gate-violation: файл ADR ${ap} в базовом коммите ${currentBaseSha.slice(0, 7)} был изменен по сравнению с принятой версией (${contract.specSha.slice(0, 7)})`,
                "Согласуй изменения ADR заново перед запуском реализации",
              );
            }
          }
        }
      }
    }
  } else if (contract.kind === "bugfix") {
    const specFiles = splitDocPaths(contract.specPath);
    if (specFiles.length === 0) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: для исправления ошибки в рамках существующего поведения задачи ${input.taskKey} не указан путь к принятой спецификации (specPath)`,
        "Укажи specPath существующей спецификации",
      );
    }
    if (!contract.specSection || !contract.specSection.trim()) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: для исправления ошибки в задаче ${input.taskKey} не указан пункт спецификации (specSection)`,
        "Укажи пункт или раздел спецификации, поведение которого восстанавливается",
      );
    }
    if (contract.altersContract === true) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: исправление ошибки в задаче ${input.taskKey} требует изменения договора (altersContract = true); задача возвращается на этап описания спецификации`,
        "Создай спецификацию на изменение поведения вместо исправления",
      );
    }

    // Git checks
    if (cmd && currentBaseSha) {
      for (const sp of specFiles) {
        const catSpec = await cmd.run(
          "git",
          ["cat-file", "-e", `${currentBaseSha}:${sp}`],
          { cwd },
        );
        if (catSpec.exitCode !== 0) {
          throw new OrchestratorError(
            "spec-gate-violation",
            `spec-gate-violation: файл спецификации ${sp} отсутствует в базовом коммите ${currentBaseSha}`,
          );
        }
      }

      // Check section exists in file
      let foundSection = false;
      for (const sp of specFiles) {
        const showSpec = await cmd.run(
          "git",
          ["show", `${currentBaseSha}:${sp}`],
          { cwd },
        );
        if (
          showSpec.exitCode === 0 &&
          sectionExistsInMarkdown(showSpec.stdout, contract.specSection)
        ) {
          foundSection = true;
          break;
        }
      }
      if (!foundSection) {
        throw new OrchestratorError(
          "spec-gate-violation",
          `spec-gate-violation: пункт спецификации "${contract.specSection}" не найден в файле ${contract.specPath} на базовом коммите`,
        );
      }

      if (contract.specSha) {
        for (const sp of specFiles) {
          const specDiff = await cmd.run(
            "git",
            ["diff", "--quiet", contract.specSha, currentBaseSha, "--", sp],
            { cwd },
          );
          if (specDiff.exitCode !== 0) {
            throw new OrchestratorError(
              "spec-gate-violation",
              `spec-gate-violation: спецификация ${sp} в базовом коммите была изменена по сравнению с принятой версией`,
            );
          }
        }
      }
    }
  } else if (contract.kind === "mechanical") {
    if (!contract.mechanicalBasis || !contract.mechanicalBasis.trim()) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: для механической работы без изменения поведения в задаче ${input.taskKey} не указано основание (mechanicalBasis)`,
        "Зафиксируй явное основание в договоре приёмки",
      );
    }
  } else {
    throw new OrchestratorError(
      "spec-gate-violation",
      `spec-gate-violation: неизвестный тип работы "${(contract as any).kind}" в договоре приёмки задачи ${input.taskKey} (ожидается: behavior_change, bugfix или mechanical)`,
    );
  }
}

/**
 * orchestrator-release §2: verify spec documents on the exact published commit.
 * If documents were deleted or modified during merge without approval, blocks release.
 */
export async function verifyReleaseDocumentsGate(
  input: VerifyReleaseDocumentsInput,
): Promise<void> {
  const contract =
    input.contract ??
    resolveTaskSpecContract(input.taskKey, input.store, undefined, {
      ...input,
      targetSha: input.publishedSha,
      forRelease: true,
    });

  const enforced = isSpecBeforeCodeEnforced({
    workGraphMode: input.workGraphMode,
    project: input.project,
    policy: input.policy,
  });

  if (!enforced) {
    return;
  }

  // If no contract found or approval missing/revoked, check if spec gate was enforced
  if (!contract || !contract.approvalId || !contract.approvalId.trim()) {
    throw new OrchestratorError(
      "spec-gate-violation",
      `spec-gate-violation: для выкладываемой задачи ${input.taskKey} отсутствует принятый договор приёмки или спецификация (approvalId отсутствует или отозван)`,
    );
  }

  const cwd = input.repoRoot;
  const cmd = input.cmd;
  if (!cmd) {
    throw new OrchestratorError(
      "spec-gate-violation",
      `spec-gate-violation: git-команды недоступны для проверки спецификации задачи ${input.taskKey}`,
    );
  }

  if (contract.approvalId.startsWith("appr:")) {
    const parts = contract.approvalId.split(":");
    const isTransition = parts[1] === "transition";
    const apprKey = isTransition ? parts[3] : parts[2];
    const normInputKey = normalizeTaskKey(input.taskKey);
    if (apprKey && apprKey !== normInputKey) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: принятие ${contract.approvalId} не принадлежит выкладываемой задаче ${input.taskKey}`,
      );
    }
    if (isTransition) {
      const apprSha = parts[4];
      if (
        apprSha &&
        apprSha !== "base" &&
        apprSha !== "sha" &&
        /^[0-9a-fA-F]{4,40}$/.test(apprSha) &&
        input.publishedSha
      ) {
        const cleanAppr = apprSha.toLowerCase();
        const cleanPub = input.publishedSha.toLowerCase();
        if (cleanAppr !== cleanPub && !cleanPub.startsWith(cleanAppr)) {
          const ancRes = await cmd.run("git", ["merge-base", "--is-ancestor", cleanAppr, cleanPub], { cwd });
          if (ancRes.exitCode !== 0) {
            throw new OrchestratorError(
              "spec-gate-violation",
              `spec-gate-violation: принятие ${contract.approvalId} привязано к коммиту ${apprSha}, который не входит в историю публикуемого коммита ${input.publishedSha}`,
            );
          }
        }
      }
    }
  }

  if (contract.kind === "behavior_change") {
    if (!contract.specPath || !contract.specPath.trim()) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: для изменения нового поведения в задаче ${input.taskKey} не указан путь к спецификации (specPath)`,
      );
    }

    // 1. Verify specPaths exist in publishedSha and have not drifted
    const specFiles = splitDocPaths(contract.specPath);
    for (const sp of specFiles) {
      const catRes = await cmd.run(
        "git",
        ["cat-file", "-e", `${input.publishedSha}:${sp}`],
        { cwd },
      );
      if (catRes.exitCode !== 0) {
        throw new OrchestratorError(
          "spec-gate-violation",
          `spec-gate-violation: спецификация ${sp} была удалена при сведении ветки релиза ${input.taskKey}`,
        );
      }
      if (contract.specSha) {
        const diffRes = await cmd.run(
          "git",
          [
            "diff",
            "--name-only",
            contract.specSha,
            input.publishedSha,
            "--",
            sp,
          ],
          { cwd },
        );
        if (diffRes.exitCode === 0 && diffRes.stdout.trim()) {
          throw new OrchestratorError(
            "spec-gate-violation",
            `spec-gate-violation: спецификация ${sp} была изменена при сведении ветки релиза ${input.taskKey} без нового согласования`,
          );
        }
      }
    }

    const adrFiles = splitDocPaths(contract.adrPath);
    if (contract.isArchitectural || adrFiles.length > 0) {
      for (const ap of adrFiles) {
        const catAdr = await cmd.run(
          "git",
          ["cat-file", "-e", `${input.publishedSha}:${ap}`],
          { cwd },
        );
        if (catAdr.exitCode !== 0) {
          throw new OrchestratorError(
            "spec-gate-violation",
            `spec-gate-violation: файл ADR ${ap} был удален при сведении ветки релиза ${input.taskKey}`,
          );
        }
        if (contract.specSha) {
          const diffAdr = await cmd.run(
            "git",
            [
              "diff",
              "--name-only",
              contract.specSha,
              input.publishedSha,
              "--",
              ap,
            ],
            { cwd },
          );
          if (diffAdr.exitCode === 0 && diffAdr.stdout.trim()) {
            throw new OrchestratorError(
              "spec-gate-violation",
              `spec-gate-violation: файл ADR ${ap} был изменен при сведении ветки релиза ${input.taskKey} без нового согласования`,
            );
          }
        }
      }
    }
  } else if (contract.kind === "bugfix") {
    const specFiles = splitDocPaths(contract.specPath);
    if (specFiles.length === 0) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: для исправления в задаче ${input.taskKey} не указан путь к спецификации (specPath)`,
      );
    }
    for (const sp of specFiles) {
      const catRes = await cmd.run(
        "git",
        ["cat-file", "-e", `${input.publishedSha}:${sp}`],
        { cwd },
      );
      if (catRes.exitCode !== 0) {
        throw new OrchestratorError(
          "spec-gate-violation",
          `spec-gate-violation: спецификация ${sp} была удалена при сведении ветки релиза ${input.taskKey}`,
        );
      }
      if (contract.specSha) {
        const diffRes = await cmd.run(
          "git",
          [
            "diff",
            "--name-only",
            contract.specSha,
            input.publishedSha,
            "--",
            sp,
          ],
          { cwd },
        );
        if (diffRes.exitCode === 0 && diffRes.stdout.trim()) {
          throw new OrchestratorError(
            "spec-gate-violation",
            `spec-gate-violation: спецификация ${sp} была изменена при сведении ветки релиза ${input.taskKey} без нового согласования`,
          );
        }
      }
    }
    if (contract.specSection) {
      let foundSec = false;
      for (const sp of specFiles) {
        const showRes = await cmd.run(
          "git",
          ["show", `${input.publishedSha}:${sp}`],
          { cwd },
        );
        if (
          showRes.exitCode === 0 &&
          sectionExistsInMarkdown(showRes.stdout, contract.specSection)
        ) {
          foundSec = true;
          break;
        }
      }
      if (!foundSec) {
        throw new OrchestratorError(
          "spec-gate-violation",
          `spec-gate-violation: пункт спецификации "${contract.specSection}" отсутствует в ${contract.specPath} на публикуемом коммите`,
        );
      }
    }
  } else if (contract.kind === "mechanical") {
    if (!contract.mechanicalBasis || !contract.mechanicalBasis.trim()) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: для механической задачи ${input.taskKey} отсутствует основание (mechanicalBasis)`,
      );
    }
    const accepted = input.store.getLatestAcceptedReview?.(input.taskKey, input.publishedSha);
    const payloadObj = (() => {
      const task = input.task ?? input.store.getTask(input.taskKey);
      if (!task?.payload) return null;
      try {
        return JSON.parse(task.payload);
      } catch {
        return null;
      }
    })();
    const hasPayloadReview = payloadObj?.review_verdict === "OK";
    if (!accepted && !hasPayloadReview) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: для механической задачи ${input.taskKey} отсутствует вердикт ревью, подтверждающий механический характер изменений (§31.9, release §2)`,
      );
    }
  }
}
