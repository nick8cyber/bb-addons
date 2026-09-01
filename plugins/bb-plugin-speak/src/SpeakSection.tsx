/**
 * The plugin's settings section: which voice, how fast, and what happens when
 * Google will not answer.
 *
 * bb renders the API key field itself, from the plugin's `secret` setting,
 * directly above this component — so there is no key input here, and the only
 * thing this section can know about the key is the `configured` boolean the
 * server hands back. What it adds is everything the host form cannot: which
 * voices that key can actually reach, what the reading will sound like, and
 * the two facts a user should have before wiring a billing-backed API into a
 * button they will press by reflex.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { rpc } from "../lib/rpc.js";
import {
  type Prefs,
  type StatusOutput,
  type VoiceRow,
  type VoicesOutput,
} from "./contract.js";
import { player, refreshPrefs } from "./player.js";

/**
 * What the Test button reads. Fixed sentences rather than a sample of the
 * thread, so the row is testing the voice and not the text.
 */
const TEST_SENTENCES: Record<string, string> = {
  "ru-RU": "Проверка голоса. Примерно так будет звучать чтение сообщений.",
  "en-US": "Voice check. This is roughly how a message will sound read aloud.",
};

const FALLBACK_TEST_SENTENCE = "Voice check. This is roughly how a message will sound read aloud.";

/** A language's voice list: still loading, unreachable, or here. */
type Catalog = "loading" | "failed" | VoiceRow[];

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

function VoiceCatalogRow({
  languageCode,
  catalog,
  selected,
  onSelect,
  onTest,
}: {
  languageCode: string;
  catalog: Catalog;
  selected: string;
  onSelect: (voiceName: string) => void;
  onTest: () => void;
}) {
  const rows = Array.isArray(catalog) ? catalog : [];
  // Nothing to choose between yet — but the saved voice still has to be
  // readable, so the select shows it disabled rather than going blank.
  const unavailable = rows.length === 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">
          {languageCode}
        </span>
        <select
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs disabled:opacity-60"
          value={selected}
          disabled={unavailable}
          onChange={(event) => onSelect(event.target.value)}
          aria-label={`Voice for ${languageCode}`}
        >
          <option value="">Let Google choose</option>
          {unavailable
            ? selected !== "" && <option value={selected}>{selected}</option>
            : rows.map((row) => (
                <option key={row.name} value={row.name}>
                  {row.name} · {row.ssmlGender.toLowerCase()}
                </option>
              ))}
        </select>
        <button
          type="button"
          className="shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
          onClick={onTest}
        >
          Test
        </button>
      </div>
      {catalog === "failed" ? (
        <p className="pl-16 text-[11px] text-muted-foreground">
          Google&rsquo;s voice list is out of reach right now. The saved voice is kept as it is.
        </p>
      ) : null}
    </div>
  );
}

export function SpeakSection() {
  const [status, setStatus] = useState<StatusOutput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<Prefs | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, Catalog>>({});
  const [saving, setSaving] = useState(false);

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

  useEffect(() => {
    if (!status) return;
    let cancelled = false;
    setCatalogs(Object.fromEntries(status.autoLanguages.map((code) => [code, "loading"])));
    // Lazily — the catalogs are only worth a round trip once the server has
    // said which languages it offers — and in parallel, because two Google
    // round trips one after the other is a wait the user can see.
    void Promise.all(
      status.autoLanguages.map(async (languageCode): Promise<[string, Catalog]> => {
        try {
          const result = await rpc<VoicesOutput>("voices", { languageCode });
          return [languageCode, result.ok ? result.voices : "failed"];
        } catch {
          return [languageCode, "failed"];
        }
      }),
    ).then((entries) => {
      if (!cancelled) setCatalogs(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [status]);

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
              <span className="font-medium">No Google API key yet.</span> It goes in the field bb
              renders directly above this section — the key stays on the server and is never sent
              back to this page, which is why all it can tell you is whether one is there.
            </p>
            <p className="text-muted-foreground">
              The key has to belong to a Google Cloud project with the{" "}
              <span className="font-mono text-[11px]">Cloud Text-to-Speech API</span> enabled.
            </p>
            <p className="text-muted-foreground">
              That API is not free past its monthly allowance. Google counts characters, and the
              WaveNet and Neural2 voices — including the two this plugin picks by default — are
              billed once the allowance is used up. Check the current pricing before you point a
              billing-backed key at a button you will press without thinking. Until a key is here,
              the browser&rsquo;s own voice does the reading, if the fallback below is on.
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="font-medium text-foreground">Voices</div>
        {status.autoLanguages.map((languageCode) => (
          <VoiceCatalogRow
            key={languageCode}
            languageCode={languageCode}
            catalog={catalogs[languageCode] ?? "loading"}
            selected={form.voices[languageCode] ?? ""}
            onSelect={(voiceName) => {
              const voices = { ...form.voices };
              // An empty pick means "no preference", which the server reads as
              // an absent key rather than as a voice named "".
              if (voiceName) voices[languageCode] = voiceName;
              else delete voices[languageCode];
              setForm({ ...form, voices });
            }}
            onTest={() => {
              void player.speak({
                messageId: `speak-settings-test-${languageCode}`,
                text: TEST_SENTENCES[languageCode] ?? FALLBACK_TEST_SENTENCE,
              });
            }}
          />
        ))}
        <p className="text-[11px] text-muted-foreground">
          Test reads through the same path the message button uses, with the settings as last
          saved — save first to hear an edit.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-3" htmlFor="speak-rate">
          <span className="w-28 shrink-0 font-medium text-foreground">Speaking rate</span>
          <input
            id="speak-rate"
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={form.speakingRate}
            onChange={(event) =>
              setForm({ ...form, speakingRate: Number(event.target.value) })
            }
            className="min-w-0 flex-1"
          />
          <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
            {form.speakingRate.toFixed(1)}×
          </span>
        </label>
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
            Use the browser&rsquo;s voice when Google cannot
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
        paste into a search box — so the button says so whenever it changes engines mid-click.
      </p>
    </div>
  );
}
