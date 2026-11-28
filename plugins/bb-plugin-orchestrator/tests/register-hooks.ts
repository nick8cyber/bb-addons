/**
 * Lets `node --test` resolve the `.js` specifiers used in `src/` imports
 * (`import … from "./store.js"`) to the real `.ts` files, like
 * bb-plugin-speak does. Loaded once via `--import` before the test files,
 * so their static imports resolve through the hook.
 */
import { registerHooks } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "node:test";

// §24.1 (PLUG-410, аудит р.3 п.5): тесты не трогают домашний каталог и
// глобальный git-конфиг машины — HOME (замки, токены, ~/.bb/git-hooks)
// и GIT_CONFIG_GLOBAL изолированы для каждого процесса тестов. Исходный
// HOME — в ORCH_TEST_REAL_HOME для теста-стража.
if (!process.env.ORCH_TEST_REAL_HOME) {
  process.env.ORCH_TEST_REAL_HOME = process.env.HOME ?? "";
  const home = mkdtempSync(join(tmpdir(), "orch-test-home-"));
  process.env.HOME = home;
  if (!process.env.GIT_CONFIG_GLOBAL) {
    const cfg = join(home, ".gitconfig");
    writeFileSync(cfg, "[user]\n\tname = Test\n\temail = test@example.invalid\n");
    process.env.GIT_CONFIG_GLOBAL = cfg;
  }
  process.env.ORCHESTRATOR_HOOKS_DIR ??= join(home, ".bb", "git-hooks");
  // PLUG-439: ни один тест не зовёт настоящий bb (хук post-checkout из
  // теста слал строки в живые треды через унаследованный BB_CLI). BB_CLI и
  // первый `bb` на PATH — заглушка: exit 0, каждый вызов строкой в журнал
  // ($ORCH_TEST_BB_LOG, по умолчанию общий журнал в изолированном HOME).
  // Тест-файл может перенаправить журнал своим ORCH_TEST_BB_LOG.
  process.env.ORCH_TEST_REAL_BB_CLI = process.env.BB_CLI ?? "";
  const stubDir = join(home, ".bb-cli-stub");
  mkdirSync(stubDir, { recursive: true });
  const stub = join(stubDir, "bb");
  const defaultLog = join(home, "bb-cli-calls.log");
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "\${ORCH_TEST_BB_LOG:-${defaultLog}}"\nexit 0\n`,
    { mode: 0o755 },
  );
  process.env.BB_CLI = stub;
  process.env.ORCH_TEST_BB_STUB = stub;
  process.env.PATH = `${stubDir}${delimiter}${process.env.PATH ?? ""}`;
  process.on("exit", () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      specifier.endsWith(".js") &&
      context.parentURL
    ) {
      const candidate = new URL(
        `${specifier.slice(0, -3)}.ts`,
        context.parentURL,
      );
      if (existsSync(fileURLToPath(candidate))) {
        return {
          url: candidate.href,
          format: "module-typescript",
          shortCircuit: true,
        };
      }
    }
    return nextResolve(specifier, context);
  },
});

// Dynamic import: a static `import "./helpers/temp.js"` would resolve before
// registerHooks() above runs, so the .js → .ts mapping must be in place first.
// The module loads in every `--test` child process, so the hook and handlers
// below apply to each test file's own temp dirs.
const { cleanupTrackedTempDirs, cleanStaleTempDirs } = await import(
  "./helpers/temp.js"
);

// Reap dirs a previous killed/crashed run left behind before this run adds
// new ones.
cleanStaleTempDirs();

const origSetTimeout = globalThis.setTimeout;
(globalThis as any).setTimeout = function (
  callback: (...args: any[]) => void,
  ms?: number,
  ...args: any[]
) {
  const timer = origSetTimeout(callback, ms, ...args);
  if (
    typeof ms === "number" &&
    ms >= 60_000 &&
    typeof timer?.unref === "function"
  ) {
    timer.unref();
  }
  return timer;
};

afterEach(cleanupTrackedTempDirs);
process.on("exit", cleanupTrackedTempDirs);
process.on("SIGINT", () => {
  cleanupTrackedTempDirs();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanupTrackedTempDirs();
  process.exit(143);
});
