// Canonical build entrypoint for this plugin: applies the zod locales
// patch (in case postinstall did not run in this checkout), runs
// `bb plugin build`, then normalizes the emitted sourcemaps so no
// absolute machine path survives into the committed dist artifacts.
// `build` in package.json points here so every npm-driven build is
// clean; running `bb plugin build` directly is also clean once the
// postinstall patch has been applied to node_modules.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const run = (argv) => execFileSync(argv[0], argv.slice(1), { stdio: 'inherit' });

run([process.execPath, path.join(scriptsDir, 'patch-zod-locales.mjs')]);
run(['bb', 'plugin', 'build', '.']);
run([process.execPath, path.join(scriptsDir, 'normalize-sourcemaps.mjs')]);
