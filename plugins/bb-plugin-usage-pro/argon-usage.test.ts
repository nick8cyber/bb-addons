import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ARGON_STALE_MS,
  argonTierLabel,
  createArgonUsage,
  formatArgonAge,
} from "./argon-usage";

const NOW = 1_763_400_000_000;

describe("createArgonUsage", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "argon-usage-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {}
  });

  function write(file: unknown) {
    fs.writeFileSync(
      path.join(stateDir, "accounts-usage.json"),
      typeof file === "string" ? file : JSON.stringify(file),
    );
  }

  function reader(now = NOW) {
    return createArgonUsage({ stateDir, userHome: () => stateDir, now: () => now });
  }

  it("returns an empty list when the file is missing", () => {
    expect(reader().readAccounts()).toEqual([]);
  });

  it("returns an empty list when the file does not parse", () => {
    write("{ not json");
    expect(reader().readAccounts()).toEqual([]);
  });

  it("returns an empty list when accounts is not an object", () => {
    write({ accounts: [1, 2] });
    expect(reader().readAccounts()).toEqual([]);
    write({ accounts: null });
    expect(reader().readAccounts()).toEqual([]);
    write("[]");
    expect(reader().readAccounts()).toEqual([]);
  });

  it("parses a contract-shaped file per account", () => {
    write({
      accounts: {
        work: {
          daily: { percent: 25, resetEpochSec: 1_763_402_000 },
          weekly: { percent: 60, resetEpochSec: 1_764_000_000 },
          tier: "ultra",
          updatedAt: NOW - 5 * 60_000,
          stale: false,
        },
        home: {
          daily: null,
          weekly: { percent: 90, resetEpochSec: 1_764_000_000 },
          tier: "pro",
          updatedAt: NOW - 60_000,
          stale: false,
        },
      },
      recipe: { rpcid: "jSf9Qc", args: "[]", updatedAt: NOW },
    });
    const accounts = reader().readAccounts();
    expect(accounts).toHaveLength(2);
    const work = accounts.find((a) => a.id === "work")!;
    expect(work.daily).toEqual({ percent: 25, resetEpochSec: 1_763_402_000 });
    expect(work.weekly).toEqual({ percent: 60, resetEpochSec: 1_764_000_000 });
    expect(work.tier).toBe("ultra");
    expect(work.updatedAtMs).toBe(NOW - 300_000);
    expect(work.stale).toBe(false);
    expect(work.ageMs).toBe(300_000);
    const home = accounts.find((a) => a.id === "home")!;
    expect(home.daily).toBeNull();
    expect(home.weekly?.percent).toBe(90);
  });

  it("marks entries stale when data is older than 30 minutes", () => {
    write({
      accounts: {
        old: {
          daily: { percent: 10, resetEpochSec: 1_763_402_000 },
          weekly: null,
          tier: "pro",
          updatedAt: NOW - ARGON_STALE_MS - 1,
          stale: false,
        },
        fresh: {
          daily: null,
          weekly: null,
          tier: null,
          updatedAt: NOW - ARGON_STALE_MS + 60_000,
          stale: false,
        },
      },
    });
    const accounts = reader().readAccounts();
    expect(accounts.find((a) => a.id === "old")!.stale).toBe(true);
    expect(accounts.find((a) => a.id === "fresh")!.stale).toBe(false);
  });

  it("respects the file's own stale flag and missing updatedAt", () => {
    write({
      accounts: {
        flagged: { daily: null, weekly: null, tier: "pro", updatedAt: NOW - 1000, stale: true },
        timeless: { daily: { percent: 5, resetEpochSec: 1_763_402_000 }, weekly: null, tier: "pro" },
      },
    });
    const accounts = reader().readAccounts();
    const flagged = accounts.find((a) => a.id === "flagged")!;
    expect(flagged.stale).toBe(true);
    expect(flagged.ageMs).toBe(1000);
    const timeless = accounts.find((a) => a.id === "timeless")!;
    expect(timeless.stale).toBe(true);
    expect(timeless.ageMs).toBeNull();
  });

  it("skips blank account keys that would break the strict output schema", () => {
    write({
      accounts: {
        "": { daily: { percent: 1, resetEpochSec: 1_763_402_000 }, weekly: null, tier: "pro", updatedAt: NOW, stale: false },
        "  ": { daily: null, weekly: null, tier: "pro", updatedAt: NOW, stale: false },
        " spaced ": { daily: null, weekly: null, tier: "pro", updatedAt: NOW, stale: false },
      },
    });
    const accounts = reader().readAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe("spaced");
  });

  it("drops malformed metrics and implausible reset times", () => {
    write({
      accounts: {
        acc: {
          daily: { percent: "high", resetEpochSec: 1_763_402_000 },
          weekly: { percent: 40, resetEpochSec: 42 },
          tier: 7,
          updatedAt: NOW - 1000,
          stale: false,
        },
        bad: "not an object",
      },
    });
    const accounts = reader().readAccounts();
    expect(accounts).toHaveLength(1);
    const acc = accounts[0];
    expect(acc.daily).toBeNull();
    expect(acc.weekly).toEqual({ percent: 40, resetEpochSec: null });
    expect(acc.tier).toBeNull();
  });

  it("resolves injected stateDir, then WEB_GEMINI_STATE_DIR, ARGON_STATE_DIR, then default dirs", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "argon-home-"));
    const argonEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "argon-env-"));
    const geminiEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-gemini-env-"));
    const writeUsage = (dir: string, id: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "accounts-usage.json"),
        JSON.stringify({ accounts: { [id]: { updatedAt: NOW, stale: false } } }),
      );
    };
    const saved = {
      WEB_GEMINI_STATE_DIR: process.env.WEB_GEMINI_STATE_DIR,
      ARGON_STATE_DIR: process.env.ARGON_STATE_DIR,
    };
    const restore = () => {
      for (const key of Object.keys(saved) as (keyof typeof saved)[]) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    try {
      const viaDefault = createArgonUsage({ userHome: () => home, now: () => NOW });
      const legacyDir = path.join(home, ".bb", "plugins", "provider-argon");
      writeUsage(legacyDir, "legacy");
      expect(viaDefault.readAccounts().map((a) => a.id)).toEqual(["legacy"]);
      const geminiDir = path.join(home, ".bb", "plugins", "provider-web-gemini");
      writeUsage(geminiDir, "gemini");
      expect(viaDefault.readAccounts().map((a) => a.id)).toEqual(["gemini"]);
      writeUsage(argonEnvDir, "argon-env");
      process.env.ARGON_STATE_DIR = argonEnvDir;
      expect(viaDefault.readAccounts().map((a) => a.id)).toEqual(["argon-env"]);
      writeUsage(geminiEnvDir, "web-gemini-env");
      process.env.WEB_GEMINI_STATE_DIR = geminiEnvDir;
      expect(viaDefault.readAccounts().map((a) => a.id)).toEqual(["web-gemini-env"]);
      write({ accounts: { injected: { updatedAt: NOW, stale: false } } });
      expect(reader().readAccounts().map((a) => a.id)).toEqual(["injected"]);
    } finally {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(argonEnvDir, { recursive: true, force: true });
      fs.rmSync(geminiEnvDir, { recursive: true, force: true });
    }
  });
});

describe("formatArgonAge", () => {
  it("formats minutes, hours and days", () => {
    expect(formatArgonAge(5_000)).toBe("только что");
    expect(formatArgonAge(59_999)).toBe("только что");
    expect(formatArgonAge(60_000)).toBe("1 мин назад");
    expect(formatArgonAge(5 * 60_000)).toBe("5 мин назад");
    expect(formatArgonAge(90 * 60_000)).toBe("1 ч назад");
    expect(formatArgonAge(47 * 3_600_000)).toBe("47 ч назад");
    expect(formatArgonAge(49 * 3_600_000)).toBe("2 д назад");
  });
});

describe("argonTierLabel", () => {
  it("maps known tiers and capitalizes the rest", () => {
    expect(argonTierLabel("ultra")).toBe("Ultra");
    expect(argonTierLabel("pro")).toBe("Pro");
    expect(argonTierLabel("free")).toBe("Free");
    expect(argonTierLabel(null)).toBeNull();
  });
});
