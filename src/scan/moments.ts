// Moments first. The manual way that works (give a stream link, ask for the clippable moments) starts
// from the strongest signals across the whole stream and looks closely at only the best few. The old
// watchlist scanned the newest 20–30 minutes of a stream blind and made up to three clips from
// whatever was there: of the 66 most-viewed viewer clips on the 15 streams it worked, 29 were in
// minutes it never scanned (ohnePixel's 120k-view clip among them), and the user rejected 26 of 33
// clips as boring (SCOPE.md, 2026-11-19).
//
// Here the community says where to look:
//   - viewer clips: someone pressed "clip" and other people watched it. Clips over the same seconds are
//     one moment; their views add up, and two different people clipping it is strong on its own;
//   - chat laughing: the most distinct people typing a laugh in 10 s. On the experts' 338 verdicts this
//     was the best single signal (65% of meme queues confirmed with laughter, 27% without).
// Only moments over a bar are kept, best first; the watchlist scans and judges the top few. A stream
// with nothing over the bar gives nothing: a bar, not a quota.
import type { Range } from '../core/ranges';
import type { ChatMessage, ViewerClip } from '../ingest/twitch';
import { clipSpan } from '../ingest/twitch';
import { BOTS, reactionOf } from '../discover/chatAnalysis';

export interface Moment {
  /** Stable for the same data: the moment's time, e.g. "moment@1:23:45". */
  id: string;
  peakMs: number;
  /** Where it happens: the region the experts read (the scan adds margin). */
  fromMs: number;
  toMs: number;
  views: number;
  clips: number;
  /** Different people who clipped it. */
  clippers: number;
  /** The most distinct people laughing in chat in any 10 s around it. */
  laughers: number;
  titles: string[];
  score: number;
  why: string[];
  /** Position in the stream under the current ranking (combined score), 1 = best. */
  rank?: number;
  /** Position under the shadow ranking (viewer clips and laughter alternating, `alternateOrder`). */
  altRank?: number;
}

/** A viewer-clip moment needs this many views, or two different clippers. */
export const MIN_VIEWS = 50;
/** A chat moment needs this many different people laughing in 10 s (and well over the stream's normal). */
export const MIN_LAUGHERS = 5;
/** A moment's region is at most this long around its peak: the experts read a moment, not a segment. */
const MAX_REGION_MS = 120_000;
const STEP_MS = 5_000;
const WINDOW_MS = 10_000;
/** Chat trails the moment: the median lag measured on this library is about 17 s. */
export const CHAT_LAG_MS = 12_000;

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const momentId = (ms: number) => `moment@${fmt(Math.floor(ms / STEP_MS) * STEP_MS)}`;

const score = (m: Pick<Moment, 'views' | 'clippers' | 'laughers'>) => m.views + 25 * Math.max(0, m.clippers - 1) + 12 * m.laughers;

/** Viewer clips over the same seconds, as moments. Pure. */
export function clipMoments(clips: ViewerClip[]): Moment[] {
  const spans = clips
    .map((c) => ({ c, ...clipSpan(c) }))
    .sort((a, b) => a.startMs - b.startMs);
  const groups: (typeof spans)[] = [];
  for (const s of spans) {
    const last = groups[groups.length - 1];
    if (last && s.startMs <= Math.max(...last.map((x) => x.endMs))) last.push(s);
    else groups.push([s]);
  }
  return groups.map((g) => {
    const top = [...g].sort((a, b) => b.c.views - a.c.views)[0];
    const peakMs = top.c.offsetMs;
    const fromMs = Math.max(Math.min(...g.map((x) => x.startMs)), peakMs - MAX_REGION_MS / 2);
    const toMs = Math.min(Math.max(...g.map((x) => x.endMs)), peakMs + MAX_REGION_MS / 2);
    const views = g.reduce((n, x) => n + x.c.views, 0);
    const clippers = new Set(g.map((x) => x.c.curator ?? x.c.slug)).size;
    const titles = [...g].sort((a, b) => b.c.views - a.c.views).slice(0, 3).map((x) => x.c.title);
    const m = { views, clippers, laughers: 0 };
    return { id: momentId(peakMs), peakMs, fromMs, toMs, ...m, clips: g.length, titles, score: score(m), why: [`${g.length} viewer clip${g.length === 1 ? '' : 's'}, ${views.toLocaleString('en-US')} views${clippers > 1 ? `, ${clippers} people clipped it` : ''}`] };
  });
}

