// The no-LLM judge: turn discovery seeds into candidates with deterministic rules.
//
// It is deliberately simple and testable. It finds the setup before the seed's peak, snaps to
// transcript lines, writes a title/hook/quote, and scores the virality funnel from signals and words.
// On streams the signals are strong enough for this to be useful; on subtle talk it is a triage
// baseline, not a replacement for a language model.
import { loadMeta, loadTranscript } from '../ingest/ingest';
import { discover } from '../discover';
import { buildLines } from '../ingest/transcript';
import { addCandidates } from '../candidates';
import { OPENING_FILLERS } from '../core/vocabulary';
import { fmtTime, clamp } from '../core/time';
import type { CandidateInput, Seed, Transcript } from '../core/schemas';

export interface HeuristicReport {
  added: number;
  rejected: number;
  seconds: number;
  reply: string;
}

const clean = (s: string) =>
  s
    .replace(/»/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const words = (s: string) => clean(s).split(' ').filter(Boolean);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']/g, '');


type Line = ReturnType<typeof buildLines>[number];

/** Lines that overlap the window, in order. */
const linesIn = (lines: Line[], startMs: number, endMs: number) => lines.filter((l) => l.endMs > startMs && l.startMs < endMs);

/** The setup starts before the seed's peak; the payoff is a little after it. */
function windowFor(seed: Seed, lines: Line[], durationMs: number) {
  let start = Math.max(seed.startMs, seed.peakMs - 25_000);
  let end = Math.min(seed.endMs, seed.peakMs + 8_000);
  if (end - start < 18_000) {
    start = Math.max(seed.startMs, seed.peakMs - 30_000);
    end = Math.min(seed.endMs, seed.peakMs + 12_000);
  }
  const startLine = lines.find((l) => l.endMs > start && l.startMs <= start + 1500) ?? lines.find((l) => l.startMs >= start);
  const endLine = [...lines].reverse().find((l) => l.startMs < end && l.endMs >= end - 2000);
  if (startLine) start = Math.max(0, startLine.startMs - 150);
  if (endLine) end = Math.min(durationMs, endLine.endMs + 250);
  if (end - start > 55_000) end = start + 55_000;
  if (end - start < 15_000) end = Math.min(durationMs, start + 20_000);
  return { startMs: Math.round(start), endMs: Math.round(end) };
}

/** The line closest to the seed's peak, or the longest line if the window has no peak line. */
function peakLine(lines: Line[], peakMs: number, startMs: number, endMs: number): Line | undefined {
  const inWindow = linesIn(lines, startMs, endMs);
  if (!inWindow.length) return undefined;
  const hit = inWindow.find((l) => l.startMs <= peakMs && l.endMs >= peakMs);
  if (hit) return hit;
  return inWindow.reduce((a, b) => (Math.abs(b.startMs - peakMs) < Math.abs(a.startMs - peakMs) ? b : a));
}

/** The most quotable line in the window: a question, claim, stake or named subject beats an answer fragment. */
function quotableLine(lines: Line[], peak: Line | undefined, startMs: number, endMs: number): Line | undefined {
  const inWindow = linesIn(lines, startMs, endMs).filter((l) => {
    const n = words(l.text).length;
    return n >= 5 && n <= 22;
  });
  let best: Line | undefined;
  let bestScore = -Infinity;
  for (const l of inWindow) {
    const text = clean(l.text);
    const ws = words(text);
    let score = 0;
    if (text.includes('?')) score += 4;
    if (/^(why|how|what|when|where|who|the|no|i|you|we|they|if|because)\b/i.test(text)) score += 2;
    if (/\b(\$|\d|million|thousand|never|every|worst|best|killed|dead|love|hate|abuse|family|mother|father)\b/i.test(text)) score += 2;
    if (ws.length >= 8 && ws.length <= 20) score += 2;
    if (l === peak) score += 1;
    if (score > bestScore || (score === bestScore && Math.abs(l.startMs - (peak?.startMs ?? startMs)) < Math.abs((best?.startMs ?? startMs) - (peak?.startMs ?? startMs)))) {
      best = l;
      bestScore = score;
    }
  }
  return best;
}

function quoteFrom(lines: Line[], peak: Line | undefined, startMs: number, endMs: number): string {
  const line = quotableLine(lines, peak, startMs, endMs) ?? peak;
  if (!line) {
    const all = linesIn(lines, startMs, endMs).flatMap((l) => words(l.text));
    return all.slice(0, 10).join(' ');
  }
  return words(line.text).slice(0, 18).join(' ');
}

const tidyTitle = (s: string) => {
  const t = clean(s)
    .replace(/^(like|and|but|so|well|yeah|you know|okay|right)[,\s]+/i, '')
    .replace(/[,;:]$/, '')
    .trim();
  return t.length > 60 ? `${t.slice(0, 60).replace(/\s+\S*$/, '')}…` : t;
};

function overlap(a: string, b: string): number {
  const A = new Set(words(a).map(norm).filter((w) => w.length > 4));
  const B = new Set(words(b).map(norm).filter((w) => w.length > 4));
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n;
}

function scoreSeed(seed: Seed, lines: Line[], window: { startMs: number; endMs: number }, platform: string) {
  const inWindow = linesIn(lines, window.startMs, window.endMs);
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const peak = peakLine(lines, seed.peakMs, window.startMs, window.endMs);
  if (!first || !last) return null;

  const firstText = clean(first.text);
  const best = quotableLine(lines, peak, window.startMs, window.endMs) ?? peak ?? first;
  const bestText = clean(best.text);
  const lastText = clean(last.text);
  const firstWords = words(firstText);
  const firstWord = norm(firstWords[0] ?? '');
  const filler = OPENING_FILLERS.has(firstWord);
  const question = firstText.includes('?');
  const stake = /\b(\$|\d|million|thousand|never|every|worst|best|why|how|what|killed|dead|win|lose)\b/i.test(firstText);
  const reaction = Math.max(seed.sources.laughter ?? 0, seed.sources.audio ?? 0);
  const crowd = Math.max(seed.sources.comments ?? 0, seed.sources.clips ?? 0, seed.sources.chat ?? 0, seed.sources.heatmap ?? 0, seed.sources.teaser ?? 0);
  const signal = clamp(seed.score / 100, 0, 1);
  const duration = window.endMs - window.startMs;
  const lengthScore = duration >= 18_000 && duration <= 50_000 ? 1 : duration < 18_000 ? 0.4 : 0.7;

  const stop = clamp(4 + (question ? 2 : 0) + (stake ? 1 : 0) + (!filler ? 1 : 0) + (reaction > 0.5 ? 1 : 0), 1, 9);
  const hold = clamp(3 + 2 * signal + 2 * reaction + lengthScore + (crowd > 0.5 ? 1 : 0), 1, 9);
  const share = clamp(2 + 3 * reaction + 2 * crowd + (words(bestText).length >= 5 ? 1 : 0) + (question ? 0 : 1), 1, 9);
  const standalone = platform === 'twitch' ? 6 : 7;
  const payoff = clamp((lastText.includes('?') ? 5 : 8) + (reaction > 0.5 ? 1 : 0), 1, 9);
  const delivery = clamp(question && lastText.includes('?') ? 4 : overlap(firstText, bestText) > 0 ? 8 : 6, 1, 9);
  const quality = clamp(Math.round(52 + 30 * signal + 8 * reaction + 5 * crowd + 5 * lengthScore), 55, 95);

  const titleText = tidyTitle(bestText);
  const title = titleText.length >= 12 ? titleText : `${platform === 'twitch' ? 'Stream' : 'Clip'}: ${titleText || fmtTime(seed.peakMs)}`;
  const hook = words(filler ? bestText : firstText).slice(0, 8).join(' ') || title;
  const quote = quoteFrom(lines, best, window.startMs, window.endMs);
  const why = seed.why.length ? seed.why.slice(0, 2).join(' · ') : 'signal peak';

  return {
    start: window.startMs,
    end: window.endMs,
    title,
    hook,
    reason: `Heuristic: ${why} · peak ${fmtTime(seed.peakMs)}`,
    quote,
    score: quality,
    scores: { stop, hold, share, standalone, payoff, delivery },
    lens: platform === 'twitch' ? 'stream-moments' : 'podcast-general',
  } satisfies CandidateInput;
}

export async function heuristicJudge(
  videoId: string,
  opts: { lens?: string; want?: number; range?: { startMs: number; endMs: number }; log?: (s: string) => void } = {},
): Promise<HeuristicReport> {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const meta = loadMeta(videoId);
  let transcript: Transcript;
  try {
    transcript = loadTranscript(videoId);
  } catch {
    throw new Error(`No transcript for ${videoId}. Run \`clip scan\`/\`clip transcript\` first; the heuristic judge needs words to quote.`);
  }
  if (!transcript.words.length) throw new Error(`The transcript for ${videoId} is empty.`);
  const signals = discover(videoId, { range: opts.range });
  const seeds = [...signals.seeds].sort((a, b) => b.score - a.score);
  if (!seeds.length) {
    const seconds = Math.round((Date.now() - t0) / 1000);
    return { added: 0, rejected: 0, seconds, reply: 'no seeds: the signals are weak for this range' };
  }
  const lines = buildLines(transcript);
  const platform = meta.platform ?? (videoId.startsWith('tw-') ? 'twitch' : 'youtube');
  const inputs: CandidateInput[] = [];
  for (const seed of seeds) {
    if (inputs.length >= (opts.want ?? 8)) break;
    const window = windowFor(seed, lines, meta.durationMs);
    if (window.endMs - window.startMs < 15_000) continue;
    const input = scoreSeed(seed, lines, window, platform);
    if (!input) continue;
    if (opts.lens) input.lens = opts.lens;
    inputs.push(input);
  }
  log(`heuristic: ${seeds.length} seeds → ${inputs.length} candidates`);
  const r = await addCandidates(videoId, inputs);
  const seconds = Math.round((Date.now() - t0) / 1000);
  return {
    added: r.accepted.length,
    rejected: r.rejected.length,
    seconds,
    reply: `heuristic accepted ${r.accepted.length}${r.rejected.length ? `, rejected ${r.rejected.length}` : ''}`,
  };
}
