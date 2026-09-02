/**
 * The player, without a browser.
 *
 * Two things stand between this file and the module under test. Node has no
 * DOM, so every browser API the player touches is stubbed onto `globalThis`
 * and taken back off in a `finally`. And Node does not rewrite a `.js`
 * specifier to the `.ts` file beside it, so a resolve hook does that — the
 * same hook that hands the player a deterministic `./speakable.js` and a
 * `sonner` whose toasts land in an array instead of on a screen.
 *
 * The `fetch` stub is the interesting half now that the player streams: it
 * records every request, honours the abort signal, and can hold a chunk back
 * so a test can decide exactly when it lands.
 *
 *   node --experimental-strip-types --test tests/player.test.ts
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

// --- module plumbing --------------------------------------------------------

interface ToastRecord {
  level: string;
  message: string;
}

const VIRTUAL_SONNER = "speak-test:sonner";
const VIRTUAL_SPEAKABLE = "speak-test:speakable";

/**
 * Toasts go to an array on `globalThis` because the virtual module below is
 * source text, not a closure — this is the only channel it and the test share.
 */
const SONNER_SOURCE = `
const sink = () => (globalThis.__speakTestToasts ??= []);
const record = (level) => (message) => { sink().push({ level, message: String(message) }); };
export const toast = Object.assign(record("message"), {
  info: record("info"),
  error: record("error"),
  success: record("success"),
  warning: record("warning"),
});
`;

/**
 * Always virtual, even though the real `src/speakable.ts` is right there: this
 * file tests the player's control flow, and it should not start failing
 * because someone taught the markdown stripper a new trick.
 */
