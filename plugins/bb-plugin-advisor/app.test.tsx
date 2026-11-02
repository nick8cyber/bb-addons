// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

/**
 * `renderSlot` queries are document.body-scoped and its roots survive RTL's
 * `cleanup`, so an unscoped query reads whatever earlier tests left mounted.
 * Every assertion below is scoped to the slot that produced it.
 */
function q(slot: { container: HTMLElement }) {
  return within(slot.container);
}

const badgeSlot = app.threadHeaderActions[0]!;
const panelSlot = app.threadPanelActions[0]!;
const bannerSlot = app.composerCustomizations[0]!.banners[0]!;
const badgeProps = {
  threadId: "t1",
  projectId: "p1",
  isCompactViewport: false,
};

function pendingAdviceItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    chainId: 10,
    severity: "concern" as const,
    summary: "Verification is incomplete",
    details: "- Run the test.",
    repeatCount: 1,
    ...overrides,
  };
}

function renderBanner(
  options: {
    threadId?: string;
    advice?: unknown;
    rpc?: Record<string, unknown>;
    realtimeConnectionState?: "connected" | "connecting" | "disconnected";
  } = {},
) {
  const threadId = options.threadId ?? "t1";
  return renderSlot(
    bannerSlot,
    {},
    {
      composer: {
        scope: { kind: "thread", threadId },
      },
      rpc: {
        pendingAdvice: () => ({
          advice:
            options.advice !== undefined
              ? (options.advice as any)
              : pendingAdviceItem(),
        }),
        ...(options.rpc as any),
      },
      realtimeConnectionState: options.realtimeConnectionState,
    },
  );
}

function emptyBadge() {
  return {
    open: null,
    latest: null,
    unavailableCount: 0,
    latestIsUnavailable: false,
    latestUnavailableReason: null,
    reviewing: false,
    lifecycle: "unreviewed" as const,
  };
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    chainId: 1,
    severity: "concern" as const,
    summary: "Verification is incomplete",
    details: "- Run the test.",
    sourceSeq: 10,
    createdAt: Date.now(),
    providerId: "codex",
    model: "gpt-5.6",
    reasoningLevel: "high",
    repeatCount: 1,
    firstSourceSeq: 10,
    firstCreatedAt: Date.now(),
    advisorThreadId: null,
    resolvedAt: null,
    resolvedReason: "",
    sentAt: null,
    decision: "",
    closedAt: null,
    closedSeq: null,
    continuedAt: null,
    ...overrides,
  };
}

function panel(reviews: unknown[], extra: Record<string, unknown> = {}) {
  return {
    reviews,
    incidents: [],
    advisorThreadId: null,
    reviewing: false,
    lifecycle: "unreviewed" as const,
    ...extra,
  };
}

describe("advisor header badge", () => {
  it("keeps advertising an open blocker after a later turn passes", async () => {
    // The whole point: a clean turn does not close an earlier finding, and the
    // finding is still being fed back to the agent.
    const slot = renderSlot(badgeSlot, badgeProps, {
      rpc: {
        threadBadge: () => ({
          ...emptyBadge(),
          open: {
            chainId: 7,
            severity: "blocker" as const,
            summary: "Migration is not atomic",
            repeatCount: 3,
          },
          latest: {
            severity: "pass" as const,
            summary: "Looks correct",
            repeatCount: 1,
          },
        }),
      },
    });

    expect(await q(slot).findByText("Must fix")).toBeTruthy();
    expect(q(slot).queryByText("No issues")).toBeNull();
    expect(await q(slot).findByText("×3")).toBeTruthy();
  });

  it("shows a failed review ahead of an open finding", async () => {
    const slot = renderSlot(badgeSlot, badgeProps, {
      rpc: {
        threadBadge: () => ({
          ...emptyBadge(),
          open: {
            chainId: 7,
            severity: "blocker" as const,
            summary: "Migration is not atomic",
            repeatCount: 1,
          },
          unavailableCount: 1,
          latestIsUnavailable: true,
          latestUnavailableReason: "the reviewer timed out",
        }),
      },
    });

    expect(await q(slot).findByText("Didn't run")).toBeTruthy();
    expect(q(slot).queryByText("Must fix")).toBeNull();
  });
});

