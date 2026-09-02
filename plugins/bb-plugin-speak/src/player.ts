/**
 * The one voice.
 *
 * There is exactly one pair of speakers, and the message button is a plain
 * `run` callback with no component around it to hang React state on — so
 * playback lives here, as a module-level singleton, and anything that wants to
 * render it subscribes.
 *
 * Two engines sit behind one `speak()`. Gemini's TTS is the good one and needs
 * a key; the browser's own `speechSynthesis` is the one that is always there.
 * Which of the two spoke is not a detail — the text leaves the machine in the
 * first case and does not in the second — so every hand-off between them is
 * announced.
 *
 * Gemini answers with uncompressed 24 kHz audio: about 4.8 KB of base64 per
 * character of input, which makes a whole message in one response megabytes of
 * silence to wait through. So the message goes chunk by chunk, and this file
 * is the loop that keeps one chunk in flight while the previous one plays.
 */

import { toast } from "sonner";

import { PLUGIN_SYNTHESIZE_ENDPOINT, rpc } from "../lib/rpc.js";
import {
  AUDIO_MIME,
  DEFAULT_PREFS,
  type Prefs,
  type StatusOutput,
  type SynthesisErrorCode,
  type SynthesizeOutput,
} from "./contract.js";
import { chunkForSynthesis } from "./chunk.js";
import { detectLanguage, toSpeakable } from "./speakable.js";

/** Which engine produced the sound. */
export type SpeakSource = "gemini" | "browser";

export type PlaybackStage = "idle" | "generating" | "playing" | "paused";

export interface PlaybackState {
  speaking: boolean;
  messageId: string | null;
  stage: PlaybackStage;
  chunkIndex: number;
  chunkCount: number;
  speed: number;
  voice: string;
}

/**
 * Chrome answers the very first `getVoices()` with an empty array and fills
 * the list a moment later. Waiting for the event it fires is right; waiting
 * for it forever is not, because a browser that never fires it would leave the
 * click doing nothing at all.
 */
const VOICE_LIST_TIMEOUT_MS = 1000;

/** What the user can be told to do about each way synthesis can fail. */
export const FAILURE_COPY: Record<SynthesisErrorCode, string> = {
  not_configured: "Add a Gemini API key in Settings → Extensions → Speak.",
  auth: "Google rejected that Gemini API key. Check it in Settings → Extensions → Speak.",
  rate_limited: "Gemini is rate-limiting this key. Try again in a moment.",
  request_failed: "Gemini text-to-speech could not be reached.",
  empty: "There was nothing in this message to read aloud.",
  too_long: "This message is too long to read aloud in one go.",
};

/**
 * Only these are worth a second engine. `empty` and `too_long` are verdicts on
 * the text, and the browser voice would reach the same one.
 */
function isRetryable(code: SynthesisErrorCode): boolean {
  return (
    code === "not_configured" ||
    code === "auth" ||
    code === "rate_limited" ||
    code === "request_failed"
  );
}

const SPEED_STORAGE_KEY = "bb_speak_playback_speed";

function loadSavedSpeed(): number {
  if (typeof localStorage === "undefined") return 1;
  try {
    const saved = Number(localStorage.getItem(SPEED_STORAGE_KEY));
    return [0.75, 1, 1.25, 1.5, 2].includes(saved) ? saved : 1;
  } catch {
    return 1;
  }
}

let currentSpeed = loadSavedSpeed();
let state: PlaybackState = {
  speaking: false,
  messageId: null,
  stage: "idle",
  chunkIndex: 0,
  chunkCount: 0,
  speed: currentSpeed,
  voice: DEFAULT_PREFS.voice,
};
const listeners = new Set<(state: PlaybackState) => void>();

/**
 * Bumped by every `stop()`, and therefore by every `speak()`, which stops
 * first. Each async step of a playback holds the generation it started under
 * and compares before acting; a mismatch means something newer has taken the
 * speakers and this step must touch nothing.
 */
let generation = 0;

let currentAudio: HTMLAudioElement | null = null;

