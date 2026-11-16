import assert from "node:assert/strict";
import test from "node:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";
import {
  createT,
  resolveLang,
  T_RU,
} from "../src/i18n/index.js";
import { EN } from "../src/i18n/en.js";
import { RU } from "../src/i18n/ru.js";
import {
  DEFAULT_GIT_INSTRUCTIONS,
  effectiveGitInstructions,
  isBuiltinGitInstructions,
} from "../src/instructions.js";
import { skillSet } from "../src/agent-config.js";
import {
  assertInstalledHookFresh,
  renderPrePush,
  syncInstalledGateHooks,
  syncInstalledLeakScan,
  syncInstalledPrePush,
  type ReleaseDeps,
} from "../src/release.js";
import type { BbCli } from "../src/bb-cli.js";

const pluginDir = fileURLToPath(new URL("..", import.meta.url));
const cli: BbCli = {
  run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
};

test("§18.1: language resolves en|ru, everything else → en", () => {
  assert.equal(resolveLang("ru"), "ru");
  assert.equal(resolveLang("en"), "en");
  assert.equal(resolveLang(undefined), "en");
  assert.equal(resolveLang("fr"), "en");
});

test("§18.1: t picks the selected language; params interpolate", () => {
  const en = createT("en");
  const ru = createT("ru");
  assert.equal(en.lang, "en");
  assert.equal(ru.lang, "ru");
  assert.equal(en("status.noDelegations"), "no delegations");
  assert.equal(ru("status.noDelegations"), "нет делегирований");
  assert.equal(
    ru("cli.cancelled", { id: 7 }),
    "делегирование #7 отменено",
  );
});

test("§18.1: a missing ru key falls back to en and warns once", () => {
  const missing = Object.keys(EN).find((k) => !(k in RU));
  const warnings: string[] = [];
  const ru = createT("ru", (m) => warnings.push(m));
  if (missing) {
    assert.equal(ru(missing), EN[missing]);
    ru(missing);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"ru"/);
    assert.match(warnings[0]!, new RegExp(missing));
  }
  const en = createT("en", (m) => warnings.push(m));
  ru("no.such.key");
  assert.equal(ru("no.such.key"), "no.such.key");
});

test("§18.1: unknown placeholders in values survive interpolation", () => {
  const en = createT("en");
  assert.equal(en("hook.wrongBranch"), EN["hook.wrongBranch"]);
  assert.match(en("hook.wrongBranch"), /\{remote\}/);
});

test("§18.1: built-in git memo of either language counts as default", () => {
  assert.ok(isBuiltinGitInstructions(DEFAULT_GIT_INSTRUCTIONS));
  assert.ok(isBuiltinGitInstructions(EN["instr.gitDefault"]!));
  assert.ok(!isBuiltinGitInstructions("CUSTOM-GIT"));
  const en = createT("en");
  const ru = createT("ru");
  // stored ru built-in under language=en → the en built-in goes out
  assert.equal(
    effectiveGitInstructions(DEFAULT_GIT_INSTRUCTIONS, en),
    EN["instr.gitDefault"],
  );
  // stored en built-in under language=ru → the ru built-in goes out
  assert.equal(
    effectiveGitInstructions(EN["instr.gitDefault"], ru),
    DEFAULT_GIT_INSTRUCTIONS,
  );
  // empty disables the section; a custom value passes verbatim
  assert.equal(effectiveGitInstructions("", en), "");
  assert.equal(effectiveGitInstructions("CUSTOM-GIT", en), "CUSTOM-GIT");
  assert.equal(effectiveGitInstructions(undefined, en), undefined);
});

test("§18.1: the skill set follows the language", () => {
  assert.deepEqual(skillSet("en"), {
    setup: "orchestrator-setup",
    coordinator: "orchestrator-coordinator",
  });
  assert.deepEqual(skillSet("ru"), {
    setup: "orchestrator-setup-ru",
    coordinator: "orchestrator-coordinator-ru",
  });
});

test("§18.1: renderPrePush(ru) is the shipped source; en is versioned", () => {
  const src = readFileSync(join(pluginDir, "hooks", "pre-push"), "utf8");
  assert.equal(renderPrePush(T_RU).toString("utf8"), src);
  const en = renderPrePush(createT("en")).toString("utf8");
  assert.notEqual(en, src);
  assert.match(en, /push refused: the release marker has expired/);
  // the hook's runtime placeholders survive rendering
  assert.match(en, /\{remote\}/);
});

test("§18.1: syncInstalledPrePush rewrites an installed hook on language change", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-hook-"));
  const hookPath = join(dir, "pre-push");
  writeFileSync(hookPath, renderPrePush(createT("en")));
  assert.equal(syncInstalledPrePush(dir, createT("en")), false);
  assert.equal(syncInstalledPrePush(dir, T_RU), true);
  assert.equal(
    readFileSync(hookPath, "utf8"),
    renderPrePush(T_RU).toString("utf8"),
  );
  // no installed hook — nothing to sync
  assert.equal(
    syncInstalledPrePush(join(dir, "absent"), T_RU),
    false,
  );
});

/** Every name `hook-names` lists, like install.mjs: `pre-push` carries
 * the rendered messages, `pre-commit` the staged gate, the rest are
 * byte-copies of `chain`; `leak-scan.ts` lands alongside (§22.1). */
