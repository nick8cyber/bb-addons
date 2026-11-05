/** Spike server: registers the provider, hosts the bridge WebSocket, runs a scripted "call". */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Sock = { send(data: string): void };
export default function plugin(bb: BbPluginApi) {
  const bridges = new Set<Sock>();
  const owner = new Map<string, Sock>();
  const turnWaiters = new Map<string, (text: string) => void>();
  const journal: string[] = [];
  const note = (m: string) => { const line = `${new Date().toISOString().slice(11, 19)} ${m}`; journal.push(line); bb.log.info(`[spike] ${m}`); };
  const toBridge = (m: { threadId?: string } & Record<string, unknown>) => { const s = JSON.stringify(m); const o = m.threadId ? owner.get(m.threadId) : undefined; if (o) o.send(s); else { note(`no owner for ${m.threadId}, broadcasting`); for (const b of bridges) b.send(s); } };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  setTimeout(() => { try { const dir = join(bb.server.experimental_dataDir, "plugins", "live-call-spike", "bridge-data"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "server.json"), JSON.stringify({ url: bb.server.loopbackBaseUrl })); note(`server.json written: ${bb.server.loopbackBaseUrl}`); } catch (e) { note(`server.json failed: ${String(e)}`); } }, 500);

  bb.providers.register({
    id: "live-call-spike",
    displayName: "Live Call (spike)",
    capabilities: { supportsServiceTier: false, supportsNativeUserQuestion: false, fork: "none", supportsManualCompaction: false,
      supportsThreadArchive: false, supportsThreadRename: false, permissionModes: ["full"], reasoningLevels: ["medium"] },
    composerActions: [],
    experimental_visibility: "installed",
    maintenance: { health: true },
  });

  bb.http.experimental_websocket("/bridge", () => ({
    onOpen: (s: Sock) => { bridges.add(s); note(`bridge connected (${bridges.size})`); },
    onMessage: (sock: Sock, data: string | Uint8Array) => {
      const m = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
      if (m.type === "hello") note(`bridge hello pid=${m.pid}`);
      if (m.type === "own") { owner.set(m.threadId, sock); note(`bridge owns ${m.threadId}`); }
      if (m.type === "turn") { note(`bridge turn on ${m.threadId}: "${m.text}"`); turnWaiters.get(m.threadId)?.(m.text); }
    },
    onClose: (s: Sock) => { bridges.delete(s); note("bridge disconnected"); },
  }), { auth: "local" });

  const waitTurn = (threadId: string, ms = 20000) => new Promise<string | null>((res) => {
    const t = setTimeout(() => { turnWaiters.delete(threadId); res(null); }, ms);
    turnWaiters.set(threadId, (text) => { clearTimeout(t); turnWaiters.delete(threadId); res(text); });
  });

  async function scenario(holdSec: number) {
    const t0 = Date.now();
    const thread = await bb.sdk.threads.spawn({
      projectId: process.env.LIVE_CALL_SPIKE_PROJECT ?? "", providerId: "live-call-spike", model: "live",
      environment: { type: "reuse", environmentId: process.env.LIVE_CALL_SPIKE_ENV ?? "" },
      title: "[SPIKE] выдуманные данные — не решения владельца",
      prompt: "[SPIKE] Что там с demo-проектом A?",
    } as never) as { id: string };
    threadId = thread.id; note(`spawned ${threadId} in ${Date.now() - t0}ms`);
    const firstTurn = await waitTurn(threadId);
    note(firstTurn === null ? "first turn NOT seen by server in 20s" : "first turn seen");
    await sleep(1500);
    toBridge({ type: "say", threadId, text: "[SPIKE] demo-проект A: выдуманный ответ для проверки транскрипта." });
    await sleep(4000);
    toBridge({ type: "say", threadId, text: "[SPIKE] 🔔 выдуманный проактивный доклад." });
    await sleep(3000);
    toBridge({ type: "end", threadId }); await sleep(800);
    const second = waitTurn(threadId);
    await bb.sdk.threads.send({ threadId, mode: "start", input: [{ type: "text", text: "[SPIKE] вторая выдуманная фраза.", mentions: [] }] } as never);
    note((await second) === null ? "second turn NOT seen" : "second turn seen");
    await sleep(1200);
    toBridge({ type: "say", threadId, text: "[SPIKE] выдуманный ответ на вторую фразу." });
    const steps = Math.max(1, Math.floor(holdSec / 30));
    for (let i = 1; i <= steps; i++) { await sleep(30000); toBridge({ type: "say", threadId, text: `⏱ ход открыт ${i * 30} с — проверка долгого хода.` }); }
    toBridge({ type: "say", threadId, text: "[SPIKE] выдуманный итог, решений нет." });
    toBridge({ type: "end", threadId });
    note(`scenario done in ${Math.round((Date.now() - t0) / 1000)}s`);
    return threadId;
  }

  bb.cli.register({
    name: "live-call-spike",
    summary: "Spike: run a scripted call into a provider-backed thread",
    commands: [{ name: "demo", summary: "Run the scripted call", usage: "bb live-call-spike demo [holdSeconds]" },
               { name: "journal", summary: "Print the spike journal", usage: "bb live-call-spike journal" }],
    async run(argv) {
      if (argv[0] === "journal") return { exitCode: 0, stdout: journal.join("\n") + "\n" };
      if (argv[0] === "demo") {
        const hold = Number(argv[1] ?? 60);
        void scenario(hold).catch((e) => note(`scenario error: ${String(e)}`));
        return { exitCode: 0, stdout: `started, hold=${hold}s; see: bb live-call-spike journal\n` };
      }
      return { exitCode: 2, stdout: "usage: bb live-call-spike demo [holdSeconds] | journal\n" };
    },
  });
}