/**
 * Resolves whatever the playback loop is currently waiting on. `pause()` and
 * `cancel()` do not reliably fire an end event, so `stop()` calls this by hand
 * rather than leaving the loop parked on a promise that will never settle.
 */
let endCurrent: (() => void) | null = null;

/**
 * All chunk requests currently in flight. `stop()` aborts all of them.
 */
const inFlightRequests = new Set<AbortController>();

/** Object URLs handed to an `<audio>` and not yet revoked. */
const liveUrls = new Set<string>();

function setState(next: Partial<PlaybackState>): void {
  const merged: PlaybackState = { ...state, ...next };
  if (
    merged.speaking === state.speaking &&
    merged.messageId === state.messageId &&
    merged.stage === state.stage &&
    merged.chunkIndex === state.chunkIndex &&
    merged.chunkCount === state.chunkCount &&
    merged.speed === state.speed &&
    merged.voice === state.voice
  ) {
    return;
  }
  state = merged;
  // Snapshot: a listener is allowed to unsubscribe itself from inside the call.
  for (const listener of [...listeners]) {
    try {
      listener(state);
    } catch {
      // One subscriber throwing is that subscriber's problem. The rest of the
      // UI still has to learn that the audio started or stopped.
    }
  }
}

// --- preferences ------------------------------------------------------------

let cachedPrefs: Prefs | null = null;
let inFlightPrefs: Promise<Prefs> | null = null;

async function fetchPrefs(): Promise<Prefs> {
  try {
    const status = await rpc<StatusOutput>("status", {});
    return status.prefs;
  } catch {
    // The button still has to do something when the settings round trip
    // fails. The defaults leave the browser fallback switched on, which is
    // the harmless way to be wrong: it speaks, and it speaks locally.
    return DEFAULT_PREFS;
  }
}

function loadPrefs(): Promise<Prefs> {
  if (cachedPrefs) return Promise.resolve(cachedPrefs);
  inFlightPrefs ??= fetchPrefs().then((prefs) => {
    cachedPrefs = prefs;
    inFlightPrefs = null;
    return prefs;
  });
  return inFlightPrefs;
}

/**
 * Drop the cached preferences and read them back. The settings page calls this
 * after a save: a stale copy here would send the old voice, or fall back to
 * the browser voice right after the user switched that off.
 */
export async function refreshPrefs(): Promise<void> {
  cachedPrefs = null;
  inFlightPrefs = null;
  // A save may well be the key arriving. Let the one-shot notices speak again
  // rather than staying silent about a hand-off that now means something else.
  announcedOnce.clear();
  await loadPrefs();
}

// --- the browser's own voice ------------------------------------------------

interface BrowserVoice {
  synth: SpeechSynthesis;
  Utterance: typeof SpeechSynthesisUtterance;
}

/** Both halves or neither: an utterance with nothing to speak it is no use. */
function browserVoice(): BrowserVoice | null {
  const scope = globalThis as {
    speechSynthesis?: SpeechSynthesis;
    SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
  };
  if (!scope.speechSynthesis || !scope.SpeechSynthesisUtterance) return null;
  return {
    synth: scope.speechSynthesis,
    Utterance: scope.SpeechSynthesisUtterance,
  };
}

function cancelBrowserVoice(): void {
  const scope = globalThis as { speechSynthesis?: SpeechSynthesis };
  try {
    scope.speechSynthesis?.cancel();
  } catch {
    // Some engines throw when asked to cancel nothing. Nothing is what we want.
  }
}

function normalizeLang(lang: string): string {
  return lang.replace(/_/g, "-").toLowerCase();
}

function waitForVoices(synth: SpeechSynthesis): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof synth.addEventListener !== "function") {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      synth.removeEventListener("voiceschanged", finish);
      resolve();
    };
    const timer = setTimeout(finish, VOICE_LIST_TIMEOUT_MS);
    synth.addEventListener("voiceschanged", finish);
  });
}

