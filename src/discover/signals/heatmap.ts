// YouTube's Most Replayed graph (100 points per video, when it exists).
import type { Signal } from '../signal';

export const heatmap: Signal = {
  name: 'heatmap',
  weight: 0.8,
  mode: 'max',
  saturation: 1,
  compute({ meta }) {
    // The opening points are high because everyone starts there; drop them.
    const pts = meta.heatmap.slice(2).filter((p) => p.startMs >= 30_000);
    if (pts.length < 10) return { available: false, events: [] };
    const vals = pts.map((p) => p.value).sort((a, b) => a - b);
    const median = vals[Math.floor(vals.length / 2)];
    const max = vals[vals.length - 1];
    if (max - median < 1e-6) return { available: true, events: [] };
    return {
      available: true,
      events: pts
        .map((p) => ({ startMs: p.startMs, endMs: p.endMs, weight: Math.max(0, (p.value - median) / (max - median)) }))
        .filter((e) => e.weight > 0.15),
    };
  },
  describe(r, out) {
    const best = Math.max(0, ...out.events.filter((e) => e.endMs > r.startMs && e.startMs < r.endMs).map((e) => e.weight));
    if (best >= 0.3) return `Most Replayed peak (${Math.round(best * 100)}% of the video's top)`;
  },
};
