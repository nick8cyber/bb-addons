export type WorkGraphMode = "off" | "shadow" | "strict";

/** Validates and normalizes workGraph mode setting. */
export function normalizeWorkGraphMode(mode: unknown): WorkGraphMode {
  if (typeof mode !== "string") return "off";
  const m = mode.toLowerCase().trim();
  if (m === "shadow" || m === "strict") return m;
  return "off";
}

/** §32.2 (PLUG-361): Safely parses workGraphProjects setting (string or object) into normalized modes map. */
export function parseWorkGraphProjects(raw: unknown): Record<string, WorkGraphMode> {
  if (!raw) return {};
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return {};
    }
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return {};
  }
  const result: Record<string, WorkGraphMode> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (!key || typeof key !== "string") continue;
    if (typeof val === "string") {
      const normalized = val.trim().toLowerCase();
      if (normalized === "off" || normalized === "shadow" || normalized === "strict") {
        result[key.trim()] = normalized;
      }
    }
  }
  return result;
}

/** §32.2 (PLUG-361): Resolves effective workGraph mode: project override if valid, else global mode (defaulting to 'off'). */
export function resolveWorkGraphMode(
  projectId?: string | null,
  globalMode?: unknown,
  projectsMap?: Record<string, WorkGraphMode>,
): WorkGraphMode {
  const normGlobal = normalizeWorkGraphMode(globalMode);
  if (projectId && typeof projectId === "string" && projectsMap) {
    const key = projectId.trim();
    const mode = projectsMap[key];
    if (mode === "off" || mode === "shadow" || mode === "strict") {
      return mode;
    }
  }
  return normGlobal;
}

/**
 * §32.2: Computes effective workGraph mode in UI.
 * Server is canonical source of truth when present; falls back to normalized project override and global mode.
 */
export function computeEffectiveWorkGraphMode(
  serverWorkGraph: string | null | undefined,
  projectOverride: string | null | undefined,
  globalWorkGraph: unknown,
): WorkGraphMode {
  if (serverWorkGraph) {
    const norm = normalizeWorkGraphMode(serverWorkGraph);
    if (norm === "shadow" || norm === "strict" || serverWorkGraph.trim().toLowerCase() === "off") {
      return norm;
    }
  }
  if (projectOverride) {
    const norm = normalizeWorkGraphMode(projectOverride);
    if (norm === "shadow" || norm === "strict" || projectOverride.trim().toLowerCase() === "off") {
      return norm;
    }
  }
  return normalizeWorkGraphMode(globalWorkGraph);
}

/** §29.2: Determines whether RoleApprovalMenu should render the approval mode section. */
export function shouldShowApprovalMenu(
  workGraphMode: WorkGraphMode,
  role: string,
): boolean {
  return (
    (workGraphMode === "strict" || workGraphMode === "shadow") &&
    (role === "orchestrator" || role === "executor")
  );
}
