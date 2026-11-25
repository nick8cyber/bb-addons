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
 *    `pre-push` is the orchestrator token gate and `pre-commit` (§22.1)
 *    the staged-diff leak gate — both chain to the local hook
 *    afterwards; every other name is a copy of `chain` — a plain
 *    pass-through to `$GIT_DIR/hooks/<name>`. `leak-scan.ts` (the shared
 *    scanner core `pre-commit` loads) lands next to them. Then writes
 *    `exclusions`.
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
  rmSync,
  statSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { covers } from "./hook-lib.mjs";

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
/** §17.3 (ревью PLUG-210/PLUG-214): ONE token dir shared by the plugin
 * and the hook — the installer asks the plugin itself (`bb orchestrator
 * hooks-dir`), never recalculates the path. No flag and no answer from
 * bb is a refusal with a hint, not a silently divergent guess. */
function pluginHooksDir() {
  try {
    const out = execFileSync(
      process.env.BB_CLI ?? "bb",
      ["orchestrator", "hooks-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    // the path is the last non-empty line — bb may print config
    // warnings on stdout ahead of it
    return out.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? null;
  } catch {
    return null;
  }
}
const hooksDirArg = flag("--hooks-dir") ?? pluginHooksDir();

// §24.1 п.1: moving a copy's local core.hooksPath into chain.json is
// an owner decision — only the plugin command checks the owner and
// verifies the effective path afterwards (one route, no second copy of
// the logic here).
if (flag("--fix-local")) {
  console.error(
    "fix-local: используйте `bb orchestrator hooks install --fix-local <копия> --confirm` из терминала владельца",
  );
  process.exit(1);
}
// §17.3 (ревью PLUG-216 мелко): the hooks dir is required only to
// INSTALL — `--self-test` falls back to this package's own wrappers and
// `--dry-run` only prints the inventory.
if (!hooksDirArg && !selfTest && !dryRun) {
  console.error(
    "каталог хуков не определён: `bb orchestrator hooks-dir` недоступен " +
      "(bb или плагин не отвечает).\n" +
      "Подсказка: канонический путь печатает `bb orchestrator hooks-dir`; " +
      "передайте его явно — --hooks-dir <путь>.",
  );
  process.exit(1);
}
const hooksDir = hooksDirArg ? resolve(hooksDirArg) : null;
const reposRoot = resolve(flag("--repos-root") ?? homedir());
const extraExcludes = multi("--exclude");
const normalizedExcludes = extraExcludes.map((p) => {
  const hasSlash = p.endsWith("/");
  const abs = resolve(p);
  return hasSlash ? (abs.endsWith("/") ? abs : abs + "/") : abs;
});

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

const exclusions = [...new Set(normalizedExcludes)];

const report = [
  `hooks dir:      ${hooksDir ?? "(не определён — для установки передайте --hooks-dir)"}`,
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
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const tmp = mkdtempSync(join(tmpdir(), "hook-selftest-"));
  // Run against a TEMP copy of the hooks dir — the token files resolve
  // relative to the hook's own directory, so the live push-token-*.json
  // (possibly written by an in-flight release) are never touched.
  const testHooksDir = join(tmp, "hooks");
  mkdirSync(testHooksDir, { recursive: true });
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const GATE_HOOKS = new Set([
    "pre-push",
    "pre-commit",
    "post-checkout",
    "reference-transaction",
  ]);
  for (const name of HOOK_NAMES) {
    const srcName = GATE_HOOKS.has(name) ? name : "chain";
    const dst = join(testHooksDir, name);
    copyFileSync(
      hooksDir && existsSync(join(hooksDir, name))
        ? join(hooksDir, name)
        : join(srcDir, srcName),
      dst,
    );
    execFileSync("chmod", ["755", dst]);
  }
  // §22.1: `pre-commit` loads `leak-scan.ts` from its own directory.
  copyFileSync(
    hooksDir && existsSync(join(hooksDir, "leak-scan.ts"))
      ? join(hooksDir, "leak-scan.ts")
      : join(srcDir, "leak-scan.ts"),
    join(testHooksDir, "leak-scan.ts"),
  );
  // §24.1: every wrapper imports the shared helpers next to it.
  copyFileSync(
    hooksDir && existsSync(join(hooksDir, "hook-lib.mjs"))
      ? join(hooksDir, "hook-lib.mjs")
      : join(srcDir, "hook-lib.mjs"),
    join(testHooksDir, "hook-lib.mjs"),
  );
  const SHA = "a".repeat(40);
  const LINE = `refs/heads/x ${SHA} refs/heads/x ${"0".repeat(40)}\n`;
  const kinds = [
    { name: "plain .git/hooks", bare: false, mk: (r) => r },
    {
      name: "worktree (.git file)",
      bare: false,
      mk: (r) => {
        execFileSync("git", ["-C", r, "worktree", "add", join(tmp, "wt")], { stdio: "ignore" });
        return join(tmp, "wt");
      },
    },
    // §17.3 (ревью PLUG-214): a bare repo — the server-side names
    // (pre-receive/update/…) exist for this shape; without it their
    // wrappers are never exercised.
    { name: "bare", bare: true, mk: (r) => r },
  ];
  let failed = 0;
  for (const kind of kinds) {
    const base = join(tmp, kind.name.replace(/\W+/g, "-"));
    execFileSync("git", ["init", ...(kind.bare ? ["--bare"] : []), base], { stdio: "ignore" });
    if (!kind.bare) {
      execFileSync("git", ["-C", base, "config", "user.email", "test@test.local"], { stdio: "ignore" });
      execFileSync("git", ["-C", base, "config", "user.name", "Test"], { stdio: "ignore" });
      execFileSync("git", ["-C", base, "checkout", "-B", "selftest-branch"], { stdio: "ignore" });
      execFileSync("git", ["-C", base, "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
    }
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
      delete env.BB_THREAD_ID;
      if (name === "pre-push") {
        writeFileSync(join(testHooksDir, "push-token-selftest.json"),
          JSON.stringify({ token: "t", sha: SHA, branch: "x", expiresAt: Date.now() + 60000 }));
      }
      const wrapper = join(testHooksDir, name);
      const r = GATE_HOOKS.has(name)
        ? spawnSync("node", [wrapper], { cwd: repo, input: name === "pre-push" ? LINE : "", env, encoding: "utf8" })
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
// §17.3 (ревью PLUG-214): a foreign global core.hooksPath refuses
// BEFORE any file lands in hooksDir — a refused install must not leave
// wrappers behind.
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

// §24.4 п.5: проверка --exclude по projects.json и live-copies.json ДО любой записи
if (hooksDir) {
  const projFile = join(hooksDir, "projects.json");
  let projectsList = null;
  if (!existsSync(projFile)) {
    if (normalizedExcludes.length > 0) {
      console.warn("проверка покрытия проектов пропущена — нет реестра; запусти bb orchestrator hooks install");
    }
  } else {
    try {
      projectsList = JSON.parse(readFileSync(projFile, "utf8"));
    } catch {}
  }

  const liveFile = join(hooksDir, "live-copies.json");
  let liveList = null;
  if (existsSync(liveFile)) {
    try {
      liveList = JSON.parse(readFileSync(liveFile, "utf8"));
    } catch {}
  }

  if (projectsList || liveList) {
    const targets = [];
    for (const p of projectsList ?? []) targets.push(dirname(p));
    for (const l of liveList ?? []) targets.push(l);
    const coversList = [];
    for (const entry of normalizedExcludes) {
      for (const t of targets) {
        if (covers(entry, t)) {
          coversList.push(`${entry} → ${t}`);
        }
      }
    }
    if (coversList.length > 0) {
      console.error(`exclusion-covers-project: ${coversList.join(", ")}`);
      process.exit(1);
    }
  }
}

const SPECIALIZED_HOOKS = new Set([
  "pre-commit",
  "post-checkout",
  "pre-push",
  "reference-transaction",
]);

// §17.3 (Б2): a global core.hooksPath shadows EVERY hook name — install
// a wrapper under each: specialized hooks for orchestrator gates,
// the rest are copies of the `chain` pass-through.
mkdirSync(hooksDir, { recursive: true, mode: 0o755 });
for (const name of HOOK_NAMES) {
  const src = join(
    HOOKS_SRC,
    SPECIALIZED_HOOKS.has(name) ? name : "chain",
  );
  const dst = join(hooksDir, name);
  copyFileSync(src, dst);
  execFileSync("chmod", ["755", dst]);
}
// §22.1: the shared scanner core `pre-commit` imports — lives next to
// the hook, not executable and not a hook name.
copyFileSync(join(HOOKS_SRC, "leak-scan.ts"), join(hooksDir, "leak-scan.ts"));
// §24.1: shared helpers every hook imports (chain, live copy, roles).
copyFileSync(join(HOOKS_SRC, "hook-lib.mjs"), join(hooksDir, "hook-lib.mjs"));
// §17.3 (ревью PLUG-214): `push-to-checkout` is retired — its mere
// presence disables git's built-in worktree update on
// receive.denyCurrentBranch=updateInstead. Remove a wrapper an older
// install wrote under that name.
rmSync(join(hooksDir, "push-to-checkout"), { force: true });
// §24.4 п.5: слияние вместо перезаписи exclusions
const exclusionsPath = join(hooksDir, "exclusions");
let existingContent = existsSync(exclusionsPath) ? readFileSync(exclusionsPath, "utf8") : "";
let newContent = existingContent;
if (normalizedExcludes.length > 0) {
  const existingLines = existingContent.split("\n");
  const existingSet = new Set(existingLines.map((l) => l.trim()).filter(Boolean));
  const toAppend = [];
  for (const entry of normalizedExcludes) {
    if (!existingSet.has(entry)) {
      toAppend.push(entry);
      existingSet.add(entry);
    }
  }
  if (toAppend.length > 0) {
    if (newContent && !newContent.endsWith("\n")) newContent += "\n";
    newContent += toAppend.join("\n") + "\n";
  }
}
if (!existsSync(exclusionsPath) || normalizedExcludes.length > 0) {
  const tmp = `${exclusionsPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, newContent);
  renameSync(tmp, exclusionsPath);
}

const chainPath = join(hooksDir, "chain.json");
let chain = {};
if (existsSync(chainPath)) {
  try {
    chain = JSON.parse(readFileSync(chainPath, "utf8"));
  } catch {}
}
// §24.1 п.1: the previous global path is kept as git reads it — an
// absolute or `~/` path as is, a relative one unresolved (git resolves
// it from the directory the hook runs in; so does `hook-lib.mjs`).
const prevAbs = hooksPathNow.startsWith("~/")
  ? join(homedir(), hooksPathNow.slice(2))
  : isAbsolute(hooksPathNow) ? resolve(hooksPathNow) : null;
if (hooksPathNow && prevAbs !== hooksDir && !chain.previousGlobalHooksPath) {
  chain.previousGlobalHooksPath = prevAbs ?? hooksPathNow;
}
writeFileSync(chainPath, JSON.stringify(chain, null, 2) + "\n", { mode: 0o644 });

execFileSync("git", ["config", "--global", "core.hooksPath", hooksDir]);
console.log(report);
console.log(`\nустановлено: core.hooksPath → ${hooksDir}`);