async function pickVoice(
  synth: SpeechSynthesis,
  languageCode: string,
): Promise<SpeechSynthesisVoice | null> {
  let voices = synth.getVoices();
  if (voices.length === 0) {
    await waitForVoices(synth);
    voices = synth.getVoices();
  }
  const wanted = normalizeLang(languageCode);
  const base = wanted.split("-")[0];
  return (
    voices.find((voice) => normalizeLang(voice.lang) === wanted) ??
    // `ru` for `ru-RU` is a better answer than the engine's default, which on
    // an English system reads Cyrillic letter by letter.
    voices.find((voice) => normalizeLang(voice.lang).split("-")[0] === base) ??
    null
  );
}

async function speakWithBrowserVoice(
  mine: number,
  text: string,
  languageCode: string,
  prefs: Prefs,
  voice: BrowserVoice,
): Promise<void> {
  // Chrome keeps a previous utterance queued rather than replacing it, so the
  // cancel is what makes this the only thing speaking.
  voice.synth.cancel();

  const installed = await pickVoice(voice.synth, languageCode);
  if (mine !== generation) return;

  const utterance = new voice.Utterance(text);
  utterance.lang = languageCode;
  // Gemini takes no rate parameter, so this is the only engine the setting can
  // reach — hence its name.
  utterance.rate = prefs.browserRate;
  if (installed) utterance.voice = installed;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (endCurrent === finish) endCurrent = null;
      resolve();
    };
    endCurrent = finish;
    utterance.onend = finish;
    utterance.onerror = finish;
    voice.synth.speak(utterance);
  });

  if (mine === generation) setState({ speaking: false, messageId: null, stage: "idle" });
}

// --- Gemini's audio ---------------------------------------------------------

let sharedAudioCtx: AudioContext | null = null;
let currentBufferSource: AudioBufferSourceNode | null = null;

function getAudioContext(): AudioContext | null {
  const scope = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioCtx = scope.AudioContext || scope.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    try {
      sharedAudioCtx = new AudioCtx();
    } catch {
      return null;
    }
  }
  if (sharedAudioCtx.state === "suspended") {
    void sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

function unlockAudio(): void {
  try {
    const ctx = getAudioContext();
    if (ctx) {
      if (ctx.state === "suspended") {
        void ctx.resume().catch(() => {});
      }
      // Play 1 silent frame to unlock iOS Web Audio hardware pipeline
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    }
  } catch {
    // Ignore environments without Web Audio
  }
}

// Auto-warm audio on the first user interaction anywhere on mobile
if (typeof document !== "undefined") {
  const warmUp = () => {
    unlockAudio();
    document.removeEventListener("touchstart", warmUp);
    document.removeEventListener("touchend", warmUp);
    document.removeEventListener("click", warmUp);
  };
  document.addEventListener("touchstart", warmUp, { passive: true, once: true });
  document.addEventListener("touchend", warmUp, { passive: true, once: true });
  document.addEventListener("click", warmUp, { passive: true, once: true });
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

/** Idempotent: `stop()` and the playback loop both try to revoke the same URL. */
function revoke(url: string): void {
  if (!liveUrls.delete(url)) return;
  URL.revokeObjectURL(url);
}

function revokeAll(): void {
  for (const url of [...liveUrls]) revoke(url);
}

async function playWithAudioContext(base64: string, mine: number): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state === "suspended") {
    await ctx.resume().catch(() => {});
  }
  const arrayBuffer = base64ToArrayBuffer(base64);
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  } catch {
    return false;
  }
  if (mine !== generation) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    currentBufferSource = source;

    const finish = (heard: boolean) => {
      if (settled) return;
      settled = true;
      if (currentBufferSource === source) currentBufferSource = null;
      if (endCurrent === silence) endCurrent = null;
      resolve(heard);
    };
    const silence = () => {
      try {
        source.stop();
      } catch {
        // Ignored
      }
      finish(false);
    };

    endCurrent = silence;
    source.onended = () => finish(true);
    try {
      source.start(0);
    } catch {
      silence();
    }
  });
}