/** Distinct people laughing per 10 s, in 5 s steps, over the fetched ranges (NaN where chat is unknown). Pure. */
export function laughLevels(messages: ChatMessage[], fetched: Range[], durationMs: number): Float64Array {
  const n = Math.ceil(durationMs / STEP_MS);
  const out = new Float64Array(n).fill(NaN);
  const laughs = messages.filter((m) => !BOTS.has(m[1]) && reactionOf(m[2]) === 'funny').sort((a, b) => a[0] - b[0]);
  let lo = 0; // first laugh at or after the window start; windows only move forward
  for (let k = 0; k < n; k++) {
    const a = k * STEP_MS;
    const b = a + WINDOW_MS;
    while (lo < laughs.length && laughs[lo][0] < a) lo++;
    if (!fetched.some((r) => r.startMs <= a && r.endMs >= b)) continue;
    const who = new Set<string>();
    for (let i = lo; i < laughs.length && laughs[i][0] < b; i++) who.add(laughs[i][1]);
    out[k] = who.size;
  }
  return out;
}

/** The chat-laughter peaks, as moments: well over the stream's normal and at least MIN_LAUGHERS people. Pure. */
export function laughMoments(levels: Float64Array, durationMs: number): Moment[] {
  const known = [...levels].filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  if (!known.length) return [];
  const normal = known[Math.floor(known.length / 2)];
  const bar = Math.max(MIN_LAUGHERS, 3 * normal + 2);
  const peaks: { k: number; v: number }[] = [];
  for (let k = 0; k < levels.length; k++) {
    const v = levels[k];
    if (Number.isNaN(v) || v < bar) continue;
    // one peak per minute: the highest step wins
    const near = peaks.findIndex((p) => Math.abs(p.k - k) * STEP_MS < 60_000);
    if (near >= 0) {
      if (v > peaks[near].v) peaks[near] = { k, v };
    } else peaks.push({ k, v });
  }
  return peaks.map(({ k, v }) => {
    const peakMs = Math.max(0, k * STEP_MS - CHAT_LAG_MS);
    const m = { views: 0, clippers: 0, laughers: v };
    return {
      id: momentId(peakMs),
      peakMs,
      fromMs: Math.max(0, peakMs - 25_000),
      toMs: Math.min(durationMs, peakMs + 15_000),
      ...m,
      clips: 0,
      titles: [],
      score: score(m),
      why: [`${v} people laughing in chat in 10 s (normal ${normal})`],
    };
  });
}

/** Clip moments and chat moments over the same seconds are one moment with both kinds of evidence. Pure. */
export function mergeMoments(a: Moment[], b: Moment[]): Moment[] {
  const all = [...a, ...b].sort((x, y) => x.fromMs - y.fromMs);
  const out: Moment[] = [];
  for (const m of all) {
    const last = out[out.length - 1];
    if (last && m.fromMs <= last.toMs) {
      const lead = m.score > last.score ? m : last;
      const merged = { views: last.views + m.views, clippers: last.clippers + m.clippers, laughers: Math.max(last.laughers, m.laughers) };
      out[out.length - 1] = {
        ...lead,
        fromMs: Math.max(Math.min(last.fromMs, m.fromMs), lead.peakMs - MAX_REGION_MS / 2),
        toMs: Math.min(Math.max(last.toMs, m.toMs), lead.peakMs + MAX_REGION_MS / 2),
        ...merged,
        clips: last.clips + m.clips,
        titles: [...last.titles, ...m.titles].slice(0, 3),
        score: score(merged),
        why: [...last.why, ...m.why],
      };
    } else out.push({ ...m });
  }
  return out;
}

/** Over the bar: enough views, two clippers, or a real laugh in chat. */
export const overBar = (m: Pick<Moment, 'views' | 'clippers' | 'laughers'>) => m.views >= MIN_VIEWS || m.clippers >= 2 || m.laughers >= MIN_LAUGHERS;

/**
 * A stream's moments over the bar, best first. Pure. `done` is what is already scanned of it (the
 * library's scan.json): a moment half covered by it was already looked at. `liveEdgeMs` keeps a
 * moment out until its minutes are on the VOD.
 */
