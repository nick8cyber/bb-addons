import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, makeTurnFailedEvent, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import { creditRetryAt, isWorkspaceCreditFailure, queueBlocksRetry, registerCreditRetry, DELAYS_MINUTES } from "./credit-retry";

afterEach(() => vi.restoreAllMocks());
const failure = (overrides: Partial<ReturnType<typeof makeTurnFailedEvent>> = {}) => makeTurnFailedEvent({
  threadId:"thread-credit",requestId:"creq-captured",turnId:"turn-credit",attemptNumber:1,inputAccepted:true,
  errorInfo:{category:"rate-limit",providerCode:"usageLimitExceeded",httpStatusCode:null},
  rateLimits:{providerId:"codex",status:"blocked",kind:"credits",windows:[],
    reachedReason:"workspace_member_credits_depleted",overageStatus:null,overageReason:null},
  ...overrides,
});
function setup() {
  const get = vi.fn(async () => makeThreadResponse({id:"thread-credit",providerId:"codex",status:"error"}));
  const list = vi.fn(async () => [] as ReturnType<typeof makeQueueEntry>[]);
  const retry = vi.fn(async (_input: unknown) => ({}));
  const discover = vi.fn(async () => [] as {pluginId:string}[]);
  const callRpc = vi.fn(async () => ({kind:"not-routed"} as Record<string,unknown>));
  const host = createFakePluginHost({pluginId:"usage-pro",sdk:{
    threads:{get,queue:{list},retry},
    plugins:{experimental_discoverRpc:discover,callRpc},
  }});
  registerCreditRetry(host.bb);
  return {...host,get,list,retry,discover,callRpc};
}

