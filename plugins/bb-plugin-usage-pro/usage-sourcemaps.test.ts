import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore
import { normalizeSourcePath } from "./scripts/normalize-sourcemaps.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname);
const distDir = path.join(pluginRoot, "dist");

describe("PLUG-417 sourcemap normalizer (scripts/normalize-sourcemaps.mjs)", () => {
  it("normalizes absolute path inside plugin root to relative from dist", () => {
    const inside = path.join(pluginRoot, "server.ts");
    expect(normalizeSourcePath(inside, distDir, pluginRoot)).toBe("../server.ts");

    const inDist = path.join(pluginRoot, "dist", "provider-usage-base.js");
    expect(normalizeSourcePath(inDist, distDir, pluginRoot)).toBe("provider-usage-base.js");
  });

  it("normalizes absolute path outside plugin root with node_modules into plugin node_modules", () => {
    const outsideNm = "/srv/external-build/checkout/node_modules/zod/v4/classic/external.js";
    expect(normalizeSourcePath(outsideNm, distDir, pluginRoot)).toBe(
      "../node_modules/zod/v4/classic/external.js",
    );
  });

  it("normalizes absolute path outside plugin root without node_modules to plugin root basename", () => {
    const stub = "/srv/external-build/temp/bb-zod-locale-stub.ts";
    expect(normalizeSourcePath(stub, distDir, pluginRoot)).toBe("../bb-zod-locale-stub.ts");
  });

  it("rewrites escaping relative path climbing out into node_modules", () => {
    const escaping = "../../../../../../../../srv/external-build/node_modules/zod/v4/core/index.js";
    expect(normalizeSourcePath(escaping, distDir, pluginRoot)).toBe(
      "../node_modules/zod/v4/core/index.js",
    );
  });

  it("preserves esbuild plugin namespaces on absolute and outside paths", () => {
    const withNs = "bb-zod-locale-stub:/srv/external-build/temp/bb-zod-locale-stub.ts";
    expect(normalizeSourcePath(withNs, distDir, pluginRoot)).toBe(
      "bb-zod-locale-stub:../bb-zod-locale-stub.ts",
    );

    const withNmNs = "custom-ns:/srv/external-build/node_modules/zod/index.js";
    expect(normalizeSourcePath(withNmNs, distDir, pluginRoot)).toBe(
      "custom-ns:../node_modules/zod/index.js",
    );
  });

  it("leaves paths already inside the plugin tree unchanged", () => {
    expect(normalizeSourcePath("../server.ts", distDir, pluginRoot)).toBe("../server.ts");
    expect(normalizeSourcePath("../provider-usage-base.js", distDir, pluginRoot)).toBe(
      "../provider-usage-base.js",
    );
    expect(
      normalizeSourcePath("../node_modules/zod/v4/classic/external.js", distDir, pluginRoot),
    ).toBe("../node_modules/zod/v4/classic/external.js");
  });
});

describe("PLUG-417 committed dist/server.js.map artifact cleanliness", () => {
  it("contains no absolute paths, no escaping ../../, and no build checkout leaks", () => {
    const mapPath = path.join(distDir, "server.js.map");
    expect(fs.existsSync(mapPath)).toBe(true);

    const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
    expect(Array.isArray(map.sources)).toBe(true);
    expect(map.sources.length).toBeGreaterThan(0);

    for (const src of map.sources) {
      // Must not be an absolute path (POSIX / or Windows C:\)
      expect(src).not.toMatch(/^(?:[A-Za-z]:[\\/]|\/)/);
      // Must not escape outside plugin directory (dist is pluginRoot/dist, so ../ stays in pluginRoot)
      expect(src).not.toMatch(/^\.\.\/\.\.\//);
      // Must not leak machine/author home paths or thread worktree names
      expect(src).not.toContain("thr_");
      expect(src).not.toContain("/home" + "/");
      expect(src).not.toContain("/work" + "/");
      // Must stay within relative plugin directory
      expect(src.startsWith("../") || src.startsWith("provider-usage-base.js")).toBe(true);
    }
  });
});

describe("PLUG-417 footer strip CSS regression (app.css & dist/app.css)", () => {
  it("does not cap strip width with max-width: 240px and supports compact mode", () => {
    const appCss = fs.readFileSync(path.join(pluginRoot, "app.css"), "utf8");
    const distCss = fs.readFileSync(path.join(distDir, "app.css"), "utf8");

    for (const css of [appCss, distCss]) {
      // Must not have max-width: 240px cap on .usage-pro-machines-strip
      expect(css).not.toContain("max-width: 240px");
      expect(css).not.toContain("max-width:240px");

      // Must support compact mode by hiding labels
      expect(css).toMatch(/\[data-fit=["']?compact["']?\]/);
      expect(css).toMatch(/\[data-fit=["']?compact["']?\].*?\.lbl/s);
    }
  });
});
