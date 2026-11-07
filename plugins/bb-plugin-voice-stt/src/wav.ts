/**
 * `pcmToWav` — обёртка накопленного PCM16 s16le mono 16 кГц в RIFF/WAVE
 * (спека voice-stt-live §4.5): на живом пути ffmpeg не вызывается, WAV
 * годится для codex/groq multipart как есть. Заголовок — канонические 44
 * байта (RIFF/fmt/data), длины считаются из реального буфера.
 *
 * Работает на DataView/Uint8Array — один и тот же код идёт в server entry
 * и в браузерный бандл (клиентский фоллбэк §4.3а собирает WAV сам).
 */

const WAV_HEADER_BYTES = 44;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function pcmToWav(pcm: Uint8Array, sampleRate = 16_000): Uint8Array {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.byteLength;

  const out = new Uint8Array(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(out.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // размер fmt-чанка (PCM)
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}
