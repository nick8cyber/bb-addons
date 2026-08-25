/**
 * bb-plugin-pi-gateways — server entry.
 *
 * Thin: it owns the `bb pi-gateways` command surface and forwards the work to
 * the host entry, which is where the credential stores and models.json live.
 */
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const gatewayReport = z.object({
  id: z.string(),
  label: z.string(),
  credentialFound: z.boolean(),
  inModelsJson: z.boolean(),
  modelCount: z.number(),
  error: z.string().optional(),
});

const hostContract = {
  status: {
    input: z.object({}),
    output: z.object({ modelsJsonPath: z.string(), gateways: z.array(gatewayReport) }),
  },
  refresh: {
    input: z.object({ only: z.array(z.string()).optional() }),
    output: z.object({
      modelsJsonPath: z.string(),
      backupPath: z.string().optional(),
      gateways: z.array(gatewayReport),
    }),
  },
  remove: {
    input: z.object({}),
    output: z.object({ removed: z.array(z.string()), backupPath: z.string().optional() }),
  },
} as const;

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: hostContract.status.output },
  refresh: { input: z.object({ only: z.array(z.string()).optional() }), output: hostContract.refresh.output },
});

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });

  /**
   * Resolve the host to act on. With one machine enrolled this is unambiguous;
   * with several, `--host` picks one, because models.json is per-machine.
   */
  const resolveHost = async (requested?: string): Promise<string> => {
    const hosts = await bb.sdk.hosts.list();
    if (hosts.length === 0) throw new Error("no host is enrolled with this bb server");
    if (requested) {
      const match = hosts.find(
        (host) => host.id === requested || host.name === requested,
      );
      if (!match) throw new Error(`no host called ${requested}`);
      return match.id;
    }
    if (hosts.length === 1) return hosts[0]!.id;
    const names = hosts.map((host) => `${host.name} (${host.id})`).join(", ");
    throw new Error(`several hosts are enrolled, pass --host: ${names}`);
  };

  const call = async <M extends keyof typeof hostContract & string>(
    method: M,
    input: unknown,
    hostName?: string,
  ) => {
    const hostId = await resolveHost(hostName);
    // The client resolves to the method's output and throws on transport or
    // handler failure, so there is no result envelope to unwrap here.
    return await host.call(method, input as never, { hostId });
  };

  bb.rpc.register(rpcContract, {
    status: async () => (await call("status", {})) as never,
    refresh: async (input) => (await call("refresh", input)) as never,
  });

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

  const flag = (argv: readonly string[], name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const USAGE = [
    "Usage: bb pi-gateways <command>",
    "",
    "  status              show what is detected and what is in models.json",
    "  refresh [--only ID] re-read the catalogues and write the provider entries",
    "  remove              delete only this plugin's entries from models.json",
    "",
    "  --host <id|name>    machine to act on (needed only with several enrolled)",
    "",
  ].join("\n");

  bb.cli.register({
    name: "pi-gateways",
    summary: "Offer OpenCode Zen and Kilo Code free models through the pi provider",
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
          lines.push(
            "",
            "pi caches its provider catalogue in memory, so restart bb before the",
            "new models appear in the picker: systemctl --user restart bb.service",
            "",
          );
          const failed = data.gateways.every(
            (report: z.infer<typeof gatewayReport>) => report.error,
          );
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

        return { exitCode: 1, stderr: `unknown command ${command}\n\n${USAGE}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { exitCode: 1, stderr: `${message}\n` };
      }
    },
  });

  bb.log.info("pi-gateways ready: bb pi-gateways status");
}
