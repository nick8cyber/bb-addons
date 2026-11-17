/**
 * §24.2 (r33.5): which changed paths count as a plugin's UI files, and
 * which plugin name a set of changed paths belongs to. Shared by the
 * watchdog (recording `plugin_staged_features`) and the release gate
 * (the unmerged-ui check).
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** §24.2: interface files of a plugin — `app.tsx`, `app.css`, `*.tsx`,
 * `*.jsx`, `*.css`, `manifest.json`, anything under `/ui/` or
 * `/components/`; test (`*.test.*`, `*.spec.*`) and service
 * (`node_modules/`, `dist/`) paths never count. */
export function isPluginUiFile(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (/(^|\/)node_modules\//.test(p) || /(^|\/)dist\//.test(p)) {
    return false;
  }
  if (/\.(test|spec)\.[^/]+$/.test(p)) return false;
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (base === "manifest.json") return true;
  if (/\.(tsx|jsx|css)$/.test(base)) return true;
  return /(^|\/)ui\//.test(p) || /(^|\/)components\//.test(p);
}

/** §24.2: plugin names a changed-paths list points at — every
 * `plugins/<name>/…` directory, sorted; empty when the list touches no
 * monorepo plugin directory. */
export function pluginNamesForPaths(paths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const p of paths) {
    const m = /^plugins\/([^/]+)\//.exec(p.replace(/\\/g, "/"));
    if (m) names.add(m[1]!);
  }
  return [...names].sort();
}

/** §24.2: the fallback plugin name outside a monorepo layout — the
 * repo's own `package.json` name, else the repo directory name. */
export function pluginNameForRepo(repoPath: string): string {
  try {
    const pkgFile = join(repoPath, "package.json");
    if (existsSync(pkgFile)) {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as {
        name?: unknown;
      };
      if (typeof pkg.name === "string" && pkg.name.trim()) {
        return pkg.name.trim();
      }
    }
  } catch {
    // unreadable/missing package.json — the directory name decides
  }
  return basename(repoPath);
}

/** §24.2: one plugin name for a changed-paths list — the first
 * `plugins/<name>` directory when present, else the repo fallback. */
export function pluginNameForPaths(
  paths: readonly string[],
  repoPath: string,
): string {
  return pluginNamesForPaths(paths)[0] ?? pluginNameForRepo(repoPath);
}
