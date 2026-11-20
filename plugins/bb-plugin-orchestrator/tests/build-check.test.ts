// plugins/bb-plugin-orchestrator/tests/build-check.test.ts
// Tests for machine build verification (§24.3) with 3 outcomes: MATCH, STALE_BUILD, MISSING_BUILD.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  verifyInstalledBuild,
  writeBuildInfo,
  type BuildVerificationResult,
} from "../src/build-check.js";

test("§24.3 build verification: returns MISSING_BUILD when dist or artifacts are missing", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "build-check-missing-"));
  try {
    // Empty plugin root: no dist dir
    const res1 = await verifyInstalledBuild({ pluginRoot: tmpDir });
    assert.equal(res1.outcome, "MISSING_BUILD");
    assert.equal(res1.distServerExists, false);
    assert.equal(res1.distAppExists, false);

    // Dist dir exists, but only server.js exists
    const distDir = path.join(tmpDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "server.js"), "console.log('server');");
    const res2 = await verifyInstalledBuild({ pluginRoot: tmpDir });
    assert.equal(res2.outcome, "MISSING_BUILD");
    assert.equal(res2.distServerExists, true);
    assert.equal(res2.distAppExists, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("§24.3 build verification: returns MATCH when build-info matches gitSha", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "build-check-match-"));
  try {
    const distDir = path.join(tmpDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "server.js"), "console.log('server');");
    fs.writeFileSync(path.join(distDir, "app.js"), "console.log('app');");

    const commitSha = "6d3ecf58e010d12a4f4b5b82715833e5f0cbe727";
    writeBuildInfo(tmpDir, commitSha);

    const res = await verifyInstalledBuild({ pluginRoot: tmpDir, gitSha: commitSha });
    assert.equal(res.outcome, "MATCH");
    assert.equal(res.builtCommit, commitSha);
    assert.equal(res.expectedCommit, commitSha);
    assert.ok(res.details.includes("matches"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("§24.3 build verification: returns STALE_BUILD when build-info does not match gitSha", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "build-check-stale-"));
  try {
    const distDir = path.join(tmpDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "server.js"), "console.log('server');");
    fs.writeFileSync(path.join(distDir, "app.js"), "console.log('app');");

    const oldSha = "1111111111111111111111111111111111111111";
    const currentSha = "2222222222222222222222222222222222222222";
    writeBuildInfo(tmpDir, oldSha);

    const res = await verifyInstalledBuild({ pluginRoot: tmpDir, gitSha: currentSha });
    assert.equal(res.outcome, "STALE_BUILD");
    assert.equal(res.builtCommit, oldSha);
    assert.equal(res.expectedCommit, currentSha);
    assert.ok(res.details.includes("does not match"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("§24.3 build verification: returns STALE_BUILD when source is newer than dist without build-info", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "build-check-mtime-"));
  try {
    const distDir = path.join(tmpDir, "dist");
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(distDir, { recursive: true });
    fs.mkdirSync(srcDir, { recursive: true });

    const pastTime = new Date(Date.now() - 60_000);
    const serverPath = path.join(distDir, "server.js");
    const appPath = path.join(distDir, "app.js");
    fs.writeFileSync(serverPath, "console.log('server');");
    fs.writeFileSync(appPath, "console.log('app');");
    fs.utimesSync(serverPath, pastTime, pastTime);
    fs.utimesSync(appPath, pastTime, pastTime);

    // Source file modified now (newer than dist)
    const srcFile = path.join(srcDir, "foo.ts");
    fs.writeFileSync(srcFile, "export const x = 1;");

    const res = await verifyInstalledBuild({ pluginRoot: tmpDir });
    assert.equal(res.outcome, "STALE_BUILD");
    assert.ok(res.details.includes("modified after"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
