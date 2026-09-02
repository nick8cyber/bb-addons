/**
 * The PLUG-34 audit's findings, kept as regression tests now that all four are
 * fixed.
 *
 * Written by an independent auditor rather than by the author of the code they
 * cover, which is why they caught what the author's own tests did not: a
 * permanent overlay spinner after a browser-voice fallback, a reading cut
 * short that left the bar claiming to play, a pause silently undone at the
 * chunk boundary, and a quota rollover an hour off on both DST days.
 *
 *   node --experimental-strip-types --test tests/audit-findings.test.ts
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const VIRTUAL_SONNER = "speak-audit:sonner";
const VIRTUAL_SPEAKABLE = "speak-audit:speakable";
const SONNER_SOURCE = `
const sink = () => (globalThis.__speakAuditToasts ??= []);
const record = (level) => (message) => { sink().push({ level, message: String(message) }); };
export const toast = Object.assign(record("message"), { info: record("info"), error: record("error"), success: record("success"), warning: record("warning") });
`;
const SPEAKABLE_SOURCE = `
export function toSpeakable(markdown) { return String(markdown).trim(); }
export function detectLanguage() { return "en-US"; }
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "sonner") return { url: VIRTUAL_SONNER, shortCircuit: true };
    if (specifier.endsWith("speakable.js")) return { url: VIRTUAL_SPEAKABLE, shortCircuit: true };
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, format: "module-typescript", shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === VIRTUAL_SONNER) return { format: "module", shortCircuit: true, source: SONNER_SOURCE };
    if (url === VIRTUAL_SPEAKABLE) return { format: "module", shortCircuit: true, source: SPEAKABLE_SOURCE };
    return nextLoad(url, context);
  },
});

const { player, refreshPrefs } = await import("../src/player.js");
const { nextQuotaReset } = await import("../src/model-chain.js");

// --- minimal fake browser ---------------------------------------------------

class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src: string;
  private autoEnd: boolean;
  constructor(src: string, autoEnd: boolean) { this.src = src; this.autoEnd = autoEnd; }
  play(): Promise<void> {
    if (this.autoEnd) queueMicrotask(() => this.onended?.());
    return Promise.resolve();
  }
  pause(): void {}
  end(): void { this.onended?.(); }
}

type Rpc = (method: string, body: Record<string, unknown>) => unknown;

function install(rpc: Rpc, autoEnd = true) {
  const scope = globalThis as unknown as Record<string, unknown>;
  const urlApi = URL as unknown as Record<string, unknown>;
  const saved = ["fetch", "Audio", "speechSynthesis", "SpeechSynthesisUtterance"].map((key) => ({ key, had: key in scope, value: scope[key] }));
  const savedCreate = urlApi.createObjectURL;
  const savedRevoke = urlApi.revokeObjectURL;
  const audios: FakeAudio[] = [];
  const utterances: { text: string; onend: (() => void) | null }[] = [];

  scope.fetch = async (input: unknown, init?: { body?: string; signal?: AbortSignal }) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const result = await new Promise((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
      Promise.resolve(rpc(method, body)).then(resolve, reject);
    });
    return { status: 200, json: async () => ({ ok: true, result }) };
  };
  scope.Audio = function Audio(this: unknown, src: string) {
    const audio = new FakeAudio(src, autoEnd);
    audios.push(audio);
    return audio;
  } as unknown as typeof globalThis.Audio;
  urlApi.createObjectURL = () => `blob:audit/${audios.length}`;
  urlApi.revokeObjectURL = () => {};
  scope.speechSynthesis = {
    cancel() {},
    getVoices: () => [{ name: "Samantha", lang: "en-US" }],
    speak(u: { onend: (() => void) | null }) { queueMicrotask(() => u.onend?.()); },
    addEventListener() {},
    removeEventListener() {},
  };
  scope.SpeechSynthesisUtterance = function Utterance(this: unknown, text: string) {
    const u = { text, onend: null as (() => void) | null, onerror: null, lang: "", rate: 1, voice: null };
    utterances.push(u);
    return u;
  } as unknown as typeof globalThis.SpeechSynthesisUtterance;

  return {
    audios,
    utterances,
    restore() {
      for (const e of saved) { if (e.had) scope[e.key] = e.value; else delete scope[e.key]; }
      urlApi.createObjectURL = savedCreate;
      urlApi.revokeObjectURL = savedRevoke;
    },
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const b64 = (s: string) => Buffer.from(s).toString("base64");
const okChunk = (i: number, n: number) => ({ ok: true, mimeType: "audio/wav", voice: "Kore", model: "m", chunkIndex: i, chunkCount: n, audioBase64: b64(`chunk ${i}`) });
const status = { configured: true, prefs: { voice: "Kore", model: "m", fallbackModel: "", browserRate: 1, fallbackEnabled: true }, voices: ["Kore"], models: ["m"] };
// Long enough for three chunks at the real 100/260 budgets.
const THREE_CHUNKS = Array.from({ length: 3 }, (_, i) => `Sentence number ${i} of this message is long enough to fill its chunk budget when repeated a few times. `.repeat(3)).join("\n\n");

async function reset() { player.stop(); await refreshPrefs(); }

// --- findings ---------------------------------------------------------------

test("audit F-1: after a browser-voice fallback the overlay stage is left at 'generating' forever", async () => {
  await reset();
  const h = install((method) => (method === "status" ? status : { ok: false, code: "not_configured", message: "no key" }));
  try {
    await player.speak({ messageId: "m1", text: "Hello there." });
    await tick();
    const s = player.getState();
    assert.equal(s.speaking, false);
    // SpeakOverlay.render() hides itself only when stage === "idle" && !speaking.
    // With stage still "generating" the floating bar shows a spinner for good.
    assert.equal(s.stage, "idle", `stage should be idle after the fallback finished, got ${s.stage}`);
  } finally { h.restore(); }
});

test("audit F-2: a reading cut short on a later chunk leaves stage at 'playing' with nothing playing", async () => {
  await reset();
  const h = install((method, body) => {
    if (method === "status") return status;
    const i = Number(body.chunkIndex);
    if (i === 1) return { ok: false, code: "request_failed", message: "boom" };
    return okChunk(i, 3);
  });
  try {
    await player.speak({ messageId: "m2", text: THREE_CHUNKS });
    await tick();
    const s = player.getState();
    assert.equal(s.speaking, false);
    assert.equal(s.stage, "idle", `stage should be idle after cutShort, got ${s.stage}`);
  } finally { h.restore(); }
});

test("audit F-3: pause() pressed while the next chunk is still being fetched is silently undone", async () => {
  await reset();
  let releaseChunk1: ((v: unknown) => void) | null = null;
  const h = install((method, body) => {
    if (method === "status") return status;
    const i = Number(body.chunkIndex);
    if (i === 1) return new Promise((resolve) => { releaseChunk1 = resolve; });
    return okChunk(i, 3);
  });
  try {
    const run = player.speak({ messageId: "m3", text: THREE_CHUNKS });
    // Let chunk 0 arrive and finish playing; the loop is now awaiting chunk 1
    // with stage === "playing" and no audio element alive.
    for (let i = 0; i < 5; i += 1) await tick();
    assert.equal(player.getState().stage, "playing");
    player.pause();
    assert.equal(player.getState().stage, "paused");
    const audiosBefore = h.audios.length;
    releaseChunk1!(okChunk(1, 3));
    await tick(); await tick();
    // Expected: still paused, no new audio started. Actual: the loop overwrites
    // the stage with "playing" and starts chunk 1 while the bar says paused.
    assert.equal(h.audios.length, audiosBefore, `no chunk should start while paused; ${h.audios.length - audiosBefore} did, and the run ended in stage '${player.getState().stage}'`);
    assert.equal(player.getState().stage, "paused", "a pause should survive the arrival of the next chunk");
    player.stop();
    await run;
  } finally { h.restore(); }
});

test("audit F-4: nextQuotaReset is an hour off on the two DST transition days", () => {
  // 01:00 PST on 2026-03-08 (spring forward). Next Pacific midnight is 07:00Z on 03-09.
  const spring = nextQuotaReset(new Date("2026-03-08T09:00:00Z"));
  assert.equal(new Date(spring).toISOString(), "2026-03-09T07:00:00.000Z");
  // 00:30 PDT on 2026-11-01 (fall back). Next Pacific midnight is 08:00Z on 11-02.
  const fall = nextQuotaReset(new Date("2026-11-01T08:30:00Z"));
  assert.equal(new Date(fall).toISOString(), "2026-11-02T08:00:00.000Z");
});
