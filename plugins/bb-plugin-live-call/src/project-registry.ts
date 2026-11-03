/**
 * Реестр звонков по проектам (§15.2, §15.3, §15.8).
 * Разбор, валидация, хеширование, диффы, вычисление строгого класса.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CallStore } from "./call-store.js";

export const toolClassSchema = z.enum(["R", "C", "P", "L", "deny"]);
export type ProjectToolClass = z.infer<typeof toolClassSchema>;

/** Для defaultClass R запрещён (§15.2): только C, P или deny. */
export const defaultClassSchema = z.enum(["C", "P", "deny"]);
export type ProjectDefaultClass = z.infer<typeof defaultClassSchema>;

export const connectorTransportSchema = z.enum(["stdio", "http"]);
export type ConnectorTransport = z.infer<typeof connectorTransportSchema>;

export const CONNECTOR_RESULT_MAX_CHARS_DEFAULT = 2000;

export const connectorConfigSchema = z
  .object({
    id: z.string().min(1),
    transport: connectorTransportSchema,
    command: z.array(z.string()).optional(),
    url: z.string().optional(),
    secrets: z.array(z.string()).optional(),
    tools: z.record(z.string(), toolClassSchema).optional(),
    defaultClass: defaultClassSchema,
    maxResultChars: z.number().int().min(500).max(20000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.transport === "stdio") {
      if (!data.command || data.command.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "stdio-коннектор требует непустой массив command",
          path: ["command"],
        });
      }
    } else if (data.transport === "http") {
      if (!data.url || !/^https?:\/\//i.test(data.url)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "http-коннектор требует url, начинающийся с http:// или https://",
          path: ["url"],
        });
      }
    }
  });

export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;

export const projectConfigSchema = z.object({
  title: z.string().min(1),
  connectors: z.array(connectorConfigSchema),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export const projectRegistrySchema = z.record(z.string(), projectConfigSchema);
export type ProjectRegistry = z.infer<typeof projectRegistrySchema>;

export interface ProjectListItem {
  projectId: string;
  title: string;
  state: "approved" | "pending" | "invalid";
  hash?: string;
  diff?: string[];
  error?: string;
}

export function canonicalizeJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalizeJson);
  if (v && typeof v === "object") {
    const res: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      res[k] = canonicalizeJson((v as Record<string, unknown>)[k]);
    }
    return res;
  }
  return v;
}

export function hashProjectConfig(cfg: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeJson(cfg))).digest("hex");
}