const SPEAKABLE_SOURCE = `
export function toSpeakable(markdown) {
  const override = globalThis.__speakTestToSpeakable;
  return override ? override(markdown) : String(markdown).trim();
}
export function detectLanguage(text) {
  return /[\\u0400-\\u04ff]/.test(text) ? "ru-RU" : "en-US";
}
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
    if (url === VIRTUAL_SONNER) {
      return { format: "module", shortCircuit: true, source: SONNER_SOURCE };
    }
    if (url === VIRTUAL_SPEAKABLE) {
      return { format: "module", shortCircuit: true, source: SPEAKABLE_SOURCE };
    }
    return nextLoad(url, context);
  },
});

const { player, refreshPrefs } = await import("../src/player.js");

// --- the fake browser -------------------------------------------------------

class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  plays = 0;
  src: string;
  autoEnd: boolean;
  refusePlay: boolean;

  constructor(src: string, autoEnd: boolean, refusePlay: boolean) {
    this.src = src;
    this.autoEnd = autoEnd;
    this.refusePlay = refusePlay;
  }

  play(): Promise<void> {
    this.plays += 1;
    // What an autoplay-blocking browser does.
    if (this.refusePlay) return Promise.reject(new Error("NotAllowedError"));
    // A real element ends on its own; a test that wants to stop mid-chunk
    // turns that off and drives `end()` by hand.
    if (this.autoEnd) queueMicrotask(() => this.onended?.());
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  end(): void {
    this.onended?.();
  }
}

class FakeUtterance {
  lang = "";
  rate = 1;
  voice: { name: string; lang: string } | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  text: string;

  constructor(text: string) {
    this.text = text;
  }
}

/** One trip to the plugin's RPC endpoint, and how it ended. */
interface RequestRecord {
  method: string;
  chunkIndex: number | null;
  settled: boolean;
  aborted: boolean;
}

interface Harness {
  toasts: ToastRecord[];
  audios: FakeAudio[];
  utterances: FakeUtterance[];
  created: string[];
  revoked: string[];
  blobs: Blob[];
  requests: RequestRecord[];
  cancels: number;
  /** The most `synthesize` calls that were ever open at the same moment. */
  maxOpen: number;
  restore(): void;
}

type RpcHandler = (method: string, input: Record<string, unknown>) => unknown;

interface HarnessOptions {
  rpc: RpcHandler;
  /** Chunks finish on their own unless a test wants to interrupt one. */
  autoEnd?: boolean;
  voices?: { name: string; lang: string }[];
  /** Drop `speechSynthesis` and its utterance entirely. */
  noBrowserVoice?: boolean;
  /** Make `play()` reject, the way a browser blocking autoplay does. */
  refusePlay?: boolean;
  /** Answer the first `getVoices()` with nothing, as Chrome does. */
  voicesArriveLate?: boolean;
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function install(options: HarnessOptions): Harness {
  const scope = globalThis as unknown as Record<string, unknown>;
  const urlApi = URL as unknown as Record<string, unknown>;

  const savedKeys = ["fetch", "Audio", "speechSynthesis", "SpeechSynthesisUtterance"];
  const saved = savedKeys.map((key) => ({ key, had: key in scope, value: scope[key] }));
  const savedCreate = urlApi.createObjectURL;
  const savedRevoke = urlApi.revokeObjectURL;

  const toasts = ((scope.__speakTestToasts ??= []) as ToastRecord[]);
  toasts.length = 0;
  delete scope.__speakTestToSpeakable;

  const harness: Harness = {
    toasts,
    audios: [],
    utterances: [],
    created: [],
    revoked: [],
    blobs: [],
    requests: [],
    cancels: 0,
    maxOpen: 0,
    restore() {
      for (const entry of saved) {
        if (entry.had) scope[entry.key] = entry.value;
        else delete scope[entry.key];
      }
      urlApi.createObjectURL = savedCreate;
      urlApi.revokeObjectURL = savedRevoke;
      delete scope.__speakTestToSpeakable;
    },
  };

  let open = 0;
  scope.fetch = async (
    input: unknown,
    init?: { body?: string; signal?: AbortSignal },
  ) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const record: RequestRecord = {
      method,
      chunkIndex: typeof body.chunkIndex === "number" ? body.chunkIndex : null,
      settled: false,
      aborted: false,
    };
    harness.requests.push(record);
    if (method === "synthesize") {
      open += 1;
      harness.maxOpen = Math.max(harness.maxOpen, open);
    }
    try {
      // A handler may return a value, return a promise a test resolves later,
      // or throw. All three are things a real endpoint does; a throw is a
      // network failure, which is exactly what the rpc paths guard against.
      const result = await new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          record.aborted = true;
          reject(new Error("AbortError"));
        });
        try {
          Promise.resolve(options.rpc(method, body)).then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      });
      return { status: 200, json: async () => ({ ok: true, result }) };
    } finally {
      record.settled = true;
      if (method === "synthesize") open -= 1;
    }
  };

  scope.Audio = function Audio(this: unknown, src: string) {
    const audio = new FakeAudio(src, options.autoEnd ?? true, options.refusePlay ?? false);
    harness.audios.push(audio);
    return audio;
  } as unknown as typeof globalThis.Audio;

  let counter = 0;
  urlApi.createObjectURL = (blob: Blob) => {
    counter += 1;
    const url = `blob:speak-test/${counter}`;
    harness.created.push(url);
    // Kept so a test can read back what was actually handed to the speakers,
    // which is the only way to prove the chunks played in order.
    harness.blobs.push(blob);
    return url;
  };
  urlApi.revokeObjectURL = (url: string) => {
    harness.revoked.push(url);
  };

  if (!options.noBrowserVoice) {
    const voices = options.voices ?? [
      { name: "Samantha", lang: "en-US" },
      { name: "Milena", lang: "ru-RU" },
    ];
    let listed = options.voicesArriveLate ? [] : voices;
    scope.speechSynthesis = {
      cancel: () => {
        harness.cancels += 1;
      },
      getVoices: () => listed,
      speak: (utterance: FakeUtterance) => {
        queueMicrotask(() => utterance.onend?.());
      },
      addEventListener: (event: string, listener: () => void) => {
        if (event !== "voiceschanged") return;
        setTimeout(() => {
          listed = voices;
          listener();
        }, 0);
      },
      removeEventListener: () => {},
    };
    scope.SpeechSynthesisUtterance = function Utterance(this: unknown, text: string) {
      const utterance = new FakeUtterance(text);
      harness.utterances.push(utterance);
      return utterance;
    } as unknown as typeof globalThis.SpeechSynthesisUtterance;
  }

  return harness;
}

/** One macrotask: enough to drain every microtask the player queued. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The `synthesize` calls, in the order they were made. */
function chunkCalls(harness: Harness): (number | null)[] {
  return harness.requests
    .filter((request) => request.method === "synthesize")
    .map((request) => request.chunkIndex);
}

/** What actually reached the speakers, decoded, in playback order. */
async function played(harness: Harness): Promise<string[]> {
  return Promise.all(harness.blobs.map((blob) => blob.text()));
}

function okChunk(index: number, count: number, payload: string) {
  return {
    ok: true,
    mimeType: "audio/wav",
    voice: "Kore",
    chunkIndex: index,
    chunkCount: count,
    audioBase64: b64(payload),
  };
}

function statusWith(overrides: Record<string, unknown> = {}) {
  return {
    configured: true,
    prefs: {
      voice: "Kore",
      model: "gemini-2.5-flash-preview-tts",
      browserRate: 1,
      fallbackEnabled: true,
      ...overrides,
    },
    voices: ["Kore", "Puck", "Zephyr"],
    models: ["gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"],
  };
}

/** A server that answers `synthesize` out of a list of chunk payloads. */
function serve(payloads: string[], prefs: Record<string, unknown> = {}): RpcHandler {
  return (method, body) => {
    if (method === "status") return statusWith(prefs);
    if (method !== "synthesize") throw new Error(`unexpected method ${method}`);
    const index = Number(body.chunkIndex);
    const payload = payloads[index];
    if (payload === undefined) throw new Error(`no chunk ${index}`);
    return okChunk(index, payloads.length, payload);
  };
}

/**
 * Chunk responses a test releases by hand, so it can hold one open and look at
 * what the player did in the meantime.
 */
function makeGate() {
  const resolvers = new Map<number, (value: unknown) => void>();
  const promises = new Map<number, Promise<unknown>>();
  const hold = (index: number): Promise<unknown> => {
    let promise = promises.get(index);
    if (!promise) {
      promise = new Promise((resolve) => resolvers.set(index, resolve));
      promises.set(index, promise);
    }
    return promise;
  };
  return {
    hold,
    /** Answer chunk `index`, whether or not it has been asked for yet. */
    release(index: number, value: unknown): void {
      hold(index);
      resolvers.get(index)?.(value);
    },
  };
}

/** Every test starts from a cold player and a cold preference cache. */
async function reset(): Promise<void> {
  player.stop();
  await refreshPrefs();
}

// --- tests ------------------------------------------------------------------

test("clicking the same message twice stops instead of speaking it twice", async () => {
  const harness = install({ autoEnd: false, rpc: serve(["one"]) });
  try {
    await reset();

    void player.speak({ messageId: "m1", text: "hello there" });
    await tick();
    assert.equal(harness.audios.length, 1);
    assert.equal(player.getState().speaking, true);
    assert.equal(player.getState().messageId, "m1");

    // A toggle returns at once — it has nothing to wait for. Racing it
    // against a tick says so, and keeps a regression here from hanging the
    // run instead of failing it.
    const toggled = player.speak({ messageId: "m1", text: "hello there" });
    const outcome = await Promise.race([
      toggled.then(() => "returned"),
      tick().then(() => "still going"),
    ]);
    assert.equal(outcome, "returned");
    assert.equal(player.getState().speaking, false);
    assert.equal(harness.audios[0]?.paused, true);

    await tick();
    assert.equal(harness.audios.length, 1, "the toggle must not start a second playback");
  } finally {
    player.stop();
    harness.restore();
  }
});

test("a different message interrupts the one that is playing", async () => {
  const harness = install({ autoEnd: false, rpc: serve(["one"]) });
  try {
    await reset();

    void player.speak({ messageId: "m1", text: "first message" });
    await tick();
    void player.speak({ messageId: "m2", text: "second message" });
    await tick();

    assert.equal(harness.audios.length, 2);
    assert.equal(harness.audios[0]?.paused, true, "the first chunk must be silenced");
    assert.equal(player.getState().speaking, true);
    assert.equal(player.getState().messageId, "m2");
  } finally {
    player.stop();
    harness.restore();
  }
});

test("an unreachable server falls back to the browser voice", async () => {
  const harness = install({
    rpc: (method) => {
      if (method === "status") return statusWith();
      throw new Error("connect ECONNREFUSED 127.0.0.1:7777");
    },
  });
  try {
    await reset();

    await player.speak({ messageId: "m1", text: "read this out loud" });

    assert.equal(harness.utterances.length, 1);
    const utterance = harness.utterances[0]!;
    assert.equal(utterance.text, "read this out loud");
    assert.equal(utterance.lang, "en-US");
    assert.equal(utterance.rate, 1);
    assert.equal(utterance.voice?.name, "Samantha", "a matching installed voice is preferred");
    assert.ok(harness.cancels > 0, "speechSynthesis.cancel() runs before speaking");
    assert.equal(harness.audios.length, 0);
    assert.equal(player.getState().speaking, false);

    assert.equal(harness.toasts.length, 1, "one toast, not one per failure hop");
    // Something is about to speak, so the hand-off is news, not a fault.
    assert.equal(harness.toasts[0]?.level, "info");
    assert.match(harness.toasts[0]!.message, /browser's own voice/);
    assert.doesNotMatch(harness.toasts[0]!.message, /ECONNREFUSED/, "no raw server text");
  } finally {
    player.stop();
    harness.restore();
  }
});

test("the browser voice picks a Russian voice for Russian text, at browserRate", async () => {
  const harness = install({
    rpc: (method) => {
      if (method === "status") return statusWith({ browserRate: 1.4 });
      return { ok: false, code: "not_configured", message: "no key" };
    },
  });
  try {
    await reset();

    await player.speak({ messageId: "m1", text: "Прочитай это вслух" });

    const utterance = harness.utterances[0]!;
    assert.equal(utterance.lang, "ru-RU");
    assert.equal(utterance.voice?.name, "Milena");
    assert.equal(utterance.rate, 1.4, "the rate reaches the browser voice, and only it");
    assert.match(harness.toasts[0]!.message, /Settings → Extensions → Speak/);
  } finally {
    player.stop();
    harness.restore();
  }
});

for (const code of ["empty", "too_long"] as const) {
  test(`code ${code} is reported, not retried with the browser voice`, async () => {
    const harness = install({
      rpc: (method) =>
        method === "status" ? statusWith() : { ok: false, code, message: "server detail" },
    });
    try {
      await reset();

      await player.speak({ messageId: "m1", text: "some text" });

      assert.equal(harness.utterances.length, 0, "no second engine would fix the text");
      assert.equal(harness.audios.length, 0);
      assert.equal(player.getState().speaking, false);
      assert.equal(harness.toasts.length, 1);
      assert.equal(harness.toasts[0]?.level, "error");
      assert.doesNotMatch(harness.toasts[0]!.message, /server detail/);
    } finally {
      player.stop();
      harness.restore();
    }
  });
}

test("a missing key is announced once, not on every click", async () => {
  const harness = install({
    rpc: (method) =>
      method === "status"
        ? statusWith()
        : { ok: false, code: "not_configured", message: "No Gemini API key yet." },
  });
  try {
    await reset();

    await player.speak({ messageId: "m1", text: "first" });
    await player.speak({ messageId: "m2", text: "second" });
    await player.speak({ messageId: "m3", text: "third" });

    assert.equal(harness.utterances.length, 3, "every click still speaks");
    assert.equal(harness.toasts.length, 1, "having no key is a steady state, not three events");
    assert.equal(harness.toasts[0]?.level, "info");

    // A save may well be the key arriving, so the notice speaks again.
    await refreshPrefs();
    await player.speak({ messageId: "m4", text: "fourth" });
    assert.equal(harness.toasts.length, 2);
  } finally {
    harness.restore();
  }
});

test("a rejected key is announced every time, unlike a missing one", async () => {
  const harness = install({
    rpc: (method) =>
      method === "status"
        ? statusWith()
        : { ok: false, code: "auth", message: "Google rejected the API key." },
  });
  try {
    await reset();

    await player.speak({ messageId: "m1", text: "first" });
    await player.speak({ messageId: "m2", text: "second" });

    // A key that is present and refused is a fault someone has to go and fix.
    assert.equal(harness.toasts.length, 2);
    assert.equal(harness.toasts[0]?.level, "info");
  } finally {
    harness.restore();
  }
});

test("fallbackEnabled: false keeps the browser voice out of it", async () => {
  const harness = install({
    rpc: (method) =>
      method === "status"
        ? statusWith({ fallbackEnabled: false })
        : { ok: false, code: "not_configured", message: "no key" },
  });
  try {
    await reset();

    await player.speak({ messageId: "m1", text: "some text" });

    assert.equal(harness.utterances.length, 0);
    assert.equal(player.getState().speaking, false);
    assert.equal(harness.toasts.length, 1);
    assert.match(harness.toasts[0]!.message, /Add a Gemini API key/);
    assert.doesNotMatch(harness.toasts[0]!.message, /browser's own voice/);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("no speechSynthesis at all names both what failed and what is missing", async () => {
  const harness = install({
    noBrowserVoice: true,
    rpc: (method) =>
      method === "status"
        ? statusWith()
        : { ok: false, code: "rate_limited", message: "429 quota exceeded" },
  });
  try {
    await reset();

    await player.speak({ messageId: "m1", text: "some text" });

    assert.equal(player.getState().speaking, false);
    assert.equal(harness.toasts.length, 1);
    assert.match(harness.toasts[0]!.message, /rate-limiting/);
    assert.match(harness.toasts[0]!.message, /no speech synthesis of its own/);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("chunks are fetched one by one and play back to back, in order", async () => {
  const harness = install({ rpc: serve(["one", "two", "three"]) });
  try {
    await reset();

    await player.speak({ messageId: "m1", text: "three chunks worth" });

    assert.deepEqual(chunkCalls(harness), [0, 1, 2], "one call per chunk, in order");
    assert.equal(harness.audios.length, 3);
    assert.deepEqual(await played(harness), ["one", "two", "three"]);
    assert.deepEqual(
      harness.audios.map((audio) => audio.src),
      harness.created,
      "each chunk plays from the URL made for it, in order",
    );
    assert.deepEqual(harness.revoked, harness.created, "every URL created is revoked");
    assert.equal(player.getState().speaking, false);
    assert.equal(harness.toasts.length, 0);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("the next chunk is fetched while the current one is still playing", async () => {
  const harness = install({ autoEnd: false, rpc: serve(["one", "two", "three"]) });
  try {
    await reset();

    void player.speak({ messageId: "m1", text: "three chunks worth" });
    await tick();

    assert.equal(harness.audios.length, 1, "only the first chunk is playing");
    assert.deepEqual(
      chunkCalls(harness),
      [0, 1, 2],
      "future chunks are asked for in parallel while chunk 0 plays",
    );

    // Chunk 1's answer is here early; it waits its turn rather than doubling up.
    assert.equal(harness.audios.length, 1);
    harness.audios[0]!.end();
    await tick();

    assert.equal(harness.audios.length, 2);
    assert.deepEqual(await played(harness), ["one", "two"], "held, then played in order");
    assert.deepEqual(chunkCalls(harness), [0, 1, 2]);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("chunks play in order even when a later answer is ready first", async () => {
  const gate = makeGate();
  const harness = install({
    autoEnd: false,
    rpc: (method, body) => {
      if (method === "status") return statusWith();
      return gate.hold(Number(body.chunkIndex));
    },
  });
  try {
    await reset();

    void player.speak({ messageId: "m1", text: "two chunks worth" });
    await tick();
    assert.deepEqual(chunkCalls(harness), [0]);

    // Make chunk 1 ready before chunk 0. The player still cannot ask for it
    // until chunk 0 establishes chunkCount, and cannot play it before chunk 0.
    gate.release(1, okChunk(1, 2, "two"));
    gate.release(0, okChunk(0, 2, "one"));
    await tick();

    assert.deepEqual(chunkCalls(harness), [0, 1]);
    assert.equal(harness.audios.length, 1, "the ready later chunk waits its turn");
    assert.deepEqual(await played(harness), ["one"]);

    harness.audios[0]!.end();
    await tick();
    assert.equal(harness.audios.length, 2);
    assert.deepEqual(await played(harness), ["one", "two"]);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("an early fetch-ahead rejection is observed until playback reaches it", async () => {
  const harness = install({
    autoEnd: false,
    rpc: (method, body) => {
      if (method === "status") return statusWith();
      if (Number(body.chunkIndex) === 0) return okChunk(0, 2, "one");
      return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:7777"));
    },
  });
  try {
    await reset();

    const speaking = player.speak({ messageId: "m1", text: "two chunks worth" });
    await tick();
    await tick();

    assert.equal(harness.audios.length, 1);
    assert.equal(player.getState().speaking, true);
    assert.equal(player.getState().messageId, "m1");
    assert.equal(harness.toasts.length, 0, "the current chunk is allowed to finish first");

    harness.audios[0]!.end();
    await speaking;

    assert.equal(harness.utterances.length, 0, "the browser voice does not restart the message");
    assert.equal(harness.toasts.length, 1);
    assert.match(harness.toasts[0]!.message, /stopped part-way through/);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("chunks are fetched in parallel ahead of playback", async () => {
  const gate = makeGate();
  const harness = install({
    autoEnd: false,
    rpc: (method, body) => {
      if (method === "status") return statusWith();
      const index = Number(body.chunkIndex);
      return gate.hold(index);
    },
  });
  try {
    await reset();

    void player.speak({ messageId: "m1", text: "four chunks worth" });
    await tick();
    assert.deepEqual(chunkCalls(harness), [0], "nothing else is asked for until chunk 0 lands");

    gate.release(0, okChunk(0, 4, "chunk-0"));
    await tick();
    assert.deepEqual(chunkCalls(harness), [0, 1, 2, 3], "chunks 1..3 are fetched in parallel");

    for (const index of [1, 2, 3]) {
      gate.release(index, okChunk(index, 4, `chunk-${index}`));
      await tick();
      harness.audios[index - 1]!.end();
      await tick();
    }
    harness.audios[3]!.end();
    await tick();

    assert.deepEqual(await played(harness), ["chunk-0", "chunk-1", "chunk-2", "chunk-3"]);
    assert.equal(player.getState().speaking, false);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("playback that catches up with the fetching waits, silently", async () => {
  const gate = makeGate();
  const harness = install({
    rpc: (method, body) => {
      if (method === "status") return statusWith();
      const index = Number(body.chunkIndex);
      return index === 0 ? okChunk(0, 2, "one") : gate.hold(index);
    },
  });
  try {
    await reset();

    void player.speak({ messageId: "m1", text: "two chunks worth" });
    await tick();

    // Chunk 0 has played out and chunk 1 is not here yet: the player is parked.
    assert.equal(harness.audios.length, 1);
    assert.equal(player.getState().speaking, true);
    assert.equal(player.getState().messageId, "m1");
    assert.equal(harness.toasts.length, 0, "a pause is not worth telling anyone about");

    gate.release(1, okChunk(1, 2, "two"));
    await tick();

    assert.deepEqual(await played(harness), ["one", "two"]);
    assert.equal(player.getState().speaking, false);
    assert.equal(harness.toasts.length, 0);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("stop() aborts the request in flight and starts nothing further", async () => {
  const gate = makeGate();
  const harness = install({
    rpc: (method, body) => {
      if (method === "status") return statusWith();
      return gate.hold(Number(body.chunkIndex));
    },
  });
  try {
    await reset();

    void player.speak({ messageId: "m1", text: "a message nobody waits for" });
    await tick();
    const request = harness.requests.find((entry) => entry.method === "synthesize")!;
    assert.equal(request.aborted, false);

    player.stop();
    assert.equal(request.aborted, true, "the outstanding chunk request is cancelled");
    assert.equal(player.getState().speaking, false, "stop() is synchronous");

    // Even if the server answers anyway, nothing may come of it.
    gate.release(0, okChunk(0, 3, "one"));
    await tick();
    await tick();

    assert.equal(harness.audios.length, 0, "no audio from a request that was cancelled");
    assert.equal(harness.utterances.length, 0, "an abort is not a failure to fall back from");
    assert.deepEqual(chunkCalls(harness), [0], "and no chunk 1");
    assert.equal(harness.toasts.length, 0);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("stop() mid-chunk aborts the fetch-ahead and prevents the next chunk", async () => {
  const harness = install({ autoEnd: false, rpc: serve(["one", "two", "three"]) });
  try {
    await reset();

    void player.speak({ messageId: "m1", text: "three chunks worth" });
    await tick();
    assert.equal(harness.audios.length, 1);
    assert.deepEqual(chunkCalls(harness), [0, 1, 2]);

    player.stop();
    await tick();
    await tick();

    assert.equal(harness.audios.length, 1, "the queue must not resume after a stop");
    assert.equal(harness.audios[0]?.paused, true);
    assert.deepEqual(harness.revoked, harness.created);
    assert.equal(harness.toasts.length, 0);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("a failure on a later chunk stops and says so, rather than starting over", async () => {
  const harness = install({
    rpc: (method, body) => {
      if (method === "status") return statusWith();
      const index = Number(body.chunkIndex);
      // Retryable on purpose: even a code the browser voice could have taken
      // over is not worth re-reading the opening the user already heard.
      if (index === 0) return okChunk(0, 3, "one");
      return { ok: false, code: "rate_limited", message: "429 quota exceeded" };
    },
  });
  try {
    await reset();

    await player.speak({ messageId: "m1", text: "three chunks worth" });

    assert.equal(harness.audios.length, 1, "what was already fetched still played");
    assert.equal(harness.utterances.length, 0, "no restart with the browser voice");
    assert.equal(player.getState().speaking, false);
    assert.equal(harness.toasts.length, 1);
    assert.equal(harness.toasts[0]?.level, "error");
    assert.match(harness.toasts[0]!.message, /stopped part-way through/);
    assert.doesNotMatch(harness.toasts[0]!.message, /429/, "no raw server text");
  } finally {
    player.stop();
    harness.restore();
  }
});

test("an unreachable server on a later chunk is cut short, not failed over", async () => {
  const harness = install({
    rpc: (method, body) => {
      if (method === "status") return statusWith();
      if (Number(body.chunkIndex) === 0) return okChunk(0, 2, "one");
      throw new Error("connect ECONNREFUSED 127.0.0.1:7777");
    },
  });
  try {
    await reset();

    await player.speak({ messageId: "m1", text: "two chunks worth" });

    assert.equal(harness.utterances.length, 0);
    assert.equal(harness.toasts.length, 1);
    assert.equal(harness.toasts[0]?.level, "error");
    assert.match(harness.toasts[0]!.message, /stopped part-way through/);
    assert.equal(player.getState().speaking, false);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("a voice list that arrives late is still waited for", async () => {
  const harness = install({
    voicesArriveLate: true,
    rpc: (method) =>
      method === "status" ? statusWith() : { ok: false, code: "auth", message: "401" },
  });
  try {
    await reset();

    await player.speak({ messageId: "m1", text: "Прочитай это вслух" });

    assert.equal(harness.utterances.length, 1);
    assert.equal(
      harness.utterances[0]?.voice?.name,
      "Milena",
      "the voice chosen after voiceschanged, not the empty first answer",
    );
    assert.equal(player.getState().speaking, false);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("audio that will not play is a toast, not silence", async () => {
  const harness = install({ refusePlay: true, rpc: serve(["one"]) });
  try {
    await reset();

    await player.speak({ messageId: "m1", text: "hello there" });

    assert.equal(harness.audios.length, 1);
    assert.equal(player.getState().speaking, false);
    assert.deepEqual(harness.revoked, harness.created);
    assert.equal(harness.toasts.length, 1);
    assert.equal(harness.toasts[0]?.level, "error");
    assert.match(harness.toasts[0]!.message, /would not play/);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("nothing speakable is a note, not a request", async () => {
  const harness = install({
    rpc: (method) => {
      if (method === "status") return statusWith();
      throw new Error("synthesize must not be called");
    },
  });
  try {
    await reset();
    (globalThis as unknown as Record<string, unknown>).__speakTestToSpeakable = () => "";

    await player.speak({ messageId: "m1", text: "```\nconst x = 1;\n```" });

    assert.equal(harness.audios.length, 0);
    assert.equal(harness.utterances.length, 0);
    assert.equal(chunkCalls(harness).length, 0);
    assert.equal(player.getState().speaking, false);
    assert.equal(harness.toasts.length, 1);
    assert.equal(harness.toasts[0]?.level, "info");
  } finally {
    player.stop();
    harness.restore();
  }
});

test("preview plays the clip it is handed, without a synthesize call", async () => {
  const harness = install({
    rpc: (method) => {
      if (method === "status") return statusWith();
      throw new Error("a settings audition must not go through speak()");
    },
  });
  try {
    await reset();

    const heard = await player.preview(b64("sample"), "audio/wav");

    assert.equal(heard, true);
    assert.equal(harness.audios.length, 1);
    assert.deepEqual(await played(harness), ["sample"]);
    assert.deepEqual(harness.revoked, harness.created);
    assert.equal(chunkCalls(harness).length, 0);
    assert.equal(player.getState().speaking, false);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("a reading and an audition share the one pair of speakers", async () => {
  const harness = install({ autoEnd: false, rpc: serve(["one"]) });
  try {
    await reset();

    void player.speak({ messageId: "m1", text: "hello there" });
    await tick();
    assert.equal(harness.audios.length, 1);

    void player.preview(b64("sample"));
    await tick();

    assert.equal(harness.audios[0]?.paused, true, "the reading is silenced first");
    assert.equal(harness.audios.length, 2);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("stop() with nothing playing is a no-op, and a throwing listener is contained", async () => {
  const harness = install({ autoEnd: false, rpc: serve(["one"]) });
  try {
    await reset();

    player.stop();
    assert.equal(player.getState().speaking, false);
    assert.equal(player.getState().messageId, null);

    const seen: boolean[] = [];
    const offBad = player.subscribe(() => {
      throw new Error("this subscriber is broken");
    });
    const offGood = player.subscribe((state) => seen.push(state.speaking));

    void player.speak({ messageId: "m1", text: "hello" });
    await tick();

    assert.ok(seen.includes(true), "the healthy listener still hears the state change");
    offBad();
    offGood();
  } finally {
    player.stop();
    harness.restore();
  }
});

test("a request_failed carries the server's own reason, not just the generic copy", async () => {
  // Audit PLUG-34 #4: a live probe with a bad model returned "unknown provider
  // for model", and the user was shown "could not be reached" — which sends
  // someone to look at their network instead of their model setting.
  const harness = install({
    rpc: (method) =>
      method === "status"
        ? statusWith()
        : {
            ok: false,
            code: "request_failed",
            message: "unknown provider for model gemini-2.5-pro-preview-tts",
          },
  });
  try {
    await reset();
    await player.speak({ messageId: "m1", text: "read this" });

    const said = harness.toasts.map((t) => t.message).join(" | ");
    assert.match(said, /unknown provider for model/, "the server's reason must reach the user");
    assert.match(said, /browser's own voice/, "and the hand-off is still announced");
  } finally {
    harness.restore();
  }
});

test("a transport failure stays generic — plumbing is not actionable", async () => {
  const harness = install({
    rpc: (method) => {
      if (method === "status") return statusWith();
      throw new Error("connect ECONNREFUSED 127.0.0.1:7777");
    },
  });
  try {
    await reset();
    await player.speak({ messageId: "m1", text: "read this" });
    const said = harness.toasts.map((t) => t.message).join(" | ");
    assert.doesNotMatch(said, /ECONNREFUSED/, "no socket detail in a toast");
  } finally {
    harness.restore();
  }
});

test("a reading that dies mid-way cancels the chunks queued behind it", async () => {
  // Audit PLUG-36, Medium. The loop fetches several chunks ahead; a failure on
  // chunk 1 used to leave the speculative ones running for audio nobody would
  // hear, against a pool metered at roughly ten requests a day per account.
  const harness = install({
    rpc: (method, body) => {
      if (method === "status") return statusWith();
      const index = Number((body as { chunkIndex?: number }).chunkIndex ?? 0);
      if (index === 0) return okChunk(0, 5, "first");
      if (index === 1) return { ok: false, code: "request_failed", message: "boom" };
      // Held open, so they are genuinely in flight when chunk 1 fails.
      return new Promise(() => {});
    },
  });
  try {
    await reset();
    await player.speak({ messageId: "m1", text: "a".repeat(1500) });
    await tick();

    const speculative = harness.requests.filter(
      (r) => r.method === "synthesize" && (r.chunkIndex ?? 0) >= 2,
    );
    assert.ok(speculative.length > 0, "the loop must have fetched ahead at all");
    const leaked = speculative.filter((r) => !r.aborted && !r.settled);
    assert.deepEqual(
      leaked.map((r) => r.chunkIndex),
      [],
      "every chunk queued behind the failure must be cancelled",
    );
    assert.equal(player.getState().stage, "idle");
  } finally {
    harness.restore();
  }
});

test("a first-chunk failure cancels the prefetch too, not just a later one", async () => {
  // Audit PLUG-39 #4: my earlier test failed chunk 1, which exercises only
  // cutShort(). The client derives the split locally and prefetches up to five
  // chunks at T=0, before chunk 0 has answered — so a chunk-0 failure, which
  // goes through failOver(), also leaves speculative requests running. The two
  // terminal paths needed covering separately.
  const harness = install({
    rpc: (method, body) => {
      if (method === "status") return statusWith();
      const index = Number((body as { chunkIndex?: number }).chunkIndex ?? 0);
      if (index === 0) return { ok: false, code: "request_failed", message: "boom" };
      return new Promise(() => {});
    },
  });
  try {
    await reset();
    await player.speak({ messageId: "m1", text: "a".repeat(1500) });
    await tick();

    const speculative = harness.requests.filter(
      (r) => r.method === "synthesize" && (r.chunkIndex ?? 0) >= 1,
    );
    assert.ok(speculative.length > 0, "the loop must have prefetched at T=0");
    const leaked = speculative.filter((r) => !r.aborted && !r.settled);
    assert.deepEqual(
      leaked.map((r) => r.chunkIndex),
      [],
      "failOver must cancel the prefetch as cutShort does",
    );
  } finally {
    harness.restore();
  }
});
