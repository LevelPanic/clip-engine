// Weighted extraction: a queue is a region; this picks the part of that region that makes sense for
// the kind of queue it is. Meme queues want a tight reaction; viral queues want the peak plus reaction;
// clip queues want the setup sentence through the payoff. The extraction agent reads the top windows
// and chooses; the curator later decides keep/review/drop. Nothing is dropped here by score.
import type { Word } from '../core/schemas';
import type { Queue, QueueKind } from '../scan/queues';

/** A laugh, shout or cheer heard in the audio (from `detectReactions`, already thresholded). */
export interface HeardReaction {
  startMs: number;
  kind: string;
}

export interface ViewerMoment {
  offsetMs: number;
  views: number;
  title: string;
}

export interface ExtractWindow {
  startMs: number;
  endMs: number;
  score: number;
  quote?: string;
  components: Record<string, number>;
  why: string[];
  /** No transcript words in the region: the edges come from the moment's time, not from speech. */
  noWords?: boolean;
}

const CLIP_MIN_MS = 15_000;
const CLIP_MAX_MS = 60_000;
/** Ever so slight handles so the first consonant and the last laugh are never clipped. */
export const BUFFER_BEFORE_MS = 300;
export const BUFFER_AFTER_MS = 400;

const RULES: Record<QueueKind, { peak: number; weights: Record<string, number> }> = {
  // a gag lands early and the reaction carries the rest: the moment sits about a third in, not halfway
  meme: { peak: 0.3, weights: { peak: 0.25, hook: 0.25, payoff: 0.25, boundary: 0.1, context: 0.15 } },
  viral: { peak: 0.5, weights: { peak: 0.25, hook: 0.15, payoff: 0.3, boundary: 0.1, context: 0.2 } },
  clip: { peak: 0.66, weights: { peak: 0.15, hook: 0.1, payoff: 0.25, boundary: 0.15, context: 0.35 } },
};

const DEAD_OPEN_PENALTY = 15;

const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));

