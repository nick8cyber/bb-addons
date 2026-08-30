/**
 * pi's own credential-reference grammar, ported.
 *
 * models.json blocks written by other tools carry `apiKey` (and `headers`)
 * strings in whatever form pi accepts, and this plugin has to decide what a
 * given string *is* before it dares touch it: a shell command and an env
 * reference are configuration and can be copied around freely, while a literal
 * is a secret that must never leave the file it already sits in.
 *
 * The rules below mirror `@earendil-works/pi-coding-agent`'s
 * `resolve-config-value.js` (parseConfigValueReference / parseConfigValueTemplate)
 * exactly, because a *nearly* right parser is what turns `$TOK-suffix` into a
 * leaked or a broken key. In particular the naive "starts with `$` → env" test
 * is wrong: `$TOK-suffix` is a template with a literal tail, `$$` and `$!` are
 * escapes, and `$1BAD` is not an env reference at all.
 */

import { execFileSync } from "node:child_process";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

export type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

function appendLiteral(parts: TemplatePart[], value: string): void {
  if (!value) return;
  const previous = parts[parts.length - 1];
  if (previous?.type === "literal") {
    previous.value += value;
    return;
  }
  parts.push({ type: "literal", value });
}

/** Port of pi's parseConfigValueTemplate. */
export function parseTemplate(config: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let index = 0;
  while (index < config.length) {
    const dollarIndex = config.indexOf("$", index);
    if (dollarIndex < 0) {
      appendLiteral(parts, config.slice(index));
      break;
    }
    appendLiteral(parts, config.slice(index, dollarIndex));
    const nextChar = config[dollarIndex + 1];
    if (nextChar === "$" || nextChar === "!") {
      appendLiteral(parts, nextChar);
      index = dollarIndex + 2;
      continue;
    }
    if (nextChar === "{") {
      const endIndex = config.indexOf("}", dollarIndex + 2);
      if (endIndex < 0) {
        appendLiteral(parts, "$");
        index = dollarIndex + 1;
        continue;
      }
      const name = config.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME_RE.test(name)) {
        parts.push({ type: "env", name });
      } else {
        appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
      }
      index = endIndex + 1;
      continue;
    }
    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      parts.push({ type: "env", name: match[0] });
      index = dollarIndex + 1 + match[0].length;
      continue;
    }
    appendLiteral(parts, "$");
    index = dollarIndex + 1;
  }
  return parts;
}

export type KeyRefKind = "command" | "env" | "env-template" | "literal" | "none";

export type KeyRefInfo =
  /** `!…`: the remainder is a shell command pi runs when a session starts. */
  | { kind: "command"; command: string }
  /** A template that is exactly one env reference — losslessly expressible as a KeySource. */
  | { kind: "env"; name: string }
  /** Several env references and no literal text: resolvable, but not a single KeySource. */
  | { kind: "env-template"; names: string[] }
  /** Carries literal text, i.e. at least part of the secret lives in the file. */
  | { kind: "literal"; hasEnvParts: boolean }
  /** No apiKey at all (some local gateways need none). */
  | { kind: "none" };

/** Classify a raw models.json credential reference. Never returns the value itself. */
export function parseKeyRef(raw: string | undefined | null): KeyRefInfo {
  if (typeof raw !== "string" || raw.length === 0) return { kind: "none" };
  if (raw.startsWith("!")) return { kind: "command", command: raw.slice(1) };
  const parts = parseTemplate(raw);
  if (parts.length === 0) return { kind: "none" };
  const envNames: string[] = [];
  let hasLiteral = false;
  for (const part of parts) {
    if (part.type === "env") {
      if (!envNames.includes(part.name)) envNames.push(part.name);
    } else {
      hasLiteral = true;
    }
  }
  if (hasLiteral) return { kind: "literal", hasEnvParts: envNames.length > 0 };
  if (parts.length === 1) return { kind: "env", name: envNames[0]! };
  return { kind: "env-template", names: envNames };
}

/**
 * The redacted rendering used everywhere a key reference is shown.
 *
 * Commands and env references print verbatim: they are configuration, and
 * hiding them would hide the very thing the user needs in order to fix a
 * broken provider. Anything with literal text prints as a shape only — no
 * partial reveal, no prefix, no suffix. Partial reveals invite mistakes.
 */
export function displayKeyRef(raw: string | undefined | null): string {
  const info = parseKeyRef(raw);
  switch (info.kind) {
    case "command":
    case "env":
    case "env-template":
      return raw as string;
    case "literal":
      return info.hasEnvParts
        ? `«literal template, ${(raw as string).length} chars»`
        : `«literal, ${(raw as string).length} chars»`;
    case "none":
      return "«no key»";
  }
}

/** How a header value is shown: presence only, because header values are secrets by assumption. */
export function displayHeaderValue(): string {
  return "«set»";
}

const ECHOED_COMMAND_RE = /^(?:echo|printf)\s/;
const TOKEN_SHAPED_RE = /\b[A-Za-z0-9_-]{20,}\b/;

/**
 * A lint, not a blocker: `!echo sk-live…` resolves fine but keeps the secret in
 * the config file, which is exactly what a reference is supposed to avoid.
 */
export function keyRefWarnings(raw: string | undefined | null): string[] {
  const info = parseKeyRef(raw);
  if (info.kind !== "command") return [];
  if (!ECHOED_COMMAND_RE.test(info.command) || !TOKEN_SHAPED_RE.test(info.command)) return [];
  return [
    "this key command embeds the token in the config file — consider migrating it to an environment variable or a key file",
  ];
}

export interface KeyRefResolver {
  /** Injected in tests; production passes pi's own semantics (`sh -c`). */
  runCommand?: (command: string) => string | undefined;
  env?: Record<string, string | undefined>;
}

/**
 * Resolve a raw reference to its value, in memory only.
 *
 * Deliberately mirrors pi (10 s ceiling, stdout trimmed, `/bin/sh`, failures
 * collapse to undefined) so that "the plugin could read the key" and "pi can
 * read the key" mean the same thing. Note the shell: pi shells out through
 * `sh`, and a command that only works under bash would pass here and fail in a
 * real session.
 */
export function resolveKeyRefValue(
  raw: string | undefined | null,
  opts: KeyRefResolver = {},
): { ok: true; token: string } | { ok: false; error: string } {
  const info = parseKeyRef(raw);
  const env = opts.env ?? process.env;
  switch (info.kind) {
    case "none":
      return { ok: false, error: "this provider block carries no apiKey" };
    case "command": {
      let out: string | undefined;
      try {
        out = opts.runCommand ? opts.runCommand(info.command) : runShellCommand(info.command);
      } catch {
        out = undefined;
      }
      if (!out) return { ok: false, error: `the key command produced no output: ${info.command}` };
      return { ok: true, token: out };
    }
    default: {
      const parts = parseTemplate(raw as string);
      let resolved = "";
      for (const part of parts) {
        if (part.type === "literal") {
          resolved += part.value;
          continue;
        }
        const value = env[part.name];
        if (value === undefined || value === "") {
          return { ok: false, error: `environment variable ${part.name} is not set on this host` };
        }
        resolved += value;
      }
      if (!resolved) return { ok: false, error: "the key reference resolved to an empty value" };
      return { ok: true, token: resolved };
    }
  }
}

function runShellCommand(command: string): string | undefined {
  const out = execFileSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out.trim() || undefined;
}
