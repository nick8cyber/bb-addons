// Post-build step: `bb plugin build` (esbuild) writes the resolved absolute
// path of bb-zod-locale-stub into sourcemap `sources`, leaking the machine
// path (and the bb worktree/thread id) into the tracked release artifact.
// Rewrite every absolute source as relative to the map's directory.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const pluginRoot = path.resolve(distDir, '..');
const ABS_RE = /^(?:[A-Za-z]:[\\/]|\/)/;

export function normalizeSourcePath(src, distDir, pluginRoot) {
  // esbuild plugin namespaces render as `ns:path` (e.g. bb-zod-locale-stub:…)
  const sep = src.indexOf(':');
  const ns = sep > 0 && !ABS_RE.test(src) ? src.slice(0, sep + 1) : '';
  const rest = src.slice(ns.length);

  const resolved = path.isAbsolute(rest) ? path.normalize(rest) : path.resolve(distDir, rest);

  let normalized;
  if (resolved === pluginRoot || resolved.startsWith(pluginRoot + path.sep)) {
    normalized = resolved;
  } else {
    // Relative sources that climb out of the plugin directory point into the
    // building machine's checkout (e.g.
    // ../../../../../../../../work/bb/bb-addons/.../node_modules/zod/...) —
    // they are invalid in the packed artifact and leak the host layout.
    // Normalize them into the plugin's own tree.
    const nmSplit = resolved.split(`${path.sep}node_modules${path.sep}`);
    normalized = nmSplit.length > 1
      ? path.join(pluginRoot, 'node_modules', nmSplit[nmSplit.length - 1])
      : path.join(pluginRoot, path.basename(resolved));
  }

  return ns + path.relative(distDir, normalized).split(path.sep).join('/');
}

export function normalizeSourcemapFile(file, distDir, pluginRoot) {
  const map = JSON.parse(readFileSync(file, 'utf8'));
  let changed = false;
  if (Array.isArray(map.sources)) {
    const newSources = map.sources.map((src) => {
      const next = normalizeSourcePath(src, distDir, pluginRoot);
      if (next !== src) changed = true;
      return next;
    });
    if (changed) {
      map.sources = newSources;
      writeFileSync(file, JSON.stringify(map));
    }
  }
  return changed;
}

export function normalizeAllSourcemaps(distDir, pluginRoot) {
  let fixed = 0;
  for (const name of readdirSync(distDir)) {
    if (!name.endsWith('.js.map')) continue;
    const file = path.join(distDir, name);
    if (normalizeSourcemapFile(file, distDir, pluginRoot)) {
      fixed += 1;
    }
  }
  return fixed;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const fixed = normalizeAllSourcemaps(distDir, pluginRoot);
  console.log(`normalize-sourcemaps: rewrote ${fixed} map(s)`);
}

