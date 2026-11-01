import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./dist/provider-usage-base.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function gate<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const now = 1700000000000;
const req = (providerId: string | null = "codex") => ({ force: true, machineIds: null, providerId, maxAgeMs: 0 });
const resource = (key: string | null) => ({ id: "native", providerId: "codex", label: "Native",
  accountKey: key, scope: { kind: "host", hostId: "server", hostName: "Server" } });
const measurement = (key: string, percent: number) => ({ accountKey: key, observedAt: now,
  usage: { status: "ok", accountEmail: null, planLabel: "Team", plan: { id: "team", multiplier: null },
    windows: [{ id: "five", kind: "five-hour", label: "Five-hour limit", usedPercent: percent,
      resetsAt: null, cost: null, model: null }] } });
const homes: string[] = [];
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Real network forbidden"); })));
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose();
  for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
async function setup(native: boolean, fetchImpl?: typeof fetch, execFileImpl?: () => string) {
  const home = mkdtempSync(join(tmpdir(), "usage-race-auth-")); homes.push(home);
  const entered = gate<void>(), result = gate<any>();
  let inventory = native ? [resource(null)] : [];
  let inventoryHandler: ((resources: ReturnType<typeof resource>[]) => Promise<any>) | null = null;
  let nextMeasurement = measurement("openai:chatgpt:B", 88);
  let first = true;
  let discovered = native;
  const h = createFakePluginHost({ pluginId: "usage-pro", sdk: {
    hosts: { list: async () => [makeHostResponse({ id: "server", name: "Server", status: "connected", type: "persistent" })] },
    providers: { list: async () => [{ id: "codex", displayName: "Codex", logoUrl: null }] as any },
    system: { config: async () => ({ primaryHostId: "server" }) as any },
    plugins: {
      experimental_discoverRpc: async () => discovered ? [{ pluginId: "source-native", displayName: "Native" }] as any : [],
      callRpc: async ({ method, outputSchema }: any) => {
        if (method.endsWith("listResources")) {
          const resources = structuredClone(inventory);
          return outputSchema.parse(inventoryHandler ? await inventoryHandler(resources) : { resources });
        }
        if (first) { first = false; entered.resolve(); return outputSchema.parse(await result.promise); }
        return outputSchema.parse(nextMeasurement);
      },
    },
  } }); hosts.push(h);
  const forbidden = () => { throw new Error("Real process forbidden"); };
  await plugin(h.bb, { userHome: home, prewarm: false, now: () => now, fetch: fetchImpl ?? forbidden as any,
    execFile: execFileImpl ?? forbidden, spawn: forbidden });
  return { ...h, home, entered, result, setInventory: (r: ReturnType<typeof resource>[]) => { inventory = r; },
    setInventoryHandler: (fn: typeof inventoryHandler) => { inventoryHandler = fn; },
    setMeasurement: (value: typeof nextMeasurement) => { nextMeasurement = value; },
    setSourceDiscovered: (value: boolean) => { discovered = value; },
    call: (providerId: string | null = "codex") => h.harness.behavior.callRpc("getUsage", req(providerId)) as Promise<any> };
}
function oldQuota(s: any) {
  return s.machines.flatMap((m: any) => m.providers).some((p: any) => p.usage?.windows?.some((w: any) => w.usedPercent === 1));
}
function auth(home: string, id: string, expires = now + 3600000) {
  const dir = join(home, ".pi", "agent"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-codex": { accountId: id, access: "fixture-token", expires } }));
}
describe("independent real SDK races", () => {
  it.each([200, 503, 401])("uses the existing token after a refresh failure and handles actual API status %s", async (status) => {
    let apiStatus = 200;
    const fetchStub = vi.fn(async () => ({ ok: apiStatus === 200, status: apiStatus,
      json: async () => ({ plan_type: "team", rate_limit: { primary_window: { used_percent: 42 } } }) })) as any;
    const execFile = vi.fn((): string => { throw new Error("Fixture refresh timeout"); });
    const h = await setup(false, fetchStub, execFile); auth(h.home, "A");
    await h.call();
    auth(h.home, "A", now + 30000); apiStatus = status;
    const data = await h.call();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub.mock.calls[1][1].headers.Authorization).toBe("Bearer fixture-token");
    const card = data.machines[0].providers[0];
    expect(card.usage.status).toBe(status === 401 ? "expired" : "ok");
    if (status !== 401) expect(card.usage.windows[0].usedPercent).toBe(42);
    expect(Boolean(card.warning)).toBe(status === 503);
  });
  it("keeps cards in the first response when concurrent inventories finish in start order", async () => {
    const h = await setup(true);
    h.setInventory([resource("openai:chatgpt:A")]);
    h.result.resolve(measurement("openai:chatgpt:A", 1));
    h.setMeasurement(measurement("openai:chatgpt:A", 1));
    const entered1 = gate<void>(), entered2 = gate<void>(), firstList = gate<void>(), secondList = gate<void>();
    let calls = 0;
    h.setInventoryHandler(async (resources) => {
      if (++calls === 1) { entered1.resolve(); await firstList.promise; }
      else { entered2.resolve(); await secondList.promise; }
      return { resources };
    });
    const first = h.call(); await entered1.promise;
    const second = h.call(); await entered2.promise;
    firstList.resolve(); const firstResponse = await first;
    secondList.resolve(); const secondResponse = await second;
    expect(firstResponse.machines[0].providers).toHaveLength(1);
    expect(secondResponse.machines[0].providers).toHaveLength(1);
  });
  it("rejects an old initially unknown native response after a known account appears", async () => {
    const h = await setup(true);
    const pending = h.call(); await h.entered.promise;
    h.setInventory([resource("openai:chatgpt:B")]);
    const newAccount = await h.call();
    expect(newAccount.machines[0].providers[0].usage.windows[0].usedPercent).toBe(88);
    h.result.resolve(measurement("openai:chatgpt:A", 1));
    expect(oldQuota(await pending)).toBe(false);
    const current = await h.call();
    expect(current.machines[0].providers[0].usage.windows[0].usedPercent).toBe(88);
  });
  it("rejects a pending response after removal and re-addition of an unknown resource id", async () => {
    const h = await setup(true);
    const pending = h.call(); await h.entered.promise;
    h.setInventory([]); await h.call("claude-code");
    h.setInventory([resource(null)]); await h.call("claude-code");
    h.result.resolve(measurement("openai:chatgpt:A", 1));
    expect(oldQuota(await pending)).toBe(false);
  });
  it("discards a Pi JSON failure after the auth account changed", async () => {
    const jsonEntered = gate<void>(), jsonResult = gate<unknown>();
    const fetchStub = vi.fn(async () => ({ ok: true, status: 200, json: () => { jsonEntered.resolve(); return jsonResult.promise; } })) as any;
    const h = await setup(false, fetchStub);
    auth(h.home, "A");
    const pending = h.call(); await jsonEntered.promise;
    auth(h.home, "B"); await h.call("claude-code");
    jsonResult.reject(new Error("Malformed old body"));
    const stale = await pending;
    expect(stale.machines[0].providers).toHaveLength(0);
  });
  it("ignores an earlier inventory response that finishes after the current inventory", async () => {
    const h = await setup(true);
    const entered = gate<void>(), delayed = gate<any>();
    let listing = 0;
    h.setInventory([resource("openai:chatgpt:A")]);
    h.setInventoryHandler(async (resources) => {
      if (listing++ === 0) { entered.resolve(); return delayed.promise; }
      return { resources };
    });
    const old = h.call("claude-code"); await entered.promise;
    h.setInventory([resource("openai:chatgpt:B")]); await h.call("claude-code");
    delayed.resolve({ resources: [resource("openai:chatgpt:A")] }); await old;
    h.result.resolve(measurement("openai:chatgpt:B", 88));
    const current = await h.call();
    expect(current.machines[0].providers[0].usage).toMatchObject({ status: "ok", windows: [{ usedPercent: 88 }] });
  });
  it("rejects a source returning its previous cached account after inventory rotation", async () => {
    const h = await setup(true);
    h.setInventory([resource("openai:chatgpt:A")]);
    h.result.resolve(measurement("openai:chatgpt:A", 1)); await h.call();
    h.setInventory([resource("openai:chatgpt:B")]);
    h.setMeasurement(measurement("openai:chatgpt:A", 1));
    const rejected = await h.call();
    expect(oldQuota(rejected)).toBe(false);
    expect(rejected.machines[0].providers[0].usage.status).toBe("error");
    h.setMeasurement(measurement("openai:chatgpt:B", 88));
    expect((await h.call()).machines[0].providers[0].usage.status).toBe("ok");
  });
  it("discards a pending first inventory when its source disappears from discovery", async () => {
    const h = await setup(true);
    const entered = gate<void>(), delayed = gate<any>();
    h.setInventoryHandler(async () => { entered.resolve(); return delayed.promise; });
    const old = h.call(); await entered.promise;
    h.setSourceDiscovered(false); await h.call("claude-code");
    h.result.resolve(measurement("openai:chatgpt:A", 1));
    delayed.resolve({ resources: [resource("openai:chatgpt:A")] });
    expect((await old).machines[0].providers).toHaveLength(0);
  });
  it.each([{}, { rate_limit: { primary_window: { used_percent: "oops" } } },
    { rate_limit: { primary_window: { used_percent: -1 } } },
    { rate_limit: { primary_window: { used_percent: 1e400 } } },
    { rate_limit: { primary_window: { used_percent: 10, reset_at: "invalid" } } },
  ])("shows malformed Pi usage as a local error rather than inventing valid limits: %j", async (body) => {
    const fetchStub = vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as any;
    const h = await setup(false, fetchStub); auth(h.home, "A");
    const data = await h.call();
    expect(data.machines[0].providers[0].usage.status).toBe("error");
    expect(data.machines[0].error).toBeNull();
  });
  it("uses actual unknown native plan metadata without inheriting object prototype properties", async () => {
    const h = await setup(true);
    const data = measurement("openai:chatgpt:B", 88);
    h.setInventory([resource("openai:chatgpt:B")]);
    h.result.resolve({ ...data, usage: { ...data.usage, planLabel: null, plan: { id: "constructor", multiplier: null } } });
    expect((await h.call()).machines[0].providers[0].usage.planLabel).toBe("Constructor");
  });
  it("inherits a native error's last known identity only until a success reports unknown scope", async () => {
    const fetchStub = vi.fn(async () => ({ ok: true, status: 200,
      json: async () => ({ plan_type: "team", rate_limit: { primary_window: { used_percent: 80 } } }) })) as any;
    const h = await setup(true, fetchStub); auth(h.home, "A");
    h.setInventory([resource("openai:chatgpt:A")]);
    h.result.resolve(measurement("openai:chatgpt:A", 1));
    expect((await h.call()).machines[0].providers).toHaveLength(1);
    h.setInventory([resource(null)]);
    const failure = { accountKey: null, observedAt: now, usage: {
      status: "error", accountEmail: null, planLabel: "Team", plan: null, message: "Temporary failure",
    } };
    h.setMeasurement(failure as any);
    const merged = await h.call();
    expect(merged.machines[0].providers).toHaveLength(1);
    expect(merged.machines[0].providers[0].usage.windows[0].usedPercent).toBe(80);
    h.setMeasurement({ ...measurement("openai:chatgpt:A", 1), accountKey: null } as any);
    expect((await h.call()).machines[0].providers).toHaveLength(2);
    h.setMeasurement(failure as any);
    expect((await h.call()).machines[0].providers).toHaveLength(2);
  });
});

