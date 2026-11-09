/**
 * Позиция перетаскиваемой FAB (§3.1 п. 4). Хранится долями свободного
 * поля окна (0..1), чтобы переживать поворот экрана и смену размера;
 * localStorage — своя на каждом устройстве.
 */
const KEY = "voice-stt:fab-pos";
export const FAB_SIZE = 52;
export const FAB_MARGIN = 8;

export interface FabRatio {
  xr: number;
  yr: number;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

export function loadFabRatio(): FabRatio | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as Partial<FabRatio>;
    if (typeof v.xr !== "number" || typeof v.yr !== "number") return null;
    return { xr: clamp01(v.xr), yr: clamp01(v.yr) };
  } catch {
    return null;
  }
}

export function saveFabRatio(r: FabRatio): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    // приватный режим / квота — позиция просто не запомнится
  }
}

/** Свободное поле, в котором ездит левый-верхний угол кнопки. */
function field(vw: number, vh: number): { w: number; h: number } {
  return {
    w: Math.max(0, vw - FAB_SIZE - 2 * FAB_MARGIN),
    h: Math.max(0, vh - FAB_SIZE - 2 * FAB_MARGIN),
  };
}

export function ratioToPx(r: FabRatio, vw: number, vh: number): { left: number; top: number } {
  const f = field(vw, vh);
  return { left: FAB_MARGIN + r.xr * f.w, top: FAB_MARGIN + r.yr * f.h };
}

export function pxToRatio(left: number, top: number, vw: number, vh: number): FabRatio {
  const f = field(vw, vh);
  return {
    xr: f.w === 0 ? 0.5 : clamp01((left - FAB_MARGIN) / f.w),
    yr: f.h === 0 ? 0.5 : clamp01((top - FAB_MARGIN) / f.h),
  };
}
