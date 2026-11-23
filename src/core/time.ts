// Time helpers shared by the CLI, the composition and the Studio (browser-safe).

export const FPS = 30;
export const FRAME_MS = 1000 / FPS;

/**
 * Parse a time into integer milliseconds.
 * Accepts "14:50", "14:50.2", "1:02:03.5", "890.2" (seconds), "890200ms", "12s",
 * and "+3.5" (seconds after `relativeTo`, e.g. the clip's in-point).
 */
export function parseTime(input: string | number, relativeTo?: number): number {
  if (typeof input === 'number') return Math.round(input);
  const s = input.trim();
  if (s.startsWith('+')) {
    if (relativeTo === undefined) throw new Error(`Relative time "${s}" needs a reference point`);
    return relativeTo + parseTime(s.slice(1));
  }
  if (/^\d+(\.\d+)?ms$/.test(s)) return Math.round(parseFloat(s));
  if (/^\d+(\.\d+)?s?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (!m) throw new Error(`Can't read time "${input}". Use 14:50, 14:50.2, 1:02:03 or seconds.`);
  const [, h, min, sec] = m;
  return Math.round(((Number(h ?? 0) * 60 + Number(min)) * 60 + Number(sec)) * 1000);
}

/** 853400 → "14:13.4", 3723500 → "1:02:03.5". */
export function fmtTime(ms: number, decimals: 0 | 1 | 2 = 1): string {
  const neg = ms < 0;
  // round first, then split, so 59.97 s at one decimal carries into the next minute ("1:07:00.0",
  // not "1:06:00.0")
  const unit = 10 ** decimals;
  const total = Math.round((Math.abs(ms) / 1000) * unit) / unit;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = (total - h * 3600 - m * 60).toFixed(decimals);
  const secStr = sec.padStart(decimals ? 3 + decimals : 2, '0');
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${secStr}` : `${m}:${secStr}`;
  return neg ? `-${body}` : body;
}

export const msToFrames = (ms: number, fps = FPS) => Math.round((ms * fps) / 1000);
export const framesToMs = (frames: number, fps = FPS) => Math.round((frames * 1000) / fps);

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
