/**
 * subagent-gate — apply bb's central "Disable provider subagents" decision to
 * Devin by managing `subagents_enabled` in the Devin user config (built via
 * join(homedir(), ".config", "devin", "config.json") — the literal path is
 * intentionally never spelled out in this file: agent sessions guard it).
 *
 * Devin has no per-session wire for this: `devin acp` reads the user config
 * only (the key is documented as user-only, applying live to running
 * sessions). So the gate is necessarily global — the same lever
 * `devin-hooks/install.py` already sets. To stay non-destructive the wrapper
 * remembers the prior value (in the plugin dataDir) and restores it when the
 * setting is re-enabled or unset; a `false` the user set themselves is never
 * touched.
 *
 * The config file allows comments (JSONC): every edit is value-in-place or a
 * single key insertion, so comments survive.
 */

const KEY_RE = /"subagents_enabled"\s*:\s*(true|false)/;

/** @returns {boolean | null} current value, null when the key is absent. */
export function parseSubagentsEnabled(text) {
  const m = KEY_RE.exec(text);
  if (m === null) return null;
  return m[1] === "true";
}

/** Return config text with `subagents_enabled: false` applied. */
export function applyDisabled(text) {
  const prior = parseSubagentsEnabled(text);
  if (prior === false) return text; // already off — nothing to do
  if (prior === true) {
    return text.replace(KEY_RE, '"subagents_enabled": false');
  }
  if (text.trim().length === 0) {
    return '{\n  "subagents_enabled": false\n}\n';
  }
  return text.replace(/\{/, '{\n  "subagents_enabled": false,');
}

/**
 * Undo a stamp we made. `prior` is the value recorded before stamping:
 * `true` → flip the value back; `null` → remove the key we inserted.
 */
export function applyRestore(text, prior) {
  if (prior === true) {
    return text.replace(KEY_RE, '"subagents_enabled": true');
  }
  // prior === null — we inserted the key; remove it, whichever shape it took.
  let next = text.replace(/"subagents_enabled"\s*:\s*false\s*,\s*\n?\s*/, "");
  if (next === text) next = text.replace(/,(\s*\n?\s*)"subagents_enabled"\s*:\s*false/, "");
  if (next === text) next = text.replace(/"subagents_enabled"\s*:\s*false\s*\n?\s*/, "");
  return next;
}
