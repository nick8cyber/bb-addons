#!/usr/bin/env node
/**
 * Installer for the shared pre-push hook (spec orchestrator-release §7).
 * Run once per development user — NOT during tests:
 *
 *   node plugins/bb-plugin-orchestrator/hooks/install.mjs [--dry-run]
 *     [--hooks-dir <dir>] [--repos-root <dir>] [--exclude <path>]...
 *
 * 1. Inventory (опись) of the user's repositories: which hooks live in
 *    `.git/hooks` (the shared hook CHAINS to them — a global
 *    `core.hooksPath` shadows every hook name, so a local `pre-commit`
 *    would silently die without the wrapper, §17.3 Б2), which have their
 *    own `core.hooksPath` («свой процесс» — the shared hook never
 *    reaches them), which are excluded (service repos with autopush —
 *    put them in `--exclude`, else their autopush breaks).
 * 2. Installs a wrapper under EVERY standard hook name (`hook-names`):
 *    `pre-push` is the orchestrator token gate that chains to the local
 *    hook afterwards; every other name is a copy of `chain` — a plain
 *    pass-through to `$GIT_DIR/hooks/<name>`. Then writes `exclusions`.
 * 3. Sets `git config --global core.hooksPath <hooks dir>` unless one is
 *    already configured (then it only reports — `--force` overrides).
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HOOKS_SRC = dirname(fileURLToPath(import.meta.url));
/** Standard hook names this installer covers — single source shared
 * with the plugin's release-time freshness check. */
