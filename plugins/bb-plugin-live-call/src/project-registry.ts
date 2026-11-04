/**
 * Реестр звонков по проектам (§15.2, §15.3, §15.8).
 * Разбор, валидация, хеширование, диффы, вычисление строгого класса.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { CallStore } from "./call-store.js";
import { maskSecrets } from "./secret-filter.js";

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
    id: z.string().regex(/^[a-zA-Z0-9_]+$/, "id коннектора должен содержать только латинские буквы, цифры и подчёркивание").max(32),
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
      if (!data.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "http-коннектор требует url",
          path: ["url"],
        });
      } else {
        try {
          const u = new URL(data.url);
          const isHttps = u.protocol === "https:";
          const isLocalHttp = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
          if (!isHttps && !isLocalHttp) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "http-коннектор разрешает только https:// или http://127.0.0.1 / http://localhost",
              path: ["url"],
            });
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "некорректный url",
            path: ["url"],
          });
        }
      }
    }
  });

export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;

export const projectConfigSchema = z
  .object({
    title: z.string().min(1),
    connectors: z.array(connectorConfigSchema),
  })
  .superRefine((data, ctx) => {
    const ids = new Set<string>();
    for (let i = 0; i < data.connectors.length; i++) {
      const id = data.connectors[i].id;
      if (ids.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `дубликат id коннектора: «${id}»`,
          path: ["connectors", i, "id"],
        });
      }
      ids.add(id);
    }
  });

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export const projectRegistrySchema = z.record(z.string(), projectConfigSchema);
export type ProjectRegistry = z.infer<typeof projectRegistrySchema>;

export interface ProjectListItem {
  projectId: string;
  title: string;
  state: "approved" | "pending" | "invalid" | "rejected";
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

/** Сравнение старой подтверждённой конфигурации и новой (§15.2, §16.7 п. 7). */
export function computeProjectDiff(oldConfig: ProjectConfig | null, newConfig: ProjectConfig): string[] {
  const diffs: string[] = [];
  if (!oldConfig) {
    const connDetails = newConfig.connectors.map((c) => {
      if (c.transport === "stdio") {
        return `${c.id} (stdio: [${(c.command ?? []).join(" ")}])`;
      }
      return `${c.id} (http: ${maskSecrets(c.url ?? "-")})`;
    });
    diffs.push(`новый проект в реестре: коннекторы [${connDetails.join(", ")}]`);
    return diffs;
  }

  if (oldConfig.title !== newConfig.title) {
    diffs.push(`изменено название: «${oldConfig.title}» → «${newConfig.title}»`);
  }

  const oldMap = new Map(oldConfig.connectors.map((c) => [c.id, c]));
  const newMap = new Map(newConfig.connectors.map((c) => [c.id, c]));

  for (const [id, c] of newMap) {
    if (!oldMap.has(id)) {
      const details = c.transport === "stdio" ? `stdio: [${(c.command ?? []).join(" ")}]` : `http: ${maskSecrets(c.url ?? "-")}`;
      diffs.push(`добавлен коннектор «${id}» (${details})`);
      continue;
    }
    const oldC = oldMap.get(id)!;
    if (oldC.transport !== c.transport) {
      diffs.push(`коннектор «${id}»: изменён транспорт ${oldC.transport} → ${c.transport}`);
    }
    if (JSON.stringify(oldC.command ?? []) !== JSON.stringify(c.command ?? [])) {
      diffs.push(`коннектор «${id}»: изменена команда запуска [${(oldC.command ?? []).join(" ")}] → [${(c.command ?? []).join(" ")}]`);
    }
    if (oldC.url !== c.url) {
      diffs.push(`коннектор «${id}»: изменён адрес ${maskSecrets(oldC.url ?? "-")} → ${maskSecrets(c.url ?? "-")}`);
    }
    if (JSON.stringify([...(oldC.secrets ?? [])].sort()) !== JSON.stringify([...(c.secrets ?? [])].sort())) {
      diffs.push(`коннектор «${id}»: изменены секреты [${(oldC.secrets ?? []).join(", ")}] → [${(c.secrets ?? []).join(", ")}]`);
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

function safeReadFileBounded(filePath: string, projectRoot: string, maxBytes = 32768): string | null {
  try {
    const resolvedRoot = resolve(projectRoot);
    const resolvedPath = resolve(filePath);
    if (!resolvedPath.startsWith(resolvedRoot)) return null;

    if (!existsSync(resolvedPath)) return null;
    const stat = lstatSync(resolvedPath);
    // Проверка: обычный файл, не симлинк (§16.7 п. 7, §15.3, review п. 12)
    if (stat.isSymbolicLink() || !stat.isFile()) return null;

    const fd = openSync(resolvedPath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead).toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Чтение файлов окружения проекта (§15.3, §16.7 п. 7).
 * Читает только .bb/live-call/PROMPT.md (до 8000 символов) и tools.json (до 32 КБ).
 * Не переходит по симлинкам; не читает устройства; не читает больше 32 КБ.
 */
export function readProjectRepoConfig(projectRoot: string): RepoProjectEnvironment {
  const result: RepoProjectEnvironment = {};
  if (!projectRoot || !existsSync(projectRoot)) return result;

  const promptPath = join(projectRoot, ".bb", "live-call", "PROMPT.md");
  const promptText = safeReadFileBounded(promptPath, projectRoot, 32768);
  if (promptText !== null) {
    result.promptMd = promptText.slice(0, 8000);
  }

  const toolsPath = join(projectRoot, ".bb", "live-call", "tools.json");
  const toolsText = safeReadFileBounded(toolsPath, projectRoot, 32768);
  if (toolsText !== null) {
    try {
      const parsed = JSON.parse(toolsText) as unknown;
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
      // Игнорируем ошибки парсинга JSON
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

    // При удалении проекта из реестра снимок удаляется (§16.7 п. 2)
    const approvedIds = this.store.listApprovedProjectIds();
    for (const id of approvedIds) {
      if (!parsed[id]) {
        this.store.deleteApprovedProject(id);
      }
    }
    const rejectedIds = this.store.listRejectedProjectIds();
    for (const id of rejectedIds) {
      if (!parsed[id]) {
        this.store.deleteRejectedProject(id);
      }
    }

    const items: ProjectListItem[] = [];
    for (const [projectId, config] of Object.entries(parsed)) {
      const currentHash = hashProjectConfig(config);
      const approved = this.store.getApprovedProject(projectId);
      const rejected = this.store.getRejectedProject(projectId);

      if (approved && approved.hash === currentHash) {
        items.push({
          projectId,
          title: config.title,
          state: "approved",
          hash: currentHash,
        });
      } else if (rejected && rejected.hash === currentHash) {
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
          state: "rejected",
          hash: currentHash,
          diff,
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
    this.store.deleteRejectedProject(projectId);
    return { ok: true };
  }

  reject(projectId: string, rawJson?: string | null): { ok: boolean } {
    const { parsed } = this.parseRegistry(rawJson);
    if (parsed && parsed[projectId]) {
      const hash = hashProjectConfig(parsed[projectId]);
      this.store.setRejectedProject(projectId, hash);
    }
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
