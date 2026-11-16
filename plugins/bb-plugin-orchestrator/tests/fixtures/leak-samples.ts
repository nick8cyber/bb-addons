/**
 * Leak-scan fixture paths (spec orchestrator-release §4 «Синтетические
 * пути в тестах», r8): the ONLY file allowed to carry literal
 * machine-path strings. Tests import every sample from here — a
 * literal path in any other source or test file is itself a
 * category-3 finding under the installed scanner.
 */

/** Positive samples — the category-3 scanner must flag them. */
export const LEAK_HOME_PATH = "/home/alice/work/secret";
export const LEAK_USERS_PATH = "/Users/bob/work/secret";

/** Negative samples — fixture prefixes the scanner must ignore. */
export const SAFE_HOME_PATH = "/home/example/safe/path";
export const SAFE_USERS_PATH = "/Users/example/safe/path";

/** One line with an exempt fixture prefix next to a real path —
 * the exemption is per occurrence, so this line is still a finding. */
export const MIXED_PATH_LINE = `cp ${SAFE_HOME_PATH} ${LEAK_HOME_PATH}`;

/** Positive sample — a fixture prefix glued to a real path with NO
 * separator: the exempt occurrence (`/…/example`) must not swallow
 * the slash that leads the real path's `home` segment, or the real
 * path loses its own match and the line goes silent (ревью PLUG-231
 * заход 2). */
export const GLUED_PATH_LINE = "/home/example/home/alice/work/secret";

// ── §22.1 / release §4 r11.1: samples for the pre-commit hook and
// release-scan tests. Every sample below is LITERAL — assembling a
// secret sample (concat/template/repeat) is a §5 gate bypass. The ONE
// exception is the r11.1 transition (release §4 «Переход», step 1,
// PLUG-273): the still-installed pre-r11.1 scanner counts a literal
// token/address a finding even inside this allow-listed file, so the
// category 1–2 samples come from the fixture functions `synthetic` /
// `syntheticEmail` until step 2 lands them as literals and removes
// the helpers.

/** Machine-path prefix matching the `home-path` rule. */
export const LEAK_HOME_PREFIX = "/home/alice";
/** A full machine path (the `/home/alice/p` sample of §22.1). */
export const LEAK_MACHINE_PATH = "/home/alice/p";
/** bb thread id matching the `bb-thread-id` rule — allowed here
 * because this file is a `leaks.allow` place (categories 3–4 only). */
export const LEAK_THREAD_ID = "thr_abc123def";
/** Private IP matching the `private-ip` rule — a positive cat-3
 * sample, so it lives only in this fixture file. */
export const LEAK_PRIVATE_IP = "172.16.0.9";
/** Three-octet version string — the `private-ip` rule must NOT match
 * it (only four octets are an address). */
export const IP_VERSION_LIKE = "172.16.0";
/** Transition step 1 helper (release §4 «Переход», PLUG-273): builds a
 * synthetic value — `prefix` plus `len` repeats of one char. The shape
 * (single repeated body after a known prefix, or the `EXAMPLE` marker)
 * is what `isSyntheticSecret`/`isSyntheticEmail` exempt inside `allow`
 * fixture files; step 2 replaces the calls with literals and removes
 * this function. */
export const synthetic = (prefix: string, len: number): string =>
  prefix + "x".repeat(len);

/** Transition step 1 helper for the category-2 sample: the WHOLE
 * address comes from one fixture function — the `EXAMPLE` marker plus
 * the `domain` — with no concatenation at the call site (release §4
 * «Переход» allows only fixture functions on step 1; assembling a
 * sample outside them is a §5 bypass). Step 2 lands it as a literal
 * and removes this function. */
export const syntheticEmail = (domain: string): string =>
  `EXAMPLE@${domain}`;

/** §4 r11.1 synthetic address. The `EXAMPLE` marker makes it exempt
 * inside this allow-listed fixture file only; the same address in any
 * other file is a category-2 `personal-email` finding. */
export const LEAK_PERSONAL_EMAIL = syntheticEmail("gmail.com");
/** §4 r11.1 synthetic secret: `ghp_` + a single repeated char. Exempt
 * inside this fixture file only; anywhere else it is a category-1
 * `github-token` finding. */
export const LEAK_GHP_SECRET = synthetic("ghp_", 36);

/** §20.2 (PLUG-269): token-shaped samples for the tool-less packet
 * tests — `synthetic` keeps each exempt inside this allow-listed
 * file; the same value anywhere else is a category-1 `github-token`
 * finding. */
export const LEAK_GH_TOKEN = synthetic("ghp_", 12);
export const LEAK_GH_TOKEN_2 = synthetic("ghp_", 18);
/** The packet tests' mask pattern over the sample shape — a regex,
 * not a secret value. */
export const GH_TOKEN_RE = /ghp_[A-Za-z0-9]+/g;