const HOOK_NAMES = readFileSync(join(HOOKS_SRC, "hook-names"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const multi = (n) => {
  const out = [];
  args.forEach((a, i) => a === n && out.push(args[i + 1]));
  return out;
};
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const selfTest = args.includes("--self-test");
/** §17.3 (ревью PLUG-210): ONE token dir shared by the plugin and the
 * hook — the installer asks the plugin itself (`bb orchestrator
 * hooks-dir`) instead of recalculating the path. Falls back to the
 * documented default when bb or the plugin is unavailable (a fresh
 * checkout, tests). */
function defaultHooksDir() {
  try {
    const out = execFileSync(
      process.env.BB_CLI ?? "bb",
      ["orchestrator", "hooks-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (out) return out;
  } catch { /* bb or the plugin unavailable — use the default */ }
  return join(homedir(), ".bb", "plugins", "orchestrator", "git-hooks");
}
const hooksDir = resolve(flag("--hooks-dir") ?? defaultHooksDir());
const reposRoot = resolve(flag("--repos-root") ?? homedir());
const extraExcludes = multi("--exclude").map((p) => resolve(p));

const SKIP = new Set([
  "node_modules", ".cache", ".local", ".npm", ".cargo", ".rustup",
  "snap", ".vscode", ".config/google-chrome",
]);
const MAX_DEPTH = 8;

function* findRepos(root, depth = 0) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  if (existsSync(join(root, ".git"))) {
    yield root;
    return; // do not descend into a repo's own tree
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name)) continue;
    // §7 опись: thread worktrees live under ~/.bb/plugins/environment-
    // git-worktree/... — hidden dirs are skipped EXCEPT .bb itself.
    if (e.name.startsWith(".") && e.name !== ".bb") continue;
    yield* findRepos(join(root, e.name), depth + 1);
  }
}

function gitConfig(repo, key) {
  try {
    return execFileSync("git", ["-C", repo, "config", "--local", key], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

// ── Inventory ──────────────────────────────────────────────────────────
const repos = [...findRepos(reposRoot)];
const ownHooksPath = [];
const withLocalHooks = [];
const plain = [];
for (const repo of repos) {
  if (gitConfig(repo, "core.hooksPath")) {
    ownHooksPath.push(repo);
    continue;
  }
  const hooksDirLocal = join(repo, ".git", "hooks");
  let hasLocal = false;
  try {
    hasLocal =
      existsSync(hooksDirLocal) &&
      readdirSync(hooksDirLocal).some(
        (f) =>
          !f.endsWith(".sample") &&
          statSync(join(hooksDirLocal, f)).mode & 0o111,
      );
  } catch { /* not a plain checkout (worktree .git file) */ }
  (hasLocal ? withLocalHooks : plain).push(repo);
}

const exclusions = [...new Set(extraExcludes)];

const report = [
  `hooks dir:      ${hooksDir}`,
  `repos root:     ${reposRoot} (${repos.length} репозиториев)`,
  "",
  `свой core.hooksPath (общий хук их НЕ трогает): ${ownHooksPath.length}`,
  ...ownHooksPath.map((r) => `  - ${r}`),
  `с локальными .git/hooks (общий хук вызовет их через обёртки всех имён): ${withLocalHooks.length}`,
  ...withLocalHooks.map((r) => `  - ${r}`),
  `без локальных хуков: ${plain.length}`,
  ...plain.map((r) => `  - ${r}`),
  `исключения (автопуш служебных): ${exclusions.length}`,
  ...exclusions.map((r) => `  - ${r}`),
  "",
  "проекты с excluded:true в настройке release: их репозитории хук не трогает —",
  "добавьте пути через --exclude <path> (или запишите в exclusions вручную).",
].join("\n");

if (dryRun) {
  console.log(report);
  process.exit(0);
}

// §5/§7 self-test: build each repository kind in a temp dir and prove
// every installed wrapper still chains to the repository's local hook —
// `pre-push` with a valid release token, every other name through the
// `chain` pass-through.
if (selfTest) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const tmp = mkdtempSync(join(tmpdir(), "hook-selftest-"));
  // Run against a TEMP copy of the hooks dir — the token files resolve
  // relative to the hook's own directory, so the live push-token-*.json
  // (possibly written by an in-flight release) are never touched.
  const testHooksDir = join(tmp, "hooks");
  mkdirSync(testHooksDir, { recursive: true });
  const srcDir = dirname(fileURLToPath(import.meta.url));
  for (const name of HOOK_NAMES) {
    const srcName = name === "pre-push" ? "pre-push" : "chain";
    const dst = join(testHooksDir, name);
    copyFileSync(
      existsSync(join(hooksDir, name))
        ? join(hooksDir, name)
        : join(srcDir, srcName),
      dst,
    );
    execFileSync("chmod", ["755", dst]);
  }
  const SHA = "a".repeat(40);
  const LINE = `refs/heads/x ${SHA} refs/heads/x ${"0".repeat(40)}\n`;
  const kinds = [
    { name: "plain .git/hooks", mk: (r) => r },
    {
      name: "worktree (.git file)",
      mk: (r) => {
        execFileSync("git", ["-C", r, "worktree", "add", join(tmp, "wt")], { stdio: "ignore" });
        return join(tmp, "wt");
      },
    },
  ];
  let failed = 0;
  for (const kind of kinds) {
    const base = join(tmp, kind.name.replace(/\W+/g, "-"));
    execFileSync("git", ["init", base], { stdio: "ignore" });
    const repo = kind.mk(base);
    const commonRaw = execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
    const common = isAbsolute(commonRaw) ? commonRaw : join(repo, commonRaw);
    const gitDir = execFileSync("git", ["-C", repo, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
    for (const name of HOOK_NAMES) {
      // local hook writes a marker next to the repo when it fires
      const lh = join(common, "hooks", name);
      writeFileSync(lh, '#!/bin/sh\n[ -n "$ORCH_MARK" ] && echo hit > "$ORCH_MARK"\nexit 0\n');
      execFileSync("chmod", ["+x", lh]);
      const mark = join(tmp, `mark-${kind.name.replace(/\W+/g, "-")}-${name}`);
      const env = { ...process.env, GIT_DIR: gitDir, ORCH_MARK: mark };
      if (name === "pre-push") {
        writeFileSync(join(testHooksDir, "push-token-selftest.json"),
          JSON.stringify({ token: "t", sha: SHA, branch: "x", expiresAt: Date.now() + 60000 }));
      }
      const wrapper = join(testHooksDir, name);
      const r = name === "pre-push"
        ? spawnSync("node", [wrapper], { cwd: repo, input: LINE, env, encoding: "utf8" })
        : spawnSync(wrapper, [], { cwd: repo, env, encoding: "utf8" });
      const ok = r.status === 0 && existsSync(mark);
      if (!ok) {
        failed++;
        console.log(`FAIL  ${name} chains to local hook: ${kind.name}`);
      }
    }
    console.log(`done  all ${HOOK_NAMES.length} wrappers chain: ${kind.name}`);
  }
  if (!failed) console.log("OK  self-test passed");
  rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

// ── Install ────────────────────────────────────────────────────────────
// §17.3 (Б2): a global core.hooksPath shadows EVERY hook name — install
// a wrapper under each: `pre-push` is the orchestrator gate (it chains
// to the local hook itself), the rest are copies of the `chain`
// pass-through so repository-local hooks keep firing.
mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
for (const name of HOOK_NAMES) {
  const src = join(HOOKS_SRC, name === "pre-push" ? "pre-push" : "chain");
  const dst = join(hooksDir, name);
  copyFileSync(src, dst);
  execFileSync("chmod", ["755", dst]);
}
writeFileSync(
  join(hooksDir, "exclusions"),
  exclusions.map((e) => `${e}\n`).join(""),
);

let hooksPathNow = "";
try {
  hooksPathNow = execFileSync(
    "git",
    ["config", "--global", "core.hooksPath"],
    { encoding: "utf8" },
  ).trim();
} catch { /* unset */ }

if (hooksPathNow && resolve(hooksPathNow) !== hooksDir && !force) {
  console.log(report);
  console.log(
    `\n!! глобальный core.hooksPath уже задан: ${hooksPathNow}\n` +
      `   не переписываю; для замены запустите с --force`,
  );
  process.exit(1);
}
execFileSync("git", ["config", "--global", "core.hooksPath", hooksDir]);
console.log(report);
console.log(`\nустановлено: core.hooksPath → ${hooksDir}`);
