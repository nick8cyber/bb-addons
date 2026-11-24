export type WorkGraphMode = "off" | "shadow" | "strict";

/** Validates and normalizes workGraph mode setting. */
export function normalizeWorkGraphMode(mode: unknown): WorkGraphMode {
  if (typeof mode !== "string") return "off";
  const m = mode.toLowerCase().trim();
  if (m === "shadow" || m === "strict") return m;
  return "off";
}

/** §32.5.6 (PLUG-398): переопределение режима проекта; `until` — мс UTC, без него — бессрочно. */
export interface WorkGraphOverride {
  mode: WorkGraphMode;
  until?: number;
  reason?: string;
}

/** §32.5.6 п. 4: срок переопределения `off` — не больше 24 часов. */
export const OFF_OVERRIDE_MAX_MS = 24 * 60 * 60 * 1000;

function parseModeString(val: unknown): WorkGraphMode | null {
  if (typeof val !== "string") return null;
  const normalized = val.trim().toLowerCase();
  if (normalized === "off" || normalized === "shadow" || normalized === "strict") {
    return normalized;
  }
  return null;
}

function parseRawObject(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return null;
  }
  return obj as Record<string, unknown>;
}

/**
 * §32.2 + §32.5.6: все валидные переопределения `workGraphProjects`
 * (строка — бессрочно; объект `{mode, until, reason}` — со сроком).
 * Объект без `until` или с невалидной датой — невалидное значение:
 * предупреждение и наследование режима (§32.5.6 п. 3).
 */
export function parseWorkGraphOverrides(
  raw: unknown,
  log?: { warn?: (msg: string) => void },
): Record<string, WorkGraphOverride> {
  const obj = parseRawObject(raw);
  if (!obj) return {};
  const result: Record<string, WorkGraphOverride> = {};
  for (const [rawKey, val] of Object.entries(obj)) {
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!key) continue;
    if (typeof val === "string") {
      const mode = parseModeString(val);
      if (mode) result[key] = { mode };
      continue;
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      const mode = parseModeString(o.mode);
      const until =
        typeof o.until === "string" && o.until.trim() ? Date.parse(o.until) : NaN;
      if (!mode || !Number.isFinite(until)) {
        log?.warn?.(
          `orchestrator: workGraphProjects.${key}: invalid override ${JSON.stringify(val)} (object needs mode and ISO-8601 until); inheriting the global mode`,
        );
        continue;
      }
      result[key] = {
        mode,
        until,
        ...(typeof o.reason === "string" && o.reason.trim() ? { reason: o.reason.trim() } : {}),
      };
    }
  }
  return result;
}

/** §32.2 (PLUG-361) + §32.5.6: действующие режимы проектов на момент `now` (истёкшие — игнорируются). */
export function parseWorkGraphProjects(
  raw: unknown,
  now: number = Date.now(),
  log?: { warn?: (msg: string) => void },
): Record<string, WorkGraphMode> {
  const result: Record<string, WorkGraphMode> = {};
  for (const [key, o] of Object.entries(parseWorkGraphOverrides(raw, log))) {
    if (o.until !== undefined && now >= o.until) continue;
    result[key] = o.mode;
  }
  return result;
}

/** §32.5.6 п. 2: проекты с истёкшим сроком переопределения. */
export function expiredWorkGraphOverrides(
  raw: unknown,
  now: number = Date.now(),
): { projectId: string; override: WorkGraphOverride }[] {
  return Object.entries(parseWorkGraphOverrides(raw))
    .filter(([, o]) => o.until !== undefined && now >= o.until)
    .map(([projectId, override]) => ({ projectId, override }));
}

/**
 * §32.5.6: новое значение `workGraphProjects` без перечисленных проектов
 * (удаление истёкших) и с обрезкой срока `off` до 24 часов от `now`.
 * Возвращает null, если менять нечего.
 */
export function rewriteWorkGraphProjects(
  raw: unknown,
  opts: { remove?: string[]; now?: number },
): { value: string; capped: string[]; removed: string[] } | null {
  const obj = parseRawObject(raw);
  if (!obj) return null;
  const now = opts.now ?? Date.now();
  const remove = new Set((opts.remove ?? []).map((k) => k.trim()));
  const out: Record<string, unknown> = {};
  const capped: string[] = [];
  const removed: string[] = [];
  for (const [rawKey, val] of Object.entries(obj)) {
    const key = rawKey.trim();
    if (remove.has(key)) {
      removed.push(key);
      continue;
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      const mode = parseModeString(o.mode);
      const until = typeof o.until === "string" ? Date.parse(o.until) : NaN;
      if (mode === "off" && Number.isFinite(until) && until - now > OFF_OVERRIDE_MAX_MS) {
        out[rawKey] = { ...o, until: new Date(now + OFF_OVERRIDE_MAX_MS).toISOString() };
        capped.push(key);
        continue;
      }
    }
    out[rawKey] = val;
  }
  if (!capped.length && !removed.length) return null;
  return { value: JSON.stringify(out), capped, removed };
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