/** Сравнение старой подтверждённой конфигурации и новой (§15.2). */
export function computeProjectDiff(oldConfig: ProjectConfig | null, newConfig: ProjectConfig): string[] {
  const diffs: string[] = [];
  if (!oldConfig) {
    diffs.push(`новый проект в реестре: коннекторы [${newConfig.connectors.map((c) => c.id).join(", ")}]`);
    return diffs;
  }

  if (oldConfig.title !== newConfig.title) {
    diffs.push(`изменено название: «${oldConfig.title}» → «${newConfig.title}»`);
  }

  const oldMap = new Map(oldConfig.connectors.map((c) => [c.id, c]));
  const newMap = new Map(newConfig.connectors.map((c) => [c.id, c]));

  for (const [id, c] of newMap) {
    if (!oldMap.has(id)) {
      diffs.push(`добавлен коннектор «${id}» (${c.transport})`);
      continue;
    }
    const oldC = oldMap.get(id)!;
    if (oldC.transport !== c.transport) {
      diffs.push(`коннектор «${id}»: изменён транспорт ${oldC.transport} → ${c.transport}`);
    }
    if (JSON.stringify(oldC.command ?? []) !== JSON.stringify(c.command ?? [])) {
      diffs.push(`коннектор «${id}»: изменена команда запуска`);
    }
    if (oldC.url !== c.url) {
      diffs.push(`коннектор «${id}»: изменён адрес ${oldC.url ?? "-"} → ${c.url ?? "-"}`);
    }
    if (JSON.stringify([...(oldC.secrets ?? [])].sort()) !== JSON.stringify([...(c.secrets ?? [])].sort())) {
      diffs.push(`коннектор «${id}»: изменены секреты`);
    }
    if (oldC.defaultClass !== c.defaultClass) {
      diffs.push(`коннектор «${id}»: класс по умолчанию изменён ${oldC.defaultClass} → ${c.defaultClass}`);
    }
    const oldMax = oldC.maxResultChars ?? CONNECTOR_RESULT_MAX_CHARS_DEFAULT;
    const newMax = c.maxResultChars ?? CONNECTOR_RESULT_MAX_CHARS_DEFAULT;
    if (oldMax !== newMax) {
      diffs.push(`коннектор «${id}»: изменён лимит ответа ${oldMax} → ${newMax}`);
    }
    const oldTools = oldC.tools as Record<string, ProjectToolClass> | undefined;
    const newTools = c.tools as Record<string, ProjectToolClass> | undefined;
    const allTools = new Set([...Object.keys(oldTools ?? {}), ...Object.keys(newTools ?? {})]);
    for (const tool of allTools) {
      const oldCls = oldTools?.[tool];
      const newCls = newTools?.[tool];
      if (oldCls === undefined && newCls !== undefined) {
        diffs.push(`коннектор «${id}»: добавлена ручка «${tool}» (${newCls})`);
      } else if (oldCls !== undefined && newCls === undefined) {
        diffs.push(`коннектор «${id}»: удалена ручка «${tool}»`);
      } else if (oldCls !== newCls) {
        diffs.push(`коннектор «${id}»: класс ручки «${tool}» изменён ${oldCls} → ${newCls}`);
      }
    }
  }

  for (const id of oldMap.keys()) {
    if (!newMap.has(id)) {
      diffs.push(`удалён коннектор «${id}»`);
    }
  }

  return diffs;
}

const CLASS_SEVERITY: Record<string, number> = {
  R: 1,
  C: 2,
  P: 3,
  L: 4,
};

/**
 * Итоговый класс — строже из реестра и репо (§15.3: R < C < P < L).
 * Режим deny всегда побеждает (запрещено).
 */
export function resolveStrictClass(
  registryClass: ProjectToolClass,
  repoClass?: "R" | "C" | "P" | "L",
): ProjectToolClass {
  if (registryClass === "deny") return "deny";
  if (!repoClass || !CLASS_SEVERITY[repoClass]) return registryClass;
  const regSev = CLASS_SEVERITY[registryClass] ?? 2;
  const repoSev = CLASS_SEVERITY[repoClass] ?? 2;
  return repoSev > regSev ? repoClass : registryClass;
}

export interface RepoProjectEnvironment {
  promptMd?: string;
  tools?: Record<string, "R" | "C" | "P" | "L">;
}

/**
 * Чтение файлов окружения проекта (§15.3).
 * Читает только .bb/live-call/PROMPT.md (до 8000 символов) и tools.json.
 * Ничего другого из репо не читается никогда.
 */
export function readProjectRepoConfig(projectRoot: string): RepoProjectEnvironment {
  const result: RepoProjectEnvironment = {};
  if (!projectRoot || !existsSync(projectRoot)) return result;

  const promptPath = join(projectRoot, ".bb", "live-call", "PROMPT.md");
  if (existsSync(promptPath)) {
    try {
      const text = readFileSync(promptPath, "utf-8");
      result.promptMd = text.slice(0, 8000);
    } catch {
      // Игнорируем ошибки чтения файла
    }
  }

  const toolsPath = join(projectRoot, ".bb", "live-call", "tools.json");
  if (existsSync(toolsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(toolsPath, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const clean: Record<string, "R" | "C" | "P" | "L"> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (v === "R" || v === "C" || v === "P" || v === "L") {
            clean[k] = v;
          }
        }
        result.tools = clean;
      }
    } catch {
      // Игнорируем ошибки чтения
    }
  }

  return result;
}

