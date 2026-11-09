import { describe, expect, it } from "vitest";
import { LiveTokenStore } from "../src/live-token.js";

describe("LiveTokenStore (§4.1, §9)", () => {
  it("issues distinct tokens", () => {
    const store = new LiveTokenStore();
    const a = store.issue();
    const b = store.issue();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThan(10);
  });

  it("consumes a valid token exactly once", () => {
    const store = new LiveTokenStore();
    const token = store.issue();
    expect(store.consume(token)).toBe(true);
    expect(store.consume(token)).toBe(false);
  });

  it("rejects unknown and empty tokens", () => {
    const store = new LiveTokenStore();
    expect(store.consume("not-a-token")).toBe(false);
    expect(store.consume("")).toBe(false);
  });

  it("rejects an expired token (TTL 30 s)", () => {
    let t = 1_000;
    const store = new LiveTokenStore(() => t);
    const token = store.issue();
    t += 29_999;
    expect(store.consume(token)).toBe(true);
    const second = store.issue();
    t += 30_000;
    expect(store.consume(second)).toBe(false);
  });

  it("sweeps expired tokens on issue without touching live ones", () => {
    let t = 0;
    const store = new LiveTokenStore(() => t);
    const old = store.issue();
    t = 31_000;
    const fresh = store.issue();
    expect(store.consume(old)).toBe(false);
    expect(store.consume(fresh)).toBe(true);
  });
});
