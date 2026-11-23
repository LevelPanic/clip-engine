// Cold-open teasers: shows that open with a montage of their own best moments.
// We find each teaser snippet's full-length moment later in the episode by shared 6-word phrases.
import type { Signal } from '../signal';
import { fmtTime } from '../../core/time';

export interface TeaserMatch {
  teaserMs: number;
  momentMs: number;
  grams: number;
}

const N = 6;

export const teaser: Signal = {
  name: 'teaser',
  weight: 1.0,
  mode: 'max',
  saturation: 1,
  compute({ transcript, sponsors }) {
    if (!transcript) return { available: false, events: [] };
    const preview = sponsors.find((s) => s.category === 'preview' && s.startMs < 60_000);
    const head = preview ? { from: preview.startMs, to: preview.endMs } : { from: 0, to: 120_000 };
    const restFrom = Math.max(head.to + 30_000, 120_000);
    const toks = transcript.words
      .map((w) => ({ ms: w.startMs, t: w.text.toLowerCase().replace(/[^a-z0-9']/g, '') }))
      .filter((x) => x.t && x.t !== '__');
    const grams = (seq: typeof toks) => {
      const g = new Map<string, number>();
      for (let i = 0; i + N <= seq.length; i++) {
        const key = seq.slice(i, i + N).map((x) => x.t).join(' ');
        if (!g.has(key)) g.set(key, seq[i].ms);
      }
      return g;
    };
    const hg = grams(toks.filter((x) => x.ms >= head.from && x.ms < head.to));
    const rg = grams(toks.filter((x) => x.ms >= restFrom));
    const hits = [...hg].filter(([k]) => rg.has(k)).map(([k, early]) => ({ later: rg.get(k)!, early }));
    hits.sort((a, b) => a.later - b.later);
    const clusters: TeaserMatch[] = [];
    for (const h of hits) {
      const last = clusters[clusters.length - 1];
      if (last && h.later - last.momentMs < 30_000) last.grams++;
      else clusters.push({ teaserMs: h.early, momentMs: h.later, grams: 1 });
    }
    const matches = clusters.filter((c) => c.grams >= 4); // ≥ 9 identical words in a row
    if (matches.length < 2) return { available: false, events: [], extra: { matches: [] } }; // not a teaser show
    return {
      available: true,
      events: matches.map((m) => ({ startMs: m.momentMs - 20_000, endMs: m.momentMs + 30_000, weight: 1 })),
      extra: { matches },
    };
  },
  describe(r, out) {
    const m = ((out.extra?.matches as TeaserMatch[]) ?? []).find((x) => x.momentMs >= r.startMs - 5000 && x.momentMs <= r.endMs);
    if (m) return `in the cold-open teaser (teaser at ${fmtTime(m.teaserMs, 0)})`;
  },
};
