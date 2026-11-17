/**
 * Lets `node --test` resolve the `.js` specifiers used in `src/` imports
 * (`import … from "./store.js"`) to the real `.ts` files, like
 * bb-plugin-speak does. Loaded once via `--import` before the test files,
 * so their static imports resolve through the hook.
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach } from "node:test";

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
