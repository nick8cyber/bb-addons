// Postinstall patch: `bb plugin build` (esbuild) rewrites every
// `*/locales/index.js` resolve inside the zod package through the
// `bb-zod-locale-stub:` namespace, and esbuild records that namespaced
// source VERBATIM in dist/*.js.map — including the machine's absolute
// path (worktree path, thread id). That leaks into the committed map
// and trips the release leak scan on every `bb plugin build`, whatever
// directory the build ran in.
//
// The stub exists to swap the ~50-locale barrel for English only.
// Applying the same swap here — at install time, inside node_modules —
// removes the barrel from the module graph, so the stub plugin never
// fires and the emitted map stays relative-only for any build
// entrypoint (bare `bb plugin build` included). The exported `locales`
// namespace keeps the stub's exact shape: `{ en }`.
//
// Idempotent: already-patched files are skipped; an unexpected zod
// layout (version bump moving the line) is a warning, not a failure —
// `npm run build` still normalizes committed maps afterwards.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARK = '__bbZodLocalesPatched';
const BARREL_LINE = 'export * as locales from "../locales/index.js";';
const PATCHED = [
  `// ${MARK}: en-only locales barrel — same swap bb's zod-locale stub`,
  '// applies at bundle time, applied here at install time so the',
  '// stubbed namespace (and its absolute machine path) never reaches',
  '// the sourcemap.',
  'import zodEn from "../locales/en.js";',
  'const locales = { en: zodEn };',
  'export { locales };',
].join('\n');

const TARGETS = [
  'node_modules/zod/v4/core/index.js',
  'node_modules/zod/v4/classic/external.js',
  'node_modules/zod/v4/mini/external.js',
];

let patched = 0;
let skipped = 0;
for (const rel of TARGETS) {
  const file = path.join(pluginRoot, rel);
  if (!existsSync(file)) {
    console.warn(`patch-zod-locales: ${rel} not found — zod moved or hoisted; skipping`);
    continue;
  }
  const src = readFileSync(file, 'utf8');
  if (src.includes(MARK)) {
    skipped += 1;
    continue;
  }
  if (!src.includes(BARREL_LINE)) {
    console.warn(`patch-zod-locales: ${rel} has no locales barrel export — zod internals changed; skipping`);
    continue;
  }
  writeFileSync(file, src.replace(BARREL_LINE, PATCHED));
  patched += 1;
}
console.log(`patch-zod-locales: patched ${patched}, already patched ${skipped}`);
