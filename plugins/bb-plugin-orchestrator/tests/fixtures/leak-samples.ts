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