export function rankMoments(input: { clips: ViewerClip[]; laughs?: Float64Array; durationMs: number; liveEdgeMs?: number; done?: Range[] }): Moment[] {
  const merged = mergeMoments(clipMoments(input.clips), input.laughs ? laughMoments(input.laughs, input.durationMs) : []);
  const edge = input.liveEdgeMs ?? input.durationMs;
  const covered = (m: Moment) =>
    (input.done ?? []).reduce((n, r) => n + Math.max(0, Math.min(r.endMs, m.toMs) - Math.max(r.startMs, m.fromMs)), 0) >= 0.5 * (m.toMs - m.fromMs);
  const kept = merged.filter((m) => overBar(m) && m.toMs <= edge && !covered(m)).sort((x, y) => y.score - x.score);
  const alt = new Map(alternateOrder(kept).map((m, i) => [m, i + 1]));
  return kept.map((m, i) => ({ ...m, rank: i + 1, altRank: alt.get(m) }));
}

/**
 * The shadow ranking (the second audit's challenger, 2026-11-19): the viewer-clip list (by views) and
 * the chat-laughter list (by distinct laughers) take turns, viewer clips first; a nomination within 30 s
 * of a moment already chosen is passed over; when one list runs out the other continues. The combined
 * score adds raw views to 12 per laugher, so a mature viewer clip buries a strong laugh (Jerma's approved
 * moped crash: first by laughter, ninth by score). On 16 past approvals this put 6 in the top 4 and 11 in
 * the top 12, against 5 and 8: a small, historical sample, so it runs in the shadow (`altRank`) and the
 * scheduler uses it only with MOMENT_RANKER=alternate. Pure.
 */
export function alternateOrder(moments: Moment[]): Moment[] {
  const lists = [
    moments.filter((m) => m.views > 0 || m.clippers > 0).sort((a, b) => b.views - a.views || b.clippers - a.clippers),
    moments.filter((m) => m.laughers > 0).sort((a, b) => b.laughers - a.laughers || b.score - a.score),
  ];
  const at = [0, 0];
  const out: Moment[] = [];
  const near = (m: Moment) => out.includes(m) || out.some((o) => Math.abs(o.peakMs - m.peakMs) <= 30_000);
  let turn = 0;
  while (at[0] < lists[0].length || at[1] < lists[1].length) {
    const k = at[turn] < lists[turn].length ? turn : 1 - turn;
    const m = lists[k][at[k]++];
    if (near(m)) continue;
    out.push(m);
    turn = 1 - k;
  }
  // what the turns passed over (a peak within 30 s of a chosen one) comes last, strongest first
  return [...out, ...moments.filter((m) => !out.includes(m)).sort((a, b) => b.score - a.score)];
}

/** The minutes a moment's job scans and judges: the region with a minute before and 45 s after. */
export const momentWindow = (m: Pick<Moment, 'fromMs' | 'toMs'>, durationMs: number): Range => ({
  startMs: Math.max(0, m.fromMs - 60_000),
  endMs: Math.min(durationMs, m.toMs + 45_000),
});

// ---------------------------------------------------------------------------------------------------
// Identity: a moment is a region of the stream, not a peak second. New viewer clips move a moment's
// peak (the most-viewed clip places it), which used to make a second row for the same seconds (27 such
// pairs among 516 moments, 2026-11-19). A re-ranked moment is matched to the row it already has.

/** The same moment: the regions overlap by half the shorter one, or the peaks are within 30 s. Pure. */
export function sameMoment(a: Pick<Moment, 'peakMs' | 'fromMs' | 'toMs'>, b: Pick<Moment, 'peakMs' | 'fromMs' | 'toMs'>): boolean {
  const overlap = Math.min(a.toMs, b.toMs) - Math.max(a.fromMs, b.fromMs);
  const shorter = Math.min(a.toMs - a.fromMs, b.toMs - b.fromMs);
  return (shorter > 0 && overlap >= 0.5 * shorter) || Math.abs(a.peakMs - b.peakMs) <= 30_000;
}

