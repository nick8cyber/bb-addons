/**
 * Smoke test: the app entry registers the nav panel with the spec-mandated
 * id/path/title/icon. The SDK app module is mocked so only the registration
 * arguments are exercised — no host runtime needed.
 */
import { describe, expect, it, vi } from "vitest";

const setups: Array<(app: unknown) => void> = [];

vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (setup: (app: unknown) => void) => {
    setups.push(setup);
    return setup;
  },
  useRpc: () => ({ call: vi.fn() }),
  useBbNavigate: () => ({}),
  useRealtimeConnectionState: () => "connected",
  experimental_useSidebarNavigation: () => ({ actions: {} }),
  Markdown: () => null,
  UrlLink: () => null,
}));

describe("app entry", () => {
  it("registers the Tasks Pro nav panel", async () => {
    await import("../app");
    expect(setups).toHaveLength(1);
    const registrations: unknown[] = [];
    const app = {
      slots: {
        navPanel: (reg: unknown) => registrations.push(reg),
      },
    };
    setups[0](app);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      id: "explorer",
      title: "Tasks Pro",
      path: "explorer",
      icon: "ListFilter",
    });
    expect(
      typeof (registrations[0] as { component: unknown }).component,
    ).toBe("function");
  });
});