describe("advisor panel", () => {
  it("counts open findings without counting clean turns", async () => {
    const slot = renderSlot(panelSlot, { threadId: "t1", params: null }, {
      rpc: {
        threadReviews: () =>
          panel([
            review({ id: 1, chainId: 1, severity: "pass", summary: "Fine" }),
            review({ id: 2, chainId: 2, severity: "pass", summary: "Also fine" }),
            review({ id: 3, chainId: 3, severity: "blocker", summary: "Broken" }),
            review({
              id: 4,
              chainId: 4,
              severity: "concern",
              summary: "Settled already",
              resolvedAt: Date.now(),
              resolvedReason: "intentional",
            }),
          ]),
      },
    });

    // Two passes are history; the settled chain is an outcome, not open work.
    expect(await q(slot).findByText("1 open")).toBeTruthy();
    expect(await q(slot).findByText("1 decided")).toBeTruthy();
    expect(await q(slot).findByText("Review log (2)")).toBeTruthy();
  });

  it("says what happened to each finding", async () => {
    const slot = renderSlot(panelSlot, { threadId: "t1", params: null }, {
      rpc: {
        threadReviews: () =>
          panel([
            review({ id: 1, chainId: 1, severity: "blocker", summary: "Queued one" }),
            review({
              id: 2,
              chainId: 2,
              severity: "concern",
              summary: "Sent one",
              sentAt: Date.now(),
            }),
            review({
              id: 3,
              chainId: 3,
              severity: "blocker",
              summary: "Ignored one",
              repeatCount: 4,
              sentAt: Date.now(),
            }),
          ]),
      },
    });

    // Never told the agent yet, told once, and told repeatedly without effect
    // are three different facts and must read differently.
    expect(
      await q(slot).findByText(
        "Queued — goes to the agent with your next message",
      ),
    ).toBeTruthy();
    expect(await q(slot).findByText(/^Sent to the agent/)).toBeTruthy();
    expect(
      await q(slot).findByText("Re-raised 4× — not addressed"),
    ).toBeTruthy();
  });

  it("attributes a settled finding to whoever settled it", async () => {
    const slot = renderSlot(panelSlot, { threadId: "t1", params: null }, {
      rpc: {
        threadReviews: () =>
          panel([
            review({
              id: 1,
              chainId: 1,
              severity: "concern",
              summary: "You fixed this",
              resolvedAt: Date.now(),
              decision: "fixed",
            }),
            review({
              id: 2,
              chainId: 2,
              severity: "blocker",
              summary: "Advisor closed this",
              closedAt: Date.now(),
              closedSeq: 51,
            }),
          ]),
      },
    });

    expect(await q(slot).findByText(/^You marked it fixed/)).toBeTruthy();
    expect(
      await q(slot).findByText("Advisor re-checked and closed it at turn 51"),
    ).toBeTruthy();
    // Both are outcomes, not open work.
    expect(await q(slot).findByText("0 open")).toBeTruthy();
    expect(await q(slot).findByText("2 decided")).toBeTruthy();
  });

  it("starts a corrective turn instead of letting the user self-certify a fix", async () => {
    const slot = renderSlot(panelSlot, { threadId: "t1", params: null }, {
      rpc: {
        threadReviews: () =>
          panel([review({ id: 9, chainId: 5, severity: "blocker" })]),
        continueFinding: () => ({
          started: true,
          reason: "started" as const,
        }),
      },
    });

    fireEvent.click(await q(slot).findByText("Verification is incomplete"));
    fireEvent.click(await q(slot).findByText("Fix in new turn"));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "continueFinding",
        input: {
          threadId: "t1",
          reviewId: 9,
        },
      }),
    );
  });

  it("asks for a review and refuses to double-fire while one is running", async () => {
    const slot = renderSlot(panelSlot, { threadId: "t1", params: null }, {
      rpc: {
        threadReviews: () => panel([]),
        requestReview: () => ({ started: true, waiting: false }),
      },
    });

    fireEvent.click(await q(slot).findByText("Review now"));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "requestReview",
        input: { threadId: "t1" },
      }),
    );
  });

  it("disables the trigger while the server reports a review in flight", async () => {
    const slot = renderSlot(panelSlot, { threadId: "t1", params: null }, {
      rpc: {
        threadReviews: () =>
          panel([], { reviewing: true, lifecycle: "pending" }),
      },
    });

    const button = (await q(slot).findByText("Reviewing…")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("lets the user overrule a finding by chain", async () => {
    // Repeats can only escalate on their own, so this is the only way a wrong
    // finding stops re-entering the agent's instructions.
    const slot = renderSlot(panelSlot, { threadId: "t1", params: null }, {
      rpc: {
        threadReviews: () =>
          panel([review({ id: 9, chainId: 5, severity: "blocker" })]),
        resolveFinding: () => ({ ok: true as const, resolved: true }),
      },
    });

    fireEvent.click(await q(slot).findByText("Verification is incomplete"));
    fireEvent.click(await q(slot).findByText("Not an issue"));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "resolveFinding",
        input: {
          threadId: "t1",
          chainId: 5,
          resolved: true,
          reason: "",
          decision: "not-an-issue",
        },
      }),
    );
  });
});

