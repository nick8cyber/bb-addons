// Post-build step: `bb plugin build` (esbuild) writes the resolved absolute
// path of bb-zod-locale-stub into sourcemap `sources`, leaking the machine
// path (and the bb worktree/thread id) into the tracked release artifact.
// Rewrite every absolute source as relative to the map's directory.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const ABS_RE = /^(?:[A-Za-z]:[\\/]|\/)/;

let fixed = 0;
for (const name of readdirSync(distDir)) {
  if (!name.endsWith('.js.map')) continue;
  const file = path.join(distDir, name);
  const map = JSON.parse(readFileSync(file, 'utf8'));
  let changed = false;
  map.sources = map.sources.map((src) => {
    // esbuild plugin namespaces render as `ns:path` (e.g. bb-zod-locale-stub:…)
    const sep = src.indexOf(':');
    const ns = sep > 0 && !ABS_RE.test(src) ? src.slice(0, sep + 1) : '';
    const rest = src.slice(ns.length);
    if (!ABS_RE.test(rest)) return src;
    changed = true;
    return ns + path.relative(distDir, rest).split(path.sep).join('/');
  });
  if (changed) {
    writeFileSync(file, JSON.stringify(map));
    fixed += 1;
  }
}
console.log(`normalize-sourcemaps: rewrote ${fixed} map(s)`);
