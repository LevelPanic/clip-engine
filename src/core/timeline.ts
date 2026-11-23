// The time map: turns a clip's in/out points plus its time markers (cut, speed, freeze) into the
// edited timeline that plays. Everything that draws or renders asks this map where a source moment
// lands, so markers stay anchored to the content (source ms) while the timeline restructures.
// Browser-safe.

export type TimeEffect =
  | { kind: 'remove' } // cut: drop this span
  | { kind: 'speed'; rate: number } // play this span faster/slower
  | { kind: 'hold'; durationMs: number }; // freeze: hold this frame

export interface TimeMarker {
  id: string;
  startMs: number;
  endMs?: number;
  effect: TimeEffect;
  /** Transition into what follows a cut. */
  transition?: { kind: string; durationMs: number };
  proposed?: boolean;
}

export interface Piece {
  kind: 'play' | 'hold';
  srcStart: number; // play: source span; hold: srcStart === srcEnd (the held frame)
  srcEnd: number;
  rate: number;
  tStart: number; // edited-timeline ms (0 = clip start; negative = context before the clip)
  tEnd: number;
  context?: boolean; // Studio-only padding outside the clip, shown dimmed
  markerId?: string; // hold: the freeze marker that made it
}

export interface Join {
  t: number; // where the next piece starts
  kind: string; // crossfade | whip | flash | zoom | none
  durationMs: number;
  overlap: boolean; // crossfade: the next piece starts `durationMs` early, under the previous one
}

export interface TimeMap {
  pieces: Piece[];
  joins: Join[];
  /** Edited length of the clip itself (context excluded). */
  durationMs: number;
  /** Timeline span covered (context included). */
  tStart: number;
  tEnd: number;
}

export function buildTimeMap(
  seg: { startMs: number; endMs: number },
  markers: TimeMarker[],
  opts: { padBefore?: number; padAfter?: number; includeProposed?: boolean } = {},
): TimeMap {
  const active = markers.filter((m) => opts.includeProposed !== false || !m.proposed);
  const inMs = seg.startMs;
  const outMs = seg.endMs;

  // 1. kept intervals = [in, out] minus cuts; remember which cut ends where (for transitions)
  const cuts = active
    .filter((m) => m.effect.kind === 'remove' && m.endMs !== undefined)
    .map((m) => ({ s: Math.max(inMs, m.startMs), e: Math.min(outMs, m.endMs!), m }))
    .filter((c) => c.e > c.s)
    .sort((a, b) => a.s - b.s);
  const kept: { s: number; e: number; afterCut?: TimeMarker }[] = [];
  let cur = inMs;
  let pendingCut: TimeMarker | undefined;
  for (const c of cuts) {
    if (c.s > cur) kept.push({ s: cur, e: c.s, afterCut: pendingCut });
    if (c.e > cur) (cur = c.e), (pendingCut = c.m);
  }
  if (outMs > cur) kept.push({ s: cur, e: outMs, afterCut: pendingCut });

  // 2. split at speed boundaries and freeze points
  const speeds = active.filter((m) => m.effect.kind === 'speed' && m.endMs !== undefined);
  const holds = active.filter((m) => m.effect.kind === 'hold');
  const pieces: Piece[] = [];
  const joins: Join[] = [];
  let t = 0;
  for (const k of kept) {
    const cutsAt = new Set<number>([k.s, k.e]);
    for (const sp of speeds) {
      if (sp.startMs > k.s && sp.startMs < k.e) cutsAt.add(sp.startMs);
      if (sp.endMs! > k.s && sp.endMs! < k.e) cutsAt.add(sp.endMs!);
    }
    for (const h of holds) if (h.startMs >= k.s && h.startMs <= k.e) cutsAt.add(h.startMs);
    const points = [...cutsAt].sort((a, b) => a - b);

    if (k.afterCut && pieces.length) {
      const tr = k.afterCut.transition ?? { kind: 'none', durationMs: 0 };
      const overlap = tr.kind === 'crossfade' && tr.durationMs > 0;
      const d = overlap ? Math.min(tr.durationMs, (k.e - k.s) / 2, (pieces[pieces.length - 1].tEnd - pieces[pieces.length - 1].tStart) / 2) : tr.durationMs;
      if (overlap) t -= d;
      joins.push({ t, kind: tr.kind, durationMs: d, overlap });
    }

    for (let p = 0; p < points.length; p++) {
      const at = points[p];
      for (const h of holds.filter((x) => x.startMs === at)) {
        const d = (h.effect as { durationMs: number }).durationMs;
        pieces.push({ kind: 'hold', srcStart: at, srcEnd: at, rate: 1, tStart: t, tEnd: t + d, markerId: h.id });
        t += d;
      }
      if (p === points.length - 1) break;
      const s = at;
      const e = points[p + 1];
      if (e <= s) continue;
      const sp = speeds.find((x) => x.startMs <= s && x.endMs! >= e);
      const rate = sp ? (sp.effect as { rate: number }).rate : 1;
      const len = (e - s) / rate;
      pieces.push({ kind: 'play', srcStart: s, srcEnd: e, rate, tStart: t, tEnd: t + len });
      t += len;
    }
  }
  const durationMs = t;

  // 3. Studio context: plain playback before/after the clip, outside the edit
  const before = opts.padBefore ?? 0;
  const after = opts.padAfter ?? 0;
  if (before > 0) pieces.unshift({ kind: 'play', srcStart: inMs - before, srcEnd: inMs, rate: 1, tStart: -before, tEnd: 0, context: true });
  if (after > 0) pieces.push({ kind: 'play', srcStart: outMs, srcEnd: outMs + after, rate: 1, tStart: durationMs, tEnd: durationMs + after, context: true });

  return { pieces, joins, durationMs, tStart: -before, tEnd: durationMs + after };
}

