import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const pluginDir = path.dirname(new URL(import.meta.url).pathname);

// The panel logic lives inside the checked-in app.bundle.js, which is not
// importable (it throws without globalThis.__bbPluginRuntime). Like
// usage-app-schema.test.ts we evaluate the extracted `function` declarations
// directly — they are pure helpers with no runtime imports.
function extractFunctionSource(bundle: string, name: string): string {
  const marker = `function ${name}(`;
  const start = bundle.indexOf(marker);
  if (start < 0) throw new Error(`cannot locate ${marker} in app.bundle.js`);
  let parenDepth = 0;
  let argsEnd = -1;
  for (let i = start + marker.length - 1; i < bundle.length; i += 1) {
    if (bundle[i] === "(") parenDepth++;
    else if (bundle[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        argsEnd = i;
        break;
      }
    }
  }
  const braceStart = bundle.indexOf("{", argsEnd);
  let depth = 0;
  let end = -1;
  let quote = "";
  let escaped = false;
  for (let i = braceStart; i < bundle.length; i += 1) {
    const c = bundle[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`function ${name} body is not terminated in app.bundle.js`);
  return bundle.slice(start, end);
}

const FN_NAMES = [
  "configuredMachines",
  "allMachinesSelected",
  "shouldShowFooterStrip",
  "accountRotationWindows",
  "freestMachine",
  "machineWorstPct",
  "sortUsageWindows",
  "formatWindowLabel",
  "offlineMachineText",
] as const;

function loadBundleHelpers() {
  const bundle = fs.readFileSync(path.join(pluginDir, "app.bundle.js"), "utf8");
  const body = FN_NAMES.map((n) => extractFunctionSource(bundle, n)).join("\n");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const build = new Function(`const ALL_MACHINES_ID="all";\n${body}; return { ${FN_NAMES.join(", ")} };`);
  return build() as Record<(typeof FN_NAMES)[number], (...args: any[]) => any>;
}

const H = loadBundleHelpers();

type Window_ = { label: string; usedPercent: number };
const win = (label: string, usedPercent: number): Window_ => ({ label, usedPercent });

const okAccount = (
  providerId: string,
  windows: Window_[],
  planLabel: string | null = "Team",
  id = `${providerId}:${Math.random().toString(36).slice(2, 8)}`,
) => ({
  id,
  providerId,
  usage: { status: "ok", accountEmail: null, planLabel, windows },
});

const machine = (
  id: string,
  providers: any[],
  status: "connected" | "disconnected" = "connected",
  extra: Record<string, unknown> = {},
) => ({
  id,
  displayName: id,
  status,
  providers,
  error: null,
  server: false,
  updatedAtMs: null,
  ...extra,
});

describe("PLUG-411 configuredMachines / allMachinesSelected", () => {
  it("counts only non-source machines, including offline ones with empty providers", () => {
    const machines = [
      machine("main", []),
      machine("worker", [], "disconnected"),
      machine("source:account-pool", [], "connected"),
    ];
    expect(H.configuredMachines(machines)).toHaveLength(2);
  });

  it("hides the all-machines item below two configured machines", () => {
    expect(H.allMachinesSelected([machine("main", [])], null)).toBe(false);
    expect(
      H.allMachinesSelected(
        [machine("main", []), machine("source:account-pool", [])],
        null,
      ),
    ).toBe(false);
  });

  it("is selected by default and by explicit choice at two configured machines", () => {
    const machines = [machine("main", []), machine("worker", [], "disconnected")];
    expect(H.allMachinesSelected(machines, null)).toBe(true);
    expect(H.allMachinesSelected(machines, "all")).toBe(true);
    expect(H.allMachinesSelected(machines, "main")).toBe(false);
  });
});

describe("PLUG-411 freestMachine («Свободнее всего»)", () => {
  const provider = "claude-code";

  it("picks the machine with the smallest worst window and labels it via formatWindowLabel", () => {
    const machines = [
      machine("main", [
        okAccount(provider, [win("Five-hour limit", 62), win("Weekly limit", 87)]),
        okAccount(provider, [win("Five-hour limit", 20)], "Team", "claude-code:other"),
      ]),
      machine("worker", [okAccount(provider, [win("Five-hour limit", 18), win("Weekly limit", 31)])]),
    ];
    const best = H.freestMachine(machines, provider, false);
    expect(best.machine.id).toBe("worker");
    expect(best.freePct).toBe(69);
    expect(best.windowLabel).toBe("Недельный лимит");
  });

  it("a machine with one full and one empty account counts as busy", () => {
    const machines = [
      machine("main", [
        okAccount(provider, [win("Weekly limit", 95)]),
        okAccount(provider, [win("Weekly limit", 5)], "Team", "claude-code:empty"),
      ]),
      machine("worker", [okAccount(provider, [win("Weekly limit", 90)])]),
    ];
    expect(H.freestMachine(machines, provider, false).machine.id).toBe("worker");
  });

  it("first machine wins a tie", () => {
    const machines = [
      machine("main", [okAccount(provider, [win("Weekly limit", 50)])], "connected", { server: true }),
      machine("worker", [okAccount(provider, [win("Weekly limit", 50)])]),
    ];
    expect(H.freestMachine(machines, provider, false).machine.id).toBe("main");
  });

  it("clamps freePct at zero when the best window is over 100%", () => {
    const machines = [
      machine("main", [okAccount(provider, [win("Weekly limit", 150)])]),
      machine("worker", [okAccount(provider, [win("Weekly limit", 120)])]),
    ];
    expect(H.freestMachine(machines, provider, false).freePct).toBe(0);
  });

  it("excludes parked / out-of-rotation / install-unavailable accounts by planLabel", () => {
    for (const planLabel of ["Out of rotation", "Parked: tos-disabled", "Install unavailable: agn-1"]) {
      const machines = [
        machine("main", [okAccount(provider, [win("Weekly limit", 10)], planLabel)]),
        machine("worker", [okAccount(provider, [win("Weekly limit", 30)])]),
      ];
      // Only one participant remains — no hint line at all.
      expect(H.freestMachine(machines, provider, false), planLabel).toBeNull();
    }
  });

  it("excludes accounts with a warning (stale data) from freest calculation", () => {
    const staleAcct = {
      ...okAccount(provider, [win("Weekly limit", 10)]),
      warning: "Данные устарели",
    };
    const machines = [
      machine("main", [staleAcct]),
      machine("worker", [okAccount(provider, [win("Weekly limit", 30)])]),
    ];
    // Main is excluded due to warning, only 1 participant remains -> null
    expect(H.freestMachine(machines, provider, false)).toBeNull();
  });

  it("skips disconnected machines and needs at least two participants", () => {
    const machines = [
      machine("main", [okAccount(provider, [win("Weekly limit", 10)])]),
      machine("worker", [okAccount(provider, [win("Weekly limit", 20)])], "disconnected"),
    ];
    expect(H.freestMachine(machines, provider, false)).toBeNull();
  });

  it("honours hideClaudeModels on the agy tab", () => {
    const agyAccount = okAccount("agy", [
      win("Claude 5h", 95),
      win("Gemini 5h", 20),
    ]);
    const machines = [
      machine("main", [agyAccount]),
      machine("worker", [okAccount("agy", [win("Gemini 5h", 60)])]),
    ];
    expect(H.freestMachine(machines, "agy", true).machine.id).toBe("main");
    expect(H.freestMachine(machines, "agy", false).machine.id).toBe("worker");
  });
});

describe("PLUG-411 footer strip model", () => {
  it("is hidden by default (footerMachines off) or below two machines, and always visible when footerMachines is on", () => {
    const two = [machine("main", []), machine("worker", [])];
    expect(H.shouldShowFooterStrip(false, false, two)).toBe(false);
    expect(H.shouldShowFooterStrip(true, true, two)).toBe(true);
    expect(H.shouldShowFooterStrip(true, false, [machine("main", [])])).toBe(false);
    expect(H.shouldShowFooterStrip(true, false, two)).toBe(true);
  });

  it("machineWorstPct reports the worst visible window per machine", () => {
    const m = machine("main", [
      okAccount("agy", [win("Claude 5h", 95), win("Gemini 5h", 40)]),
      okAccount("claude-code", [win("Weekly limit", 55)]),
    ]);
    expect(H.machineWorstPct(m, "agy", true)).toBe(40);
    expect(H.machineWorstPct(m, "agy", false)).toBe(95);
    expect(H.machineWorstPct(m, "claude-code", true)).toBe(55);
    expect(H.machineWorstPct(m, "codex", true)).toBeNull();
  });

  it("machineWorstPct preserves last-known percentage on warned/stale accounts (unlike freestMachine)", () => {
    const staleAcct = {
      ...okAccount("codex", [win("5h limit", 72)]),
      warning: "Данные устарели",
    };
    const m = machine("remote", [staleAcct]);
    // machineWorstPct includes warned accounts for the mini-bar
    expect(H.machineWorstPct(m, "codex", false)).toBe(72);

    // freestMachine excludes warned accounts
    const machines = [
      machine("main", [okAccount("codex", [win("5h limit", 30)])]),
      m,
    ];
    expect(H.freestMachine(machines, "codex", false)).toBeNull();
  });
});

describe("PLUG-411 offlineMachineText", () => {
  it("renders bare text without a timestamp and minutes-ago otherwise", () => {
    expect(H.offlineMachineText(machine("worker", [], "disconnected"))).toBe("Машина недоступна");
    const tenMinAgo = Date.now() - 10 * 60000;
    expect(
      H.offlineMachineText(machine("worker", [], "disconnected", { updatedAtMs: tenMinAgo })),
    ).toBe("Машина недоступна · данные 10 мин назад");
  });
});

describe("PLUG-411 offline machine cold-start sections visibility (#2127 Item 1)", () => {
  const bundle = fs.readFileSync(path.join(pluginDir, "app.bundle.js"), "utf8");
  const srcMachineSectionAll = extractFunctionSource(bundle, "MachineSectionAll");
  const srcSettingsMachineSection = extractFunctionSource(bundle, "SettingsMachineSection");
  const srcMachineProviderAccounts = extractFunctionSource(bundle, "machineProviderAccounts");
  const srcOfflineMachineText = extractFunctionSource(bundle, "offlineMachineText");

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const makeComponents = new Function(`
    const A = (type, props) => ({ type, props });
    const p = (type, props) => ({ type, props });
    const MachineSectionHeader = (props) => ({ type: "Header", props });
    const UsageAccountCard = (props) => ({ type: "Card", props });
    const ClaudeKeyToggle = () => ({ type: "Toggle" });
    const Rm = (props) => ({ type: "Rm", props });
    ${srcMachineProviderAccounts}
    ${srcOfflineMachineText}
    ${srcMachineSectionAll}
    ${srcSettingsMachineSection}
    return { MachineSectionAll, SettingsMachineSection };
  `);
  const C = makeComponents();

  it("SettingsMachineSection renders for offline machine even with empty providers and null updatedAtMs", () => {
    const offlineEmpty = machine("worker", [], "disconnected", { server: false, updatedAtMs: null });
    const section = C.SettingsMachineSection({ machine: offlineEmpty, loading: false, error: null });
    expect(section).not.toBeNull();
    expect(section.type).toBe("div");
  });

  it("MachineSectionAll renders offline state for cold-start offline machine on multi-machine providers", () => {
    const offlineEmpty = machine("worker", [], "disconnected", { server: false, updatedAtMs: null });
    const section = C.MachineSectionAll({ machine: offlineEmpty, providerId: "codex", snapshot: {} });
    expect(section).not.toBeNull();
    expect(section.type).toBe("section");
  });

  it("MachineSectionAll excludes server-only providers (agy, acp-argon) on non-server machines", () => {
    const offlineEmptyRemote = machine("worker", [], "disconnected", { server: false, updatedAtMs: null });
    expect(C.MachineSectionAll({ machine: offlineEmptyRemote, providerId: "agy", snapshot: {} })).toBeNull();
    expect(C.MachineSectionAll({ machine: offlineEmptyRemote, providerId: "acp-argon", snapshot: {} })).toBeNull();

    const offlineEmptyServer = machine("main", [], "disconnected", { server: true, updatedAtMs: null });
    expect(C.MachineSectionAll({ machine: offlineEmptyServer, providerId: "agy", snapshot: {} })).not.toBeNull();
  });

  it("MachineSectionAll excludes synthetic source: entries", () => {
    const sourceEntry = machine("source:pool", [], "disconnected", { server: false });
    expect(C.MachineSectionAll({ machine: sourceEntry, providerId: "codex", snapshot: {} })).toBeNull();
  });
});

describe("PLUG-411 disclosure register control contract (#2127 non-blocker)", () => {
  it("bundle registers disclosure and strip button calls .toggle()", () => {
    const bundle = fs.readFileSync(path.join(pluginDir, "app.bundle.js"), "utf8");
    // Verify register is called for usage disclosure
    expect(bundle).toContain('register({kind:"disclosure",id:"usage"');
    // Verify FooterMachinesStrip uses .toggle?.() safely
    expect(bundle).toContain("usageDisclosureCtl?.toggle?.()");
  });
});

describe("PLUG-411 Fix 1: footer search priority and maxRight container skipping", () => {
  const bundle = fs.readFileSync(path.join(pluginDir, "app.bundle.js"), "utf8");

  it("prioritizes [data-testid=\"sidebar-footer-body\"] over [data-sidebar=\"footer\"] and fallback", () => {
    expect(bundle).toContain(
      'document.querySelector(\'[data-testid="sidebar-footer-body"]\')??document.querySelector(\'[data-sidebar="footer"]\')??document.querySelector(\'footer,[class*="sidebar-footer"]\')',
    );

    const resolveFooter = (elements: Record<string, any>) =>
      elements['[data-testid="sidebar-footer-body"]'] ??
      elements['[data-sidebar="footer"]'] ??
      elements['footer,[class*="sidebar-footer"]'];

    const bodyEl = { name: "footer-body" };
    const sidebarEl = { name: "sidebar-footer" };
    const fallbackEl = { name: "fallback" };

    expect(resolveFooter({
      '[data-testid="sidebar-footer-body"]': bodyEl,
      '[data-sidebar="footer"]': sidebarEl,
      'footer,[class*="sidebar-footer"]': fallbackEl,
    })).toBe(bodyEl);

    expect(resolveFooter({
      '[data-sidebar="footer"]': sidebarEl,
      'footer,[class*="sidebar-footer"]': fallbackEl,
    })).toBe(sidebarEl);

    expect(resolveFooter({
      'footer,[class*="sidebar-footer"]': fallbackEl,
    })).toBe(fallbackEl);
  });

  it("skips containers holding buttons/links and elements inside usage-pro or row", () => {
    expect(bundle).toContain(
      "l.contains(it)||it===row||it.contains(row)||it.closest?.('[data-bb-plugin=\"usage-pro\"]')||it.querySelector?.('button,a,[role=\"button\"]')",
    );

    const strip = {
      contains: (el: any) => el.inStrip === true,
    };
    const row = {
      contains: (el: any) => el.isRowChild === true,
    };

    const isSkipped = (it: any) =>
      strip.contains(it) ||
      it === row ||
      it.contains?.(row) ||
      it.closest?.('[data-bb-plugin="usage-pro"]') ||
      it.querySelector?.('button,a,[role="button"]');

    // 1. Element inside strip
    expect(isSkipped({ inStrip: true })).toBeTruthy();
    // 2. Row itself
    expect(isSkipped(row)).toBeTruthy();
    // 3. Row ancestor
    expect(isSkipped({ contains: (el: any) => el === row })).toBeTruthy();
    // 4. Element inside usage-pro
    expect(isSkipped({ closest: (sel: string) => sel === '[data-bb-plugin="usage-pro"]' ? {} : null })).toBeTruthy();
    // 5. Container containing a button (like UL with buttons)
    expect(isSkipped({ querySelector: (sel: string) => sel.includes("button") ? {} : null })).toBeTruthy();
    // 6. Real leaf button: NOT skipped
    expect(isSkipped({
      inStrip: false,
      closest: () => null,
      querySelector: () => null,
    })).toBeFalsy();
  });
});

describe("PLUG-411 Fix 2: strip toggle and title", () => {
  const bundle = fs.readFileSync(path.join(pluginDir, "app.bundle.js"), "utf8");

  it("sets strip title to 'Лимиты всех машин — открыть/закрыть панель'", () => {
    expect(bundle).toContain('title:"Лимиты всех машин — открыть/закрыть панель"');
  });

  it("triggers usageDisclosureCtl?.toggle?.() on onClick and Enter/Space keyDown", () => {
    expect(bundle).toContain("onClick:()=>usageDisclosureCtl?.toggle?.()");
    expect(bundle).toContain('(l.key==="Enter"||l.key===" ")&&(l.preventDefault(),usageDisclosureCtl?.toggle?.())');
  });
});

describe("PLUG-411 Fix 3: panel click-outside capture listener", () => {
  const bundle = fs.readFileSync(path.join(pluginDir, "app.bundle.js"), "utf8");

  it("registers pointerdown capture listener in Qm and closes disclosure on click outside", () => {
    expect(bundle).toContain('document.addEventListener("pointerdown",h,!0)');
    expect(bundle).toContain('document.removeEventListener("pointerdown",h,!0)');

    let closed = false;
    const usageDisclosureCtl = { close: () => { closed = true; } };

    const shouldIgnoreClick = (target: any) => {
      if (!target.isConnected) return true;
      if (target.closest?.('[data-bb-plugin="usage-pro"],.usage-pro-machines-strip,[data-testid="plugin-sidebar-footer-item-usage-pro-usage"],[role="menu"],[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper]')) {
        return true;
      }
      return false;
    };

    const handleClick = (ev: { target: any }) => {
      if (shouldIgnoreClick(ev.target)) return;
      usageDisclosureCtl.close();
    };

    // Click outside: should close
    closed = false;
    handleClick({ target: { isConnected: true, closest: () => null } });
    expect(closed).toBe(true);

    // Click inside panel: should NOT close
    closed = false;
    handleClick({ target: { isConnected: true, closest: (sel: string) => sel.includes("usage-pro") ? {} : null } });
    expect(closed).toBe(false);

    // Click inside machines strip: should NOT close
    closed = false;
    handleClick({ target: { isConnected: true, closest: (sel: string) => sel.includes(".usage-pro-machines-strip") ? {} : null } });
    expect(closed).toBe(false);

    // Click inside radix popper portal or menu: should NOT close
    closed = false;
    handleClick({ target: { isConnected: true, closest: (sel: string) => sel.includes("popper") ? {} : null } });
    expect(closed).toBe(false);

    // Disconnected target: should NOT close
    closed = false;
    handleClick({ target: { isConnected: false, closest: () => null } });
    expect(closed).toBe(false);
  });
});

describe("PLUG-411 Fix 4: ClaudeKeyToggle hides switcher when available is false", () => {
  const bundle = fs.readFileSync(path.join(pluginDir, "app.bundle.js"), "utf8");

  it("bundle initializes available: false and returns null when !st.available", () => {
    expect(bundle).toContain("let[st,setSt]=G({available:false,enabled:null,busy:false,failed:false})");
    expect(bundle).toContain("if(!st.available)return null");
    expect(bundle).toContain("setSt(s=>({...s,available:false}))");
  });

  it("ClaudeKeyToggle returns null when available is false and renders when available is true", () => {
    const srcClaudeKeyToggle = extractFunctionSource(bundle, "ClaudeKeyToggle");
    const makeToggle = (stState: any) => {
      const fn = new Function(`
        const G = () => [${JSON.stringify(stState)}, () => {}];
        const J = (cb) => cb;
        const pu = () => {};
        const p = (type, props) => ({ type, props });
        const A = (type, props) => ({ type, props });
        const K = () => null;
        const w = (...args) => args.filter(Boolean).join(" ");
        const CLAUDE_KEY_HINT = "hint";
        const CLAUDE_KEY_POLL_MS = 10000;
        const claudeKeyRpc = async () => ({});
        ${srcClaudeKeyToggle}
        return ClaudeKeyToggle();
      `);
      return fn();
    };

    expect(makeToggle({ available: false, enabled: true, busy: false, failed: false })).toBeNull();
    const rendered = makeToggle({ available: true, enabled: true, busy: false, failed: false });
    expect(rendered).not.toBeNull();
    expect(rendered.type).toBe("div");
  });
});

describe("PLUG-411 review #2189: single getUsage in Vm settings", () => {
  const bundle = fs.readFileSync(path.join(pluginDir, "app.bundle.js"), "utf8");
  const srcVm = extractFunctionSource(bundle, "Vm");
  const srcConfiguredMachines = extractFunctionSource(bundle, "configuredMachines");
  const srcAllMachinesSelected = extractFunctionSource(bundle, "allMachinesSelected");

  it("calls getUsage exactly once with providerId: null for multiple providers on refresh", async () => {
    const calls: any[] = [];
    let effectCb: any = null;

    const mockRpc = {
      call: vi.fn(async (method: string, args: any) => {
        calls.push({ method, args });
        return {
          machines: [
            machine("main", [okAccount("codex", [win("5h", 50)]), okAccount("claude-code", [win("7d", 30)])]),
            machine("worker", [okAccount("codex", [win("5h", 20)]), okAccount("claude-code", [win("7d", 40)])]),
            machine("offline-box", [], "disconnected"),
          ],
        };
      }),
    };

    const ctx: any = {
      rpc: mockRpc,
      stateVal: [],
    };

    const runVm = (isRefresh = false) => {
      const fn = new Function("ctx", "isRefresh", `
        let effectCbLocal = null;
        const window = { setInterval: () => 123, clearInterval: () => {} };
        const document = { visibilityState: "visible" };
        const Cl = () => ctx.rpc;
        const G = (init) => {
          if (Array.isArray(init)) {
            return [ctx.stateVal, (next) => { ctx.stateVal = typeof next === "function" ? next(ctx.stateVal) : next; }];
          }
          let v = init;
          return [v, (next) => { v = typeof next === "function" ? next(v) : next; }];
        };
        const tu = (init) => ({ current: init });
        const pu = (cb) => { effectCbLocal = cb; };
        const p = (type, props) => ({ type, props });
        const Jm = (props) => ({ type: "Jm", props });
        const ALL_MACHINES_ID = "all";
        const Cu = { data: null };
        const tt = (machines, id) => machines.find(m => m.id === id);
        ${srcConfiguredMachines}
        ${srcAllMachinesSelected}
        ${isRefresh ? srcVm.replace("[l,d]=G(0)", "[l,d]=G(1)") : srcVm}
        Vm();
        return effectCbLocal;
      `);
      return fn(ctx, isRefresh);
    };

    // 1. Initial mount load
    const cb1 = runVm(false);
    expect(cb1).toBeDefined();
    await cb1();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("getUsage");
    expect(calls[0].args.providerId).toBeNull();
    expect(calls[0].args.force).toBe(false);

    // 2. Manual refresh with two providers (codex + claude-code)
    calls.length = 0;
    const cb2 = runVm(true);
    expect(cb2).toBeDefined();
    await cb2();
    // Crucial check: TWO providers on machines -> EXACTLY ONE request, NOT N+1!
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("getUsage");
    expect(calls[0].args.providerId).toBeNull();
    expect(calls[0].args.force).toBe(true);
    expect(calls[0].args.machineIds).toEqual(["main", "worker", "offline-box"]);
  });
});

describe("PLUG-411 audit: settings cards show stale-provider warning (Rm → Lm)", () => {
  const bundle = fs.readFileSync(path.join(pluginDir, "app.bundle.js"), "utf8");
  const srcLm = extractFunctionSource(bundle, "Lm");
  const srcRm = extractFunctionSource(bundle, "Rm");

  const renderSettingsCard = (resource: any) => {
    const fn = new Function("resource", `
      // Invoke function components (like a real renderer) so Rm → Lm nests.
      const p = (type, props, key) => typeof type === "function" ? type({ ...props, key }) : ({ type, props, key });
      const A = (type, props, key) => typeof type === "function" ? type({ ...props, key }) : ({ type, props, key });
      const At = (props) => ({ type: "At", props });
      const Nu = () => "settings-card-heading";
      const Nt = () => null;
      const Om = (props) => ({ type: "Om", props });
      ${srcLm}
      ${srcRm}
      return Rm({
        config: { name: "Codex", providerId: "codex", signInHint: "sign in", expiredHint: "expired", provider: { id: "codex" } },
        resources: [resource],
        isLoading: false,
        isError: false,
      });
    `);
    return fn(resource);
  };

  const findAmber = (node: any): any[] => {
    const hits: any[] = [];
    const walk = (n: any) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.props) {
        if (typeof n.props.className === "string" && n.props.className.includes("text-amber-500")) hits.push(n);
        walk(n.props.children);
      }
    };
    walk(node);
    return hits;
  };

  it("renders the amber stale warning above the windows list", () => {
    const out = renderSettingsCard({
      id: "res-1",
      providerId: "codex",
      warning: "Данные устарели",
      usage: { status: "ok", accountEmail: null, planLabel: "Team", windows: [{ label: "Weekly limit", usedPercent: 15, resetsAt: null, cost: null }] },
    });
    const amber = findAmber(out);
    expect(amber).toHaveLength(1);
    expect(amber[0].props.children).toBe("Данные устарели");
  });

  it("renders the warning also when the card has no windows", () => {
    const out = renderSettingsCard({
      id: "res-1",
      providerId: "codex",
      warning: "Данные устарели",
      usage: { status: "ok", accountEmail: null, planLabel: "Team", windows: [] },
    });
    const amber = findAmber(out);
    expect(amber).toHaveLength(1);
    expect(amber[0].props.children).toBe("Данные устарели");
  });

  it("a healthy card renders no warning paragraph", () => {
    const out = renderSettingsCard({
      id: "res-1",
      providerId: "codex",
      warning: null,
      usage: { status: "ok", accountEmail: null, planLabel: "Team", windows: [{ label: "Weekly limit", usedPercent: 15, resetsAt: null, cost: null }] },
    });
    expect(findAmber(out)).toHaveLength(0);
  });

  it("Rm forwards resource warning into Lm", () => {
    // The call site must pass warning — regression guard for the audit blocker.
    expect(srcRm).toContain("warning:u.warning??null");
  });
});

