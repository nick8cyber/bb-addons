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

export interface SpecContract {
  kind: SpecWorkKind;
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
}

/** Check if spec-before-code enforcement is active for this invocation */
export function isSpecBeforeCodeEnforced(params: {
  workGraphMode?: WorkGraphMode;
  project?: ResolvedProject | null;
  policy?: Policy | null;
  specBeforeCode?: boolean;
}): boolean {
  if (params.specBeforeCode === true) return true;
  if ((params.policy as any)?.specBeforeCode === true) return true;
  if ((params.project as any)?.specBeforeCode === true) return true;
  if ((params.project as any)?.orchestrator?.specBeforeCode === true) return true;
  // §31.9: "Режим workGraph управляет переходами графа. В том числе в shadow он не отключает проверку документации."
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
  if (params?.specContract && typeof params.specContract === "object") {
    return normalizeContract(params.specContract);
  }
  if (params?.spec_contract && typeof params.spec_contract === "object") {
    return normalizeContract(params.spec_contract);
  }

  // 2. Persisted in task_spec_contracts table
  const row = store.getSpecContract(taskKey);
  if (row) {
    return {
      kind: row.kind,
      specPath: row.spec_path ?? undefined,
      specSha: row.spec_sha ?? undefined,
      specSection: row.spec_section ?? undefined,
      adrPath: row.adr_path ?? undefined,
      isArchitectural: Boolean(row.is_architectural),
      altersContract: Boolean(row.alters_contract),
      mechanicalBasis: row.mechanical_basis ?? undefined,
      approvalId: row.approval_id ?? undefined,
      preparedBaseSha: row.prepared_base_sha ?? undefined,
    };
  }

  // 3. From task payload
  const taskRow = params?.task ?? store.getTask(taskKey);
  const pl = payload ?? (() => {
    if (!taskRow?.payload) return null;
    try {
      return JSON.parse(taskRow.payload);
    } catch {
      return null;
    }
  })();

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
      if (parsed) return parsed;
      if (taskRow?.route === "simple" || params?.level === "simple") {
        return {
          kind: "mechanical",
          mechanicalBasis: pl.acceptance_text.trim(),
        };
      }
      if (taskRow?.route === "fix") {
        const normKey = normalizeTaskKey(taskKey);
        return {
          kind: "bugfix",
          specPath: `docs/specs/acceptance/${normKey}.md`,
          specSection: "§31.9",
          altersContract: false,
        };
      }
    }

    // In feature route, spec node deliverables
    if (typeof pl.spec_path === "string" || typeof pl.specPath === "string") {
      const sp = (pl.spec_path ?? pl.specPath) as string;
      const sha = (pl.spec_sha ?? pl.specSha) as string | undefined;
      const adr = (pl.adr_path ?? pl.adrPath) as string | undefined;
      const isArch = Boolean(pl.is_architectural ?? pl.isArchitectural);
      return {
        kind: "behavior_change",
        specPath: sp,
        specSha: sha,
        adrPath: adr,
        isArchitectural: isArch,
      };
    }

    // In fix route with spec section
    if (typeof pl.spec_section === "string" || typeof pl.specSection === "string") {
      return {
        kind: "bugfix",
        specPath: (pl.spec_path ?? pl.specPath) as string | undefined,
        specSection: (pl.spec_section ?? pl.specSection) as string,
        altersContract: Boolean(pl.alters_contract ?? pl.altersContract),
      };
    }

    // Mechanical basis in payload
    if (typeof pl.mechanical_basis === "string" || typeof pl.mechanicalBasis === "string") {
      return {
        kind: "mechanical",
        mechanicalBasis: (pl.mechanical_basis ?? pl.mechanicalBasis) as string,
      };
    }
  }

  // 4. From task_queue row directly
  if (taskRow) {
    const accSha = taskRow.acceptance_sha ?? taskRow.spec_sha;
    const normKey = normalizeTaskKey(taskRow.task_key);
    if (accSha) {
      if (taskRow.route === "simple") {
        return {
          kind: "mechanical",
          mechanicalBasis:
            pl?.mechanical_basis ??
            pl?.acceptance_text ??
            `Acceptance contract committed at docs/specs/acceptance/${normKey}.md`,
        };
      }
      if (taskRow.route === "fix") {
        return {
          kind: "bugfix",
          specPath: `docs/specs/acceptance/${normKey}.md`,
          specSection: "§31.9",
          specSha: accSha,
          altersContract: false,
        };
      }
      return {
        kind: "behavior_change",
        specPath: `docs/specs/acceptance/${normKey}.md`,
        specSha: accSha,
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

function parseContractFromText(text: string): SpecContract | null {
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
  // Non-code tasks, auditors, architects, reviewers, researchers bypass
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

  const cwd = input.repoRoot ?? process.cwd();
  const cmd = input.cmd;

  // Resolve base commit SHA if possible
  let currentBaseSha = input.baseSha;
  if (!currentBaseSha && cmd) {
    try {
      const res = await cmd.run("git", ["rev-parse", "HEAD"], { cwd });
      if (res.exitCode === 0 && res.stdout.trim()) {
        currentBaseSha = res.stdout.trim();
      }
    } catch {}
  }

  // 4. Validate according to work kind
  if (contract.kind === "behavior_change") {
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

      // 2. Verify specPath exists in base commit
      const catSpec = await cmd.run(
        "git",
        ["cat-file", "-e", `${currentBaseSha}:${contract.specPath}`],
        { cwd },
      );
      if (catSpec.exitCode !== 0) {
        throw new OrchestratorError(
          "spec-gate-violation",
          `spec-gate-violation: файл спецификации ${contract.specPath} отсутствует в базовом коммите ${currentBaseSha}`,
        );
      }

      // 3. If architectural, verify adrPath exists in base commit
      if (contract.isArchitectural && contract.adrPath) {
        const catAdr = await cmd.run(
          "git",
          ["cat-file", "-e", `${currentBaseSha}:${contract.adrPath}`],
          { cwd },
        );
        if (catAdr.exitCode !== 0) {
          throw new OrchestratorError(
            "spec-gate-violation",
            `spec-gate-violation: файл ADR ${contract.adrPath} отсутствует в базовом коммите ${currentBaseSha}`,
          );
        }
      }

      // 4. Race condition: base branch moved between preparation and spawn
      const prepSha = contract.preparedBaseSha ?? input.preparedBaseSha;
      if (prepSha && prepSha !== currentBaseSha) {
        const diffPaths = [contract.specPath];
        if (contract.adrPath) diffPaths.push(contract.adrPath);
        const diffRes = await cmd.run(
          "git",
          ["diff", "--name-only", prepSha, currentBaseSha, "--", ...diffPaths],
          { cwd },
        );
        if (diffRes.exitCode === 0 && diffRes.stdout.trim()) {
          throw new OrchestratorError(
            "spec-gate-violation",
            `spec-gate-violation: целевая базовая ветка изменилась (${prepSha.slice(0, 7)} -> ${currentBaseSha.slice(0, 7)}), спецификация ${contract.specPath} была изменена или удалена; требуется новая сверка`,
          );
        }
      }
    }
  } else if (contract.kind === "bugfix") {
    if (!contract.specPath || !contract.specPath.trim()) {
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
      const catSpec = await cmd.run(
        "git",
        ["cat-file", "-e", `${currentBaseSha}:${contract.specPath}`],
        { cwd },
      );
      if (catSpec.exitCode !== 0) {
        throw new OrchestratorError(
          "spec-gate-violation",
          `spec-gate-violation: файл спецификации ${contract.specPath} отсутствует в базовом коммите ${currentBaseSha}`,
        );
      }

      // Check section exists in file
      const showSpec = await cmd.run(
        "git",
        ["show", `${currentBaseSha}:${contract.specPath}`],
        { cwd },
      );
      const cleanSection = contract.specSection.replace(/^§\s*/, "");
      if (
        showSpec.exitCode !== 0 ||
        (!showSpec.stdout.includes(contract.specSection) &&
         !showSpec.stdout.includes(cleanSection))
      ) {
        throw new OrchestratorError(
          "spec-gate-violation",
          `spec-gate-violation: пункт спецификации "${contract.specSection}" не найден в файле ${contract.specPath} на базовом коммите`,
        );
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
    resolveTaskSpecContract(input.taskKey, input.store);

  // If no contract found, check if spec gate was enforced
  if (!contract) {
    const enforced = isSpecBeforeCodeEnforced({
      project: input.project,
      policy: input.policy,
    });
    if (enforced) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: для выкладываемой задачи ${input.taskKey} отсутствует сохранённый договор приёмки или спецификация`,
      );
    }
    return;
  }

  const cwd = input.repoRoot;
  const cmd = input.cmd;
  if (!cmd) return;

  if (contract.kind === "behavior_change") {
    if (contract.specPath) {
      // 1. Verify specPath exists in publishedSha
      const catRes = await cmd.run(
        "git",
        ["cat-file", "-e", `${input.publishedSha}:${contract.specPath}`],
        { cwd },
      );
      if (catRes.exitCode !== 0) {
        throw new OrchestratorError(
          "spec-gate-violation",
          `spec-gate-violation: спецификация ${contract.specPath} была удалена при сведении ветки релиза ${input.taskKey}`,
        );
      }

      // 2. If specSha known, check for unapproved modifications during merge
      if (contract.specSha) {
        const diffRes = await cmd.run(
          "git",
          [
            "diff",
            "--name-only",
            contract.specSha,
            input.publishedSha,
            "--",
            contract.specPath,
          ],
          { cwd },
        );
        if (diffRes.exitCode === 0 && diffRes.stdout.trim()) {
          throw new OrchestratorError(
            "spec-gate-violation",
            `spec-gate-violation: спецификация ${contract.specPath} была изменена при сведении ветки релиза ${input.taskKey} без нового согласования`,
          );
        }
      }
    }

    if (contract.isArchitectural && contract.adrPath) {
      const catAdr = await cmd.run(
        "git",
        ["cat-file", "-e", `${input.publishedSha}:${contract.adrPath}`],
        { cwd },
      );
      if (catAdr.exitCode !== 0) {
        throw new OrchestratorError(
          "spec-gate-violation",
          `spec-gate-violation: файл ADR ${contract.adrPath} был удален при сведении ветки релиза ${input.taskKey}`,
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
            contract.adrPath,
          ],
          { cwd },
        );
        if (diffAdr.exitCode === 0 && diffAdr.stdout.trim()) {
          throw new OrchestratorError(
            "spec-gate-violation",
            `spec-gate-violation: файл ADR ${contract.adrPath} был изменен при сведении ветки релиза ${input.taskKey} без нового согласования`,
          );
        }
      }
    }
  } else if (contract.kind === "bugfix") {
    if (contract.specPath) {
      const catRes = await cmd.run(
        "git",
        ["cat-file", "-e", `${input.publishedSha}:${contract.specPath}`],
        { cwd },
      );
      if (catRes.exitCode !== 0) {
        throw new OrchestratorError(
          "spec-gate-violation",
          `spec-gate-violation: спецификация ${contract.specPath} была удалена при сведении ветки релиза ${input.taskKey}`,
        );
      }
      if (contract.specSection) {
        const showRes = await cmd.run(
          "git",
          ["show", `${input.publishedSha}:${contract.specPath}`],
          { cwd },
        );
        const cleanSection = contract.specSection.replace(/^§\s*/, "");
        if (
          showRes.exitCode !== 0 ||
          (!showRes.stdout.includes(contract.specSection) &&
           !showRes.stdout.includes(cleanSection))
        ) {
          throw new OrchestratorError(
            "spec-gate-violation",
            `spec-gate-violation: пункт спецификации "${contract.specSection}" отсутствует в ${contract.specPath} на публикуемом коммите`,
          );
        }
      }
    }
  } else if (contract.kind === "mechanical") {
    if (!contract.mechanicalBasis || !contract.mechanicalBasis.trim()) {
      throw new OrchestratorError(
        "spec-gate-violation",
        `spec-gate-violation: для механической задачи ${input.taskKey} отсутствует основание (mechanicalBasis)`,
      );
    }
  }
}