describe("retry alongside a later scheduled draft", () => {
  const future = (overrides: Parameters<typeof makeQueueEntry>[0] = {}) => makeQueueEntry({
    id: "future-user", payload: {kind: "inline"}, state: "scheduled",
    waitingOn: {kind: "time"}, sendAt: Date.now() + 86_400_000, groupWithNext: false, ...overrides,
  });
  it("allows multiple later drafts without mutating them", () => {
    const rows = [future(),future({id:"another",sendAt:20_000_000})];
    const before = JSON.stringify(rows);
    expect(queueBlocksRetry(rows,1_900_000)).toBe(false);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it.each([
    ["due first", {sendAt:1_899_999}],
    ["same time", {sendAt:1_900_000}],
    ["missing clock", {sendAt:null}],
    ["invalid clock", {sendAt:Number.NaN}],
    ["grouped", {groupWithNext:true}],
    ["claimed", {state:"claimed" as const}],
    ["failed", {state:"failed_exhausted" as const}],
    ["retrying failure", {state:"failed_retrying" as const}],
    ["ready", {state:"queued" as const}],
    ["waiting for interaction", {state:"waiting" as const,waitingOn:{kind:"interaction" as const}}],
    ["waiting on plugin", {state:"waiting" as const,waitingOn:{kind:"plugin" as const,pluginId:"owner",reason:"hold"}}],
    ["other retry", {payload:{kind:"retry" as const,retryOfTurnRequestId:"other",attempt:2,reason:"retry"}}],
  ])("blocks %s", (_name,overrides) => {
    expect(queueBlocksRetry([future(overrides)],1_900_000)).toBe(true);
  });
  it("emits turn.failed -> durable SDK retry, preserves later draft, deduplicates after reload", async () => {
    vi.spyOn(Date,"now").mockReturnValue(1_000_000); vi.spyOn(Math,"random").mockReturnValue(0);
    const h=setup(),later=future(),before=JSON.stringify(later);
    const queue=[later]; h.list.mockImplementation(async()=>queue);
    h.retry.mockImplementation(async input=>{
      const r=input as {sendAt:number;reason:string;turnRequestId:string};
      queue.push(makeQueueEntry({id:"native-retry",state:"scheduled",sendAt:r.sendAt,waitingOn:{kind:"time"},
        payload:{kind:"retry",retryOfTurnRequestId:r.turnRequestId,attempt:2,reason:r.reason}}));
      return {};
    });
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(h.retry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({turnRequestId:"creq-captured",sendAt:1_900_000}));
    expect(queue).toHaveLength(2); expect(JSON.stringify(queue[0])).toBe(before);
    expect(queue[1]!.sendAt).toBeLessThan(queue[0]!.sendAt!);
    await h.harness.lifecycle.reload(async bb=>registerCreditRetry(bb));
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(queue).toHaveLength(2); expect(h.retry).toHaveBeenCalledTimes(1);
    await h.harness.lifecycle.dispose();
  });
  it("blocks a mixed queue if even one ordinary message takes precedence", async () => {
    const h=setup(); h.list.mockResolvedValue([future(),makeQueueEntry()]);
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(h.retry).not.toHaveBeenCalled();
    expect(await h.harness.behavior.callRpc("creditRetry.status",{threadId:"thread-credit"}))
      .toMatchObject({last:{outcome:"declined",reason:"queue-takes-precedence"}});
    expect(JSON.stringify(h.harness.logEntries)).toContain("queue-takes-precedence");
    await h.harness.lifecycle.dispose();
  });
  it("rechecks queue before scheduling after a ready message appears", async () => {
    const h=setup(); h.list.mockResolvedValueOnce([future()]).mockResolvedValueOnce([makeQueueEntry()]);
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(h.retry).not.toHaveBeenCalled(); expect(h.list).toHaveBeenCalledTimes(2);
    await h.harness.lifecycle.dispose();
  });
  it("rechecks thread before scheduling after manual stop", async () => {
    const h=setup(); h.get.mockResolvedValueOnce(makeThreadResponse({providerId:"codex",status:"error"}))
      .mockResolvedValueOnce(makeThreadResponse({providerId:"codex",status:"idle"}));
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(h.retry).not.toHaveBeenCalled();
    await h.harness.lifecycle.dispose();
  });
  it("does not report a committed retry as declined when diagnostics storage fails", async () => {
    const h=setup(); vi.spyOn(h.bb.storage.kv,"set").mockRejectedValue(new Error("disk unavailable"));
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(h.retry).toHaveBeenCalledTimes(1);
    const logs=JSON.stringify(h.harness.logEntries);
    expect(logs).toContain("queued but diagnostic");
    expect(logs).not.toContain("could not be queued");
    await h.harness.lifecycle.dispose();
  });
  it("does not overwrite deduplication history when its initial read fails", async () => {
    const h=setup();
    vi.spyOn(h.bb.storage.kv,"get").mockRejectedValue(new Error("read unavailable"));
    const set=vi.spyOn(h.bb.storage.kv,"set");
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(h.retry).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
    await h.harness.lifecycle.dispose();
  });
});

describe("Codex credit retry", () => {
  it("recognizes the captured structured out-of-credits failure", () => {
    expect(isWorkspaceCreditFailure(failure())).toBe(true);
  });
  it.each([null, {...failure().rateLimits!,providerId:"claude-code"},
    {...failure().rateLimits!,kind:"subscription-window" as const},
    {...failure().rateLimits!,kind:"spend-control" as const},
    {...failure().rateLimits!,reachedReason:"workspace_credits_depleted"},
    {...failure().rateLimits!,status:"allowed" as const}])("does not extend policy to another limit", rateLimits => {
    expect(isWorkspaceCreditFailure(failure({rateLimits}))).toBe(false);
  });
  it("does not treat overload/auth as a credit failure", () => {
    for(const category of ["overloaded","unauthorized"] as const) {
      expect(isWorkspaceCreditFailure(failure({errorInfo:{category,providerCode:null,httpStatusCode:null}}))).toBe(false);
    }
  });
  it.each(DELAYS_MINUTES.map((delay,i)=>[i+1,delay]))("attempt%s delays %s minutes", (attempt,delay) => {
    expect(creditRetryAt(attempt!,1_000,0)).toBe(1_000+delay!*60_000);
    expect(creditRetryAt(attempt!,1_000,1)).toBe(1_000+delay!*60_000+30_000);
  });
  it.each([0,5,-1,1.5])("caps invalid/exhausted attempt%s", attempt => {
    expect(creditRetryAt(attempt,0,0)).toBeNull();
  });
  it("queues the captured failure BY REFERENCE with a durable sendAt", async () => {
    vi.spyOn(Date,"now").mockReturnValue(1_000_000);
    vi.spyOn(Math,"random").mockReturnValue(0);
    const h=setup();
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(h.retry).toHaveBeenCalledExactlyOnceWith({
      threadId:"thread-credit",turnRequestId:"creq-captured",sendAt:1_900_000,
      reason:"Временный отказ Codex — автоматический повтор",
    });
    expect(await h.harness.behavior.callRpc("creditRetry.status",{threadId:"thread-credit"}))
      .toMatchObject({enabled:true,delaysMinutes:[15,30,60,120],last:{outcome:"scheduled",sendAt:1_900_000}});
    await h.harness.lifecycle.dispose();
  });
  it("deduplicates concurrent, later and reload deliveries, even after queue cancellation", async () => {
    const h=setup(),event=failure();
    await Promise.all([h.harness.behavior.emitThreadEvent("turn.failed",event),h.harness.behavior.emitThreadEvent("turn.failed",event)]);
    await h.harness.behavior.emitThreadEvent("turn.failed",event);
    await h.harness.lifecycle.reload(async bb=>registerCreditRetry(bb));
    await h.harness.behavior.emitThreadEvent("turn.failed",event); // queue empty: user cancellation does not resurrect it
    expect(h.retry).toHaveBeenCalledTimes(1);
    await h.harness.lifecycle.dispose();
  });
  it("allows four retries in a chain and stops on attempt5", async () => {
    const h=setup();
    for(let i=1;i<=5;i++) await h.harness.behavior.emitThreadEvent("turn.failed",failure({attemptNumber:i,requestId:"request-"+i}));
    expect(h.retry).toHaveBeenCalledTimes(4);
    expect(await h.harness.behavior.callRpc("creditRetry.status",{threadId:"thread-credit"}))
      .toMatchObject({last:{outcome:"declined",reason:"attempts-exhausted"}});
    await h.harness.lifecycle.dispose();
  });
  it.each(["active","idle","stopping","pending"] as const)("skips a thread already%s", async status => {
    const h=setup();
    h.get.mockResolvedValue(makeThreadResponse({providerId:"codex",status}));
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(h.retry).not.toHaveBeenCalled();await h.harness.lifecycle.dispose();
  });
  it.each([{archivedAt:100},{deletedAt:100},{providerId:"claude-code"}])("skips archived/deleted/provider-changed", async extra => {
    const h=setup();h.get.mockResolvedValue(makeThreadResponse({providerId:"codex",status:"error",...extra}));
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(h.retry).not.toHaveBeenCalled();await h.harness.lifecycle.dispose();
  });
  it("does not append a retry behind a user message or another retry", async () => {
    const h=setup();h.list.mockResolvedValue([makeQueueEntry()]);
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(h.retry).not.toHaveBeenCalled();await h.harness.lifecycle.dispose();
  });
  it.each([{kind:"ready"},{kind:"blocked",retryAt:10},{kind:"unavailable",reason:"authentication"}])("does not override a routed pool", async availability => {
    const h=setup();h.discover.mockResolvedValue([{pluginId:"account-pool"}]);h.callRpc.mockResolvedValue(availability);
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(h.retry).not.toHaveBeenCalled();await h.harness.lifecycle.dispose();
  });
  it("fails closed on unavailable or malformed RPC source", async () => {
    const h=setup();h.discover.mockResolvedValue([{pluginId:"pool"}]);h.callRpc.mockRejectedValue(new Error("Unavailable"));
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(h.retry).not.toHaveBeenCalled();await h.harness.lifecycle.dispose();
  });
  it("uses fallback only when every availability source says not-routed", async () => {
    const h=setup();h.discover.mockResolvedValue([{pluginId:"pool"}]);
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(h.retry).toHaveBeenCalledTimes(1);await h.harness.lifecycle.dispose();
  });
  it("logs a core race rejection and never claims a scheduled retry", async () => {
    const h=setup();h.retry.mockRejectedValue(new Error("no_failed_turn"));
    await h.harness.behavior.emitThreadEvent("turn.failed",failure());
    expect(await h.harness.behavior.callRpc("creditRetry.status",{threadId:"thread-credit"})).toMatchObject({last:{outcome:"declined",reason:"scheduling-error"}});
    expect(h.harness.logEntries.some(e=>e.level==="warn")).toBe(true);await h.harness.lifecycle.dispose();
  });
  it("does not replay old failures at startup or emit work after dispose", async () => {
    const h=setup();expect(h.retry).not.toHaveBeenCalled();await h.harness.lifecycle.dispose();
    expect(h.retry).not.toHaveBeenCalled();
  });
});
