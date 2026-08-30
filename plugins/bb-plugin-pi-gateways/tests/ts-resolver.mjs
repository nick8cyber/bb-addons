/**
 * Test-only module resolution: let the plugin's `./x.js` imports find `./x.ts`.
 *
 * The sources deliberately use extension-ful `.js` specifiers, which is what
 * the esbuild-based plugin bundler expects. Node's type stripping does not
 * rewrite them, so without this hook the test runner cannot import any module
 * that has a runtime (non-type) import of a sibling. Nothing here changes what
 * ships — it only teaches the test process how to find the TypeScript sources.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