/** A tracked moment as the plan reads it. */
export interface KnownMoment {
  momentId: string;
  peakMs: number;
  fromMs: number;
  toMs: number;
  windowFromMs: number;
  windowToMs: number;
  score: number;
  status: string;
  note: string | null;
}
export type RankedMoment = Moment & { window: Range; skip?: string; rank?: number; altRank?: number };

/** Moments a job has taken or finished: their bounds are what that job used, so a re-rank keeps them. */
export const WORKED = new Set(['queued', 'working', 'clipped', 'no-clip', 'failed']);
/** A skip a rule made (a gambling chapter, a sexual moment): a re-rank where it no longer holds lifts it. */
const ruleSkip = (note: string | null) => !!note && /: never clipped\b/.test(note);

export interface MomentPlan {
  /** Matched to a row we have: `bounds` false for a worked row (numbers only). */
  update: { momentId: string; m: RankedMoment; bounds: boolean; status?: string; note?: string | null }[];
  insert: { m: RankedMoment; status: string; note: string | null; coveredBy?: string }[];
}

/**
 * What a re-rank does to a stream's tracked moments. Pure.
 *   - a ranked moment that is the same as a row we have updates that row and keeps its id; a waiting
 *     row also takes the new bounds, window and eligibility (a gambling chapter or a sexual moment skips
 *     it; when that no longer holds it is waiting again), a worked row only its numbers;
 *   - a new moment whose peak is inside a worked moment's window is recorded `covered` by it: those
 *     seconds were already looked at;
 *   - anything else is a new waiting moment (or skipped, with why).
 */
export function planMoments(known: KnownMoment[], ranked: RankedMoment[]): MomentPlan {
  const plan: MomentPlan = { update: [], insert: [] };
  const used = new Set<string>();
  const live = known.filter((k) => k.status !== 'covered');
  const worked = live.filter((k) => WORKED.has(k.status));
  for (const m of [...ranked].sort((a, b) => b.score - a.score)) {
    const matches = live.filter((k) => sameMoment(k, m));
    // a worked row first (the moment was looked at), then the closest peak
    const best = matches
      .filter((k) => !used.has(k.momentId))
      .sort((a, b) => Number(WORKED.has(b.status)) - Number(WORKED.has(a.status)) || Math.abs(a.peakMs - m.peakMs) - Math.abs(b.peakMs - m.peakMs))[0];
    if (best) {
      used.add(best.momentId);
      if (WORKED.has(best.status)) plan.update.push({ momentId: best.momentId, m, bounds: false });
      else if (m.skip) plan.update.push({ momentId: best.momentId, m, bounds: true, status: 'skipped', note: m.skip });
      else if (best.status === 'skipped' && ruleSkip(best.note)) plan.update.push({ momentId: best.momentId, m, bounds: true, status: 'pending', note: null });
      else plan.update.push({ momentId: best.momentId, m, bounds: true });
      continue;
    }
    if (matches.length) continue; // the same moment as one this re-rank already matched
    const inside = worked.find((w) => m.peakMs >= w.windowFromMs && m.peakMs <= w.windowToMs);
    if (inside) plan.insert.push({ m, status: 'covered', note: `inside ${inside.momentId}'s window, already looked at`, coveredBy: inside.momentId });
    else plan.insert.push({ m, status: m.skip ? 'skipped' : 'pending', note: m.skip ?? null });
  }
  return plan;
}

/**
 * Waiting rows that duplicate another row: the same moment as a worked row or a stronger waiting one, or
 * a peak inside a worked row's window. They become `covered` by that row, so the seconds run once. Pure.
 */
export function duplicatesOf(rows: KnownMoment[]): { momentId: string; by: string; why: string }[] {
  const out: { momentId: string; by: string; why: string }[] = [];
  const kept: KnownMoment[] = rows.filter((r) => WORKED.has(r.status));
  for (const r of rows.filter((x) => x.status === 'pending').sort((a, b) => b.score - a.score)) {
    const twin = kept.find((k) => sameMoment(k, r));
    const inside = kept.find((k) => WORKED.has(k.status) && r.peakMs >= k.windowFromMs && r.peakMs <= k.windowToMs);
    const by = twin ?? inside;
    if (by) out.push({ momentId: r.momentId, by: by.momentId, why: twin ? `the same moment as ${by.momentId}` : `inside ${by.momentId}'s window, already looked at` });
    else kept.push(r);
  }
  return out;
}