export class ProjectRegistryManager {
  constructor(private store: CallStore) {}

  parseRegistry(rawJson?: string | null): {
    parsed: Record<string, ProjectConfig> | null;
    rawObj?: Record<string, unknown>;
    error?: string;
  } {
    if (!rawJson || !rawJson.trim()) {
      return { parsed: {} };
    }
    let obj: unknown;
    try {
      obj = JSON.parse(rawJson);
    } catch (e) {
      return { parsed: null, error: `некорректный JSON в настройке projectCalls: ${String((e as Error)?.message ?? e)}` };
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return { parsed: null, error: "projectCalls должен быть объектом { <projectId>: { title, connectors } }" };
    }
    const res = projectRegistrySchema.safeParse(obj);
    if (!res.success) {
      const msg = res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return { parsed: null, rawObj: obj as Record<string, unknown>, error: `ошибка валидации projectCalls: ${msg}` };
    }
    return { parsed: res.data as Record<string, ProjectConfig>, rawObj: obj as Record<string, unknown> };
  }

  listProjects(rawJson?: string | null): ProjectListItem[] {
    const { parsed, rawObj, error } = this.parseRegistry(rawJson);
    if (parsed === null) {
      // Если весь JSON не распарсился
      if (rawObj && typeof rawObj === "object") {
        return Object.entries(rawObj).map(([pid, val]) => {
          const title = val && typeof val === "object" && "title" in val && typeof val.title === "string" ? val.title : pid;
          return {
            projectId: pid,
            title,
            state: "invalid",
            error: error ?? "ошибка валидации",
          };
        });
      }
      return [
        {
          projectId: "unknown",
          title: "Некорректный реестр",
          state: "invalid",
          error: error ?? "ошибка JSON",
        },
      ];
    }

    const items: ProjectListItem[] = [];
    for (const [projectId, config] of Object.entries(parsed)) {
      const currentHash = hashProjectConfig(config);
      const approved = this.store.getApprovedProject(projectId);

      if (approved && approved.hash === currentHash) {
        items.push({
          projectId,
          title: config.title,
          state: "approved",
          hash: currentHash,
        });
      } else {
        let oldConfig: ProjectConfig | null = null;
        if (approved?.configJson) {
          try {
            oldConfig = JSON.parse(approved.configJson) as ProjectConfig;
          } catch {
            oldConfig = null;
          }
        }
        const diff = computeProjectDiff(oldConfig, config);
        items.push({
          projectId,
          title: config.title,
          state: "pending",
          hash: currentHash,
          diff,
        });
      }
    }

    return items;
  }

  approve(projectId: string, hash: string, rawJson?: string | null): { ok: boolean; error?: string } {
    const { parsed, error } = this.parseRegistry(rawJson);
    if (!parsed) return { ok: false, error: error ?? "некорректный реестр" };
    const config = parsed[projectId];
    if (!config) return { ok: false, error: `проект ${projectId} не найден в реестре` };
    const currentHash = hashProjectConfig(config);
    if (currentHash !== hash) {
      return { ok: false, error: "stale" };
    }
    this.store.setApprovedProject(projectId, hash, JSON.stringify(config));
    return { ok: true };
  }

  reject(projectId: string): { ok: boolean } {
    // Журнал registry_rejected фиксирует вызывающая сторона (server.ts)
    return { ok: true };
  }

  getApprovedConfig(projectId: string): {
    config: ProjectConfig;
    hash: string;
  } | null {
    const approved = this.store.getApprovedProject(projectId);
    if (!approved) return null;
    try {
      const config = JSON.parse(approved.configJson) as ProjectConfig;
      return { config, hash: approved.hash };
    } catch {
      return null;
    }
  }
}