describe("advisor model settings", () => {
  it("renders machine-local models and saves the selected provider/model pair", async () => {
    const configuration = {
      hosts: [
        {
          hostId: "host-laptop",
          hostName: "Laptop",
          connected: true,
          selection: null,
          options: [
            {
              providerId: "codex",
              providerName: "Codex",
              model: "gpt-advisor",
              modelName: "GPT Advisor",
              isDefault: false,
              supportedReasoningLevels: ["low", "medium", "high"],
              defaultReasoningLevel: "medium",
            },
          ],
          error: null,
        },
      ],
    };
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          modelConfiguration: () => configuration,
          setHostModel: () => ({ ok: true as const }),
        },
      },
    );

    const select = (await slot.findByLabelText(
      "Advisor model for Laptop",
    )) as HTMLSelectElement;
    expect(select.value).toBe("follow");
    expect(select.textContent).toContain("Codex · GPT Advisor");

    fireEvent.change(select, { target: { value: "0" } });
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setHostModel",
        input: {
          hostId: "host-laptop",
          selection: {
            providerId: "codex",
            model: "gpt-advisor",
            reasoningLevel: "default",
          },
        },
      }),
    );
  });

  it("saves a supported reasoning level with the machine model", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          modelConfiguration: () => ({
            hosts: [
              {
                hostId: "host-laptop",
                hostName: "Laptop",
                connected: true,
                selection: {
                  providerId: "codex",
                  model: "gpt-advisor",
                  reasoningLevel: "default" as const,
                },
                options: [
                  {
                    providerId: "codex",
                    providerName: "Codex",
                    model: "gpt-advisor",
                    modelName: "GPT Advisor",
                    isDefault: false,
                    supportedReasoningLevels: ["low", "medium", "high"] as const,
                    defaultReasoningLevel: "medium" as const,
                  },
                ],
                error: null,
              },
            ],
          }),
          setHostModel: () => ({ ok: true as const }),
        },
      },
    );

    const reasoning = (await slot.findByLabelText(
      "Advisor reasoning for Laptop",
    )) as HTMLSelectElement;
    expect(reasoning.value).toBe("default");
    expect(reasoning.textContent).toContain("Model default (medium)");

    fireEvent.change(reasoning, { target: { value: "high" } });
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setHostModel",
        input: {
          hostId: "host-laptop",
          selection: {
            providerId: "codex",
            model: "gpt-advisor",
            reasoningLevel: "high",
          },
        },
      }),
    );
  });
});

