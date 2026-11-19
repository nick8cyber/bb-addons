import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as z from "zod";
import { providerUsageRpcContract } from "./dist/provider-usage-base.js";

const pluginDir = path.dirname(new URL(import.meta.url).pathname);

// The panel schema lives inside the checked-in app.bundle.js (rebuilt into
// dist/app.js). It is not importable — the bundle throws without
// globalThis.__bbPluginRuntime — so we evaluate the single `var` statement
// that declares the zod schemas with the real zod namespace bound to the
// bundle's minified alias.
function loadInterfaceUsageUnion(): z.ZodType {
  const bundle = fs.readFileSync(path.join(pluginDir, "app.bundle.js"), "utf8");
  const decl = /(?:var |,)([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.discriminatedUnion\("status"/.exec(bundle);
  if (!decl) throw new Error('cannot locate discriminatedUnion("status") in app.bundle.js');
  const [, unionName, zodAlias] = decl;
  const varStart = bundle.lastIndexOf("var ", decl.index);
  if (varStart < 0) throw new Error("cannot locate the schema var statement in app.bundle.js");
  let depth = 0;
  let end = -1;
  let quote = "";
  let escaped = false;
  for (let i = varStart; i < bundle.length; i += 1) {
    const c = bundle[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === ";" && depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error("schema var statement is not terminated in app.bundle.js");
  const statement = bundle.slice(varStart, end);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const build = new Function(zodAlias, `${statement}; return ${unionName};`);
  return build(z) as z.ZodType;
}

const defOf = (schema: z.ZodType) => (schema as unknown as { _zod: { def: any } })._zod.def;

function okBranchKeys(union: z.ZodType): string[] {
  const options = defOf(union).options as z.ZodType[];
  const ok = options.find((o) => "accountEmail" in defOf(o).shape);
  if (!ok) throw new Error('the "ok" branch (with accountEmail) is missing from the union');
  return Object.keys(defOf(ok).shape).sort();
}

// Server side: providerUsageRpcContract.getUsage.output — strictObject
// { machines } → array element → strictObject machine → providers array →
// strictObject provider → nullable usage union.
function serverUsageUnion(): z.ZodType {
  const output = (providerUsageRpcContract as any).getUsage.output as z.ZodType;
  const machine = defOf(defOf(output).shape.machines).element as z.ZodType;
  const provider = defOf(defOf(machine).shape.providers).element as z.ZodType;
  return defOf(defOf(provider).shape.usage).innerType as z.ZodType;
}

describe("PLUG-328 usage panel schema parity", () => {
  const usageUnion = loadInterfaceUsageUnion();
  const okCard = {
    status: "ok",
    accountEmail: "ops@example.com",
    planLabel: "Pro",
    install: null,
    windows: [],
  };

  it("accepts an ok card carrying install:null", () => {
    expect(usageUnion.safeParse(okCard).success).toBe(true);
  });

  it("accepts an ok card without install and with an install name", () => {
    const { install: _install, ...withoutInstall } = okCard;
    expect(usageUnion.safeParse(withoutInstall).success).toBe(true);
    expect(usageUnion.safeParse({ ...okCard, install: "agn-personal" }).success).toBe(true);
  });

  it('keeps the "ok" branch key set identical to the server contract', () => {
    expect(okBranchKeys(usageUnion)).toEqual(okBranchKeys(serverUsageUnion()));
  });
});
