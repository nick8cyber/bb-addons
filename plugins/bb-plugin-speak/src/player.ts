/**
 * The one voice.
 *
 * There is exactly one pair of speakers, and the message button is a plain
 * `run` callback with no component around it to hang React state on — so
 * playback lives here, as a module-level singleton, and anything that wants to
 * render it subscribes.
 *
 * Two engines sit behind one `speak()`. Google Cloud Text-to-Speech is the
 * good one and needs a key; the browser's own `speechSynthesis` is the one
 * that is always there. Which of the two spoke is not a detail — the text
 * leaves the machine in the first case and does not in the second — so every
 * hand-off between them is announced.
 */

import { toast } from "sonner";

import { rpc } from "../lib/rpc.js";
import {
  DEFAULT_PREFS,
  type Prefs,
  type StatusOutput,
  type SynthesisErrorCode,
  type SynthesizeOutput,
} from "./contract.js";
import { detectLanguage, toSpeakable } from "./speakable.js";

/** Which engine produced the sound. */
export type SpeakSource = "google" | "browser";

export interface PlaybackState {
  speaking: boolean;
  messageId: string | null;
}

/**
 * Chrome answers the very first `getVoices()` with an empty array and fills
 * the list a moment later. Waiting for the event it fires is right; waiting
 * for it forever is not, because a browser that never fires it would leave the
 * click doing nothing at all.
 */
const VOICE_LIST_TIMEOUT_MS = 1000;

/** What the user can be told to do about each way synthesis can fail. */
const FAILURE_COPY: Record<SynthesisErrorCode, string> = {
  not_configured:
    "Add a Google Cloud API key in Settings → Extensions → Speak.",
  auth: "Google rejected that API key. Check it in Settings → Extensions → Speak.",
  rate_limited: "Google is rate-limiting this key. Try again in a moment.",
  request_failed: "Google Text-to-Speech could not be reached.",
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

let state: PlaybackState = { speaking: false, messageId: null };
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

/** Object URLs handed to an `<audio>` and not yet revoked. */
const liveUrls = new Set<string>();

function setState(next: PlaybackState): void {
  if (next.speaking === state.speaking && next.messageId === state.messageId)
    return;
  state = next;
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
 * after a save: a stale copy here would send the old speaking rate, or fall
 * back to the browser voice right after the user switched that off.
 */
export async function refreshPrefs(): Promise<void> {
  cachedPrefs = null;
  inFlightPrefs = null;
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
  utterance.rate = prefs.speakingRate;
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

  if (mine === generation) setState({ speaking: false, messageId: null });
}

// --- Google's audio ---------------------------------------------------------

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

/** Resolves with whether the chunk actually reached the speakers. */
function playOne(url: string, mine: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const audio = new Audio(url);
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
    void Promise.resolve(audio.play()).catch(silence);
  });
}

/** Resolves with whether any chunk made a sound. */
async function playChunks(
  chunks: string[],
  mimeType: string,
  mine: number,
): Promise<boolean> {
  let heard = false;
  for (const chunk of chunks) {
    // A stop that lands between two chunks must not start the next one.
    if (mine !== generation) return heard;
    const url = URL.createObjectURL(base64ToBlob(chunk, mimeType));
    liveUrls.add(url);
    try {
      heard = (await playOne(url, mine)) || heard;
    } finally {
      revoke(url);
    }
  }
  return heard;
}

// --- the public surface -----------------------------------------------------

function announce(code: SynthesisErrorCode, next: SpeakSource | null): void {
  const reason = FAILURE_COPY[code];
  toast.error(
    next === "browser"
      ? `${reason} Reading with the browser's own voice instead.`
      : reason,
  );
}

async function failOver(
  mine: number,
  code: SynthesisErrorCode,
  text: string,
  languageCode: string,
  prefs: Prefs,
): Promise<void> {
  if (mine !== generation) return;

  if (!isRetryable(code) || !prefs.fallbackEnabled) {
    setState({ speaking: false, messageId: null });
    announce(code, null);
    return;
  }

  const voice = browserVoice();
  if (!voice) {
    setState({ speaking: false, messageId: null });
    toast.error(
      `${FAILURE_COPY[code]} This browser has no speech synthesis of its own to fall back on.`,
    );
    return;
  }

  announce(code, "browser");
  await speakWithBrowserVoice(mine, text, languageCode, prefs, voice);
}

function stop(): void {
  generation += 1;

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
  setState({ speaking: false, messageId: null });
}

async function speak(args: { messageId: string; text: string }): Promise<void> {
  const text = toSpeakable(args.text);
  if (!text) {
    toast.info(
      "Nothing here to read aloud — this message is code or markup all the way down.",
    );
    return;
  }

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
  setState({ speaking: true, messageId: args.messageId });

  const languageCode = detectLanguage(text);
  const prefs = await loadPrefs();
  if (mine !== generation) return;

  let output: SynthesizeOutput;
  try {
    output = await rpc<SynthesizeOutput>("synthesize", { text, languageCode });
  } catch {
    // The thrown message quotes the server at the user. Ours says what to do.
    await failOver(mine, "request_failed", text, languageCode, prefs);
    return;
  }
  if (mine !== generation) return;

  if (!output.ok) {
    await failOver(mine, output.code, text, languageCode, prefs);
    return;
  }

  const heard = await playChunks(output.chunks, output.mimeType, mine);
  if (mine !== generation) return;
  setState({ speaking: false, messageId: null });
  if (!heard) {
    // Google answered, the audio did not arrive at the speakers, and the user
    // is looking at a button that appeared to do nothing. Say so.
    toast.error(
      "Google returned audio this browser would not play. Try again, or turn on " +
        "the browser voice in Settings → Extensions → Speak.",
    );
  }
}

export const player = {
  /** Speak this text. Clicking the message that is already speaking stops it. */
  speak,
  stop,
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
