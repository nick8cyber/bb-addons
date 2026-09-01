/**
 * The plugin's settings section: which voice, which model, how fast the
 * fallback speaks, and what happens when Gemini will not answer.
 *
 * bb renders the API key field itself, from the plugin's `secret` setting,
 * directly above this component — so there is no key input here, and the only
 * thing this section can know about the key is the `configured` boolean the
 * server hands back. What it adds is everything the host form cannot: which
 * voices there are, what one of them sounds like before it is saved, and the
 * two facts a user should have before wiring a billing-backed API into a
 * button they will press by reflex.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { rpc } from "../lib/rpc.js";
import {
  DEFAULT_VOICE,
  type Prefs,
  type ProbeOutput,
  type StatusOutput,
} from "./contract.js";
import { FAILURE_COPY, player, refreshPrefs } from "./player.js";

function AlertGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "the request failed";
}

/**
 * The server's list, with the saved value forced into it. A voice or model
 * saved before an upgrade dropped it would otherwise make the select go blank
 * and quietly rewrite the setting on the next save.
 */
function withSelected(options: string[], selected: string): string[] {
  return options.includes(selected) ? options : [selected, ...options];
}

export function SpeakSection() {
  const [status, setStatus] = useState<StatusOutput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<Prefs | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void rpc<StatusOutput>("status", {})
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setForm(next.prefs);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(messageOf(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    try {
      const result = await rpc<{ prefs: Prefs }>("savePrefs", { prefs: form });
      setForm(result.prefs);
      // The player holds its own copy of these. Refresh it before the toast,
      // so a user who presses the button the moment it appears gets the
      // settings they just saved and not the ones they replaced.
      await refreshPrefs();
      toast.success("Speak settings saved");
    } catch (error: unknown) {
      // Leave the form exactly as the user left it; the edits are still theirs.
      toast.error(`Could not save the Speak settings: ${messageOf(error)}`);
    } finally {
      setSaving(false);
    }
  }, [form]);

  /**
   * Auditions what is in the form, saved or not — that is the whole point of
   * the button, and why it goes through `probe` rather than through
   * `player.speak`, which reads the saved preferences.
   */
  const test = useCallback(async () => {
    if (!form) return;
    setTesting(true);
    try {
      const result = await rpc<ProbeOutput>("probe", {
        voice: form.voice,
        model: form.model,
      });
      if (!result.ok) {
        toast.error(FAILURE_COPY[result.code]);
        return;
      }
      const heard = await player.preview(result.audioBase64, result.mimeType);
      if (!heard) toast.error("This browser would not play the audio Gemini returned.");
    } catch (error: unknown) {
      toast.error(`Could not reach Gemini for a test: ${messageOf(error)}`);
    } finally {
      setTesting(false);
    }
  }, [form]);

  if (loadError) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Could not read the Speak settings: {loadError}
      </p>
    );
  }

  if (!status || !form) {
    // A quiet line, not a spinner: this resolves in a few milliseconds on a
    // local server and a spinner would only flash.
    return <p className="text-xs leading-relaxed text-muted-foreground">Reading settings…</p>;
  }

  return (
    <div className="flex flex-col gap-4 text-xs leading-relaxed">
      {status.configured ? null : (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <AlertGlyph className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
          <div className="min-w-0 flex-1 space-y-1.5 text-foreground">
            <p>
              <span className="font-medium">No Gemini API key yet.</span> It goes in the field bb
              renders directly above this section — the key stays on the server and is never sent
              back to this page, which is why all it can tell you is whether one is there.
            </p>
            <p className="text-muted-foreground">
              It has to be an <span className="font-medium">AI Studio</span> key, from{" "}
              <a
                className="underline underline-offset-2"
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
              >
                aistudio.google.com/app/apikey
              </a>
              . A Google Cloud console key for the{" "}
              <span className="font-mono text-[11px]">Cloud Text-to-Speech API</span> is a
              different key for a different API, and this plugin no longer uses it — paste one
              here and Gemini will simply reject it.
            </p>
            <p className="text-muted-foreground">
              Gemini TTS is billed per token, with a free tier on the flash model and none on pro.
              Check the current pricing before you point a billing-backed key at a button you will
              press without thinking. Until a key is here, the browser&rsquo;s own voice does the
              reading, if the fallback below is on.
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <label className="w-28 shrink-0 font-medium text-foreground" htmlFor="speak-voice">
            Voice
          </label>
          <select
            id="speak-voice"
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
            value={form.voice}
            onChange={(event) => setForm({ ...form, voice: event.target.value })}
          >
            {withSelected(status.voices, form.voice).map((voice) => (
              <option key={voice} value={voice}>
                {/* Thirty star names in alphabetical order give a reader no
                    reason to start anywhere in particular. This is the one. */}
                {voice === DEFAULT_VOICE ? `${voice} — default` : voice}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
            disabled={testing || !status.configured}
            onClick={() => void test()}
          >
            {testing ? "Testing…" : "Test"}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <label className="w-28 shrink-0 font-medium text-foreground" htmlFor="speak-model">
            Model
          </label>
          <select
            id="speak-model"
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 font-mono text-[11px]"
            value={form.model}
            onChange={(event) => setForm({ ...form, model: event.target.value })}
          >
            {withSelected(status.models, form.model).map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>

        <p className="text-[11px] text-muted-foreground">
          {status.configured
            ? "Test reads one fixed sentence with the voice and model selected here, saved or not — it is how you hear an edit before keeping it."
            : "Test needs a key: it is Gemini that speaks it, and the point is to hear the Gemini voice."}{" "}
          The voices are multilingual, so one of them covers every language a message might be in.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-3" htmlFor="speak-rate">
          <span className="w-28 shrink-0 font-medium text-foreground">Fallback rate</span>
          <input
            id="speak-rate"
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={form.browserRate}
            onChange={(event) => setForm({ ...form, browserRate: Number(event.target.value) })}
            className="min-w-0 flex-1"
          />
          <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
            {form.browserRate.toFixed(1)}×
          </span>
        </label>
        <p className="pl-[7.75rem] text-[11px] text-muted-foreground">
          The browser&rsquo;s own voice only. Gemini TTS has no rate parameter — its pace is a
          matter of how the model reads the text — so this leaves it untouched.
        </p>
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 size-3.5 shrink-0"
          checked={form.fallbackEnabled}
          onChange={(event) => setForm({ ...form, fallbackEnabled: event.target.checked })}
        />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-foreground">
            Use the browser&rsquo;s voice when Gemini cannot
          </span>
          <span className="block text-muted-foreground">
            Missing key, rejected key, rate limit, unreachable server. Off means the button says
            what went wrong and stays quiet.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="border-t" />
      <p className="text-muted-foreground">
        Where the words go: with a key configured, the text of the message is sent to Google to be
        turned into audio. With the browser voice, it never leaves this machine. Which of the two
        just happened is worth knowing before you press the button on something you would not
        paste into a search box — so a hand-off to the browser voice says so. Running with no key
        at all says it once a session rather than on every click, because then it is not an event.
      </p>
    </div>
  );
}
