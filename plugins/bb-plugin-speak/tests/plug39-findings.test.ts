/**
 * PLUG-39 audit reproductions.
 *
 * These tests intentionally fail at 8217596. They describe defects rather than
 * changing plugin behaviour:
 *   node --experimental-strip-types --test tests/plug39-findings.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const VIRTUAL_SONNER = "plug39:sonner";
const VIRTUAL_SPEAKABLE = "plug39:speakable";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "sonner") return { url: VIRTUAL_SONNER, shortCircuit: true };
    if (specifier.endsWith("speakable.js")) {
      return { url: VIRTUAL_SPEAKABLE, shortCircuit: true };
    }
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
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export const toast = Object.assign(() => {}, " +
          "{ info() {}, error() {}, success() {}, warning() {} });",
      };
    }
    if (url === VIRTUAL_SPEAKABLE) {
      return {
        format: "module",
        shortCircuit: true,
        source:
          'export const toSpeakable = (text) => String(text).trim();' +
          'export const detectLanguage = () => "en-US";',
      };
    }
    return nextLoad(url, context);
  },
});

const { contract } = await import("../src/contract.js");
const { chunkForSynthesis } = await import("../src/chunk.js");
const { redact } = await import("../src/gemini-tts.js");
const { player, refreshPrefs } = await import("../src/player.js");

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class ResumeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  rejectNextPlay = false;

  play(): Promise<void> {
    if (!this.rejectNextPlay) return Promise.resolve();
    this.rejectNextPlay = false;
    const rejected = Promise.reject(new Error("NotAllowedError"));
    // Keep Node from treating the browser-style rejection as an unhandled test
    // error. The player itself still receives and ignores the rejected promise.
    void rejected.catch(() => {});
    return rejected;
  }

  pause(): void {}
}

function installResumeHarness(): { audios: ResumeAudio[]; restore(): void } {
  const scope = globalThis as unknown as Record<string, unknown>;
  const urlApi = URL as unknown as Record<string, unknown>;
  const savedKeys = ["fetch", "Audio", "speechSynthesis", "SpeechSynthesisUtterance"];
  const saved = savedKeys.map((key) => ({ key, had: key in scope, value: scope[key] }));
  const savedCreate = urlApi.createObjectURL;
  const savedRevoke = urlApi.revokeObjectURL;
  const audios: ResumeAudio[] = [];

  scope.fetch = async (input: unknown) => {
    const method = String(input).slice(String(input).lastIndexOf("/") + 1);
    const result =
      method === "status"
        ? {
            configured: true,
            prefs: {
              voice: "Kore",
              model: "model",
              fallbackModel: "",
              browserRate: 1,
              fallbackEnabled: false,
            },
            voices: ["Kore"],
            models: ["model"],
          }
        : {
            ok: true,
            mimeType: "audio/wav",
            voice: "Kore",
            model: "model",
            chunkIndex: 0,
            chunkCount: 1,
            audioBase64: Buffer.from("audio").toString("base64"),
          };
    return { status: 200, json: async () => ({ ok: true, result }) };
  };
  scope.Audio = function Audio() {
    const audio = new ResumeAudio();
    audios.push(audio);
    return audio;
  };
  delete scope.speechSynthesis;
  delete scope.SpeechSynthesisUtterance;
  urlApi.createObjectURL = () => "blob:plug39";
  urlApi.revokeObjectURL = () => {};

  return {
    audios,
    restore() {
      for (const entry of saved) {
        if (entry.had) scope[entry.key] = entry.value;
        else delete scope[entry.key];
      }
      urlApi.createObjectURL = savedCreate;
      urlApi.revokeObjectURL = savedRevoke;
    },
  };
}

test("RUN: a rejected play() on resume must not leave the overlay at Playing", async () => {
  const harness = installResumeHarness();
  let run: Promise<void> | undefined;
  try {
    player.stop();
    await refreshPrefs();
    run = player.speak({ messageId: "resume-rejection", text: "hello" });
    for (let attempt = 0; attempt < 5 && player.getState().stage !== "playing"; attempt += 1) {
      await tick();
    }

    assert.equal(player.getState().stage, "playing", "the initial play started");
    player.pause();
    harness.audios[0]!.rejectNextPlay = true;
    player.resume();
    await tick();

    assert.notEqual(
      player.getState().stage,
      "playing",
      "rejected resume cannot truthfully claim that audio is playing",
    );
  } finally {
    player.stop();
    await run;
    harness.restore();
  }
});

test("RUN: the escaping guard must catch an unsafe value carried through an alias", () => {
  const testSource = readFileSync(
    new URL("./overlay-escaping.test.ts", import.meta.url),
    "utf8",
  );
  assert.match(testSource, /matchAll\(\/\\\$\\\{\(\[\^}\]\*\)\\\}\/g\)/);

  const overlaySource = readFileSync(
    new URL("../src/SpeakOverlay.ts", import.meta.url),
    "utf8",
  );
  const mutated = overlaySource
    .replace(
      'const isPaused = state.stage === "paused";',
      'const isPaused = state.stage === "paused";\n' +
        '      const displayValue = state.voice || "Gemini";',
    )
    .replace('${esc(state.voice || "Gemini")}', '${displayValue}');
  assert.notEqual(mutated, overlaySource, "the mutation was installed");

  const interpolations = [...mutated.matchAll(/\$\{([^}]*)\}/g)].map((match) =>
    match[1].trim(),
  );
  const caught = interpolations.filter((expression) => {
    if (!/\bstate\.|\bvoice\b|\bspeed\b/.test(expression)) return false;
    if (expression.startsWith("esc(")) return false;
    if (expression.startsWith("Number(")) return false;
    return true;
  });

  assert.ok(
    caught.includes("displayValue"),
    "the guard accepted an unescaped alias of state.voice",
  );
});

test("RUN: percent-encoded short credentials must not survive redaction", () => {
  const key = "a+b/c?";
  const encoded = encodeURIComponent(key);
  const visible = redact(`Gateway rejected credential ${encoded}`, key);

  assert.equal(
    visible,
    "(details withheld: they quoted the API key)",
    `recoverable credential reached the user as ${visible}`,
  );
});

test("RUN: a client/server chunk split mismatch must be rejected on the wire", () => {
  const text = "One sentence with enough words to split differently. ".repeat(30);
  const clientPieces = chunkForSynthesis(text, { first: 80, rest: 200 });
  const serverPieces = chunkForSynthesis(text);
  assert.notDeepEqual(clientPieces, serverPieces, "the two versions disagree");

  const accepted = contract.synthesize.input.safeParse({ text, chunkIndex: 1 });
  assert.equal(
    accepted.success,
    false,
    "the request has no version or split fingerprint, so the server accepted the mismatch",
  );
});
