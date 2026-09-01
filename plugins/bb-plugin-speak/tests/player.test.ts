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
 * Always virtual, even once the real `src/speakable.ts` lands: this file tests
 * the player's control flow, and it should not start failing because someone
 * taught the markdown stripper a new trick.
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

interface Harness {
  toasts: ToastRecord[];
  audios: FakeAudio[];
  utterances: FakeUtterance[];
  created: string[];
  revoked: string[];
  cancels: number;
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
    cancels: 0,
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

  scope.fetch = async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    // A throwing handler is a network failure: the rpc wrapper sees a
    // rejected fetch, which is exactly the shape it guards against.
    const result = options.rpc(method, body);
    return { status: 200, json: async () => ({ ok: true, result }) };
  };

  scope.Audio = function Audio(this: unknown, src: string) {
    const audio = new FakeAudio(src, options.autoEnd ?? true, options.refusePlay ?? false);
    harness.audios.push(audio);
    return audio;
  } as unknown as typeof globalThis.Audio;

  let counter = 0;
  urlApi.createObjectURL = () => {
    counter += 1;
    const url = `blob:speak-test/${counter}`;
    harness.created.push(url);
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

function okAudio(chunks: string[]) {
  return { ok: true, mimeType: "audio/mpeg", voice: "en-US-Wavenet-F", chunks };
}

function statusWith(overrides: Record<string, unknown> = {}) {
  return {
    configured: true,
    prefs: { voices: {}, speakingRate: 1, fallbackEnabled: true, ...overrides },
    autoLanguages: ["ru-RU", "en-US"],
    defaultVoices: {},
  };
}

/** Every test starts from a cold player and a cold preference cache. */
async function reset(): Promise<void> {
  player.stop();
  await refreshPrefs();
}

// --- tests ------------------------------------------------------------------

test("clicking the same message twice stops instead of speaking it twice", async () => {
  const harness = install({
    autoEnd: false,
    rpc: (method) => (method === "status" ? statusWith() : okAudio([b64("one")])),
  });
  try {
    await reset();

    void player.speak({ messageId: "m1", text: "hello there" });
    await tick();
    assert.equal(harness.audios.length, 1);
    assert.deepEqual(player.getState(), { speaking: true, messageId: "m1" });

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
  const harness = install({
    autoEnd: false,
    rpc: (method) => (method === "status" ? statusWith() : okAudio([b64("one")])),
  });
  try {
    await reset();

    void player.speak({ messageId: "m1", text: "first message" });
    await tick();
    void player.speak({ messageId: "m2", text: "second message" });
    await tick();

    assert.equal(harness.audios.length, 2);
    assert.equal(harness.audios[0]?.paused, true, "the first chunk must be silenced");
    assert.deepEqual(player.getState(), { speaking: true, messageId: "m2" });
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

test("the browser voice picks a Russian voice for Russian text", async () => {
  const harness = install({
    rpc: (method) => {
      if (method === "status") return statusWith({ speakingRate: 1.4 });
      return { ok: false, code: "not_configured", message: "no key" };
    },
  });
  try {
    await reset();

    await player.speak({ messageId: "m1", text: "Прочитай это вслух" });

    const utterance = harness.utterances[0]!;
    assert.equal(utterance.lang, "ru-RU");
    assert.equal(utterance.voice?.name, "Milena");
    assert.equal(utterance.rate, 1.4, "the cached speaking rate is applied");
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
        : { ok: false, code: "not_configured", message: "No Google API key yet." },
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
    assert.match(harness.toasts[0]!.message, /Add a Google Cloud API key/);
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

test("chunks play back to back, in order, and every object URL is revoked", async () => {
  const harness = install({
    rpc: (method) =>
      method === "status" ? statusWith() : okAudio([b64("one"), b64("two"), b64("three")]),
  });
  try {
    await reset();

    await player.speak({ messageId: "m1", text: "three chunks worth" });

    assert.equal(harness.audios.length, 3);
    assert.deepEqual(
      harness.audios.map((audio) => audio.src),
      harness.created,
      "each chunk plays from the URL made for it, in order",
    );
    assert.deepEqual(harness.revoked, harness.created, "every URL created is revoked");
    assert.equal(player.getState().speaking, false);
  } finally {
    player.stop();
    harness.restore();
  }
});

test("stop() between chunks prevents the next one", async () => {
  const harness = install({
    autoEnd: false,
    rpc: (method) =>
      method === "status" ? statusWith() : okAudio([b64("one"), b64("two"), b64("three")]),
  });
  try {
    await reset();

    void player.speak({ messageId: "m1", text: "three chunks worth" });
    await tick();
    assert.equal(harness.audios.length, 1);

    player.stop();
    assert.equal(player.getState().speaking, false, "stop() is synchronous");

    await tick();
    assert.equal(harness.audios.length, 1, "the queue must not resume after a stop");
    assert.equal(harness.audios[0]?.paused, true);
    assert.deepEqual(harness.revoked, harness.created);
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
  const harness = install({
    refusePlay: true,
    rpc: (method) => (method === "status" ? statusWith() : okAudio([b64("one")])),
  });
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
    assert.equal(player.getState().speaking, false);
    assert.equal(harness.toasts.length, 1);
    assert.equal(harness.toasts[0]?.level, "info");
  } finally {
    player.stop();
    harness.restore();
  }
});

test("stop() with nothing playing is a no-op, and a throwing listener is contained", async () => {
  const harness = install({
    autoEnd: false,
    rpc: (method) => (method === "status" ? statusWith() : okAudio([b64("one")])),
  });
  try {
    await reset();

    player.stop();
    assert.deepEqual(player.getState(), { speaking: false, messageId: null });

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