/** Where a source moment plays on the edited timeline, or null if it was cut. Holds don't move it. */
export function srcToT(map: TimeMap, src: number): number | null {
  for (const p of map.pieces) {
    if (p.kind !== 'play') continue;
    if (src >= p.srcStart && src < p.srcEnd) return p.tStart + (src - p.srcStart) / p.rate;
  }
  const last = [...map.pieces].reverse().find((p) => p.kind === 'play');
  if (last && src === last.srcEnd) return last.tEnd;
  return null;
}

/** Like srcToT, but a cut moment snaps to where playback resumes after the cut. */
export function srcToTNearest(map: TimeMap, src: number): number {
  const t = srcToT(map, src);
  if (t !== null) return t;
  const next = map.pieces.find((p) => p.kind === 'play' && p.srcStart >= src);
  return next ? next.tStart : map.tEnd;
}

/** Which source frame shows at timeline time t (holds return the held frame). */
export function tToSrc(map: TimeMap, t: number): number {
  let best: Piece | undefined;
  for (const p of map.pieces) if (t >= p.tStart && t < p.tEnd) best = p; // later pieces win in crossfade overlaps
  if (!best) best = t < map.tStart ? map.pieces[0] : map.pieces[map.pieces.length - 1];
  if (!best) return 0;
  if (best.kind === 'hold') return best.srcStart;
  return Math.min(best.srcEnd, best.srcStart + Math.max(0, t - best.tStart) * best.rate);
}

/** Map a source span onto the timeline: the parts that survive cuts, merged. */
export function spanToT(map: TimeMap, s: number, e: number): { tStart: number; tEnd: number } | null {
  let a: number | null = null;
  let b: number | null = null;
  for (const p of map.pieces) {
    if (p.kind === 'hold') {
      if (p.srcStart >= s && p.srcStart < e) (a = a ?? p.tStart), (b = p.tEnd);
      continue;
    }
    const lo = Math.max(s, p.srcStart);
    const hi = Math.min(e, p.srcEnd);
    if (hi <= lo) continue;
    const ta = p.tStart + (lo - p.srcStart) / p.rate;
    const tb = p.tStart + (hi - p.srcStart) / p.rate;
    a = a === null ? ta : Math.min(a, ta);
    b = b === null ? tb : Math.max(b, tb);
  }
  return a === null || b === null ? null : { tStart: a, tEnd: b };
}