describe("advisor compact composer banner", () => {
  it("renders collapsed by default with severity, single-line preview, and accessible toggle control", async () => {
    const slot = renderBanner({
      advice: pendingAdviceItem({
        id: 1,
        severity: "blocker",
        summary: "Migration is not atomic",
      }),
    });

    expect(await q(slot).findByText("Must fix")).toBeTruthy();
    const toggle = await q(slot).findByRole("button", { name: "Show more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const controlsId = toggle.getAttribute("aria-controls");
    expect(controlsId).toBe("advisor-banner-details-1");

    const details = slot.container.querySelector(`#${controlsId}`);
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("hidden")).toBe(true);

    // Truncated preview is visible in the container
    const preview = await q(slot).findByText("Migration is not atomic");
    expect(preview).toBeTruthy();
    // Action buttons exist in DOM inside the hidden section
    expect(details?.querySelector("button")).toBeTruthy();
    fireEvent.click(preview);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(details?.hasAttribute("hidden")).toBe(false);
  });

  it("toggles expand and collapse on click, Enter, and Space without calling RPC", async () => {
    let rpcCount = 0;
    const slot = renderBanner({
      rpc: {
        pendingAdvice: () => {
          rpcCount++;
          return { advice: pendingAdviceItem({ id: 1 }) };
        },
      },
    });

    const toggle = await q(slot).findByRole("button", { name: "Show more" });
    const initialCalls = slot.rpcCalls.length;

    // Click to expand
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await q(slot).findByRole("button", { name: "Show less" })).toBeTruthy();
    const details = slot.container.querySelector("#advisor-banner-details-1");
    expect(details?.hasAttribute("hidden")).toBe(false);
    expect(slot.rpcCalls.length).toBe(initialCalls);

    // Enter to collapse
    fireEvent.keyDown(toggle, { key: "Enter" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(details?.hasAttribute("hidden")).toBe(true);
    expect(slot.rpcCalls.length).toBe(initialCalls);

    // Space to expand
    fireEvent.keyDown(toggle, { key: " " });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(details?.hasAttribute("hidden")).toBe(false);
    expect(slot.rpcCalls.length).toBe(initialCalls);
  });

  it("preserves expanded state when the same card refetches", async () => {
    let currentAdvice = pendingAdviceItem({
      id: 1,
      summary: "First summary",
    });

    const slot = renderBanner({
      rpc: {
        pendingAdvice: () => ({ advice: currentAdvice }),
      },
    });

    const toggle = await q(slot).findByRole("button", { name: "Show more" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    // Server updates advice for the same card id
    currentAdvice = pendingAdviceItem({
      id: 1,
      summary: "Updated summary",
    });
    await slot.emitRealtime("thread-changed", { threadId: "t1" });

    // Summary updated, expanded state preserved!
    expect(await q(slot).findByText("Updated summary")).toBeTruthy();
    const toggleAfter = await q(slot).findByRole("button", { name: "Show less" });
    expect(toggleAfter.getAttribute("aria-expanded")).toBe("true");
  });

  it("starts collapsed when advice or thread changes without state leaking", async () => {
    let currentAdvice = pendingAdviceItem({ id: 1, summary: "Card 1" });
    const slot = renderBanner({
      threadId: "t1",
      rpc: {
        pendingAdvice: ({ threadId }: any) => ({
          advice:
            threadId === "t1"
              ? currentAdvice
              : pendingAdviceItem({ id: 2, summary: "Card on thread 2" }),
        }),
      },
    });

    const toggle = await q(slot).findByRole("button", { name: "Show more" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    // Switch scope to thread t2
    await slot.setComposerScope({ kind: "thread", threadId: "t2" });

    // On t2, banner starts collapsed!
    expect(await q(slot).findByText("Card on thread 2")).toBeTruthy();
    const toggleT2 = await q(slot).findByRole("button", { name: "Show more" });
    expect(toggleT2.getAttribute("aria-expanded")).toBe("false");
  });

  it("lets user resolve finding with Not an issue passing exact chainId and refetches", async () => {
    let refetched = false;
    const slot = renderBanner({
      advice: pendingAdviceItem({
        id: 7,
        chainId: 99,
        repeatCount: 3,
        summary: "Repeated warning",
      }),
      rpc: {
        resolveFinding: () => ({ ok: true as const, resolved: true }),
        pendingAdvice: () => {
          refetched = true;
          return {
            advice: pendingAdviceItem({ id: 7, chainId: 99 }),
          };
        },
      },
    });

    fireEvent.click(await q(slot).findByRole("button", { name: "Show more" }));
    const notAnIssue = await q(slot).findByText("Not an issue");
    fireEvent.click(notAnIssue);

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "resolveFinding",
        input: {
          threadId: "t1",
          chainId: 99,
          resolved: true,
          reason: "",
          decision: "not-an-issue",
        },
      }),
    );
    expect(refetched).toBe(true);
  });

  it("treats resolved: false as an error, shows error without replacing card, and allows retry", async () => {
    const slot = renderBanner({
      advice: pendingAdviceItem({ id: 1, chainId: 10 }),
      rpc: {
        resolveFinding: () => ({ ok: true as const, resolved: false }),
      },
    });

    fireEvent.click(await q(slot).findByRole("button", { name: "Show more" }));
    fireEvent.click(await q(slot).findByText("Not an issue"));

    expect(await q(slot).findByText("This finding is no longer open.")).toBeTruthy();

    // Card is NOT replaced: user can still collapse/expand
    const toggle = await q(slot).findByRole("button", { name: "Show less" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    // Error remains visible even when collapsed
    expect(await q(slot).findByText("This finding is no longer open.")).toBeTruthy();

    // Retry button clears error and refetches without re-invoking resolveFinding
    const initialResolveCalls = slot.rpcCalls.filter(
      (c) => c.method === "resolveFinding",
    ).length;
    fireEvent.click(await q(slot).findByText("Retry"));

    await waitFor(() => {
      expect(q(slot).queryByText("This finding is no longer open.")).toBeNull();
    });
    // No second resolveFinding call from Retry!
    expect(
      slot.rpcCalls.filter((c) => c.method === "resolveFinding").length,
    ).toBe(initialResolveCalls);
  });

  it("blocks concurrent mutations while a request is in flight", async () => {
    let resolveMutation: (val: any) => void;
    const slot = renderBanner({
      advice: pendingAdviceItem({ id: 1, chainId: 10 }),
      rpc: {
        resolveFinding: () =>
          new Promise((resolve) => {
            resolveMutation = resolve;
          }),
      },
    });

    fireEvent.click(await q(slot).findByRole("button", { name: "Show more" }));
    const notAnIssue = (await q(slot).findByText("Not an issue")) as HTMLButtonElement;
    const dismiss = (await q(slot).findByText("Dismiss")) as HTMLButtonElement;
    const fixInNewTurn = (await q(slot).findByText("Fix in new turn")) as HTMLButtonElement;

    fireEvent.click(notAnIssue);
    // Double click
    fireEvent.click(notAnIssue);

    await waitFor(() => {
      expect(notAnIssue.disabled).toBe(true);
      expect(dismiss.disabled).toBe(true);
      expect(fixInNewTurn.disabled).toBe(true);
    });

    const calls = slot.rpcCalls.filter((c) => c.method === "resolveFinding");
    expect(calls.length).toBe(1);

    resolveMutation!({ ok: true as const, resolved: true });
  });

  it("preserves Dismiss, View review, and Fix in new turn semantics", async () => {
    const slot = renderBanner({
      advice: pendingAdviceItem({ id: 4, chainId: 10 }),
      rpc: {
        dismissAdvice: () => ({ ok: true as const }),
        continueFinding: () => ({
          started: true as const,
          reason: "started" as const,
        }),
      },
    });

    fireEvent.click(await q(slot).findByRole("button", { name: "Show more" }));

    // View review opens thread panel
    fireEvent.click(await q(slot).findByText("View review"));
    expect(slot.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: { actionId: "reviews" },
    });

    // Dismiss calls dismissAdvice
    fireEvent.click(await q(slot).findByText("Dismiss"));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "dismissAdvice",
        input: { threadId: "t1", adviceId: 4 },
      }),
    );

    // Fix in new turn calls continueFinding
    fireEvent.click(await q(slot).findByText("Fix in new turn"));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "continueFinding",
        input: { threadId: "t1", reviewId: 4 },
      }),
    );
  });

  it("useThreadAdvisor binds data to threadId and discards late responses after thread switch", async () => {
    let resolveT1: (val: any) => void;
    const slot = renderSlot(
      bannerSlot,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "t1" },
        },
        rpc: {
          pendingAdvice: ({ threadId }: any) => {
            if (threadId === "t1") {
              return new Promise((resolve) => {
                resolveT1 = resolve;
              });
            }
            return {
              advice: pendingAdviceItem({ id: 2, summary: "Thread 2 advice" }),
            };
          },
        },
      },
    );

    // Switch to t2 before t1 deferred response arrives
    await slot.setComposerScope({ kind: "thread", threadId: "t2" });

    // t2 response renders
    expect(await q(slot).findByText("Thread 2 advice")).toBeTruthy();

    // Now t1 deferred response resolves late
    resolveT1!({
      advice: pendingAdviceItem({ id: 1, summary: "Stale thread 1 advice" }),
    });

    // Wait and ensure t2 advice stays, t1 is discarded
    await waitFor(() => {
      expect(q(slot).queryByText("Stale thread 1 advice")).toBeNull();
      expect(q(slot).getByText("Thread 2 advice")).toBeTruthy();
    });
  });

  it("scopes mutation error and busy state to threadId and adviceId", async () => {
    let rejectMutation: (err: any) => void;
    const slot = renderBanner({
      threadId: "t1",
      advice: pendingAdviceItem({ id: 1 }),
      rpc: {
        resolveFinding: () =>
          new Promise((_, reject) => {
            rejectMutation = reject;
          }),
        pendingAdvice: ({ threadId }: any) => ({
          advice:
            threadId === "t1"
              ? pendingAdviceItem({ id: 1 })
              : pendingAdviceItem({ id: 2, summary: "Thread 2 advice" }),
        }),
      },
    });

    fireEvent.click(await q(slot).findByRole("button", { name: "Show more" }));
    fireEvent.click(await q(slot).findByText("Not an issue"));

    // Switch to t2 while mutation on t1 is pending
    await slot.setComposerScope({ kind: "thread", threadId: "t2" });
    expect(await q(slot).findByText("Thread 2 advice")).toBeTruthy();

    // Old mutation fails late
    rejectMutation!(new Error("Old mutation failure on t1"));

    // Error does not leak to t2
    await waitFor(() => {
      expect(q(slot).queryByText("Old mutation failure on t1")).toBeNull();
    });
  });

  it("discards deferred mutation late success on t1 after switching to t2 and preserves t2 card", async () => {
    let resolveT1Mutation: (val: any) => void;
    const slot = renderBanner({
      threadId: "t1",
      advice: pendingAdviceItem({ id: 1, summary: "Thread 1 advice" }),
      rpc: {
        resolveFinding: () =>
          new Promise((resolve) => {
            resolveT1Mutation = resolve;
          }),
        pendingAdvice: ({ threadId }: any) => ({
          advice:
            threadId === "t1"
              ? pendingAdviceItem({ id: 1, summary: "Thread 1 advice" })
              : pendingAdviceItem({ id: 2, summary: "Thread 2 advice" }),
        }),
      },
    });

    fireEvent.click(await q(slot).findByRole("button", { name: "Show more" }));
    fireEvent.click(await q(slot).findByText("Not an issue"));

    // Switch to thread t2 while t1 mutation is still in flight
    await slot.setComposerScope({ kind: "thread", threadId: "t2" });
    expect(await q(slot).findByText("Thread 2 advice")).toBeTruthy();

    // Now t1 mutation resolves late with success
    resolveT1Mutation!({ ok: true as const, resolved: true });

    // Ensure thread 2 advice remains displayed, not wiped by stale reload from t1
    await waitFor(() => {
      expect(q(slot).getByText("Thread 2 advice")).toBeTruthy();
      expect(q(slot).queryByText("Thread 1 advice")).toBeNull();
    });
  });

  it("keeps buttons locked and blocks second click until reload completes after successful resolve", async () => {
    let resolveRpcDone: (val: any) => void;
    let deferredReloadDone: (val: any) => void;
    let reloadStarted = false;

    const slot = renderBanner({
      advice: pendingAdviceItem({ id: 1, chainId: 10 }),
      rpc: {
        resolveFinding: () =>
          new Promise((resolve) => {
            resolveRpcDone = resolve;
          }),
        pendingAdvice: () => {
          if (!reloadStarted) {
            return { advice: pendingAdviceItem({ id: 1, chainId: 10 }) };
          }
          return new Promise((resolve) => {
            deferredReloadDone = resolve;
          });
        },
      },
    });

    fireEvent.click(await q(slot).findByRole("button", { name: "Show more" }));
    const notAnIssue = (await q(slot).findByText("Not an issue")) as HTMLButtonElement;

    // First click triggers resolveFinding
    fireEvent.click(notAnIssue);
    expect(slot.rpcCalls.filter((c) => c.method === "resolveFinding").length).toBe(1);

    // resolveFinding resolves, but reload (pendingAdvice) is deferred
    reloadStarted = true;
    resolveRpcDone!({ ok: true as const, resolved: true });

    // Wait for resolveFinding promise to settle and reload to start
    await waitFor(() => {
      expect(slot.rpcCalls.filter((c) => c.method === "pendingAdvice").length).toBe(2);
    });

    // Second click while reload is still in flight: must be blocked!
    fireEvent.click(notAnIssue);
    expect(slot.rpcCalls.filter((c) => c.method === "resolveFinding").length).toBe(1);
    expect(notAnIssue.disabled).toBe(true);

    // Now deferred reload resolves
    deferredReloadDone!({ advice: null });
  });

  it("allows overlapping mutations on t1 and t2 where t1 completion does not unlock t2", async () => {
    let resolveT1Done: (val: any) => void;
    let resolveT2Done: (val: any) => void;

    const slot = renderBanner({
      threadId: "t1",
      advice: pendingAdviceItem({ id: 1, summary: "Thread 1 advice" }),
      rpc: {
        resolveFinding: () =>
          new Promise((resolve) => {
            resolveT1Done = resolve;
          }),
        dismissAdvice: () =>
          new Promise((resolve) => {
            resolveT2Done = resolve;
          }),
        pendingAdvice: ({ threadId }: any) => ({
          advice:
            threadId === "t1"
              ? pendingAdviceItem({ id: 1, summary: "Thread 1 advice" })
              : pendingAdviceItem({ id: 2, summary: "Thread 2 advice" }),
        }),
      },
    });

    // Start mutation on t1
    fireEvent.click(await q(slot).findByRole("button", { name: "Show more" }));
    fireEvent.click(await q(slot).findByText("Not an issue"));
    expect(slot.rpcCalls.filter((c) => c.method === "resolveFinding").length).toBe(1);

    // Switch to t2 while t1 mutation is still pending
    await slot.setComposerScope({ kind: "thread", threadId: "t2" });
    expect(await q(slot).findByText("Thread 2 advice")).toBeTruthy();

    // Expand t2 card and click Dismiss
    fireEvent.click(await q(slot).findByRole("button", { name: "Show more" }));
    const dismissT2 = (await q(slot).findByText("Dismiss")) as HTMLButtonElement;
    expect(dismissT2.disabled).toBe(false);

    // Click dismiss on t2: should NOT be blocked by t1's in-flight mutation!
    fireEvent.click(dismissT2);
    await waitFor(() => {
      expect(slot.rpcCalls.filter((c) => c.method === "dismissAdvice").length).toBe(1);
    });
    expect(dismissT2.disabled).toBe(true);

    // Now t1 mutation completes
    resolveT1Done!({ ok: true as const, resolved: true });

    // Verify t2 remains busy/disabled and is not unlocked by t1's completion
    await waitFor(() => {
      expect(dismissT2.disabled).toBe(true);
    });

    // Finally t2 completes
    resolveT2Done!({ ok: true as const });
  });
});
