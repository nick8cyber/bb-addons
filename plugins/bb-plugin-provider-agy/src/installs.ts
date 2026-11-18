/**
 * Parallel agy installs (spec provider-agy-installs.md §2, §5): the
 * instance-local registry `<dataDir>/agy-installs.json` binds install names
 * to binary paths and per-install child env, and every account's `install`
 * field names the install its binary must come from — strictly, with no
 * substitution.
 *
 * The file is machine-local: install names travel in the shared
 * accounts-state.json, but each host maps them to its own paths, so the
 * registry never syncs. Without the file the plugin runs exactly as before
 * (resolveAgyCommand answers every launch); a present-but-invalid file is a
 * loud error — the operator opted into registry mode and silence would
 * launch the wrong binary.
 */
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const INSTALLS_FILE = "agy-installs.json";

/** Install names are lowercase, short, and safe inside log lines (§2 п.3). */
export const INSTALL_NAME_RE = /^[a-z0-9-]{1,32}$/u;

export interface InstallRecord {
  bin: string;
  env: Record<string, string>;
}

export interface InstallsRegistry {
  installs: Record<string, InstallRecord>;
  /** Name of the primary install; must exist in `installs`. */
  default: string;
}

export type RegistryState =
  | { kind: "absent" }
  | { kind: "ok"; registry: InstallsRegistry }
  | { kind: "broken"; reason: string };

/**
 * Env keys a registry `env` section may not carry (§2 п.3): the plugin,
 * the shim and the account own these — a registry override would silently
 * rewrite the launch contract. The whole `AGY_*` prefix is off-limits for
 * the same reason. Presence of any of these makes the registry invalid.
 */
const FORBIDDEN_ENV_EXACT = new Set([
  "HOME",
  "ELECTRON_RUN_AS_NODE",
  "GEMINI_API_KEY",
  "GOOGLE_GEMINI_BASE_URL",
]);
const FORBIDDEN_ENV_PROXY = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);

function forbiddenEnvKey(key: string): boolean {
  return (
    FORBIDDEN_ENV_EXACT.has(key) ||
    FORBIDDEN_ENV_PROXY.has(key.toUpperCase()) ||
    key.startsWith("AGY_")
  );
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function validateRegistry(
  path: string,
  parsed: unknown,
): { ok: true; registry: InstallsRegistry } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return fail(`${path}: registry is not a JSON object`);
  }
  const doc = parsed as Record<string, unknown>;
  const installs: Record<string, InstallRecord> = {};
  if (doc.installs === null || typeof doc.installs !== "object" || Array.isArray(doc.installs)) {
    return fail(`${path}: "installs" is not an object`);
  }
  for (const [name, raw] of Object.entries(
    doc.installs as Record<string, unknown>,
  )) {
    if (!INSTALL_NAME_RE.test(name)) {
      return fail(`${path}: install name ${JSON.stringify(name)} does not match ${String(INSTALL_NAME_RE)}`);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return fail(`${path}: install ${name} is not an object`);
    }
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.bin !== "string" ||
      !entry.bin.startsWith("/")
    ) {
      return fail(`${path}: install ${name} "bin" is not an absolute path`);
    }
    const env: Record<string, string> = {};
    if (entry.env !== undefined) {
      if (entry.env === null || typeof entry.env !== "object" || Array.isArray(entry.env)) {
        return fail(`${path}: install ${name} "env" is not an object`);
      }
      for (const [key, value] of Object.entries(
        entry.env as Record<string, unknown>,
      )) {
        if (forbiddenEnvKey(key)) {
          return fail(
            `${path}: install ${name} env key ${key} is managed by the plugin and cannot be overridden`,
          );
        }
        if (typeof value !== "string") {
          return fail(`${path}: install ${name} env ${key} is not a string`);
        }
        env[key] = value;
      }
    }
    installs[name] = { bin: entry.bin, env };
  }
  if (typeof doc.default !== "string" || !Object.hasOwn(installs, doc.default)) {
    return fail(
      `${path}: "default" does not name an entry in "installs"`,
    );
  }
  return {
    ok: true,
    registry: { installs, default: doc.default },
  };
}

/**
 * The registry on disk right now, cached by (mtime, size): the file is
 * stat'ed on every call so an operator edit applies to the next pick/launch
 * without a plugin reload (§2 п.5), while unchanged mtime skips the parse.
 */
