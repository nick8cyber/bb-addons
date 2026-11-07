/**
 * `bb.host`-энтри плагина (спека §5): всё, что трогает файловую систему и
 * сеть — ffmpeg, `~/.codex/auth.json`, сокеты — живёт здесь, в воркере на
 * хост-демоне. Значения ключей наружу не уходят: в ответ только текст либо
 * код/сообщение ошибки без секретов.
 */
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { ffmpegAvailable } from "./src/audio.js";
import { runTranscribeChain } from "./src/chain.js";
import { mapCodexAuthState, readCodexAuthFile } from "./src/codex.js";
import { contract, toFailureResult } from "./src/contract.js";

const log = (message: string): void => {
  console.error(`[voice-stt] ${message}`);
};

export default experimental_defineHostEntry({
  contract,

  handlers: {
    "voice-stt.transcribe": async (input, context) => {
      try {
        return await runTranscribeChain(input, {
          signal: context.signal,
          tempDir: context.experimental_paths.tempDir,
          log,
        });
      } catch (e) {
        const failure = toFailureResult(e);
        log(`voice-stt.transcribe failed ${failure.code}: ${failure.message}`);
        return failure;
      }
    },

    "voice-stt.status": async () => ({
      codexAuth: mapCodexAuthState(await readCodexAuthFile()),
      ffmpeg: ffmpegAvailable(),
    }),
  },
});
