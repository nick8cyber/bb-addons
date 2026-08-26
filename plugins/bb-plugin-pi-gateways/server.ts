/**
 * bb-plugin-pi-gateways — server entry.
 *
 * Thin: it owns the `bb pi-gateways` command surface and the RPC surface the
 * settings UI calls, forwarding all work to the host entry, which is where the
 * credential stores and models.json live.
 */
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { contractSchemas, rpcSchemas } from "./src/contract.js";

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
    reservedIds: async ({ host }) => call("reservedIds", {}, host),
    probe: async ({ host, ...rest }) => call("probe", rest, host),
    saveCustom: async ({ host, ...rest }) => call("saveCustom", rest, host),
    refreshCustom: async ({ host, ...rest }) => call("refreshCustom", rest, host),
    deleteCustom: async ({ host, ...rest }) => call("deleteCustom", rest, host),
    listCustom: async ({ host }) => call("listCustom", {}, host),
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

  function parseKeySource(argv: readonly string[]): { type: "file"; path: string } | { type: "env"; name: string } | { type: "command"; command: string } {
    const file = flag(argv, "key-file");
    const env = flag(argv, "key-env");
    const command = flag(argv, "key-command");
    const given = [file, env, command].filter((v) => v !== undefined).length;
    if (given !== 1) {
      throw new Error("give exactly one key source: --key-file <path> | --key-env <NAME> | --key-command '<cmd>'");
    }
    if (file !== undefined) return { type: "file", path: file };
    if (env !== undefined) return { type: "env", name: env };
    return { type: "command", command: command! };
  }

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
    "  list [--json]       built-in gateways plus every user-defined endpoint",
    "  add                 save a user-defined endpoint (see options below)",
    "        --id ID            provider id, lowercase slug; must not collide with",
    "                           ids pi already ships or blocks owned by others",
    "        --name NAME        display name",
    "        --base-url URL     API root without routes, e.g. https://example.com/v1",
    "        --api KIND         openai-completions | openai-responses | anthropic-messages",
    "        --key-file PATH    read the token from a file at request time",
    "        --key-env NAME     ...or take it from this environment variable",
    "        --key-command CMD  ...or run this command and use its stdout",
    "        [--paid]           include paid models (default: zero-priced only)",
    "        [--models LIST]    comma-separated model ids to pin explicitly",
    "  test                probe an endpoint without saving anything:",
    "        --base-url URL --api KIND and one --key-* option as in `add`",
    "  delete <id>         remove a user-defined endpoint",
    "",
    "  --host <id|name>    machine to act on (needed only with several enrolled)",
    "",
  ].join("\n");

  bb.cli.register({
    name: "pi-gateways",
    summary:
      "Offer OpenCode Zen, Kilo Code and any OpenAI-compatible endpoint through the pi provider, by token, without running their CLIs",
    async run(argv) {
      const command = argv[0] ?? "status";
      const host = flag(argv, "host");
      try {
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

        if (command === "list") {
          const [status, custom] = await Promise.all([
            call("status", {}, host),
            call("listCustom", {}, host),
          ]);
          if (hasFlag(argv, "json")) {
            return {
              exitCode: 0,
              stdout: `${JSON.stringify({ modelsJsonPath: custom.modelsJsonPath, builtin: status.gateways, endpoints: custom.endpoints }, null, 2)}\n`,
            };
          }
          const lines = [`models.json: ${custom.modelsJsonPath}`, "", "Built-in gateways:"];
          renderReports(status.gateways, lines);
          lines.push("", "User-defined endpoints:");
          if (custom.endpoints.length === 0) {
            lines.push("  (none — add one with `bb pi-gateways add`)");
          } else {
            for (const endpoint of custom.endpoints) {
              const state = endpoint.inModelsJson
                ? endpoint.error ?? "configured"
                : `not in models.json${endpoint.error ? ` — ${endpoint.error}` : ""}`;
              lines.push(
                `  ${endpoint.id.padEnd(16)} ${String(endpoint.modelCount).padStart(3)} models · ${endpoint.freeOnly ? "free-only" : "PAID ALLOWED "} · ${state}`,
              );
              lines.push(`    ${endpoint.baseUrl} · key: ${endpoint.keyRef}`);
            }
          }
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }

        if (command === "test") {
          const baseUrl = flag(argv, "base-url");
          const api = flag(argv, "api") ?? "openai-completions";
          if (!baseUrl) throw new Error("--base-url is required");
          const result = await call(
            "probe",
            {
              baseUrl,
              api: api as "openai-completions" | "openai-responses" | "anthropic-messages",
              keySource: parseKeySource(argv),
            },
            host,
          );
          if (!result.ok) return { exitCode: 1, stderr: `probe failed: ${result.error}\n` };
          const lines = [`HTTP ${result.httpStatus} · ${result.totalCount} models · ${result.freeCount} free`];
          if (result.sampleCall) {
            lines.push(
              result.sampleCall.ok
                ? `live call OK (${result.sampleCall.status})`
                : `live call FAILED${result.sampleCall.status ? ` (${result.sampleCall.status})` : ""}: ${(result.sampleCall.error ?? "").slice(0, 200)}`,
            );
          } else {
            lines.push("no free model to live-test against");
          }
          for (const model of result.models.filter((m) => m.free)) {
            lines.push(`  ${model.priceKnown ? "free" : "zero?"}  ${model.id}`);
          }
          return { exitCode: result.sampleCall?.ok === false ? 1 : 0, stdout: `${lines.join("\n")}\n` };
        }

        if (command === "add") {
          const id = flag(argv, "id");
          const name = flag(argv, "name");
          const baseUrl = flag(argv, "base-url");
          const api = flag(argv, "api") ?? "openai-completions";
          if (!id || !name || !baseUrl) {
            throw new Error("--id, --name and --base-url are required");
          }
          if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
            throw new Error("--id must be a lowercase slug (letters, digits, dashes)");
          }
          const paid = hasFlag(argv, "paid");
          const modelsArg = flag(argv, "models");
          const data = await call(
            "saveCustom",
            {
              id,
              name,
              baseUrl,
              api: api as "openai-completions" | "openai-responses" | "anthropic-messages",
              keySource: parseKeySource(argv),
              freeOnly: !paid,
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
          if (!id || id.startsWith("--")) throw new Error("usage: bb pi-gateways delete <id>");
          const data = await call("deleteCustom", { id }, host);
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
