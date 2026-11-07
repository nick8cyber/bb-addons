/**
 * Выбор микрофона (жалоба владельца 07.11): на маке Continuity подсовывал
 * микрофон iPhone как вход по умолчанию — запись шла без звука.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { pickInput } from "../src/ui/capture.js";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";

function dev(deviceId: string, label: string) {
  return { kind: "audioinput", deviceId, label, groupId: "g" };
}

function setup(ua: string, devices: ReturnType<typeof dev>[], touch = 0, lastGood: string | null = null) {
  const store = new Map<string, string>();
  if (lastGood !== null) store.set("voice-stt:mic-device", lastGood);
  vi.stubGlobal("navigator", {
    userAgent: ua,
    maxTouchPoints: touch,
    mediaDevices: { enumerateDevices: async () => devices },
  });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("pickInput — микрофон на маке (Continuity)", () => {
  it("default = iPhone → берёт встроенный микрофон MacBook", async () => {
    setup(MAC_UA, [
      dev("default", "Default - iPhone Microphone"),
      dev("iph", "iPhone Microphone"),
      dev("mbp", "MacBook Pro Microphone (Built-in)"),
    ]);
    expect((await pickInput(new Set())).deviceId).toBe("mbp");
  });

  it("default — не iPhone → берёт default", async () => {
    setup(MAC_UA, [dev("default", "Default - MacBook Pro Microphone"), dev("mbp", "MacBook Pro Microphone")]);
    expect((await pickInput(new Set())).deviceId).toBe("default");
  });

  it("запомненное рабочее устройство в приоритете", async () => {
    setup(MAC_UA, [dev("default", "Default - MacBook Pro Microphone"), dev("usb", "USB Mic")], 0, "usb");
    expect((await pickInput(new Set())).deviceId).toBe("usb");
  });

  it("виртуальные и исключённые входы пропускаются", async () => {
    setup(MAC_UA, [
      dev("bh", "BlackHole 2ch"),
      dev("mbp", "MacBook Pro Microphone"),
      dev("usb", "USB Mic"),
    ]);
    expect((await pickInput(new Set(["mbp"]))).deviceId).toBe("usb");
  });

  it("только iPhone → системный default (null)", async () => {
    setup(MAC_UA, [dev("default", "Default - iPhone Microphone"), dev("iph", "iPhone Microphone")]);
    expect((await pickInput(new Set())).deviceId).toBeNull();
  });

  it("без разрешения (пустые метки) → default, разберётся переоткрытие", async () => {
    setup(MAC_UA, [dev("", ""), dev("", "")]);
    expect((await pickInput(new Set())).deviceId).toBeNull();
  });

  it("на самом iPhone свой микрофон не исключается — системный default", async () => {
    setup(IPHONE_UA, [dev("iph", "iPhone Microphone")], 5);
    expect((await pickInput(new Set())).deviceId).toBeNull();
  });
});
