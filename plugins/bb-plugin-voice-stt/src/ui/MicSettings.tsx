/**
 * Настройка «Микрофон на этом устройстве» (спека voice-stt-live §7.1).
 * Выбор хранится в localStorage — у мака и телефона свой. «Авто» — умный
 * выбор capture.ts (на маке пропускает iPhone/Continuity и виртуальные
 * входы). «Проверить» показывает уровень с выбранного входа 4 с.
 */
import { useEffect, useRef, useState } from "react";

import { listInputs, loadMicChoice, pickInput, saveMicChoice, type MicChoice } from "./capture.js";
import { voiceRecorder } from "./recorder.js";

const TEST_MS = 4000;

export function MicSettings() {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [choice, setChoice] = useState<MicChoice | null>(() => loadMicChoice());
  const [needsPermission, setNeedsPermission] = useState(false);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [testInfo, setTestInfo] = useState<string | null>(null);
  const stopTest = useRef<(() => void) | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const list = await listInputs();
      setInputs(list);
      setNeedsPermission(list.length === 0 || list.every((d) => d.label === ""));
    } catch {
      setInputs([]);
    }
  };

  useEffect(() => {
    void refresh();
    const md = navigator.mediaDevices;
    const on = () => void refresh();
    md?.addEventListener?.("devicechange", on);
    return () => {
      md?.removeEventListener?.("devicechange", on);
      stopTest.current?.();
    };
  }, []);

  const grant = async (): Promise<void> => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {
      // отказ — список останется без названий
    }
    await refresh();
  };

  const select = (deviceId: string): void => {
    voiceRecorder.releaseMic(); // тёплый микрофон на старом устройстве — гасим
    if (deviceId === "auto") {
      saveMicChoice(null);
      setChoice(null);
      return;
    }
    const d = inputs.find((x) => x.deviceId === deviceId);
    const next = { deviceId, label: d?.label ?? "" };
    saveMicChoice(next);
    setChoice(next);
  };

  const test = async (): Promise<void> => {
    stopTest.current?.();
    setTestInfo(null);
    setTesting(true);
    try {
      const picked = await pickInput(new Set());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: picked.deviceId !== null ? { deviceId: { exact: picked.deviceId } } : true,
      });
      const track = stream.getAudioTracks()[0];
      setTestInfo(`${track?.label || "микрофон"} · ${picked.why === "manual" ? "выбран вручную" : "авто"}`);
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor();
      await ctx.resume().catch(() => {});
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      let raf = 0;
      const tick = (): void => {
        an.getFloatTimeDomainData(buf);
        let peak = 0;
        for (const x of buf) peak = Math.max(peak, Math.abs(x));
        setLevel(Math.min(1, peak * 2.2));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      const done = (): void => {
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close().catch(() => {});
        setTesting(false);
        setLevel(0);
        stopTest.current = null;
      };
      stopTest.current = done;
      setTimeout(() => {
        if (stopTest.current === done) done();
      }, TEST_MS);
      await refresh(); // после разрешения появятся названия
    } catch (e) {
      setTesting(false);
      setTestInfo(`не удалось открыть микрофон: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const current = choice?.deviceId ?? "auto";
  const missing = choice !== null && !inputs.some((d) => d.deviceId === choice.deviceId || d.label === choice.label);

  return (
    <div className="vsl-set">
      <label className="vsl-set-row">
        <span className="vsl-set-label">Микрофон на этом устройстве</span>
        <select className="vsl-set-select" value={current} onChange={(e) => select(e.target.value)}>
          <option value="auto">Авто (рекомендуется)</option>
          {inputs.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Микрофон ${i + 1}`}
            </option>
          ))}
          {missing && choice !== null && <option value={choice.deviceId}>{choice.label || "выбранный"} (не подключён)</option>}
        </select>
      </label>
      <p className="vsl-set-hint">
        Авто: на маке пропускает микрофон iPhone (Continuity) и виртуальные входы, запоминает вход, с которого
        шёл звук. Выбор хранится отдельно на каждом устройстве.
        {missing ? " Выбранный микрофон не подключён — пока используется авто." : ""}
      </p>
      <div className="vsl-set-row">
        {needsPermission && (
          <button type="button" className="vsl-set-btn" onClick={() => void grant()}>
            Показать названия микрофонов
          </button>
        )}
        <button type="button" className="vsl-set-btn" disabled={testing} onClick={() => void test()}>
          {testing ? "Говорите…" : "Проверить"}
        </button>
        <span className="vsl-level vsl-set-level" aria-hidden="true">
          <span className="vsl-level-fill" style={{ width: `${Math.round(level * 100)}%` }} />
        </span>
      </div>
      {testInfo !== null && <p className="vsl-set-hint">{testInfo}</p>}
    </div>
  );
}
