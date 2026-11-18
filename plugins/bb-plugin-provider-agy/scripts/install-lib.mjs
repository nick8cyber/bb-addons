#!/usr/bin/env node
/**
 * Shared helpers for the operator scripts (add-account.mjs,
 * import-accounts.mjs): the instance-local installs registry
 * `<dataDir>/agy-installs.json` (spec provider-agy-installs §2), atomic
 * accounts-state.json writes (§4), and the pool-side marker check.
 * Mirrors the rules in src/installs.ts — the scripts are plain .mjs, so
 * the validator lives here in parallel.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const INSTALLS_FILE = "agy-installs.json";
export const INSTALL_NAME_RE = /^[a-z0-9-]{1,32}$/u;
export const SATELLITE_MARKER = "pool-satellite";

/** §2 п.3: env keys an install record may not carry — the plugin, the
 * shim and the account own them; the whole AGY_* prefix is off-limits. */
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

function forbiddenEnvKey(key) {
  return (
    FORBIDDEN_ENV_EXACT.has(key) ||
    FORBIDDEN_ENV_PROXY.has(key.toUpperCase()) ||
    key.startsWith("AGY_")
  );
}

/**
 * Read and validate the registry (§2 пп. 3-4):
 *   { state: "absent" }                         — no file, legacy mode
 *   { state: "ok", installs, default }          — installs[name] = {bin, env}
 *   { state: "broken", reason }                 — invalid file: a loud
 *                                                 operator error, never
 *                                                 a silent default
 */
export function readInstallsRegistry(dataDir) {
  const path = join(dataDir, INSTALLS_FILE);
  if (!existsSync(path)) {
    return { state: "absent" };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { state: "broken", reason: `${path}: not parseable JSON (${error.message})` };
  }
  const fail = (reason) => ({ state: "broken", reason: `${path}: ${reason}` });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("registry is not a JSON object");
  }
  const installs = {};
  if (parsed.installs === null || typeof parsed.installs !== "object" || Array.isArray(parsed.installs)) {
    return fail('"installs" is not an object');
  }
  for (const [name, raw] of Object.entries(parsed.installs)) {
    if (!INSTALL_NAME_RE.test(name)) {
      return fail(`install name ${JSON.stringify(name)} does not match ${INSTALL_NAME_RE}`);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return fail(`install ${name} is not an object`);
    }
    if (typeof raw.bin !== "string" || !raw.bin.startsWith("/")) {
      return fail(`install ${name} "bin" is not an absolute path`);
    }
    const env = {};
    if (raw.env !== undefined) {
      if (raw.env === null || typeof raw.env !== "object" || Array.isArray(raw.env)) {
        return fail(`install ${name} "env" is not an object`);
      }
      for (const [key, value] of Object.entries(raw.env)) {
        if (forbiddenEnvKey(key)) {
          return fail(`install ${name} env key ${key} is managed by the plugin and cannot be overridden`);
        }
        if (typeof value !== "string") {
          return fail(`install ${name} env ${key} is not a string`);
        }
        env[key] = value;
      }
    }
    installs[name] = { bin: raw.bin, env };
  }
  if (typeof parsed.default !== "string" || !Object.hasOwn(installs, parsed.default)) {
    return fail('"default" does not name an entry in "installs"');
  }
  return { state: "ok", installs, default: parsed.default };
}

/**
 * Resolve the registry name an operator's `--install` argument binds to
 * (§4.1/§4.3): the literal "default" and the registry's own default name
 * both mean "the main install" — the account record then carries no
 * `install` field at all. Returns:
 *   { ok: true, field: null }        — binds to default, nothing is written
 *   { ok: true, field: name, bin, env }
 *   { ok: false, reason }
 */
export function resolveInstallArg(registryState, installArg) {
  if (installArg === undefined) {
    return { ok: true, field: null };
  }
  if (typeof installArg !== "string" || !INSTALL_NAME_RE.test(installArg)) {
    return {
      ok: false,
      reason: `--install ${JSON.stringify(installArg)} does not match ${INSTALL_NAME_RE}`,
    };
  }
  if (registryState.state !== "ok") {
    return {
      ok: false,
      reason:
        registryState.state === "absent"
          ? `--install ${installArg}: no ${INSTALLS_FILE} on this host`
          : `--install ${installArg}: ${registryState.reason}`,
    };
  }
  if (installArg === "default" || installArg === registryState.default) {
    return { ok: true, field: null };
  }
  const record = registryState.installs[installArg];
  if (record === undefined) {
    return {
      ok: false,
      reason: `--install ${installArg} is not declared in ${INSTALLS_FILE}`,
    };
  }
  return { ok: true, field: installArg, bin: record.bin, env: record.env };
}

/** The binary a login/import flow runs when the operator gave no --install:
 * the registry's default install, or the legacy resolution without one. */
export function defaultInstallBin(registryState) {
  if (registryState.state === "ok") {
    const record = registryState.installs[registryState.default];
    return { bin: record.bin, env: record.env };
  }
  return null; // caller falls back to its own agy resolution
}

/** The pool-side marker: writes to the shared file on a satellite are
 * wiped by the keeper sync within ~30s — shared-state mutations refuse. */
export function isSatellite(dataDir) {
  return existsSync(join(dataDir, SATELLITE_MARKER));
}

/** Tolerant read of <dataDir>/accounts-state.json → {accounts:{...}}. */
export function readAccountsState(dataDir) {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dataDir, "accounts-state.json"), "utf8"),
    );
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (
        parsed.accounts === null ||
        typeof parsed.accounts !== "object" ||
        Array.isArray(parsed.accounts)
      ) {
        parsed.accounts = {};
      }
      return parsed;
    }
  } catch {}
  return { accounts: {} };
}

/** §4.1: temp file in the same directory + rename — a concurrent reader
 * never sees a half-written shared file. */
export function writeJsonAtomic(path, obj) {
  const tmp = join(
    dirname(path),
    `.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function accountsStatePath(dataDir) {
  return join(dataDir, "accounts-state.json");
}

export { mkdtempSync, tmpdir };
