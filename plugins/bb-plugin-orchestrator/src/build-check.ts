// plugins/bb-plugin-orchestrator/src/build-check.ts
// Machine verification of installed plugin build vs repository commit.
// Spec: docs/specs/orchestrator.md §24.3, r34.3

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CmdRunner } from "./cmd.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultPluginRoot = path.resolve(__dirname, "..");

export type BuildVerificationOutcome = "MATCH" | "STALE_BUILD" | "MISSING_BUILD";

export interface BuildVerificationResult {
  outcome: BuildVerificationOutcome;
  details: string;
  expectedCommit?: string;
  builtCommit?: string;
  distServerExists: boolean;
  distAppExists: boolean;
  distServerMtime?: number;
  distAppMtime?: number;
  builtAt?: number;
}

export interface BuildInfo {
  gitSha: string;
  builtAt: number;
}

export function writeBuildInfo(pluginRoot: string = defaultPluginRoot, gitSha?: string): void {
  const distDir = path.join(pluginRoot, "dist");
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  let sha = gitSha;
  if (!sha) {
    try {
      const headFile = path.join(pluginRoot, "..", "..", ".git", "HEAD");
      if (fs.existsSync(headFile)) {
        const headContent = fs.readFileSync(headFile, "utf8").trim();
        if (headContent.startsWith("ref: ")) {
          const refPath = path.join(pluginRoot, "..", "..", ".git", headContent.slice(5));
          if (fs.existsSync(refPath)) {
            sha = fs.readFileSync(refPath, "utf8").trim();
          }
        } else {
          sha = headContent;
        }
      }
    } catch {}
  }

  const info: BuildInfo = {
    gitSha: sha ?? "unknown",
    builtAt: Date.now(),
  };

  fs.writeFileSync(path.join(distDir, "build-info.json"), JSON.stringify(info, null, 2), "utf8");
}

export async function verifyInstalledBuild(options?: {
  pluginRoot?: string;
  gitSha?: string;
  cmd?: CmdRunner;
}): Promise<BuildVerificationResult> {
  const pluginRoot = options?.pluginRoot ?? defaultPluginRoot;
  const distDir = path.join(pluginRoot, "dist");
  const serverJs = path.join(distDir, "server.js");
  const appJs = path.join(distDir, "app.js");
  const buildInfoFile = path.join(distDir, "build-info.json");

  const distServerExists = fs.existsSync(serverJs);
  const distAppExists = fs.existsSync(appJs);

  if (!distServerExists || !distAppExists) {
    return {
      outcome: "MISSING_BUILD",
      details: `missing essential build artifacts in dist/ (server.js: ${distServerExists}, app.js: ${distAppExists})`,
      distServerExists,
      distAppExists,
    };
  }

  const serverStat = fs.statSync(serverJs);
  const appStat = fs.statSync(appJs);
  const distMtime = Math.min(serverStat.mtimeMs, appStat.mtimeMs);

  // Determine current repository HEAD SHA
  let expectedSha = options?.gitSha;
  if (!expectedSha && options?.cmd) {
    const res = await options.cmd.run("git", ["rev-parse", "HEAD"], { cwd: pluginRoot });
    if (res.exitCode === 0) {
      expectedSha = res.stdout.trim();
    }
  }
  if (!expectedSha) {
    try {
      // Find .git directory relative to plugin
      let cur = pluginRoot;
      for (let i = 0; i < 5; i++) {
        const gitDir = path.join(cur, ".git");
        if (fs.existsSync(gitDir)) {
          const headFile = path.join(gitDir, "HEAD");
          if (fs.existsSync(headFile)) {
            const headContent = fs.readFileSync(headFile, "utf8").trim();
            if (headContent.startsWith("ref: ")) {
              const refPath = path.join(gitDir, headContent.slice(5));
              if (fs.existsSync(refPath)) {
                expectedSha = fs.readFileSync(refPath, "utf8").trim();
              }
            } else {
              expectedSha = headContent;
            }
          }
          break;
        }
        cur = path.dirname(cur);
      }
    } catch {}
  }

  // Check build-info.json if present
  if (fs.existsSync(buildInfoFile)) {
    try {
      const info: BuildInfo = JSON.parse(fs.readFileSync(buildInfoFile, "utf8"));
      if (expectedSha && info.gitSha && info.gitSha !== "unknown") {
        if (info.gitSha === expectedSha) {
          return {
            outcome: "MATCH",
            details: `installed build matches repository HEAD commit ${expectedSha.slice(0, 8)}`,
            expectedCommit: expectedSha,
            builtCommit: info.gitSha,
            distServerExists,
            distAppExists,
            distServerMtime: serverStat.mtimeMs,
            distAppMtime: appStat.mtimeMs,
            builtAt: info.builtAt,
          };
        } else {
          return {
            outcome: "STALE_BUILD",
            details: `installed build commit (${info.gitSha.slice(0, 8)}) does not match repository HEAD (${expectedSha.slice(0, 8)})`,
            expectedCommit: expectedSha,
            builtCommit: info.gitSha,
            distServerExists,
            distAppExists,
            distServerMtime: serverStat.mtimeMs,
            distAppMtime: appStat.mtimeMs,
            builtAt: info.builtAt,
          };
        }
      }
    } catch {}
  }

  // Fallback: check file timestamps against source files
  const srcDir = path.join(pluginRoot, "src");
  const serverTs = path.join(pluginRoot, "server.ts");
  const appTsx = path.join(pluginRoot, "app.tsx");

  let newestSourceMtime = 0;
  if (fs.existsSync(serverTs)) {
    newestSourceMtime = Math.max(newestSourceMtime, fs.statSync(serverTs).mtimeMs);
  }
  if (fs.existsSync(appTsx)) {
    newestSourceMtime = Math.max(newestSourceMtime, fs.statSync(appTsx).mtimeMs);
  }

  if (fs.existsSync(srcDir)) {
    const scanDir = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(full);
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
          newestSourceMtime = Math.max(newestSourceMtime, fs.statSync(full).mtimeMs);
        }
      }
    };
    scanDir(srcDir);
  }

  // If source files are newer than dist artifacts by more than 1 second, it's stale
  if (newestSourceMtime > distMtime + 1000) {
    return {
      outcome: "STALE_BUILD",
      details: `source files modified after installed build artifacts (${new Date(newestSourceMtime).toISOString()} > ${new Date(distMtime).toISOString()})`,
      expectedCommit: expectedSha,
      distServerExists,
      distAppExists,
      distServerMtime: serverStat.mtimeMs,
      distAppMtime: appStat.mtimeMs,
    };
  }

  return {
    outcome: "MATCH",
    details: `installed build artifacts are up-to-date with source files`,
    expectedCommit: expectedSha,
    distServerExists,
    distAppExists,
    distServerMtime: serverStat.mtimeMs,
    distAppMtime: appStat.mtimeMs,
  };
}
