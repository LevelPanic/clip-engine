// Timestamped comments: viewers pointing at moments ("14:50 I'm dead").
import type { Signal } from '../signal';
import { fmtTime } from '../../core/time';

const TS = /(?<![\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?![\d:])/g;
// Short comments that only navigate ("starts at 2:15", "skip to 3:40") aren't moments.
const NAV = /\b(start(s|ed)?|skip(ped)?|begins?|intro|sponsor|ad (ends|over)|timestamps?)\b/i;

export interface CommentHit {
  ms: number;
  likes: number;
  text: string;
}

const hitsIn = (hits: CommentHit[], r: { startMs: number; endMs: number }) =>
  hits.filter((h) => h.ms >= r.startMs && h.ms <= r.endMs + 5000);

export const comments: Signal = {
  name: 'comments',
  weight: 1.0,
  mode: 'sum',
  saturation: (max) => Math.max(8, 0.5 * max), // relative to this video's most-commented moment
  compute({ info, meta }) {
    const list = (info.comments ?? []).filter((c) => !c.parent || c.parent === 'root');
    const hits: CommentHit[] = [];
    for (const c of list) {
      const text = (c.text ?? '').replace(/\s+/g, ' ').trim();
      const found = [...text.matchAll(TS)];
      if (!found.length || found.length >= 4) continue; // 4+ timestamps = a chapter list
      if (text.length < 60 && NAV.test(text)) continue;
      for (const m of found.slice(0, 3)) {
        const ms = ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
        if (ms <= 0 || ms >= meta.durationMs) continue;
        hits.push({ ms, likes: c.like_count ?? 0, text: text.slice(0, 160) });
      }
    }
    hits.sort((a, b) => b.likes - a.likes);
    return {
      available: hits.length > 0,
      // People timestamp the punchline, so the moment's setup starts ~30 s earlier.
      events: hits.map((h) => ({ startMs: h.ms - 30_000, endMs: h.ms + 5_000, weight: Math.sqrt(h.likes + 1) })),
      extra: { hits },
    };
  },
  describe(r, out) {
    const hits = hitsIn((out.extra?.hits as CommentHit[]) ?? [], r);
    if (!hits.length) return;
    const top = hits.reduce((a, b) => (b.likes > a.likes ? b : a));
    return `${hits.length} timestamped comment${hits.length > 1 ? 's' : ''} (top: ${top.likes} likes at ${fmtTime(top.ms, 0)})`;
  },
};