/** Resolves with whether the chunk actually reached the speakers. */
function playOne(url: string, mine: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const audio = new Audio(url);

    const applySpeed = () => {
      try {
        audio.preservesPitch = true;
        (audio as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
        (audio as unknown as { mozPreservesPitch?: boolean }).mozPreservesPitch = true;
        audio.playbackRate = currentSpeed;
      } catch {}
    };

    applySpeed();
    if (typeof audio.addEventListener === "function") {
      audio.addEventListener("loadedmetadata", applySpeed);
      audio.addEventListener("canplay", applySpeed);
      audio.addEventListener("play", applySpeed);
    }

    let settled = false;
    const finish = (heard: boolean) => {
      if (settled) return;
      settled = true;
      if (currentAudio === audio) currentAudio = null;
      if (endCurrent === silence) endCurrent = null;
      resolve(heard);
    };
    const silence = () => finish(false);
    currentAudio = audio;
    endCurrent = silence;
    audio.onended = () => finish(true);
    // A chunk the browser cannot decode ends that chunk, not the queue.
    audio.onerror = silence;
    if (mine !== generation) {
      silence();
      return;
    }
    // A rejected `play()` is an autoplay refusal. It is not supposed to happen
    // behind a click, and when it does the user hears nothing at all — so it
    // is counted, not swallowed.
    void Promise.resolve(audio.play())
      .then(applySpeed)
      .catch(silence);
  });
}

/** Decode, play, and give the object URL back. Resolves with whether it sounded. */
async function playAudio(
  base64: string,
  mimeType: string,
  mine: number,
): Promise<boolean> {
  // A stop that lands between two chunks must not start the next one.
  if (mine !== generation) return false;

  // Prefer HTMLAudioElement for native WSOLA pitch preservation (no chipmunk effect)
  const url = URL.createObjectURL(base64ToBlob(base64, mimeType));
  liveUrls.add(url);
  try {
    const heard = await playOne(url, mine);
    if (heard) return true;
    if (mine !== generation) return false;
  } finally {
    revoke(url);
  }

  // Fallback to Web Audio Context if HTMLAudio is unsupported in environment
  const scope = globalThis as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  if (scope.AudioContext || scope.webkitAudioContext) {
    const heard = await playWithAudioContext(base64, mine);
    if (heard) return true;
  }

  return false;
}

/**
 * One chunk, cancellably.
 *
 * `rpc()` has no signal parameter. The cancellable synthesis path therefore
 * uses the plugin's HTTP route, whose Hono request signal stays linked to this
 * fetch and is forwarded to Gemini. Everything else about the envelope is the
 * same.
 */
async function fetchChunk(
  text: string,
  chunkIndex: number,
): Promise<SynthesizeOutput> {
  const controller = new AbortController();
  inFlightRequests.add(controller);
  try {
    const response = await fetch(PLUGIN_SYNTHESIZE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, chunkIndex }),
      signal: controller.signal,
    });
    const body = (await response.json()) as
      | { ok: true; result: SynthesizeOutput }
      | { ok: false; error?: unknown };
    if (!body?.ok) throw new Error(`synthesize failed (HTTP ${response.status})`);
    return body.result;
  } finally {
    inFlightRequests.delete(controller);
  }
}

type ChunkRequestResult = { output: SynthesizeOutput } | { error: true };

/**
 * Observe rejection as soon as fetch-ahead starts, even though the playback
 * loop may not inspect the result until the current chunk has finished. A raw
 * rejected promise left parked for several seconds would otherwise reach the
 * browser as an `unhandledrejection` before the loop got around to its catch.
 */
function startChunkRequest(
  text: string,
  chunkIndex: number,
): Promise<ChunkRequestResult> {
  return fetchChunk(text, chunkIndex).then(
    (output) => ({ output }),
    () => ({ error: true }),
  );
}

// --- the public surface -----------------------------------------------------

/**
 * Codes already announced for a hand-off in this session. `not_configured` is
 * a steady state, not an event: someone running deliberately without a key
 * should be told once, not on every click for the rest of the session.
 */