describe("PLUG-411 audit: failed source rows in the all-machines popover", () => {
  const bundle = fs.readFileSync(path.join(pluginDir, "app.bundle.js"), "utf8");

  const loadFailedSourceMachines = () => {
    const src = extractFunctionSource(bundle, "failedSourceMachines");
    return new Function(`${src}; return failedSourceMachines;`)() as (m: any) => any[];
  };

  it("selects only source: machines that carry an error", () => {
    const failedSourceMachines = loadFailedSourceMachines();
    const failedSource = machine("source:pool", [], "connected", {
      displayName: "Pool",
      error: "Pool: Usage resources could not be listed.",
    });
    const okSource = machine("source:native", [], "connected", { displayName: "Native" });
    const erroredHost = machine("worker", [], "connected", { error: "collect failed" });
    const healthy = machine("main", []);
    expect(failedSourceMachines([healthy, okSource, erroredHost, failedSource])).toEqual([failedSource]);
    expect(failedSourceMachines([healthy, erroredHost])).toEqual([]);
    expect(failedSourceMachines([])).toEqual([]);
    expect(failedSourceMachines(null)).toEqual([]);
  });

  const renderPopover = (opts: {
    machines: any[];
    selectedTab?: string | null;
    isRefreshing?: boolean;
    error?: any;
  }) => {
    const srcYm = extractFunctionSource(bundle, "Ym");
    const srcConfiguredMachines = extractFunctionSource(bundle, "configuredMachines");
    const srcAllMachinesSelected = extractFunctionSource(bundle, "allMachinesSelected");
    const srcProviderTabsFor = extractFunctionSource(bundle, "providerTabsFor");
    const srcFailedSourceMachines = extractFunctionSource(bundle, "failedSourceMachines");
    const srcFreestMachine = extractFunctionSource(bundle, "freestMachine");
    const srcOfflineMachineText = extractFunctionSource(bundle, "offlineMachineText");
    const srcFormatWindowLabel = extractFunctionSource(bundle, "formatWindowLabel");
    const srcSortUsageWindows = extractFunctionSource(bundle, "sortUsageWindows");
    const srcMachineWorstPct = extractFunctionSource(bundle, "machineWorstPct");
    const srcAccountRotationWindows = extractFunctionSource(bundle, "accountRotationWindows");

    const fn = new Function("opts", `
      let selectedTabId = opts.selectedTab ?? null;
      let kt = "all";
      const ALL_MACHINES_ID = "all";
      const W = { refreshFailed: "refreshFailed", loadFailed: "loadFailed", loading: "loading", noSources: "noSources" };
      const Ft = 120000;
      const c0 = (arr) => Array.isArray(arr) && arr.length > 0;
      const T4 = (d, U) => "disconnected";
      const P4 = (d) => "no-provider";
      const Nu = () => "test-id";
      const p0 = () => {};
      const J = (fn) => fn;
      const G = (init) => [init, () => {}];
      const pu = () => {};
      const Ou = (fn) => fn();
      const useHideClaude = () => [false, () => {}];
      const tt = (machines, id) => machines?.find(m => m.id === id);
      const w = (...args) => args.filter(Boolean).join(" ");
      const Nm = (acc) => null;
      const Nt = (props) => ({ type: "Nt", props });
      const Hm = (props) => ({ type: "Hm", props });
      const K = (props) => ({ type: "Icon", props });
      const M4 = (props) => ({ type: "M4", props });
      const MachineSectionAll = (props) => ({ type: "MachineSectionAll", props });
      const MachineSectionHeader = (props) => ({ type: "MachineSectionHeader", props });
      const UsageAccountCard = (props) => ({ type: "UsageAccountCard", props });
      const ClaudeKeyToggle = () => ({ type: "ClaudeKeyToggle" });
      const jt = "Fragment";
      const p = (type, props, key) => typeof type === "function" ? type({ ...props, key }) : ({ type, props: { ...props, key } });
      const A = (type, props, key) => typeof type === "function" ? type({ ...props, key }) : ({ type, props: { ...props, key } });

      ${srcFormatWindowLabel}
      ${srcSortUsageWindows}
      ${srcAccountRotationWindows}
      ${srcMachineWorstPct}
      ${srcFreestMachine}
      ${srcConfiguredMachines}
      ${srcAllMachinesSelected}
      ${srcProviderTabsFor}
      ${srcFailedSourceMachines}
      ${srcOfflineMachineText}
      ${srcYm}

      const snapshot = {
        data: { machines: opts.machines },
        isRefreshing: opts.isRefreshing ?? false,
        error: opts.error ?? null,
      };

      return Ym({
        dismiss: () => {},
        snapshot,
        threadMachineId: "main",
        refreshEnabled: false,
      });
    `);
    return fn(opts);
  };

  const findNodes = (node: any, predicate: (n: any) => boolean): any[] => {
    const hits: any[] = [];
    const walk = (n: any) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (predicate(n)) hits.push(n);
      if (n.props && n.props.children) walk(n.props.children);
    };
    walk(node);
    return hits;
  };

  it("renders failed source rows when provider tabs are present (g !== null) with no double prefix and healthy sections intact", () => {
    const machines = [
      machine("main", [okAccount("codex", [win("5h", 10)])], "connected", { displayName: "Main" }),
      machine("worker", [okAccount("codex", [win("5h", 20)])], "connected", { displayName: "Worker" }),
      machine("source:pool", [], "connected", {
        displayName: "Pool",
        error: "Pool: Connection failed",
      }),
      machine("source:argon", [], "connected", {
        displayName: "Argon",
        error: "Daemon timeout",
      }),
    ];

    const out = renderPopover({ machines });
    const errorRows = findNodes(out, (n) => n.type === "M4");
    expect(errorRows).toHaveLength(2);
    // Single prefix (no "Pool: Pool: Connection failed")
    expect(errorRows[0].props.message).toBe("Pool: Connection failed");
    // Prepended displayName if prefix was absent
    expect(errorRows[1].props.message).toBe("Argon: Daemon timeout");

    // Healthy machine sections are still rendered underneath
    const machineSections = findNodes(out, (n) => n.type === "MachineSectionAll");
    expect(machineSections).toHaveLength(4);
    expect(machineSections[0].props.machine.id).toBe("main");
    expect(machineSections[1].props.machine.id).toBe("worker");
  });

  it("renders failed source rows when no provider tabs are available (g === null)", () => {
    const machines = [
      machine("main", [], "connected", { displayName: "Main" }),
      machine("worker", [], "connected", { displayName: "Worker" }),
      machine("source:pool", [], "connected", {
        displayName: "Pool",
        error: "Pool: All upstream gateways down",
      }),
    ];

    const out = renderPopover({ machines });
    const errorRows = findNodes(out, (n) => n.type === "M4");
    expect(errorRows).toHaveLength(1);
    expect(errorRows[0].props.message).toBe("Pool: All upstream gateways down");

    // Fallback empty text is rendered alongside failed source rows
    const emptyNotes = findNodes(out, (n) => n.type === "p" && n.props?.children === "noSources");
    expect(emptyNotes).toHaveLength(1);
  });
});
