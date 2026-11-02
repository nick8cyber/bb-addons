import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./dist/provider-usage-base.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  vi.unstubAllGlobals();
});
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "usage-disabled-"));
  const state = { accounts: [{ id: "disabled", enabled: false }, { id: "enabled-error", enabled: true }] as any[],
    metadataFailure: false, nativeId: "native" };
  const collected: string[] = [];
  const resource = (id: string, key: string) => ({ id, accountKey: key, providerId: "codex",
    label: id, scope: { kind: "shared" } });
  const h = createFakePluginHost({ pluginId: "usage-pro", sdk: {
    hosts: { list: async () => [makeHostResponse({ id: "server", name: "Server", status: "connected" })] },
    providers: { list: async () => [{ id: "codex", displayName: "Codex", logoUrl: null }] as any },
    system: { config: async () => ({ primaryHostId: "server" }) as any },
    plugins: {
      experimental_discoverRpc: async () => [{ pluginId: "account-pool", displayName: "Account Pooler" },
        { pluginId: "native-source", displayName: "Native" }] as any,
      callRpc: async ({ pluginId, method, input, outputSchema }: any) => {
        if (method === "account.list") {
          expect(pluginId).toBe("account-pool"); expect(input).toBeNull();
          if (state.metadataFailure) throw new Error("Fixture metadata unavailable");
          return outputSchema.parse(state.accounts);
        }
        if (method.endsWith("listResources")) {
          return outputSchema.parse({ resources: pluginId === "account-pool"
            ? [resource("disabled", "openai:chatgpt:D"), resource("enabled-error", "openai:chatgpt:E")]
            : [resource(state.nativeId, "openai:chatgpt:N")] });
        }
        collected.push(pluginId + ":" + input.resourceId);
        const isPool = pluginId === "account-pool";
        return outputSchema.parse({ accountKey: isPool
          ? "openai:chatgpt:" + (input.resourceId === "disabled" ? "D" : "E") : "openai:chatgpt:N",
          observedAt: isPool ? null : 1700000000000,
          usage: { status: isPool ? "error" : "ok", accountEmail: null,
            plan: isPool ? null : { id: "team", multiplier: null }, planLabel: isPool ? null : "Team",
            ...(isPool ? { message: "Fixture account failure" } : { windows: [{
              id: "five", kind: "five-hour", label: "Five-hour limit", usedPercent: 33,
              resetsAt: null, cost: null, model: null,
            }] }),
          } });
      },
    },
  } });
  disposers.push(async () => { await h.harness.lifecycle.dispose(); rmSync(home, { recursive: true, force: true }); });
  const forbidden = () => { throw new Error("Real external IO forbidden"); };
  vi.stubGlobal("fetch", forbidden);
  await plugin(h.bb, { userHome: home, prewarm: false, fetch: forbidden as any,
    execFile: forbidden, spawn: forbidden });
  return { state, collected, read: async () => {
    const snapshot: any = await h.harness.behavior.callRpc("getUsage", {
      force: true, machineIds: null, providerId: null, maxAgeMs: 0,
    });
    return snapshot.machines.find((machine: any) => machine.id === "server");
  } };
}
describe("explicitly disabled Account Pooler visibility", () => {
  it("omits disabled accounts from both collection and display while keeping enabled errors", async () => {
    const h = await setup(), machine = await h.read();
    expect(machine.providers.map((p: any) => p.id).sort()).toEqual(["account-pool:enabled-error", "native-source:native"]);
    expect(h.collected).not.toContain("account-pool:disabled");
    expect(machine.providers.find((p: any) => p.id === "account-pool:enabled-error").usage.status).toBe("error");
    expect(machine.providers.find((p: any) => p.id === "native-source:native").usage.planLabel).toBe("Team");
    expect(machine.error).toBeNull();
  });
  it("reflects enable and disable on the next read without reloading or changing account state", async () => {
    const h = await setup(); await h.read();
    h.state.accounts[0].enabled = true;
    expect((await h.read()).providers.some((p: any) => p.id === "account-pool:disabled")).toBe(true);
    h.state.accounts[0].enabled = false;
    expect((await h.read()).providers.some((p: any) => p.id === "account-pool:disabled")).toBe(false);
    expect(h.collected.filter((id) => id === "account-pool:disabled")).toHaveLength(1);
    expect(h.state.accounts[0].enabled).toBe(false);
  });
  it("keeps account errors when enabled metadata is unavailable", async () => {
    const h = await setup(); h.state.metadataFailure = true;
    const machine = await h.read();
    expect(machine.providers).toHaveLength(3);
    expect(machine.providers.filter((p: any) => p.id.startsWith("account-pool:")).every((p: any) => p.usage.status === "error")).toBe(true);
    expect(machine.error).toBeNull();
  });
  it("does not guess disabled state from malformed metadata", async () => {
    const h = await setup(); h.state.accounts = [{ id: "disabled", enabled: "false" }];
    expect((await h.read()).providers).toHaveLength(3);
  });
  it("keeps resources whose IDs are absent from metadata", async () => {
    const h = await setup(); h.state.accounts = [];
    expect((await h.read()).providers).toHaveLength(3);
  });
  it("does not hide the same resource ID from another plugin", async () => {
    const h = await setup(); h.state.nativeId = "disabled";
    const machine = await h.read();
    expect(machine.providers.some((p: any) => p.id === "native-source:disabled")).toBe(true);
    expect(machine.providers.some((p: any) => p.id === "account-pool:disabled")).toBe(false);
  });
});