const announcedOnce = new Set<SynthesisErrorCode>();
const ANNOUNCE_ONCE: ReadonlySet<SynthesisErrorCode> = new Set(["not_configured"]);

/**
 * The server's own message, when it says more than our generic copy does.
 *
 * FAILURE_COPY tells the user what to do; it cannot tell them what happened,
 * and "could not be reached" in place of "unknown provider for model X" sends
 * someone looking at their network instead of their model setting. The server
 * has already redacted the key out of this and capped it.
 */
const DETAIL_ADDS_NOTHING: ReadonlySet<SynthesisErrorCode> = new Set([
  // For these the generic copy already says both what happened and what to do,
  // and the server's wording only repeats it at greater length.
  "empty",
  "too_long",
  "not_configured",
  "rate_limited",
]);

function detailSuffix(
  detail: string | undefined,
  reason: string,
  code: SynthesisErrorCode,
): string {
  if (DETAIL_ADDS_NOTHING.has(code)) return "";
  const trimmed = (detail ?? "").trim();
  if (trimmed.length === 0) return "";
  if (reason.toLowerCase().includes(trimmed.toLowerCase())) return "";
  return ` (${trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed})`;
}

function announce(
  code: SynthesisErrorCode,
  next: SpeakSource | null,
  detail?: string,
): void {
  const reason = FAILURE_COPY[code] + detailSuffix(detail, FAILURE_COPY[code], code);
  if (next !== "browser") {
    toast.error(reason);
    return;
  }
  if (!ANNOUNCE_ONCE.has(code) || !announcedOnce.has(code)) {
    announcedOnce.add(code);
    toast.info(`${reason} Reading with the browser's own voice instead.`);
  }
}

/** Stop playback and hand over to the browser's own synthesizer. */
async function failOver(
  mine: number,
  code: SynthesisErrorCode,
  text: string,
  prefs: Prefs,
  detail?: string,
): Promise<void> {
  if (mine !== generation) return;
  // Whatever happens next, the chunks queued behind this one will never be
  // played. Stop paying for them.
  abortInFlight();

  if (!isRetryable(code) || !prefs.fallbackEnabled) {
    setState({ speaking: false, messageId: null, stage: "idle" });
    announce(code, null, detail);
    return;
  }

  const voice = browserVoice();
  if (!voice) {
    setState({ speaking: false, messageId: null, stage: "idle" });
    toast.error(
      `${FAILURE_COPY[code]} This browser has no speech synthesis of its own to fall back on.`,
    );
    return;
  }

  announce(code, "browser", detail);
  await speakWithBrowserVoice(mine, text, detectLanguage(text), prefs, voice);
}

/**
 * A later chunk failed. Gemini was reached, spoke at least once, and the run
 * ended there. So: stop, and say that it was cut short.
 */
function cutShort(code: SynthesisErrorCode, chunkIndex: number, detail?: string): void {
  abortInFlight();
  setState({ speaking: false, messageId: null, stage: "idle" });
  toast.error(
    `${FAILURE_COPY[code]}${detailSuffix(detail, FAILURE_COPY[code], code)} ` +
      `The reading stopped part-way through this message ` +
      `(chunk ${chunkIndex + 1}); the rest was not read aloud.`,
  );
}

/**
 * Drop every chunk request still in flight, without ending the playback the
 * way `stop()` does.
 *
 * The loop fetches up to five chunks ahead, so a reading that dies on chunk 1
 * leaves four speculative requests running for audio nobody will hear. Against
 * a pool metered at roughly ten requests a day per model per account, that is
 * the difference between one wasted request and five.
 */
function abortInFlight(): void {
  for (const controller of inFlightRequests) {
    controller.abort();
  }
  inFlightRequests.clear();
}

