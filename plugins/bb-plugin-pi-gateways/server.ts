/**
 * bb-plugin-pi-gateways — server entry.
 *
 * Thin: it owns the `bb pi-gateways` command surface and the RPC surface the
 * settings UI calls, forwarding all work to the host entry, which is where the
 * credential stores and models.json live.
 */
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  API_KINDS,
  contractSchemas,
  rpcSchemas,
  type ApiKind,
} from "./src/contract.js";
import {
  SAVED_PROVIDER_PRESETS,
  findSavedProviderPreset,
} from "./src/presets.js";

const gatewayReport = contractSchemas.status.output.shape.gateways.element;

/** The host contract, mirrored: the client is typed against exactly these methods. */
const hostContract = contractSchemas;

export const rpcContract = defineRpcContract(rpcSchemas);

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });

  /**
   * Resolve the host to act on. With one machine enrolled this is unambiguous;
   * with several, an explicit id wins, then --host / the UI picker, otherwise
   * a single enrolled host is used — models.json is per-machine, so guessing
   * among many would be wrong.
   */
  const resolveHost = async (requested?: string): Promise<string> => {
    const hosts = await bb.sdk.hosts.list();
    if (hosts.length === 0) throw new Error("no host is enrolled with this bb server");
    if (requested) {
      const match = hosts.find((h) => h.id === requested || h.name === requested);
      if (!match) throw new Error(`no host called ${requested}`);
      return match.id;
    }
    if (hosts.length === 1) return hosts[0]!.id;
    const names = hosts.map((h) => `${h.name} (${h.id})`).join(", ");
    throw new Error(`several hosts are enrolled, pass --host or pick one in settings: ${names}`);
  };

  const call = async <M extends keyof typeof hostContract & string>(
    method: M,
    input: unknown,
    hostName?: string,
  ) => {
    const hostId = await resolveHost(hostName);
    return await host.call(method, input as never, { hostId });
  };

  bb.rpc.register(rpcContract, {
    status: async ({ host }) => call("status", {}, host),
    refresh: async ({ host, ...rest }) => call("refresh", rest, host),
    remove: async ({ host }) => call("remove", {}, host),
    reservedIds: async ({ host }) => call("reservedIds", {}, host),
    probe: async ({ host, ...rest }) => call("probe", rest, host),
    saveCustom: async ({ host, ...rest }) => call("saveCustom", rest, host),
    refreshCustom: async ({ host, ...rest }) => call("refreshCustom", rest, host),
    deleteCustom: async ({ host, ...rest }) => call("deleteCustom", rest, host),
    listCustom: async ({ host }) => call("listCustom", {}, host),
    listProviders: async ({ host }) => call("listProviders", {}, host),
    providerDetail: async ({ host, ...rest }) => call("providerDetail", rest, host),
    adopt: async ({ host, ...rest }) => call("adopt", rest, host),
    disown: async ({ host, ...rest }) => call("disown", rest, host),
    updateCustom: async ({ host, ...rest }) => call("updateCustom", rest, host),
    deleteProvider: async ({ host, ...rest }) => call("deleteProvider", rest, host),
    hosts: async () => {
      const list = await bb.sdk.hosts.list();
      return { hosts: list.map((h) => ({ id: h.id, name: h.name })) };
    },
  });

  const flag = (argv: readonly string[], name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const hasFlag = (argv: readonly string[], name: string): boolean => argv.includes(`--${name}`);

  function parseKeySource(
    argv: readonly string[],
    defaultEnv?: string,
  ): { type: "file"; path: string } | { type: "env"; name: string } | { type: "command"; command: string } {
    const file = flag(argv, "key-file");
    const env = flag(argv, "key-env");
    const command = flag(argv, "key-command");
    const given = [file, env, command].filter((v) => v !== undefined).length;
    if (given === 0 && defaultEnv) return { type: "env", name: defaultEnv };
    if (given !== 1) {
      throw new Error("give exactly one key source: --key-file <path> | --key-env <NAME> | --key-command '<cmd>'");
    }
    if (file !== undefined) return { type: "file", path: file };
    if (env !== undefined) return { type: "env", name: env };
    return { type: "command", command: command! };
  }

  /** Like parseKeySource, but "no key flags at all" is a legitimate answer. */
  function parseOptionalKeySource(argv: readonly string[]) {
    const file = flag(argv, "key-file");
    const env = flag(argv, "key-env");
    const command = flag(argv, "key-command");
    const given = [file, env, command].filter((v) => v !== undefined).length;
    if (given === 0) return undefined;
    if (given > 1) {
      throw new Error("give at most one key source: --key-file <path> | --key-env <NAME> | --key-command '<cmd>'");
    }
    if (file !== undefined) return { type: "file" as const, path: file };
    if (env !== undefined) return { type: "env" as const, name: env };
    return { type: "command" as const, command: command! };
  }

  const parseApi = (value: string): ApiKind => {
    if (!API_KINDS.includes(value as ApiKind)) {
      throw new Error(`--api must be one of: ${API_KINDS.join(", ")}`);
    }
    return value as ApiKind;
  };

  const presetFrom = (argv: readonly string[]) => {
    const id = flag(argv, "preset");
    const preset = findSavedProviderPreset(id);
    if (id && !preset) {
      throw new Error(`unknown preset "${id}"; run \`bb pi-gateways presets\``);
    }
    return preset;
  };

  /** Existing pi bridge workers keep the catalogue they loaded at startup. */
  const CATALOG_NOTICE = [
    "",
    "pi bridge workers load models.json when they start; an already-running",
    "worker keeps its current catalogue until it exits. The safe immediate",
    "fallback is to restart bb only when no pi turn is running:",
    "  systemctl --user restart bb.service",
    "",
  ];

  const renderReports = (
    reports: readonly z.infer<typeof gatewayReport>[],
    lines: string[],
  ): void => {
    for (const report of reports) {
      if (report.error) {
        lines.push(`  ${report.label.padEnd(14)} — ${report.error}`);
        continue;
      }
      const state = report.inModelsJson ? "configured" : "credential found, not configured";
      lines.push(`  ${report.label.padEnd(14)} ${String(report.modelCount).padStart(3)} models · ${state}`);
    }
  };

  const USAGE = [
    "Usage: bb pi-gateways <command>",
    "",
    "  status              show what is detected and what is in models.json",
    "  refresh [--only ID] re-read the built-in catalogues and write the entries",
    "  remove              delete only this plugin's built-in entries",
    "",
    "  presets             list ready-to-use provider presets",
    "  list [--json]       built-in gateways plus every user-defined endpoint",
    "  add                 save a preset or custom endpoint (see options below)",
    `        [--preset NAME]    ${SAVED_PROVIDER_PRESETS.map((preset) => preset.id).join(" | ")}`,
    "                           fills connection defaults; provider key is automatic",
    "        [--name NAME]      display name (preset supplies it when omitted)",
    "        [--base-url URL]   API root (preset supplies it when omitted)",
    `        [--api KIND]       ${API_KINDS.join(" | ")}`,
    "        --key-file PATH    read the token from a file at request time",
    "        --key-env NAME     ...or take it from this environment variable",
    "        --key-command CMD  ...or run this command and use its stdout",
    "        [--paid]           include paid models (default: zero-priced only)",
    "        [--models LIST]    comma-separated model ids to pin explicitly",
    "                           required when catalogue pricing is not guaranteed",
    "  test                probe a preset or endpoint without saving anything:",
    "        --preset NAME, or --base-url URL --api KIND; key options match `add`",
    "  show <id>           full detail for one provider, managed or not",
    "  adopt <id>          manage a provider that already exists in models.json",
    "        [--key-env N | --key-file P | --key-command C]",
    "                           migrate a literal key to a reference while adopting;",
    "                           without a key flag the key stays where it is",
    "        [--confirm-mismatch] accept that the new source resolves to another token",
    "        [--preset NAME]    inherit pricing rules from a preset with the same base URL",
    "  disown <id>         stop managing it, leaving models.json untouched",
    "  edit <id>           change a managed provider",
    "        [--name N] [--base-url URL] [--models a,b,c] [--paid | --free-only]",
    "        [--key-env|--key-file|--key-command ...] [--confirm-mismatch]",
    "        [--allow-unverified-models] [--accept-drift]",
    "  delete <id>         remove a provider from models.json",
    "        [--force]          required for blocks this plugin does not manage",
    "        [--disown]         adopted blocks: forget them instead of deleting",
    "  refresh-endpoints   re-read catalogues of managed providers",
    "        [--only ID] [--accept-drift]",
    "",
    "  --host <id|name>    machine to act on (needed only with several enrolled)",
    "",
  ].join("\n");

  bb.cli.register({
    name: "pi-gateways",
    summary:
      "Offer Google AI Studio, TokenRouter, OpenRouter, NVIDIA Build, OpenCode Zen, Kilo Code and custom endpoints through pi",
    commands: [
      { name: "presets", summary: "List ready-to-use provider presets", usage: "bb pi-gateways presets" },
      { name: "test", summary: "Discover models and run a smoke test", usage: "bb pi-gateways test [--preset NAME | --base-url URL --api KIND] [--key-* ...]" },
      { name: "add", summary: "Save a preset or custom provider", usage: "bb pi-gateways add [--preset NAME] [--models id1,id2] [--key-* ...]" },
      { name: "list", summary: "List configured gateways", usage: "bb pi-gateways list [--json]" },
      { name: "refresh", summary: "Refresh saved catalogues", usage: "bb pi-gateways refresh [--only ID]" },
      { name: "show", summary: "Show one provider in detail", usage: "bb pi-gateways show <id>" },
      { name: "adopt", summary: "Manage an existing models.json provider", usage: "bb pi-gateways adopt <id> [--key-env NAME]" },
      { name: "disown", summary: "Stop managing a provider", usage: "bb pi-gateways disown <id>" },
      { name: "edit", summary: "Edit a managed provider", usage: "bb pi-gateways edit <id> [--name N] [--models a,b]" },
      { name: "delete", summary: "Delete a provider from models.json", usage: "bb pi-gateways delete <id> [--force]" },
      { name: "refresh-endpoints", summary: "Refresh managed providers", usage: "bb pi-gateways refresh-endpoints [--only ID] [--accept-drift]" },
    ],
    async run(argv) {
      const command = argv[0] ?? "status";
      const host = flag(argv, "host");
      try {
        if (command === "help" || command === "--help" || command === "-h") {
          return { exitCode: 0, stdout: USAGE };
        }

        if (command === "status") {
          const data = await call("status", {}, host);
          const lines = [`models.json: ${data.modelsJsonPath}`];
          renderReports(data.gateways, lines);
          lines.push("", "Run `bb pi-gateways refresh` to write or update the entries.", "");
          return { exitCode: 0, stdout: lines.join("\n") };
        }

        if (command === "refresh") {
          const only = flag(argv, "only");
          const data = await call("refresh", { only: only ? [only] : undefined }, host);
          const lines: string[] = [];
          renderReports(data.gateways, lines);
          if (data.backupPath) lines.push("", `previous file kept at ${data.backupPath}`);
          lines.push(...CATALOG_NOTICE);
          const failed = data.gateways.every((report: z.infer<typeof gatewayReport>) => report.error);
          return { exitCode: failed ? 1 : 0, stdout: lines.join("\n") };
        }

        if (command === "remove") {
          const data = await call("remove", {}, host);
          if (data.removed.length === 0) {
            return { exitCode: 0, stdout: "nothing of ours was in models.json\n" };
          }
          const kept = data.backupPath ? `\nprevious file kept at ${data.backupPath}` : "";
          return { exitCode: 0, stdout: `removed: ${data.removed.join(", ")}${kept}\n` };
        }

        if (command === "presets") {
          const lines = ["Saved-provider presets:"];
          for (const preset of SAVED_PROVIDER_PRESETS) {
            lines.push(`  ${preset.id.padEnd(18)} ${preset.name}`);
            lines.push(`    ${preset.description}`);
            lines.push(`    default key variable: ${preset.keyEnv}`);
            if (preset.pricing === "unknown") {
              lines.push("    prices: not provided; explicit --models selection is required");
            } else {
              lines.push("    prices: read from the OpenAI-compatible catalogue; unpriced models are not free");
            }
          }
          lines.push("", "OpenCode Zen and Kilo Code remain managed built-ins.", "");
          return { exitCode: 0, stdout: lines.join("\n") };
        }

        if (command === "list") {
          const data = await call("listProviders", {}, host);
          if (hasFlag(argv, "json")) {
            return {
              exitCode: 0,
              stdout: `${JSON.stringify({ modelsJsonPath: data.modelsJsonPath, providers: data.providers }, null, 2)}\n`,
            };
          }
          const lines = [`models.json: ${data.modelsJsonPath}`];
          if (!data.reservedComplete) {
            lines.push("warning: pi's bundled catalogue was not found; adopting and adding are refused until it is");
          }
          const groups: Array<[string, readonly string[]]> = [
            ["Built-in", ["builtin"]],
            ["Managed", ["owned", "adopted", "orphaned"]],
            ["Unmanaged", ["foreign", "reserved"]],
          ];
          for (const [title, states] of groups) {
            const rows = data.providers.filter((row) => states.includes(row.ownership));
            if (rows.length === 0) continue;
            lines.push("", `${title}:`);
            for (const row of rows) {
              const flags = [
                row.ownership,
                row.drifted ? "DRIFTED" : undefined,
                row.inModelsJson ? undefined : "not in models.json",
                row.apiSupported ? undefined : "unsupported api",
              ].filter(Boolean).join(" · ");
              lines.push(`  ${row.id.padEnd(22)} ${String(row.modelCount).padStart(3)} models · ${flags}`);
              lines.push(`    ${row.baseUrl ?? "(no base URL)"} · key: ${row.keyRefDisplay}`);
              if (row.error) lines.push(`    ${row.error}`);
              for (const warning of row.warnings) lines.push(`    note: ${warning}`);
            }
          }
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }

        if (command === "show") {
          const id = argv[1];
          if (!id || id.startsWith("--")) throw new Error("usage: bb pi-gateways show <id>");
          const data = await call("providerDetail", { id }, host);
          const row = data.row;
          const lines = [
            `${row.id}${row.name && row.name !== row.id ? ` — ${row.name}` : ""}`,
            `  ownership     ${row.ownership}${row.drifted ? " (changed outside the plugin)" : ""}`,
            `  base URL      ${row.baseUrl ?? "(none)"}`,
            `  api           ${row.api ?? "(none)"}${row.apiSupported ? "" : " — unsupported by this plugin"}`,
            `  key           ${row.keyRefDisplay} (${row.keyRefKind})`,
            `  models        ${row.modelCount}`,
          ];
          if (data.headerNames.length > 0) {
            lines.push(`  headers       ${data.headerNames.join(", ")} (values never leave the host)`);
          }
          if (data.manifest) {
            lines.push(
              `  recorded as   ${data.manifest.origin}, key source ${data.manifest.keySource.type}`,
            );
            if (data.manifest.adoptedAt) lines.push(`  adopted       ${data.manifest.adoptedAt}`);
            if (data.manifest.updatedAt) lines.push(`  last written  ${data.manifest.updatedAt}`);
          }
          if (row.error) lines.push(`  problem       ${row.error}`);
          for (const warning of row.warnings) lines.push(`  note          ${warning}`);
          if (data.models.length > 0) {
            lines.push("  model ids:");
            for (const model of data.models) lines.push(`    ${model.id}`);
          }
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }

        if (command === "adopt") {
          const id = argv[1];
          if (!id || id.startsWith("--")) throw new Error("usage: bb pi-gateways adopt <id> [--key-env NAME]");
          const preset = presetFrom(argv);
          const data = await call(
            "adopt",
            {
              id,
              keyMigration: parseOptionalKeySource(argv),
              confirmMismatch: hasFlag(argv, "confirm-mismatch"),
              linkPresetId: preset?.id,
            },
            host,
          );
          const lines = [
            `adopted "${data.id}" with ${data.modelCount} models (key: ${data.keyRefKind}${data.inPlaceKey ? ", left in models.json" : ""})`,
          ];
          if (data.backupPath) lines.push(`previous file kept at ${data.backupPath}`);
          for (const warning of data.warnings) lines.push(`warning: ${warning}`);
          if (!data.apiSupported) lines.push("this provider can be renamed or deleted, but not probed or refreshed");
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }

        if (command === "disown") {
          const id = argv[1];
          if (!id || id.startsWith("--")) throw new Error("usage: bb pi-gateways disown <id>");
          const data = await call("disown", { id }, host);
          return {
            exitCode: 0,
            stdout: data.forgotten
              ? `"${data.id}" is no longer managed; its models.json block was left untouched\n`
              : `"${data.id}" was not managed by this plugin\n`,
          };
        }

        if (command === "edit") {
          const id = argv[1];
          if (!id || id.startsWith("--")) throw new Error("usage: bb pi-gateways edit <id> [--name N] [--models a,b]");
          const modelsArg = flag(argv, "models");
          const paid = hasFlag(argv, "paid");
          const freeOnly = hasFlag(argv, "free-only");
          if (paid && freeOnly) throw new Error("--paid and --free-only contradict each other");
          const data = await call(
            "updateCustom",
            {
              id,
              name: flag(argv, "name"),
              baseUrl: flag(argv, "base-url"),
              keySource: parseOptionalKeySource(argv),
              confirmMismatch: hasFlag(argv, "confirm-mismatch"),
              freeOnly: paid ? false : freeOnly ? true : undefined,
              selectionMode: modelsArg ? ("explicit" as const) : undefined,
              selectedModelIds: modelsArg
                ? modelsArg.split(",").map((m) => m.trim()).filter(Boolean)
                : undefined,
              allowUnverifiedModels: hasFlag(argv, "allow-unverified-models") ? true : undefined,
              acceptDrift: hasFlag(argv, "accept-drift") ? true : undefined,
            },
            host,
          );
          const lines = [`updated "${data.id}": ${data.modelCount} models in ${data.modelsJsonPath}`];
          if (data.backupPath) lines.push(`previous file kept at ${data.backupPath}`);
          if (data.warning) lines.push(`warning: ${data.warning}`);
          lines.push(...CATALOG_NOTICE);
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }

        if (command === "refresh-endpoints") {
          const only = flag(argv, "only");
          const ids = only ? [only] : undefined;
          const data = await call(
            "refreshCustom",
            {
              ids,
              acceptDrift: hasFlag(argv, "accept-drift") ? (ids ?? []) : undefined,
            },
            host,
          );
          const lines: string[] = [];
          if (data.results.length === 0) lines.push("no managed providers to refresh");
          for (const result of data.results) {
            if (result.ok) {
              lines.push(`  ${result.id.padEnd(22)} ${String(result.modelCount ?? 0).padStart(3)} models`);
              if (result.warning) lines.push(`    note: ${result.warning}`);
            } else {
              lines.push(`  ${result.id.padEnd(22)} — ${result.error}`);
            }
          }
          if (data.backupPath) lines.push("", `previous file kept at ${data.backupPath}`);
          lines.push(...CATALOG_NOTICE);
          const failed = data.results.length > 0 && data.results.every((result) => !result.ok);
          return { exitCode: failed ? 1 : 0, stdout: `${lines.join("\n")}\n` };
        }

        if (command === "test") {
          const preset = presetFrom(argv);
          const baseUrl = flag(argv, "base-url") ?? preset?.baseUrl;
          const api = parseApi(flag(argv, "api") ?? preset?.api ?? "openai-completions");
          if (!baseUrl) throw new Error("--base-url is required");
          const result = await call(
            "probe",
            {
              baseUrl,
              api,
              presetId: preset?.id,
              keySource: parseKeySource(argv, preset?.keyEnv),
            },
            host,
          );
          if (!result.ok) return { exitCode: 1, stderr: `probe failed: ${result.error}\n` };
          const requiresExplicitModels = preset?.requiresExplicitModels ?? api === "google-generative-ai";
          const pricingNotGuaranteed = preset?.pricing === "unknown" || api === "google-generative-ai";
          const lines = [
            pricingNotGuaranteed
              ? `HTTP ${result.httpStatus} · ${result.totalCount} compatible models · catalogue pricing not guaranteed`
              : `HTTP ${result.httpStatus} · ${result.totalCount} models · ${result.freeCount} free`,
          ];
          if (result.sampleCall) {
            lines.push(
              result.sampleCall.ok
                ? `live call OK (${result.sampleCall.status})`
                : `live call FAILED${result.sampleCall.status ? ` (${result.sampleCall.status})` : ""}: ${(result.sampleCall.error ?? "").slice(0, 200)}`,
            );
          } else {
            lines.push(requiresExplicitModels ? "no compatible model to live-test against" : "no free model to live-test against");
          }
          for (const model of result.models.filter((item) => requiresExplicitModels || item.free)) {
            lines.push(`  ${!model.priceKnown ? "unknown" : model.free ? "free" : "paid"}  ${model.id}`);
          }
          return { exitCode: result.sampleCall?.ok === false ? 1 : 0, stdout: `${lines.join("\n")}\n` };
        }

        if (command === "add") {
          const preset = presetFrom(argv);
          const name = flag(argv, "name") ?? preset?.name;
          const baseUrl = flag(argv, "base-url") ?? preset?.baseUrl;
          const api = parseApi(flag(argv, "api") ?? preset?.api ?? "openai-completions");
          if (!name || !baseUrl) {
            throw new Error("--name and --base-url are required without --preset");
          }
          const paid = hasFlag(argv, "paid");
          const modelsArg = flag(argv, "models");
          const requiresExplicitModels = preset?.requiresExplicitModels ?? api === "google-generative-ai";
          if (requiresExplicitModels && !modelsArg) {
            throw new Error(`${preset?.name ?? "This endpoint"} does not guarantee catalogue pricing; pass --models with the model ids you explicitly chose`);
          }
          const data = await call(
            "saveCustom",
            {
              presetId: preset?.id,
              name,
              baseUrl,
              api,
              keySource: parseKeySource(argv, preset?.keyEnv),
              freeOnly: requiresExplicitModels ? false : !paid,
              selectionMode: modelsArg ? ("explicit" as const) : ("all-free" as const),
              selectedModelIds: modelsArg
                ? modelsArg.split(",").map((m) => m.trim()).filter(Boolean)
                : undefined,
            },
            host,
          );
          const lines = [`saved "${data.id}" with ${data.modelCount} models into ${data.modelsJsonPath}`];
          if (data.backupPath) lines.push(`previous file kept at ${data.backupPath}`);
          if (data.warning) lines.push(`warning: ${data.warning}`);
          lines.push(...CATALOG_NOTICE);
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }

        if (command === "delete") {
          const id = argv[1];
          if (!id || id.startsWith("--")) throw new Error("usage: bb pi-gateways delete <id> [--force] [--disown]");
          const data = await call(
            "deleteProvider",
            {
              id,
              force: hasFlag(argv, "force") ? true : undefined,
              disownOnly: hasFlag(argv, "disown") ? true : undefined,
            },
            host,
          );
          if (data.disowned) {
            return { exitCode: 0, stdout: `"${id}" is no longer managed; its models.json block was left untouched\n` };
          }
          if (data.removed.length === 0) {
            return { exitCode: 0, stdout: `"${id}" was not in models.json (forgotten)\n` };
          }
          const kept = data.backupPath ? `\nprevious file kept at ${data.backupPath}` : "";
          return { exitCode: 0, stdout: `removed: ${data.removed.join(", ")}${kept}\n` };
        }

        return { exitCode: 1, stderr: `unknown command ${command}\n\n${USAGE}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { exitCode: 1, stderr: `${message}\n` };
      }
    },
  });

  bb.log.info("pi-gateways ready: bb pi-gateways status");
}