function installWrappers(dir: string, prePush: Buffer) {
  const hooksSrc = join(pluginDir, "hooks");
  mkdirSync(dir, { recursive: true });
  const names = readFileSync(join(hooksSrc, "hook-names"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const n of names) {
    if (n === "pre-push") writeFileSync(join(dir, n), prePush);
    else if (n === "pre-commit") cpSync(join(hooksSrc, n), join(dir, n));
    else cpSync(join(hooksSrc, "chain"), join(dir, n));
  }
  cpSync(join(hooksSrc, "leak-scan.ts"), join(dir, "leak-scan.ts"));
}

test("§22.1 (ревью): syncInstalledGateHooks кладёт leak-scan.ts рядом с установленным pre-commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-scan-"));
  // A pre-r33.1 install: the gate is there, the scanner module is not.
  cpSync(join(pluginDir, "hooks", "pre-commit"), join(dir, "pre-commit"));
  assert.equal(syncInstalledGateHooks(dir, T_RU), true);
  assert.equal(
    readFileSync(join(dir, "leak-scan.ts"), "utf8"),
    readFileSync(join(pluginDir, "hooks", "leak-scan.ts"), "utf8"),
  );
  // A stale copy is replaced byte-for-byte; a fresh one is left alone.
  writeFileSync(join(dir, "leak-scan.ts"), "stale\n");
  assert.equal(syncInstalledLeakScan(dir), true);
  assert.equal(syncInstalledGateHooks(dir, T_RU), false);
  // No installed pre-commit → nothing to drop the scanner for.
  const bare = mkdtempSync(join(tmpdir(), "orch-scan-none-"));
  assert.equal(syncInstalledLeakScan(bare), false);
  assert.equal(existsSync(join(bare, "leak-scan.ts")), false);
});

test("§22.1 (ревью): assertInstalledHookFresh чинит leak-scan.ts на месте, а не отказывает", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-scan-fresh-"));
  installWrappers(dir, renderPrePush(T_RU));
  const deps = () =>
    ({
      hooksDir: () => dir,
      t: T_RU,
    }) as unknown as ReleaseDeps;
  // A corrupted scanner is synced in place — the check then passes.
  writeFileSync(join(dir, "leak-scan.ts"), "stale\n");
  assert.doesNotThrow(() => assertInstalledHookFresh(deps()));
  assert.equal(
    readFileSync(join(dir, "leak-scan.ts"), "utf8"),
    readFileSync(join(pluginDir, "hooks", "leak-scan.ts"), "utf8"),
  );
  // A missing scanner is restored the same way.
  rmSync(join(dir, "leak-scan.ts"));
  assert.doesNotThrow(() => assertInstalledHookFresh(deps()));
  assert.equal(existsSync(join(dir, "leak-scan.ts")), true);
});

test("§18.1 (ревью PLUG-247a п.7): a language change via settings.onChange rewrites the installed pre-push", async () => {
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    // Own dataDir — the SDK default is a fixed /tmp path shared by every
    // test process: a parallel host's startup syncInstalledPrePush would
    // rewrite the same installed pre-push mid-assertion.
    dataDir: mkdtempSync(join(tmpdir(), "orch-i18n-")),
    settings: {
      policy:
        '{"version":1,"levels":{"simple":{"chain":["s"]}},"routes":{"s":{"preset":"s","provider":"p"}}}',
    },
  });
  const hooksDir = join(
    host.bb.server.experimental_dataDir,
    "plugins",
    "orchestrator",
    "git-hooks",
  );
  // what install.mjs drops — the shipped (ru) pre-push
  installWrappers(hooksDir, renderPrePush(T_RU));
  await createPlugin(host.bb, { bbCli: cli });
  // default language=en — the startup sync already rewrote the hook
  const enRender = renderPrePush(createT("en")).toString("utf8");
  assert.equal(readFileSync(join(hooksDir, "pre-push"), "utf8"), enRender);
  // flipping the setting rewrites it again — and release's freshness
  // check then passes under the new language
  await host.harness.setSettings({ language: "ru" });
  assert.equal(
    readFileSync(join(hooksDir, "pre-push"), "utf8"),
    renderPrePush(T_RU).toString("utf8"),
  );
  assert.doesNotThrow(() =>
    assertInstalledHookFresh({
      hooksDir: () => hooksDir,
      t: createT("ru"),
    } as unknown as ReleaseDeps),
  );
});

test("§18.1: default settings resolve the English skills", async () => {
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    settings: {
      policy:
        '{"version":1,"levels":{"simple":{"chain":["s"]}},"routes":{"s":{"preset":"s","provider":"p"}}}',
    },
    agentSkillIds: [
      "orchestrator-setup",
      "orchestrator-coordinator",
      "orchestrator-setup-ru",
      "orchestrator-coordinator-ru",
    ],
  });
  await createPlugin(host.bb, { bbCli: cli });
  const resolved = await host.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({}),
  );
  assert.deepEqual(
    [...resolved.skills].sort(),
    ["orchestrator-coordinator", "orchestrator-setup"],
  );
});

test("§18.1: language=ru declares only the Russian skill set", async () => {
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    settings: {
      language: "ru",
      policy:
        '{"version":1,"levels":{"simple":{"chain":["s"]}},"routes":{"s":{"preset":"s","provider":"p"}}}',
    },
    agentSkillIds: [
      "orchestrator-setup",
      "orchestrator-coordinator",
      "orchestrator-setup-ru",
      "orchestrator-coordinator-ru",
    ],
  });
  await createPlugin(host.bb, { bbCli: cli });
  const resolved = await host.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({}),
  );
  assert.deepEqual(
    [...resolved.skills].sort(),
    ["orchestrator-coordinator-ru", "orchestrator-setup-ru"],
  );
});

test("§19 (аудит выкладки PLUG-269): role.body.executor keeps the helpers-done rule", () => {
  assert.match(
    EN["role.body.executor"],
    /Do not commit and do not report the work finished until your helpers have returned their results\./,
  );
  assert.match(
    RU["role.body.executor"],
    /Не коммить и не отчитывайся о готовности, пока твои помощники не вернули итог\./,
  );
});