function stop(): void {
  generation += 1;

  // Before anything else: nothing new should arrive for a playback that is
  // over. `abort()` rejects the pending fetch, and the loop's generation guard
  // turns that rejection into a silent return rather than a failure notice.
  abortInFlight();

  const source = currentBufferSource;
  currentBufferSource = null;
  if (source) {
    try {
      source.stop();
    } catch {
      // Ignored
    }
  }

  const audio = currentAudio;
  currentAudio = null;
  if (audio) {
    try {
      audio.pause();
    } catch {
      // A detached element can refuse; it is already silent either way.
    }
  }

  // Unpark the playback loop before it can be told to continue: the bump
  // above is what makes it stop, this is only what makes it look.
  const finish = endCurrent;
  endCurrent = null;
  finish?.();

  cancelBrowserVoice();
  revokeAll();
  setState({
    speaking: false,
    messageId: null,
    stage: "idle",
    chunkIndex: 0,
    chunkCount: 0,
  });
}

/** Resolves on the next state change, whatever it is. */
function onceStateChanged(): Promise<void> {
  return new Promise((resolve) => {
    const listener = (): void => {
      listeners.delete(listener);
      resolve();
    };
    listeners.add(listener);
  });
}

/**
 * Holds while the reading is paused.
 *
 * Without this the loop walks straight on to the next chunk and overwrites the
 * paused stage with "playing" — the bar says paused and the voice keeps
 * reading, which is worse than the pause button not existing.
 */
async function awaitResume(mine: number): Promise<void> {
  while (state.stage === "paused" && mine === generation) {
    await onceStateChanged();
  }
}

function pause(): void {
  if (state.stage !== "playing") return;
  const ctx = getAudioContext();
  if (ctx && ctx.state === "running") {
    void ctx.suspend().catch(() => {});
  }
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {}
  }
  const scope = globalThis as { speechSynthesis?: SpeechSynthesis };
  if (scope.speechSynthesis?.speaking) {
    try {
      scope.speechSynthesis.pause();
    } catch {}
  }
  setState({ stage: "paused" });
}

function resume(): void {
  if (state.stage !== "paused") return;
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }
  if (currentAudio) {
    try {
      void currentAudio.play();
    } catch {}
  }
  const scope = globalThis as { speechSynthesis?: SpeechSynthesis };
  if (scope.speechSynthesis?.paused) {
    try {
      scope.speechSynthesis.resume();
    } catch {}
  }
  setState({ stage: "playing" });
}

function setSpeed(speed: number): void {
  currentSpeed = speed;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(SPEED_STORAGE_KEY, String(speed));
    } catch {}
  }
  if (currentAudio) {
    try {
      currentAudio.preservesPitch = true;
      (currentAudio as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
      (currentAudio as unknown as { mozPreservesPitch?: boolean }).mozPreservesPitch = true;
      currentAudio.playbackRate = speed;
    } catch {}
  }
  if (currentBufferSource) {
    try {
      currentBufferSource.playbackRate.value = speed;
    } catch {}
  }
  setState({ speed });
}

/**
 * Parallel pipelining: chunks are pre-fetched immediately in parallel.
 * As soon as the user clicks, chunks 0, 1, 2, 3... are sent concurrently.
 */
