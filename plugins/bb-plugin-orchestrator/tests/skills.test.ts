import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";
import {
  buildAgentConfiguration,
  SKILL_COORDINATOR,
  SKILL_COORDINATOR_RU,
  SKILL_SETUP,
  SKILL_SETUP_RU,
  type ExecutorProbes,
} from "../src/agent-config.js";
import type { BbCli } from "../src/bb-cli.js";

const SKILL_IDS = [SKILL_SETUP, SKILL_COORDINATOR] as const;
const SKILL_IDS_RU = [SKILL_SETUP_RU, SKILL_COORDINATOR_RU] as const;
const pluginDir = fileURLToPath(new URL("..", import.meta.url));
const readSkill = (name: string) =>
  readFileSync(`${pluginDir}/skills/${name}/SKILL.md`, "utf8");

const noopProbes: ExecutorProbes = {
  delegationByThreadId: () => undefined,
  hasFreshDispatching: () => false,
};

test("the manifest declares the skills root and both skills exist", () => {
  const manifest = JSON.parse(
    readFileSync(`${pluginDir}/package.json`, "utf8"),
  ) as { bb?: { skills?: string[] } };
  assert.deepEqual(manifest.bb?.skills, ["skills"]);
  for (const id of [...SKILL_IDS, ...SKILL_IDS_RU]) {
    const file = `${pluginDir}/skills/${id}/SKILL.md`;
    assert.ok(existsSync(file), `missing ${file}`);
    const frontmatter = readSkill(id).split("---")[1] ?? "";
    assert.match(frontmatter, new RegExp(`name:\\s*${id}\\b`));
  }
});

test("configure gives a coordinator both skills when injectInstructions is on", () => {
  const config = buildAgentConfiguration(
    makePluginAgentConfigurationContext({}),
    {
      injectInstructions: true,
      instructionsText: "RULE",
      probes: noopProbes,
    },
  );
  assert.deepEqual(config.skills, [SKILL_COORDINATOR, SKILL_SETUP]);
});

test("injectInstructions off keeps only orchestrator-setup", () => {
  const config = buildAgentConfiguration(
    makePluginAgentConfigurationContext({}),
    {
      injectInstructions: false,
      instructionsText: "RULE",
      probes: noopProbes,
    },
  );
  assert.deepEqual(config.skills, [SKILL_SETUP]);
  assert.equal(config.instructions, undefined);
});

test("an executor-shaped thread gets no skills", () => {
  const config = buildAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { parentThreadId: "thr_parent" },
    }),
    {
      injectInstructions: true,
      instructionsText: "RULE",
      probes: noopProbes,
    },
  );
  assert.deepEqual(config.skills, []);
});

test("resolveAgentConfiguration passes the declared skills through", async () => {
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    settings: {
      policy:
        '{"version":1,"levels":{"simple":{"chain":["s"]}},"routes":{"s":{"preset":"s","provider":"p"}}}',
    },
    agentSkillIds: [...SKILL_IDS],
  });
  const cli: BbCli = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
  await createPlugin(host.bb, { bbCli: cli });
  const resolved = await host.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({}),
  );
  assert.deepEqual([...resolved.skills].sort(), [...SKILL_IDS].sort());
});

test("skill texts contain no thread ids, filesystem paths or model names", () => {
  const forbidden =
    /thr_[a-z0-9]+|\/(home|Users|opt|srv|var|tmp)\/|\b(claude|opus|sonnet|gemini|deepseek|nemotron|minimax|gpt-|codex|devin|opencode|kilo|agy|swe-?[0-9])/i;
  for (const id of [...SKILL_IDS, ...SKILL_IDS_RU]) {
    const text = readSkill(id);
    assert.doesNotMatch(text, forbidden, `${id} leaks a forbidden token`);
  }
});