/** The buffer is part of the clip: a hair before the first word and a hair after the last. */
export function bufferWindow(startMs: number, endMs: number, durationMs?: number): { startMs: number; endMs: number } {
  return {
    startMs: Math.max(0, startMs - BUFFER_BEFORE_MS),
    endMs: durationMs !== undefined ? Math.min(durationMs, endMs + BUFFER_AFTER_MS) : endMs + BUFFER_AFTER_MS,
  };
}
const endsSentence = (s: string) => /[.!?…]["')\]]?$/.test(s.trim());
const FILLERS = new Set(['so', 'yeah', 'um', 'uh', 'like', 'well', 'okay', 'right', 'and', 'but', 'alright']);

function sentenceStart(words: Word[], i: number): boolean {
  if (i === 0) return true;
  const prev = words[i - 1];
  return endsSentence(prev.text) || words[i].startMs - prev.endMs > 500;
}

/**
 * A line to quote from the window: the sentence at the moment (or the nearest one with a few words in
 * it), cut at a word boundary. The validator checks the quote against the transcript, and the line
 * people repeat is the one at the hit, not the longest sentence in the clip.
 */
function quoteFor(words: Word[], start: number, end: number, peakMs: number): string | undefined {
  const inside = words.filter((w) => w.startMs >= start && w.endMs <= end);
  if (!inside.length) return undefined;
  const lines: { text: string[]; startMs: number; endMs: number }[] = [];
  let cur: { text: string[]; startMs: number; endMs: number } | null = null;
  for (let i = 0; i < inside.length; i++) {
    const w = inside[i];
    if (!cur) cur = { text: [], startMs: w.startMs, endMs: w.endMs };
    cur.text.push(w.text);
    cur.endMs = w.endMs;
    if (endsSentence(w.text) || (inside[i + 1] && inside[i + 1].startMs - w.endMs > 500)) {
      lines.push(cur);
      cur = null;
    }
  }
  if (cur) lines.push(cur);
  const distance = (l: { startMs: number; endMs: number }) => (peakMs >= l.startMs && peakMs <= l.endMs ? 0 : Math.min(Math.abs(l.startMs - peakMs), Math.abs(l.endMs - peakMs)));
  const quotable = lines.filter((l) => l.text.length >= 4);
  const pick = (quotable.length ? quotable : lines).sort((a, b) => distance(a) - distance(b) || b.text.length - a.text.length)[0];
  return pick.text.slice(0, 20).join(' ');
}

/** Score one candidate window. Pure: the tests use it directly. */
export function scoreWindow(input: {
  kind: QueueKind;
  startMs: number;
  endMs: number;
  peakMs: number;
  words: Word[];
  reactions: HeardReaction[];
  clips: ViewerMoment[];
  muted?: { startMs: number; endMs: number }[];
}): { score: number; components: Record<string, number>; why: string[] } {
  const { kind, startMs, endMs, peakMs, words, reactions, clips, muted = [] } = input;
  const rule = RULES[kind];
  const dur = endMs - startMs;
  const inside = words.filter((w) => w.startMs >= startMs && w.endMs <= endMs);
  const first = inside[0];
  const last = inside[inside.length - 1];
  const why: string[] = [];

  const duration = clamp(1 - Math.max(0, CLIP_MIN_MS - dur, dur - CLIP_MAX_MS) / CLIP_MIN_MS);
  const peak = clamp(1 - Math.abs((peakMs - startMs) / Math.max(1, dur) - rule.peak) / 0.5);
  // the first thing that happens: a word or a reaction (a scream is a hook too). Full marks within a
  // second; nothing by four. A second or two of calm before a scare is fine; ten is a dead open.
  const firstReaction = reactions.find((r) => r.startMs >= startMs && r.startMs <= endMs);
  const firstEventMs = Math.min(first?.startMs ?? Infinity, firstReaction?.startMs ?? Infinity);
  const hook = Number.isFinite(firstEventMs) ? clamp(1 - Math.max(0, firstEventMs - startMs - 1000) / 3000) : 0;
  const endSentence = last ? (endsSentence(last.text) ? 0.6 : 0.2) : 0.2;
  // the reaction is the payoff: a window that ends just after one lands; one that ends before it is cut short
  const payoffEvent = reactions.some((r) => r.startMs >= endMs - 4000 && r.startMs <= endMs + 1000) ? 0.4 : 0;
  // a viewer clip's offset is an anchor near the moment (see clipSpan), so it backs the window, not its last second
  const payoffClip = clips.some((c) => c.offsetMs >= startMs && c.offsetMs <= endMs + 2000) ? 0.2 : 0;
  let payoff = clamp(endSentence + payoffEvent + payoffClip);
  if (last && /[?]$/.test(last.text.trim())) payoff = clamp(payoff - 0.25);
  if (last && FILLERS.has(last.text.toLowerCase().replace(/[^a-z]/g, ''))) payoff = clamp(payoff - 0.2);
  const boundary = (first && sentenceStart(words, words.indexOf(first)) ? 0.5 : 0) + (last && endsSentence(last.text) ? 0.5 : 0);
  const context =
    kind === 'clip'
      ? clamp((peakMs - startMs - 6000) / 12_000)
      : kind === 'meme'
        ? clamp(1 - Math.max(0, peakMs - startMs - 8000) / 12_000)
        : clamp(1 - Math.abs(peakMs - startMs - 12_000) / 18_000);
  const mutedHit = muted.some((m) => m.startMs < endMs && m.endMs > startMs);
  if (mutedHit) return { score: 0, components: {}, why: ['overlaps muted footage'] };
  if (dur < CLIP_MIN_MS || dur > CLIP_MAX_MS) why.push('outside 15–60 s');
  if (first) why.push(`first word at ${((first.startMs - startMs) / 1000).toFixed(1)}s`);
  else why.push('no words in this window');
  if (firstReaction && firstReaction.startMs < (first?.startMs ?? Infinity)) why.push(`opens on a ${firstReaction.kind} at ${((firstReaction.startMs - startMs) / 1000).toFixed(1)}s`);
  if (Number.isFinite(firstEventMs) && firstEventMs - startMs > 4000) why.push(`dead open: nothing for ${((firstEventMs - startMs) / 1000).toFixed(1)}s`);
  if (payoffEvent) why.push('ends on a reaction');
  const cutShort = reactions.find((r) => r.startMs > endMs + 1000 && r.startMs <= endMs + 5000);
  if (cutShort) why.push(`a ${cutShort.kind} follows ${((cutShort.startMs - endMs) / 1000).toFixed(1)}s after the end`);
  if (last && endsSentence(last.text)) why.push('ends on a sentence');
  if (kind === 'clip' && startMs <= peakMs - 10_000) why.push('includes the setup');
  if (kind === 'meme' && startMs >= peakMs - 10_000) why.push('opens close to the reaction');
  const components = { duration, peak, hook, payoff, boundary, context };
  const raw = Math.round(100 * Object.entries(rule.weights).reduce((s, [k, w]) => s + w * components[k as keyof typeof components], 0));
  // nothing for four seconds loses the viewer before the moment, whatever the rest scores (0 stays "unusable")
  const deadOpen = Number.isFinite(firstEventMs) ? firstEventMs - startMs > 4000 : inside.length === 0 && reactions.length > 0;
  const score = Math.max(1, raw - (deadOpen ? DEAD_OPEN_PENALTY : 0));
  return { score, components, why };
}

/** Start/end offsets around the moment to try when a region has no transcript words. */
const WORDLESS: Record<QueueKind, [number, number][]> = {
  meme: [[5_000, 11_000], [7_000, 12_000], [9_000, 14_000]],
  viral: [[9_000, 13_000], [12_000, 18_000], [15_000, 22_000]],
  clip: [[14_000, 14_000], [20_000, 18_000], [26_000, 24_000]],
};

/** The best start/end windows around a queue, strongest first. */
export function bestWindows(input: {
  queue: Queue;
  words: Word[];
  reactions: HeardReaction[];
  clips: ViewerMoment[];
  muted?: { startMs: number; endMs: number }[];
  durationMs?: number;
  limit?: number;
}): ExtractWindow[] {
  const { queue, words, reactions, clips, muted = [], limit = 5, durationMs } = input;
  const qs = queue.startMs;
  const qe = queue.endMs;
  const peak = queue.peakMs;
  const out: ExtractWindow[] = [];
  const inRegion = words.filter((w) => w.startMs >= qs && w.endMs <= qe);
  if (inRegion.length < 5) {
    // a visual or sound-only moment, or a region nobody has transcribed: cut around the moment itself
    for (const [before, after] of WORDLESS[queue.kind]) {
      const s = Math.max(0, peak - before);
      const e = durationMs !== undefined ? Math.min(durationMs, peak + after) : peak + after;
      if (e - s < CLIP_MIN_MS) continue;
      const scored = scoreWindow({ kind: queue.kind, startMs: s, endMs: e, peakMs: peak, words, reactions, clips, muted });
      if (!scored.score) continue;
      out.push({ startMs: s, endMs: e, score: scored.score, components: scored.components, why: ['no transcript words here: edges are set from the moment, so check them in frames', ...scored.why.filter((x) => x !== 'no words in this window')], noWords: true });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  const wordStarts = [...new Set(words.filter((w) => w.startMs >= qs && w.startMs <= Math.min(peak + 2000, qe)).map((w) => w.startMs))].sort((a, b) => Math.abs(a - peak) - Math.abs(b - peak)).slice(0, 23);
  const wordEnds = [...new Set(words.filter((w) => w.endMs >= Math.max(peak - 2000, qs) && w.endMs <= qe).map((w) => w.endMs))].sort((a, b) => Math.abs(a - peak) - Math.abs(b - peak)).slice(0, 23);
  // where speech is sparse (a scare, a fail) the best start is a beat before the moment, not a word
  const leadIns = [2000, 4000, 6000].map((d) => peak - d).filter((t) => t >= qs && !words.some((w) => w.startMs <= t && w.endMs > t));
  const startList = [...new Set([qs, ...wordStarts, ...leadIns])].sort((a, b) => b - a);
  const endList = [...wordEnds, qe].sort((a, b) => a - b);
  for (const s of startList) {
    for (const e of endList) {
      // Leave room for the buffer so the final clip still fits 15–60 s.
      if (e - s < CLIP_MIN_MS || e - s > CLIP_MAX_MS - BUFFER_BEFORE_MS - BUFFER_AFTER_MS) continue;
      const scored = scoreWindow({ kind: queue.kind, startMs: s, endMs: e, peakMs: peak, words, reactions, clips, muted });
      if (!scored.score) continue;
      const buffered = bufferWindow(s, e, durationMs);
      out.push({
        startMs: buffered.startMs,
        endMs: buffered.endMs,
        score: scored.score,
        quote: quoteFor(words, s, e, peak),
        components: scored.components,
        why: scored.why,
      });
    }
  }
  // Keep the best window for each near-identical duration/position, then the strongest few.
  out.sort((a, b) => b.score - a.score);
  const kept: ExtractWindow[] = [];
  for (const w of out) {
    if (kept.some((k) => Math.abs(k.startMs - w.startMs) < 1000 && Math.abs(k.endMs - w.endMs) < 1000)) continue;
    kept.push(w);
    if (kept.length >= limit) break;
  }
  return kept;
}
