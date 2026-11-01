import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import providerUsagePlugin, { createProviderUsagePlugin } from "./dist/provider-usage-base.js";
import { codexAccountKey, actualPlanLabel, selectAccountResources } from "./usage-policy";
import type { CollectorOptions } from "./collector-adapter";

const usageListMethod = "provider-usage.v1.listResources";
const usageFetchMethod = "provider-usage.v1.getResource";

describe("PLUG-82 Usage Integration with real A and fake-host DI", () => {
  let tmpUserHome: string;
  let currentTime: number;
  let originalGlobalFetch: typeof globalThis.fetch;
  const fakeHosts: ReturnType<typeof createFakePluginHost>[] = [];

  beforeEach(() => {
    tmpUserHome = fs.mkdtempSync(path.join(os.tmpdir(), "usage-int-"));
    currentTime = 1_700_000_000_000;
    originalGlobalFetch = globalThis.fetch;
    // Real external network calls fail-fast
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Real global fetch is forbidden in isolated tests");
    }) as any;
  });

  afterEach(async () => {
    for (const host of fakeHosts.splice(0)) await host.harness.lifecycle.dispose();
    globalThis.fetch = originalGlobalFetch;
    try {
      fs.rmSync(tmpUserHome, { recursive: true, force: true });
    } catch {}
    vi.restoreAllMocks();
  });

  type Host = {
    id: string;
    name: string;
    status: "connected" | "disconnected";
    type?: string;
  };

  type DiscoveredSource = {
    pluginId: string;
    displayName?: string;
  };

  type TestRigConfig = {
    hosts?: Host[];
    primaryHostId?: string;
    sources?: DiscoveredSource[];
    inventories?: Record<string, { label?: string; resources: any[]; error?: string | null }>;
    measurements?: Record<string, any | (() => any)>;
    providers?: any[];
    piAuth?: any;
    piUsageResponse?: { status: number; body: any } | (() => { status: number; body: any });
    piRunner?: (cmd: string, args: string[]) => string;
    spawnRunner?: (bin: string, args: string[]) => any;
    now?: () => number;
  };

  function setupHarness(cfg: TestRigConfig) {
    const hostsList: Host[] = cfg.hosts ?? [
      { id: "host-primary", name: "Stockholm Server", status: "connected" },
      { id: "host-remote", name: "Dubai Remote", status: "connected" },
    ];
    const primaryHostId = cfg.primaryHostId ?? "host-primary";
    const sourcesList = cfg.sources ?? [
      { pluginId: "source-native", displayName: "Native Codex" },
    ];
    const providersList = cfg.providers ?? [
      { id: "codex", displayName: "Codex", logoUrl: null },
      { id: "claude-code", displayName: "Claude", logoUrl: null },
      { id: "agy", displayName: "Antigravity", logoUrl: null },
    ];

    const inventoryMap = new Map<string, { label?: string; resources: any[]; error?: string | null }>(
      Object.entries(
        cfg.inventories ?? {
          "source-native": {
            resources: [
              {
                id: "res-native-1",
                label: "Codex Native Primary",
                providerId: "codex",
                scope: { kind: "host", hostId: "host-primary", hostName: "Stockholm Server" },
                accountKey: "openai:chatgpt:team-acc-1",
              },
            ],
          },
        },
      ),
    );

    const measurementMap = new Map<string, any | (() => any)>(
      Object.entries(cfg.measurements ?? {}),
    );

    // Setup Pi auth file if provided
    if (cfg.piAuth !== undefined) {
      const piDir = path.join(tmpUserHome, ".pi", "agent");
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(path.join(piDir, "auth.json"), JSON.stringify(cfg.piAuth, null, 2));
    }

    // Mock fetch for Pi
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("chatgpt.com/backend-api/wham/usage")) {
        if (!cfg.piUsageResponse) {
          throw new Error("No Pi usage response configured in test");
        }
        const resp =
          typeof cfg.piUsageResponse === "function"
            ? cfg.piUsageResponse()
            : cfg.piUsageResponse;
        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL in test: ${urlStr}`);
    });

    // Mock runner for Pi CLI
    const mockRunner = vi.fn((file: string, args: string[]) => {
      if (cfg.piRunner) {
        return cfg.piRunner(file, args);
      }
      if (file === "pi" && args.includes("print-bearer-token")) {
        throw new Error("pi auth token print failed in test");
      }
      throw new Error(`Unexpected command in test: ${file} ${args.join(" ")}`);
    });

    const mockSpawn = vi.fn((bin: string, args: string[]) => {
      if (cfg.spawnRunner) {
        return cfg.spawnRunner(bin, args);
      }
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const proc = new EventEmitter() as any;
      proc.stdout = stdout;
      proc.stderr = stderr;
      setTimeout(() => {
        proc.emit("close", 0);
      }, 5);
      return proc;
    });

    const fakeHost = createFakePluginHost({ pluginId: "usage-pro" });
    fakeHosts.push(fakeHost);

    fakeHost.harness.sdk.stub("hosts.list", async () => {
      return hostsList.map((h) =>
        makeHostResponse({
          id: h.id,
          name: h.name,
          status: h.status,
          type: (h.type ?? "persistent") as any,
        }),
      );
    });

    fakeHost.harness.sdk.stub("plugins.experimental_discoverRpc", async ({ method }: { method: string }) => {
      if (method === usageListMethod) {
        return sourcesList;
      }
      return [];
    });

    fakeHost.harness.sdk.stub("providers.list", async () => providersList);

    fakeHost.harness.sdk.stub("system.config", async () => ({ primaryHostId }));

    fakeHost.harness.sdk.stub("plugins.callRpc", async ({ pluginId, method, input, outputSchema }: any) => {
      if (method === usageListMethod) {
        const inv = inventoryMap.get(pluginId);
        if (!inv) {
          throw new Error(`Plugin ${pluginId} listing failed`);
        }
        if (inv.error) {
          throw new Error(inv.error);
        }
        return outputSchema.parse({
          label: inv.label,
          resources: inv.resources.map((resource: any) => ({
            ...resource, label: resource.label ?? resource.id,
            scope: resource.scope.kind === "host"
              ? { ...resource.scope, hostName: resource.scope.hostName ?? resource.scope.hostId }
              : resource.scope,
          })),
        });
      }
      if (method === usageFetchMethod) {
        const key = `${pluginId}:${input.resourceId}`;
        const m = measurementMap.get(key);
        if (m === undefined) {
          throw new Error(`No measurement configured for ${key}`);
        }
        const raw = typeof m === "function" ? await m() : m;
        // Complete deterministic source fixtures, then enforce the real cross-plugin contract.
        return outputSchema.parse({
          ...raw, accountKey: raw.accountKey ?? null, observedAt: raw.observedAt ?? null,
          usage: {
            accountEmail: null, planLabel: null, plan: null, ...raw.usage,
            ...(raw.usage.status === "error" ? { message: raw.usage.message ?? "Fixture source failure" } : {}),
            ...(raw.usage.status === "ok" ? { windows: raw.usage.windows.map((window: any, index: number) => ({
              id: "fixture-window-" + index, kind: "custom", model: null, resetsAt: null, cost: null, ...window,
            })) } : {}),
          },
        });
      }
      throw new Error(`Unhandled RPC method: ${method}`);
    });

    const collectorOpts: CollectorOptions = {
      userHome: () => tmpUserHome,
      fetch: mockFetch as any,
      runner: mockRunner as any,
      execFile: mockRunner as any,
      spawn: mockSpawn as any,
      now: cfg.now ?? (() => currentTime),
      prewarm: false,
    };

    const registeredRpc = {
      getUsage: (input: any) => fakeHost.harness.behavior.callRpc("getUsage", input) as Promise<any>,
    };

    return {
      bb: fakeHost.bb,
      fakeHost,
      harness: fakeHost.harness,
      registeredRpc,
      inventoryMap,
      measurementMap,
      mockFetch,
      mockRunner,
      mockSpawn,
      collectorOpts,
    };
  }

  // Row 1: Native/Pi same accountKey -> Exactly one card, real windows/plan, neither auth modified
  it("Scenario 1: Native and Pi with same accountKey are deduplicated to single card with actual plan", async () => {
    const accountId = "team-67628130";
    const canonicalKey = codexAccountKey(accountId);

    const h = setupHarness({
      hosts: [{ id: "host-primary", name: "Stockholm Server", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [{ pluginId: "source-native", displayName: "Native Codex" }],
      inventories: {
        "source-native": {
          resources: [
            {
              id: "res-native-1",
              label: "Codex Native Primary",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary", hostName: "Stockholm Server" },
              accountKey: canonicalKey,
            },
          ],
        },
      },
      measurements: {
        "source-native:res-native-1": {
          accountKey: canonicalKey,
          observedAt: currentTime - 10_000,
          usage: {
            status: "ok",
            accountEmail: "team@example.com",
            planLabel: "team",
            windows: [
              {
                label: "Five-hour limit",
                usedPercent: 42,
                resetsAt: new Date(currentTime + 3600000).toISOString(),
                cost: null,
              },
            ],
          },
        },
      },
      piAuth: {
        "openai-codex": {
          access: "valid-mock-token",
          accountId: accountId,
          expires: currentTime + 3_600_000,
        },
      },
      piUsageResponse: {
        status: 200,
        body: {
          plan_type: "team",
          email: "team@example.com",
          rate_limit: {
            primary_window: {
              used_percent: 42,
              reset_at: Math.floor((currentTime + 3600000) / 1000),
            },
            secondary_window: {
              used_percent: 15,
              reset_at: Math.floor((currentTime + 86400000) / 1000),
            },
          },
        },
      },
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);

    const snapshot = await h.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 60_000,
    });

    const stockholm = snapshot.machines.find((m: any) => m.id === "host-primary");
    expect(stockholm).toBeDefined();

    const codexProviders = stockholm.providers.filter((p: any) => p.providerId === "codex");
    expect(codexProviders).toHaveLength(1);
    const card = codexProviders[0];
    expect(card.usage.status).toBe("ok");
    expect(card.usage.planLabel).toBe("Team");
    expect(card.usage.windows.length).toBeGreaterThanOrEqual(1);
    expect(card.accountLabel).not.toBe("Plus");
    expect(stockholm.error).toBeNull();
  });

  // Row 2: Different/unknown IDs, same email/percentages -> Separate cards
  it("Scenario 2: Different or unknown IDs with identical email/percentages remain separate cards", async () => {
    const h = setupHarness({
      hosts: [{ id: "host-primary", name: "Primary", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [{ pluginId: "source-native", displayName: "Native Codex" }],
      inventories: {
        "source-native": {
          resources: [
            {
              id: "res-native-1",
              label: "Codex Native Alpha",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary", hostName: "Primary" },
              accountKey: "openai:chatgpt:id-alpha",
            },
            {
              id: "res-unknown-2",
              label: "Codex Native Unknown",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary", hostName: "Primary" },
              accountKey: null,
            },
          ],
        },
      },
      measurements: {
        "source-native:res-native-1": {
          accountKey: "openai:chatgpt:id-alpha",
          observedAt: currentTime,
          usage: {
            status: "ok",
            accountEmail: "same@example.com",
            planLabel: "Pro",
            windows: [{ label: "Five-hour limit", usedPercent: 50, resetsAt: null, cost: null }],
          },
        },
        "source-native:res-unknown-2": {
          accountKey: null,
          observedAt: currentTime,
          usage: {
            status: "ok",
            accountEmail: "same@example.com",
            planLabel: "Pro",
            windows: [{ label: "Five-hour limit", usedPercent: 50, resetsAt: null, cost: null }],
          },
        },
      },
      piAuth: {
        "openai-codex": {
          access: "valid-token",
          accountId: "id-beta",
          expires: currentTime + 3_600_000,
        },
      },
      piUsageResponse: {
        status: 200,
        body: {
          plan_type: "pro",
          email: "same@example.com",
          rate_limit: {
            primary_window: { used_percent: 50, reset_at: null },
          },
        },
      },
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);

    const snapshot = await h.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 60_000,
    });

    const m = snapshot.machines.find((x: any) => x.id === "host-primary");
    const codexCards = m.providers.filter((p: any) => p.providerId === "codex");
    expect(codexCards).toHaveLength(3);
  });

  // Row 3: Different hosts and server origin -> Pi localhost-only
  it("Scenario 3: Pi is attached strictly to primaryHostId and not copied to remote hosts", async () => {
    const h = setupHarness({
      hosts: [
        { id: "host-stockholm", name: "Stockholm", status: "connected" },
        { id: "host-dubai", name: "Dubai", status: "connected" },
      ],
      primaryHostId: "host-stockholm",
      sources: [{ pluginId: "source-native", displayName: "Native Codex" }],
      inventories: {
        "source-native": {
          resources: [
            {
              id: "res-stockholm",
              label: "Stockholm Codex",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-stockholm", hostName: "Stockholm" },
              accountKey: "openai:chatgpt:stockholm-acc",
            },
            {
              id: "res-dubai",
              label: "Dubai Codex",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-dubai", hostName: "Dubai" },
              accountKey: "openai:chatgpt:dubai-acc",
            },
          ],
        },
      },
      measurements: {
        "source-native:res-stockholm": {
          accountKey: "openai:chatgpt:stockholm-acc",
          observedAt: currentTime,
          usage: { status: "ok", windows: [] },
        },
        "source-native:res-dubai": {
          accountKey: "openai:chatgpt:dubai-acc",
          observedAt: currentTime,
          usage: { status: "ok", windows: [] },
        },
      },
      piAuth: {
        "openai-codex": {
          access: "valid-token",
          accountId: "pi-server-acc",
          expires: currentTime + 3_600_000,
        },
      },
      piUsageResponse: {
        status: 200,
        body: { plan_type: "team", email: "pi@server.com" },
      },
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);

    const snapshot = await h.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 60_000,
    });

    const stockholm = snapshot.machines.find((x: any) => x.id === "host-stockholm");
    const dubai = snapshot.machines.find((x: any) => x.id === "host-dubai");

    expect(stockholm.providers.some((p: any) => p.id === "codex:pi-team")).toBe(true);
    expect(dubai.providers.some((p: any) => p.id === "codex:pi-team")).toBe(false);
    expect(dubai.providers).toHaveLength(1);
    expect(dubai.providers[0].id).toBe("source-native:res-dubai");
  });

  // Row 4: Fresh healthy vs stale/error duplicate -> Healthy wins, no summing
  it("Scenario 4: Fresh healthy measurement wins over stale/error candidate with same identity", async () => {
    const sameKey = "openai:chatgpt:duplicate-id";
    const h = setupHarness({
      hosts: [{ id: "host-primary", name: "Host", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [{ pluginId: "source-native", displayName: "Native" }],
      inventories: {
        "source-native": {
          resources: [
            {
              id: "res-1",
              label: "Codex Resource",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary", hostName: "Host" },
              accountKey: sameKey,
            },
          ],
        },
      },
      measurements: {
        "source-native:res-1": {
          accountKey: sameKey,
          observedAt: null,
          usage: { status: "error", message: "Native collection failed" },
        },
      },
      piAuth: {
        "openai-codex": {
          access: "token",
          accountId: "duplicate-id",
          expires: currentTime + 100_000,
        },
      },
      piUsageResponse: {
        status: 200,
        body: {
          plan_type: "team",
          rate_limit: { primary_window: { used_percent: 25, reset_at: null } },
        },
      },
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);

    const snapshot = await h.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 60_000,
    });

    const m = snapshot.machines.find((x: any) => x.id === "host-primary");
    const codexCards = m.providers.filter((p: any) => p.providerId === "codex");
    expect(codexCards).toHaveLength(1);
    expect(codexCards[0].usage.status).toBe("ok");
    expect(codexCards[0].usage.windows[0].usedPercent).toBe(25);
    expect(m.error).toBeNull();
  });

  // Row 5: Identity rotation and cache invalidation
  it("Scenario 5: Pi identity rotation invalidates old cache regardless of TTL", async () => {
    let currentPiAccountId = "acc-first";
    const piUsageBodies: Record<string, any> = {
      "acc-first": {
        plan_type: "plus",
        email: "first@example.com",
        rate_limit: { primary_window: { used_percent: 10 } },
      },
      "acc-second": {
        plan_type: "enterprise",
        email: "second@example.com",
        rate_limit: { primary_window: { used_percent: 90 } },
      },
    };

    const h = setupHarness({
      hosts: [{ id: "host-primary", name: "Host", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [],
      inventories: {},
      piAuth: {
        "openai-codex": {
          access: "token-1",
          accountId: currentPiAccountId,
          expires: currentTime + 3_600_000,
        },
      },
      piUsageResponse: () => ({
        status: 200,
        body: piUsageBodies[currentPiAccountId],
      }),
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);

    const snap1 = await h.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 1_000_000,
    });
    const card1 = snap1.machines[0].providers.find((p: any) => p.providerId === "codex");
    expect(card1.usage.planLabel).toBe("Plus");
    expect(card1.usage.windows[0].usedPercent).toBe(10);

    currentPiAccountId = "acc-second";
    const piDir = path.join(tmpUserHome, ".pi", "agent");
    fs.writeFileSync(
      path.join(piDir, "auth.json"),
      JSON.stringify(
        {
          "openai-codex": {
            access: "token-2",
            accountId: "acc-second",
            expires: currentTime + 3_600_000,
          },
        },
        null,
        2,
      ),
    );

    const snap2 = await h.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 1_000_000,
    });
    const card2 = snap2.machines[0].providers.find((p: any) => p.providerId === "codex");
    expect(card2.usage.planLabel).toBe("Enterprise");
    expect(card2.usage.windows[0].usedPercent).toBe(90);
  });

  // Row 6: Pool error + healthy others -> Local account error, machine.error = null
  it("Scenario 6: Pool account status=error remains local card, machine.error is null", async () => {
    const h = setupHarness({
      hosts: [{ id: "host-primary", name: "Stockholm", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [
        { pluginId: "source-codex", displayName: "Codex" },
        { pluginId: "source-pool", displayName: "Account Pooler" },
      ],
      inventories: {
        "source-codex": {
          resources: [
            {
              id: "res-codex-healthy",
              label: "Healthy Codex Account",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary", hostName: "Stockholm" },
              accountKey: "openai:chatgpt:healthy-codex",
            },
          ],
        },
        "source-pool": {
          resources: [
            {
              id: "res-pool-disabled",
              label: "Disabled Pool Account",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary", hostName: "Stockholm" },
              accountKey: "openai:chatgpt:d42622fa-disabled",
            },
          ],
        },
      },
      measurements: {
        "source-codex:res-codex-healthy": {
          accountKey: "openai:chatgpt:healthy-codex",
          observedAt: currentTime,
          usage: {
            status: "ok",
            planLabel: "Team",
            windows: [{ label: "Five-hour limit", usedPercent: 12, resetsAt: null, cost: null }],
          },
        },
        "source-pool:res-pool-disabled": {
          accountKey: "openai:chatgpt:d42622fa-disabled",
          observedAt: null,
          usage: {
            status: "error",
            message: "Account disabled in Pooler",
          },
        },
      },
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);

    const snapshot = await h.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 60_000,
    });

    const m = snapshot.machines[0];
    expect(m.error).toBeNull();

    const poolCard = m.providers.find((p: any) => p.id === "source-pool:res-pool-disabled");
    expect(poolCard).toBeDefined();
    expect(poolCard.usage.status).toBe("error");
    expect(poolCard.usage.message).toBe("Account Pooler: Account disabled in Pooler");

    const healthyCard = m.providers.find((p: any) => p.id === "source-codex:res-codex-healthy");
    expect(healthyCard).toBeDefined();
    expect(healthyCard.usage.status).toBe("ok");
  });

  // Row 7: Source transport error + stale data & recovery
  it("Scenario 7: Transport failure keeps last-known data with local warning, recovery clears warning", async () => {
    let failFetch = false;

    const h = setupHarness({
      hosts: [{ id: "host-primary", name: "Host", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [{ pluginId: "source-native", displayName: "Native" }],
      inventories: {
        "source-native": {
          resources: [
            {
              id: "res-1",
              label: "Codex Stale Resource",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary", hostName: "Host" },
              accountKey: "openai:chatgpt:stale-test-acc",
            },
          ],
        },
      },
      measurements: {
        "source-native:res-1": () => {
          if (failFetch) {
            throw new Error("Network connection dropped");
          }
          return {
            accountKey: "openai:chatgpt:stale-test-acc",
            observedAt: currentTime,
            usage: {
              status: "ok",
              planLabel: "Team",
              windows: [{ label: "Five-hour limit", usedPercent: 33, resetsAt: null, cost: null }],
            },
          };
        },
      },
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);

    const snap1 = await h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });
    const card1 = snap1.machines[0].providers[0];
    expect(card1.usage.status).toBe("ok");
    expect(card1.warning).toBeNull();
    expect(snap1.machines[0].error).toBeNull();

    failFetch = true;
    const snap2 = await h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });
    const card2 = snap2.machines[0].providers[0];
    expect(card2.usage.status).toBe("ok");
    expect(card2.usage.windows[0].usedPercent).toBe(33);
    expect(card2.warning).toBe("Usage could not be refreshed. Showing last known data.");
    expect(snap2.machines[0].error).toBeNull();

    failFetch = false;
    const snap3 = await h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });
    const card3 = snap3.machines[0].providers[0];
    expect(card3.usage.status).toBe("ok");
    expect(card3.warning).toBeNull();
  });

  // Coordinator Feedback 1: Switching provider tabs preserves all cached provider cards
  it("Coordinator 1: Switching provider tabs preserves all cached provider cards", async () => {
    const h = setupHarness({
      hosts: [{ id: "host-primary", name: "Host", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [
        { pluginId: "source-codex", displayName: "Codex" },
        { pluginId: "source-claude", displayName: "Claude" },
      ],
      inventories: {
        "source-codex": {
          resources: [
            {
              id: "res-codex",
              label: "Codex Resource",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary", hostName: "Host" },
              accountKey: "openai:chatgpt:codex-1",
            },
          ],
        },
        "source-claude": {
          resources: [
            {
              id: "res-claude",
              label: "Claude Resource",
              providerId: "claude-code",
              scope: { kind: "host", hostId: "host-primary", hostName: "Host" },
              accountKey: "claude:acc-1",
            },
          ],
        },
      },
      measurements: {
        "source-codex:res-codex": {
          accountKey: "openai:chatgpt:codex-1",
          observedAt: currentTime,
          usage: { status: "ok", windows: [] },
        },
        "source-claude:res-claude": {
          accountKey: "claude:acc-1",
          observedAt: currentTime,
          usage: { status: "ok", windows: [] },
        },
      },
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);

    const snapAll = await h.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 60000,
    });
    expect(snapAll.machines[0].providers.some((p: any) => p.providerId === "codex")).toBe(true);
    expect(snapAll.machines[0].providers.some((p: any) => p.providerId === "claude-code")).toBe(true);

    const snapCodexOnly = await h.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: "codex",
      maxAgeMs: 60000,
    });
    expect(snapCodexOnly.machines[0].providers.some((p: any) => p.providerId === "codex")).toBe(true);
    expect(snapCodexOnly.machines[0].providers.some((p: any) => p.providerId === "claude-code")).toBe(true);
  });

  // Coordinator Feedback 2: AGY baseline semantics preserved across non-source hosts
  it("Coordinator 2: AGY baseline semantics preserved across non-source hosts", async () => {
    const agyDir = path.join(tmpUserHome, ".bb", "plugins", "provider-agy", "bridge-data", "accounts", "user@example.com", ".gemini", "antigravity-cli");
    fs.mkdirSync(agyDir, { recursive: true });
    fs.writeFileSync(path.join(agyDir, "antigravity-oauth-token"), "mock-token");

    const h = setupHarness({
      hosts: [
        { id: "host-1", name: "Host 1", status: "connected" },
        { id: "host-2", name: "Host 2", status: "connected" },
      ],
      primaryHostId: "host-1",
      sources: [],
      inventories: {},
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);

    const snap = await h.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 60000,
    });

    const host1Agy = snap.machines.find((m: any) => m.id === "host-1").providers.filter((p: any) => p.providerId === "agy");
    const host2Agy = snap.machines.find((m: any) => m.id === "host-2").providers.filter((p: any) => p.providerId === "agy");
    expect(host1Agy).toHaveLength(1);
    expect(host2Agy).toHaveLength(1);
  });

  // Coordinator Feedback 3: Pi transport failure persists warning, observedAt kept, recovery clears
  it("Coordinator 3: Pi transport failure persists warning state across reads and recovery clears it", async () => {
    let piFails = false;

    const h = setupHarness({
      hosts: [{ id: "host-primary", name: "Host", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [],
      inventories: {},
      piAuth: {
        "openai-codex": {
          access: "valid-token",
          accountId: "pi-persist-acc",
          expires: currentTime + 3_600_000,
        },
      },
      piUsageResponse: () => {
        if (piFails) {
          return { status: 500, body: { error: "Internal Server Error" } };
        }
        return {
          status: 200,
          body: {
            plan_type: "team",
            rate_limit: { primary_window: { used_percent: 20 } },
          },
        };
      },
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);

    const snap1 = await h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });
    const card1 = snap1.machines[0].providers.find((p: any) => p.providerId === "codex");
    expect(card1.usage.status).toBe("ok");
    expect(card1.warning).toBeNull();

    piFails = true;
    const snap2 = await h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });
    const card2 = snap2.machines[0].providers.find((p: any) => p.providerId === "codex");
    expect(card2.usage.status).toBe("ok");
    expect(card2.warning).toBe("Usage could not be refreshed. Showing last known data.");

    const snap3 = await h.registeredRpc.getUsage({ force: false, machineIds: null, providerId: null, maxAgeMs: 60000 });
    const card3 = snap3.machines[0].providers.find((p: any) => p.providerId === "codex");
    expect(card3.usage.status).toBe("ok");
    expect(card3.warning).toBe("Usage could not be refreshed. Showing last known data.");

    piFails = false;
    const snap4 = await h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });
    const card4 = snap4.machines[0].providers.find((p: any) => p.providerId === "codex");
    expect(card4.usage.status).toBe("ok");
    expect(card4.warning).toBeNull();
  });

  // Coordinator Feedback 3: Refreshed token changes request scope and request header
  it("Coordinator 3: Refreshed token changes request scope and canonical identity matches header", async () => {
    let capturedHeaderAccountId: string | null = null;
    const claims = {
      "https://api.openai.com/auth": {
        chatgpt_account_id: "scope-changed-acc",
        chatgpt_plan_type: "team",
      },
    };
    const b64Claims = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const fakeToken = `h.${b64Claims}.s`;

    const h = setupHarness({
      hosts: [{ id: "host-primary", name: "Host", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [],
      inventories: {},
      piAuth: {
        "openai-codex": {
          access: "old-token",
          accountId: "old-initial-acc",
          expires: currentTime - 1000,
        },
      },
      piRunner: (cmd, args) => {
        if (cmd === "pi" && args.includes("print-bearer-token")) {
          return fakeToken;
        }
        throw new Error("unexpected runner call");
      },
    });

    h.mockFetch.mockImplementation(async (_url: any, init?: any) => {
      capturedHeaderAccountId = init?.headers?.["chatgpt-account-id"];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "team",
          rate_limit: { primary_window: { used_percent: 10 } },
        }),
      } as any;
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);
    const snap = await h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });

    expect(capturedHeaderAccountId).toBe("scope-changed-acc");
    const card = snap.machines[0].providers[0];
    expect(card.usage.status).toBe("ok");
    expect(card.usage.planLabel).toBe("Team");
  });

  // Coordinator Feedback 5: Inventory source errors and valid account error formatting
  it("Coordinator 5: Inventory source.error does not infect other hosts; signed with source name", async () => {
    const h = setupHarness({
      hosts: [
        { id: "host-primary", name: "Primary Host", status: "connected" },
      ],
      primaryHostId: "host-primary",
      sources: [
        { pluginId: "source-healthy", displayName: "Healthy Plugin" },
        { pluginId: "source-broken-empty", displayName: "Broken Empty Plugin" },
        { pluginId: "source-broken-known", displayName: "Broken Known Plugin" },
      ],
      inventories: {
        "source-healthy": {
          resources: [
            {
              id: "res-healthy",
              label: "Healthy Resource",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary", hostName: "Primary Host" },
              accountKey: "openai:chatgpt:healthy-1",
            },
          ],
        },
        "source-broken-empty": {
          error: "Empty inventory could not be listed.",
          resources: [],
        },
        "source-broken-known": {
          error: null,
          resources: [
            {
              id: "res-known",
              label: "Known Resource",
              providerId: "claude-code",
              scope: { kind: "host", hostId: "host-primary", hostName: "Primary Host" },
              accountKey: "claude:known-1",
            },
          ],
        },
      },
      measurements: {
        "source-healthy:res-healthy": {
          accountKey: "openai:chatgpt:healthy-1",
          observedAt: currentTime,
          usage: { status: "ok", windows: [] },
        },
        "source-broken-known:res-known": {
          accountKey: "claude:known-1",
          observedAt: currentTime,
          usage: { status: "ok", windows: [] },
        },
      },
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);

    await h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });

    h.inventoryMap.get("source-broken-known")!.error = "Known inventory refresh failed.";
    const snap = await h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });

    const primary = snap.machines.find((m: any) => m.id === "host-primary");
    expect(primary.error).toBeNull();

    const knownCard = primary.providers.find((p: any) => p.id === "source-broken-known:res-known");
    expect(knownCard.warning).toContain("Broken Known Plugin");

    const emptySourceGroup = snap.machines.find((m: any) => m.id === "source:source-broken-empty");
    expect(emptySourceGroup).toBeDefined();
    expect(emptySourceGroup.error).toContain("Broken Empty Plugin");
  });

  // Coordinator Feedback 5: Valid account error is signed with source name
  it("Coordinator 5: Valid account error card is signed with source name", async () => {
    const h = setupHarness({
      hosts: [{ id: "host-primary", name: "Host", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [{ pluginId: "source-pool", displayName: "Account Pooler" }],
      inventories: {
        "source-pool": {
          resources: [
            {
              id: "res-pool",
              label: "Pool Resource",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary", hostName: "Host" },
              accountKey: "openai:chatgpt:pool-err",
            },
          ],
        },
      },
      measurements: {
        "source-pool:res-pool": {
          accountKey: "openai:chatgpt:pool-err",
          observedAt: null,
          usage: { status: "error", message: "Account disabled" },
        },
      },
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);

    const snap = await h.registeredRpc.getUsage({ force: false, machineIds: null, providerId: null, maxAgeMs: 60000 });
    const card = snap.machines[0].providers[0];
    expect(card.usage.status).toBe("error");
    expect(card.usage.message).toBe("Account Pooler: Account disabled");
    expect(snap.machines[0].error).toBeNull();
  });

  // Pi absence / unauthenticated without accountId or access token / 401 expired
  it("Contract: Pi absence produces no resource; missing accountId or access token produces unauthenticated card without HTTP request; 401 returns expired", async () => {
    const hAbsence = setupHarness({
      hosts: [{ id: "host-primary", name: "Host", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [],
      inventories: {},
      piAuth: undefined,
    });
    await providerUsagePlugin(hAbsence.bb, hAbsence.collectorOpts);
    const snapAbsence = await hAbsence.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 60000,
    });
    expect(snapAbsence.machines[0].providers).toHaveLength(0);

    const hNoAcc = setupHarness({
      hosts: [{ id: "host-primary", name: "Host", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [],
      inventories: {},
      piAuth: {
        "openai-codex": {
          access: "token-without-acc-id",
          accountId: "",
          expires: currentTime + 3_600_000,
        },
      },
    });
    await providerUsagePlugin(hNoAcc.bb, hNoAcc.collectorOpts);
    const snapNoAcc = await hNoAcc.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 60000,
    });
    const cardNoAcc = snapNoAcc.machines[0].providers[0];
    expect(cardNoAcc.usage.status).toBe("unauthenticated");
    expect(hNoAcc.mockFetch).not.toHaveBeenCalled();

    const hNoToken = setupHarness({
      hosts: [{ id: "host-primary", name: "Host", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [],
      inventories: {},
      piAuth: {
        "openai-codex": {
          access: "",
          accountId: "acc-with-empty-token",
          expires: currentTime + 3_600_000,
        },
      },
    });
    await providerUsagePlugin(hNoToken.bb, hNoToken.collectorOpts);
    const snapNoToken = await hNoToken.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 60000,
    });
    const cardNoToken = snapNoToken.machines[0].providers[0];
    expect(cardNoToken.usage.status).toBe("unauthenticated");
    expect(hNoToken.mockFetch).not.toHaveBeenCalled();

    const hExpired = setupHarness({
      hosts: [{ id: "host-primary", name: "Host", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [],
      inventories: {},
      piAuth: {
        "openai-codex": {
          access: "expired-token",
          accountId: "acc-exp-123",
          expires: currentTime + 3_600_000,
        },
      },
      piUsageResponse: {
        status: 401,
        body: { error: "Unauthorized" },
      },
    });
    await providerUsagePlugin(hExpired.bb, hExpired.collectorOpts);
    const snapExpired = await hExpired.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 60000,
    });
    const cardExpired = snapExpired.machines[0].providers[0];
    expect(cardExpired.usage.status).toBe("expired");
    expect(cardExpired.warning).toBeNull();
  });

  // Factory DI before prewarm: createProviderUsagePlugin
  it("Contract: createProviderUsagePlugin factory accepts DI before prewarm", async () => {
    const customHome = tmpUserHome;
    const pluginFactory = createProviderUsagePlugin({
      userHome: customHome,
      prewarm: false,
    });

    const h = setupHarness({
      hosts: [{ id: "host-primary", name: "Host", status: "connected" }],
      primaryHostId: "host-primary",
    });

    await pluginFactory(h.bb);
    expect(h.registeredRpc.getUsage).toBeDefined();

    const snap = await h.registeredRpc.getUsage({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 60000,
    });
    expect(snap.machines).toBeDefined();
    expect(snap.machines).toHaveLength(1);
  });

  // Frontend regression: app.bundle.js client schema and card warning renderer
  it("Frontend: app.bundle.js client schema supports optional warning and card renderer displays it", () => {
    const bundlePath = path.resolve(__dirname, "app.bundle.js");
    const bundleContent = fs.readFileSync(bundlePath, "utf8");

    // Im schema in app.bundle.js includes warning: x.optional(x.nullable(P))
    expect(bundleContent).toContain("warning:x.optional(x.nullable(P))");

    // Xm card renderer displays warning in amber styling above card content
    expect(bundleContent).toContain('text-2xs text-amber-500 mb-1 leading-tight');
  });
});