async function streamChunks(
  mine: number,
  text: string,
  totalChunks: number,
  prefs: Prefs,
): Promise<boolean | null> {
  const chunkRequests = new Map<number, Promise<ChunkRequestResult>>();

  function getOrFetch(idx: number): Promise<ChunkRequestResult> {
    let req = chunkRequests.get(idx);
    if (!req) {
      req = startChunkRequest(text, idx);
      chunkRequests.set(idx, req);
    }
    return req;
  }

  // Pre-fetch all initial chunks concurrently right at start (T=0)
  for (let i = 0; i < Math.min(totalChunks, 5); i += 1) {
    getOrFetch(i);
  }

  let index = 0;
  let heard = false;

  for (;;) {
    // A pause taken in the gap between two chunks has to hold here, before
    // anything overwrites the stage or starts the next piece of audio.
    await awaitResume(mine);
    if (mine !== generation) return null;

    setState({
      stage: index === 0 && !heard ? "generating" : "playing",
      chunkIndex: index,
      chunkCount: totalChunks,
    });

    const result = await getOrFetch(index);
    if ("error" in result) {
      if (mine !== generation) return null;
      if (index === 0) {
        await failOver(mine, "request_failed", text, prefs);
        return null;
      }
      cutShort("request_failed", index);
      return null;
    }
    if (mine !== generation) return null;
    const output = result.output;

    if (!output.ok) {
      if (index === 0) {
        await failOver(mine, output.code, text, prefs, output.message);
        return null;
      }
      cutShort(output.code, index, output.message);
      return null;
    }

    totalChunks = output.chunkCount;

    // Immediately launch parallel pre-fetch for all remaining chunks in the message!
    for (let ahead = index + 1; ahead < Math.min(totalChunks, index + 6); ahead += 1) {
      getOrFetch(ahead);
    }

    await awaitResume(mine);
    if (mine !== generation) return null;

    setState({
      stage: "playing",
      chunkIndex: index,
      chunkCount: totalChunks,
      voice: output.voice || prefs.voice,
    });

    heard = (await playAudio(output.audioBase64, output.mimeType, mine)) || heard;
    if (mine !== generation) return null;

    if (index + 1 >= totalChunks) return heard;
    index += 1;
  }
}

async function speak(args: { messageId: string; text: string }): Promise<void> {
  unlockAudio();
  const text = toSpeakable(args.text);
  if (!text) {
    toast.info(
      "Nothing here to read aloud — this message is code or markup all the way down.",
    );
    return;
  }

  const pieces = chunkForSynthesis(text);
  if (pieces.length === 0) return;

  // The ordering below is the whole reason two voices cannot end up in the
  // room together: silence what is playing FIRST, and only then decide
  // whether this click was a toggle. Deciding first and stopping second
  // leaves a window in which the new playback has already begun.
  const wasSpeaking = state.speaking;
  const previousId = state.messageId;
  stop();
  if (wasSpeaking && previousId === args.messageId) return;

  // `stop()` has just bumped the generation; this run owns the new one.
  const mine = generation;
  setState({
    speaking: true,
    messageId: args.messageId,
    stage: "generating",
    chunkIndex: 0,
    chunkCount: pieces.length,
    speed: currentSpeed,
  });

  const prefs = await loadPrefs();
  if (mine !== generation) return;

  const heard = await streamChunks(mine, text, pieces.length, prefs);
  if (heard === null || mine !== generation) return;
  setState({ speaking: false, messageId: null, stage: "idle" });
  if (!heard) {
    // Gemini answered, the audio did not arrive at the speakers, and the user
    // is looking at a button that appeared to do nothing. Say so.
    toast.error(
      "Gemini returned audio this browser would not play. Try again, or turn on " +
        "the browser voice in Settings → Extensions → Speak.",
    );
  }
}

/** No message has this id, so no message button lights up for an audition. */
export const PREVIEW_MESSAGE_ID = "speak:preview";

/**
 * Play one ready-made clip — what the settings page's Test button does with
 * the audio `probe` hands back. It goes through this rather than through
 * `speak()` so that an audition uses the unsaved voice in the form, and still
 * shares the one pair of speakers: a Test interrupts a reading, and a reading
 * interrupts a Test.
 */
async function preview(audioBase64: string, mimeType: string = AUDIO_MIME): Promise<boolean> {
  unlockAudio();
  stop();
  const mine = generation;
  setState({ speaking: true, messageId: PREVIEW_MESSAGE_ID, stage: "playing" });
  const heard = await playAudio(audioBase64, mimeType, mine);
  if (mine === generation) setState({ speaking: false, messageId: null, stage: "idle" });
  return heard;
}

export const player = {
  /** Speak this text. Clicking the message that is already speaking stops it. */
  speak,
  preview,
  stop,
  pause,
  resume,
  setSpeed,
  getSpeed(): number {
    return currentSpeed;
  },
  getState(): PlaybackState {
    return state;
  },
  subscribe(listener: (state: PlaybackState) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