let registryCache: {
  path: string;
  mtimeMs: number;
  size: number;
  state: RegistryState;
} | null = null;

export function installsRegistry(dataDir: string): RegistryState {
  if (dataDir === "") {
    return { kind: "absent" };
  }
  const path = join(dataDir, INSTALLS_FILE);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    registryCache = { path, mtimeMs: 0, size: 0, state: { kind: "absent" } };
    return registryCache.state;
  }
  if (
    registryCache !== null &&
    registryCache.path === path &&
    registryCache.mtimeMs === stat.mtimeMs &&
    registryCache.size === stat.size
  ) {
    return registryCache.state;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    registryCache = {
      path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      state: {
        kind: "broken",
        reason: `${path}: not parseable JSON (${error instanceof Error ? error.message : String(error)})`,
      },
    };
    return registryCache.state;
  }
  const verdict = validateRegistry(path, parsed);
  registryCache = {
    path,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    state:
      verdict.ok === true
        ? { kind: "ok", registry: verdict.registry }
        : { kind: "broken", reason: verdict.reason },
  };
  return registryCache.state;
}

/**
 * Which binary an account's `install` field resolves to on this host:
 *
 * - `legacy`: no registry and no binding — the old resolveAgyCommand answer.
 * - `bin`: a concrete install binary plus the env layer the registry names.
 * - `unavailable`: the account is bound to something this host cannot run —
 *   an unknown/invalid install name, a registry that does not exist here,
 *   or a bin that is missing/not executable. The account is locally
 *   unavailable (§5 п.2): never picked, never probed, never launched.
 * - `broken`: the registry itself is invalid — nothing may launch at all,
 *   not even direct/relay (§2 п.4).
 */
export type InstallResolution =
  | { kind: "legacy" }
  | { kind: "bin"; name: string; bin: string; env: Record<string, string> }
  | { kind: "unavailable"; reason: string }
  | { kind: "broken"; reason: string };

/**
 * `install` is the ledger field's raw value: anything that is not a
 * pattern-matching string counts as an unknown install, never as default
 * (§3 п.2 — a typo must not silently rebind the account).
 */
export function resolveInstall(
  dataDir: string,
  install: unknown,
): InstallResolution {
  const state = installsRegistry(dataDir);
  if (state.kind === "broken") {
    return { kind: "broken", reason: state.reason };
  }
  if (install !== undefined) {
    if (typeof install !== "string" || !INSTALL_NAME_RE.test(install)) {
      return {
        kind: "unavailable",
        reason: `install ${JSON.stringify(install)} is not a valid install name`,
      };
    }
    if (state.kind === "absent") {
      return {
        kind: "unavailable",
        reason: `install ${install}: no ${INSTALLS_FILE} on this host`,
      };
    }
    const record = state.registry.installs[install];
    if (record === undefined) {
      return {
        kind: "unavailable",
        reason: `install ${install} is not declared in ${INSTALLS_FILE}`,
      };
    }
    if (!isExecutable(record.bin)) {
      return {
        kind: "unavailable",
        reason: `install ${install} binary ${record.bin} is missing or not executable`,
      };
    }
    return { kind: "bin", name: install, bin: record.bin, env: record.env };
  }
  if (state.kind === "absent") {
    return { kind: "legacy" };
  }
  const name = state.registry.default;
  const record = state.registry.installs[name];
  if (!isExecutable(record.bin)) {
    return {
      kind: "unavailable",
      reason: `default install ${name} binary ${record.bin} is missing or not executable`,
    };
  }
  return { kind: "bin", name, bin: record.bin, env: record.env };
}

/** True when the install resolution lets the account launch on this host. */
export function installAvailable(
  dataDir: string,
  install: unknown,
): boolean {
  const kind = resolveInstall(dataDir, install).kind;
  return kind === "bin" || kind === "legacy";
}

/** The §9 п.1 startup line naming every install and its binary path. */
export function registryLogLine(dataDir: string): string {
  const state = installsRegistry(dataDir);
  if (state.kind === "absent") {
    return "installs registry absent: implicit single install via resolveAgyCommand";
  }
  if (state.kind === "broken") {
    return `installs registry invalid: ${state.reason}`;
  }
  const parts = Object.entries(state.registry.installs).map(
    ([name, record]) => `${name}: ${record.bin}`,
  );
  return `installs registry loaded: default=${state.registry.default}; ${parts.join("; ")}`;
}
