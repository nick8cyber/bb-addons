import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import providerUsagePlugin, { createProviderUsagePlugin } from "./dist/provider-usage-base.js";
import { codexAccountKey, actualPlanLabel, selectAccountResources } from "./usage-policy";
import type { CollectorOptions } from "./collector-adapter";

const usageListMethod = "provider-usage.v1.listResources";
const usageFetchMethod = "provider-usage.v1.getResource";

describe("PLUG-82 Usage Integration with real A and fake-host DI", () => {
  let tmpUserHome: string;
  let currentTime: number;
  let originalGlobalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpUserHome = fs.mkdtempSync(path.join(os.tmpdir(), "usage-int-"));
    currentTime = 1_700_000_000_000;
    originalGlobalFetch = globalThis.fetch;
    // Real external network calls fail-fast
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Real global fetch is forbidden in isolated tests");
    }) as any;
  });

  afterEach(() => {
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
                providerId: "codex",
                scope: { kind: "host", hostId: "host-primary" },
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

    const registeredRpc: Record<string, any> = {};
    const eventHandlers: Record<string, Function[]> = {};

    const bb: any = {
      settings: {
        define: vi.fn(),
      },
      sdk: {
        hosts: {
          list: vi.fn(async () => hostsList),
        },
        plugins: {
          experimental_discoverRpc: vi.fn(async ({ method }: { method: string }) => {
            if (method === usageListMethod) {
              return sourcesList;
            }
            return [];
          }),
          callRpc: vi.fn(async ({ pluginId, method, input }: any) => {
            if (method === usageListMethod) {
              const inv = inventoryMap.get(pluginId);
              if (!inv) {
                throw new Error(`Plugin ${pluginId} listing failed`);
              }
              if (inv.error) {
                throw new Error(inv.error);
              }
              return inv;
            }
            if (method === usageFetchMethod) {
              const key = `${pluginId}:${input.resourceId}`;
              const m = measurementMap.get(key);
              if (m === undefined) {
                throw new Error(`No measurement configured for ${key}`);
              }
              if (typeof m === "function") {
                return m();
              }
              return m;
            }
            throw new Error(`Unhandled RPC method: ${method}`);
          }),
        },
        providers: {
          list: vi.fn(async () => providersList),
        },
        system: {
          config: vi.fn(async () => ({ primaryHostId })),
        },
      },
      rpc: {
        register: vi.fn((_contract: any, handlers: any) => {
          Object.assign(registeredRpc, handlers);
        }),
      },
      events: {
        on: vi.fn((evt: string, handler: Function) => {
          eventHandlers[evt] = eventHandlers[evt] || [];
          eventHandlers[evt].push(handler);
        }),
      },
    };

    const collectorOpts: CollectorOptions = {
      userHome: () => tmpUserHome,
      fetch: mockFetch as any,
      runner: mockRunner as any,
      execFile: mockRunner as any,
      spawn: mockSpawn as any,
      now: cfg.now ?? (() => currentTime),
      prewarm: false,
    };

    return {
      bb,
      registeredRpc,
      eventHandlers,
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
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary" },
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
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary" },
              accountKey: "openai:chatgpt:id-alpha",
            },
            {
              id: "res-unknown-2",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary" },
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
              providerId: "codex",
              scope: { kind: "host", hostId: "host-stockholm" },
              accountKey: "openai:chatgpt:stockholm-acc",
            },
            {
              id: "res-dubai",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-dubai" },
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
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary" },
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
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary" },
              accountKey: "openai:chatgpt:healthy-codex",
            },
          ],
        },
        "source-pool": {
          resources: [
            {
              id: "res-pool-disabled",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary" },
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
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary" },
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
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary" },
              accountKey: "openai:chatgpt:codex-1",
            },
          ],
        },
        "source-claude": {
          resources: [
            {
              id: "res-claude",
              providerId: "claude-code",
              scope: { kind: "host", hostId: "host-primary" },
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

  // Coordinator Feedback 4: Race fixtures - concurrent rotation & in-flight invalidation
  it("Coordinator 4: Concurrent scope rotation invalidates in-flight old identity for native and Pi", async () => {
    let resolveDelayedNative: any;
    const delayedNativePromise = new Promise((resolve) => {
      resolveDelayedNative = resolve;
    });

    let currentNativeKey = "openai:chatgpt:initial-key";

    const h = setupHarness({
      hosts: [{ id: "host-primary", name: "Host", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [{ pluginId: "source-native", displayName: "Native" }],
      inventories: {
        "source-native": {
          resources: [
            {
              id: "res-race",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary" },
              accountKey: currentNativeKey,
            },
          ],
        },
      },
      measurements: {
        "source-native:res-race": async () => {
          await delayedNativePromise;
          return {
            accountKey: "openai:chatgpt:initial-key",
            observedAt: currentTime,
            usage: { status: "ok", windows: [{ label: "Five-hour limit", usedPercent: 1 }] },
          };
        },
      },
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);

    const inFlightRead = h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });

    currentNativeKey = "openai:chatgpt:rotated-new-key";
    h.inventoryMap.get("source-native")!.resources[0].accountKey = currentNativeKey;

    resolveDelayedNative();
    await inFlightRead;

    const snapAfter = await h.registeredRpc.getUsage({ force: false, machineIds: null, providerId: null, maxAgeMs: 60000 });
    const card = snapAfter.machines[0].providers[0];
    expect(card).toBeDefined();
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
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary" },
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
              providerId: "claude-code",
              scope: { kind: "host", hostId: "host-primary" },
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
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary" },
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

  // Native non-ok/null key inherits last known; success/null clears history; removal clears history
  it("Contract: Native non-ok/null key inherits last known; success/null clears history; removal clears history", async () => {
    let currentAccountKey: string | null = "openai:chatgpt:inherited-acc";
    let currentStatus = "ok";

    const h = setupHarness({
      hosts: [{ id: "host-primary", name: "Host", status: "connected" }],
      primaryHostId: "host-primary",
      sources: [{ pluginId: "source-native", displayName: "Native" }],
      inventories: {
        "source-native": {
          resources: [
            {
              id: "res-native-heritage",
              providerId: "codex",
              scope: { kind: "host", hostId: "host-primary" },
              accountKey: currentAccountKey,
            },
          ],
        },
      },
      measurements: {
        "source-native:res-native-heritage": () => ({
          accountKey: currentAccountKey,
          observedAt: currentTime,
          usage: {
            status: currentStatus,
            planLabel: "Team",
            windows: [],
          },
        }),
      },
    });

    await providerUsagePlugin(h.bb, h.collectorOpts);

    await h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });

    currentAccountKey = null;
    currentStatus = "error";
    h.inventoryMap.get("source-native")!.resources[0].accountKey = null;

    const snapError = await h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });
    const cardError = snapError.machines[0].providers[0];
    expect(cardError.usage.status).toBe("error");

    currentStatus = "ok";
    const snapOkNull = await h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });
    const cardOkNull = snapOkNull.machines[0].providers[0];
    expect(cardOkNull.usage.status).toBe("ok");

    h.inventoryMap.get("source-native")!.resources = [];
    await h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });

    h.inventoryMap.get("source-native")!.resources = [
      {
        id: "res-native-heritage",
        providerId: "codex",
        scope: { kind: "host", hostId: "host-primary" },
        accountKey: null,
      },
    ];
    currentStatus = "error";
    const snapCleared = await h.registeredRpc.getUsage({ force: true, machineIds: null, providerId: null, maxAgeMs: 0 });
    const cardCleared = snapCleared.machines[0].providers[0];
    expect(cardCleared.usage.status).toBe("error");
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
  });
});
