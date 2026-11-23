// Speech rate: fast, excited stretches. A small nudge only; fast talk alone isn't a clip.
import type { Signal } from '../signal';

const WIN = 30_000;
const STEP = 10_000;

export const speech: Signal = {
  name: 'speech',
  weight: 0.2,
  mode: 'max',
  saturation: 1,
  compute({ transcript, meta }) {
    const words = transcript?.words ?? [];
    if (words.length < 200) return { available: false, events: [] };
    const wins: { startMs: number; wpm: number }[] = [];
    let lo = 0;
    let hi = 0;
    for (let s = 0; s + WIN <= meta.durationMs; s += STEP) {
      while (lo < words.length && words[lo].startMs < s) lo++;
      while (hi < words.length && words[hi].startMs < s + WIN) hi++;
      wins.push({ startMs: s, wpm: ((hi - lo) * 60_000) / WIN });
    }
    const talking = wins.filter((w) => w.wpm > 40);
    const mu = talking.reduce((a, w) => a + w.wpm, 0) / Math.max(1, talking.length);
    const sd = Math.sqrt(talking.reduce((a, w) => a + (w.wpm - mu) ** 2, 0) / Math.max(1, talking.length)) || 1;
    const events = wins
      .map((w) => ({ ...w, z: (w.wpm - mu) / sd }))
      .filter((w) => w.z >= 1)
      .map((w) => ({ startMs: w.startMs, endMs: w.startMs + WIN, weight: Math.min(1, 0.3 + (w.z - 1) / 1.5), wpm: w.wpm }));
    return { available: true, events, extra: { meanWpm: Math.round(mu) } };
  },
  describe(r, out) {
    const ev = out.events.filter((e) => e.startMs >= r.startMs - 10_000 && e.endMs <= r.endMs + 10_000) as { wpm?: number }[];
    const top = Math.max(0, ...ev.map((e) => e.wpm ?? 0));
    if (top) return `fast speech (${Math.round(top)} wpm vs ${out.extra?.meanWpm} average)`;
  },
};
