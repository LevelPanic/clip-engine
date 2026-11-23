// clip discover <videoId>: run every signal, combine them, and pick seed windows for the judge.
import { paths, readJsonIf, writeJson } from '../core/paths';
import { loadMeta, loadInfo, loadSponsors } from '../ingest/ingest';
import { EXCLUDED_CATEGORIES } from '../ingest/sponsorblock';
import type { Transcript, Seed, SignalsFile, SignalName, SponsorSegment } from '../core/schemas';
import type { Signal, SignalContext, SignalOutput } from './signal';
import { comments } from './signals/comments';
import { laughter } from './signals/laughter';
import { heatmap } from './signals/heatmap';
import { teaser } from './signals/teaser';
import { speech } from './signals/speech';
import { title } from './signals/title';
import { audio } from './signals/audio';
import { chat } from './signals/chat';
import { clips } from './signals/clips';
import { loadChat, loadViewerClips } from '../ingest/chat';
import { fmtTime } from '../core/time';

/** Every signal, in display order. A new signal is a new file plus one entry here. */
export const SIGNALS: Signal[] = [comments, chat, clips, laughter, audio, teaser, heatmap, speech, title];

const SEC = 1000;
const BIN_MS = 5000;
const MAX_SEEDS = 20;

export interface Computed {
  ctx: SignalContext;
  outputs: Map<SignalName, SignalOutput>;
  /** Per-second strength 0–1 for each signal. */
  norm: Map<SignalName, Float32Array>;
  excluded: SponsorSegment[];
}

export function computeSignals(videoId: string): Computed {
  const meta = loadMeta(videoId);
  const transcript = readJsonIf<Transcript>(paths.videoFile(videoId, 'transcript.json'));
  const sponsors = loadSponsors(videoId);
  const ctx: SignalContext = { meta, transcript, info: loadInfo(videoId), sponsors, chat: loadChat(videoId), viewerClips: loadViewerClips(videoId)?.clips };
  const n = Math.ceil(meta.durationMs / SEC) + 1;
  const outputs = new Map<SignalName, SignalOutput>();
  const norm = new Map<SignalName, Float32Array>();
  for (const s of SIGNALS) {
    const out = s.compute(ctx);
    outputs.set(s.name, out);
    const arr = new Float32Array(n);
    for (const e of out.events) {
      const a = Math.max(0, Math.floor(e.startMs / SEC));
      const b = Math.min(n - 1, Math.ceil(e.endMs / SEC));
      for (let i = a; i <= b; i++) arr[i] = s.mode === 'sum' ? arr[i] + e.weight : Math.max(arr[i], e.weight);
    }
    const sat = typeof s.saturation === 'function' ? s.saturation(arr.reduce((a, b) => Math.max(a, b), 0)) : s.saturation;
    for (let i = 0; i < n; i++) arr[i] = Math.min(1, arr[i] / sat);
    norm.set(s.name, arr);
  }
  const excluded = sponsors.filter((s) => EXCLUDED_CATEGORIES.has(s.category));
  return { ctx, outputs, norm, excluded };
}

/** Strength of each signal over a range (max of its per-second values). */
export function signalStrengths(c: Computed, r: { startMs: number; endMs: number }): Partial<Record<SignalName, number>> {
  const out: Partial<Record<SignalName, number>> = {};
  for (const s of SIGNALS) {
    const arr = c.norm.get(s.name)!;
    let m = 0;
    for (let i = Math.max(0, Math.floor(r.startMs / SEC)); i <= Math.min(arr.length - 1, Math.ceil(r.endMs / SEC)); i++) m = Math.max(m, arr[i]);
    if (m >= 0.05) out[s.name] = Math.round(m * 100) / 100;
  }
  return out;
}

export function describeRange(c: Computed, r: { startMs: number; endMs: number }): string[] {
  return SIGNALS.map((s) => s.describe(r, c.outputs.get(s.name)!)).filter((x): x is string => !!x);
}

/** Run the signals and pick seeds; `range` limits the seeds to one stretch (a stream scan pass). */
export function discover(videoId: string, opts: { range?: { startMs: number; endMs: number } } = {}): SignalsFile {
  const c = computeSignals(videoId);
  const { meta } = c.ctx;
  const n = Math.ceil(meta.durationMs / SEC) + 1;

  const combined = new Float32Array(n);
  // audio laughter tracks caption [laughter] closely (r = 0.87 per minute on a podcast), so when both
  // exist the audio signal counts half to avoid scoring the same laughs twice
  const both = c.outputs.get('laughter')?.available && c.outputs.get('audio')?.available;
  for (const s of SIGNALS) {
    const arr = c.norm.get(s.name)!;
    const w = s.name === 'audio' && both ? s.weight / 2 : s.weight;
    for (let i = 0; i < n; i++) combined[i] += w * arr[i];
  }
  const blocked = new Uint8Array(n);
  for (let i = 0; i < Math.min(n, 20); i++) blocked[i] = 1; // the very start is never a clip
  for (const e of c.excluded)
    for (let i = Math.max(0, Math.floor(e.startMs / SEC) - 3); i <= Math.min(n - 1, Math.ceil(e.endMs / SEC) + 3); i++) blocked[i] = 1;
  if (opts.range) for (let i = 0; i < n; i++) if (i * SEC < opts.range.startMs || i * SEC > opts.range.endMs) blocked[i] = 1;
  for (let i = 0; i < n; i++) if (blocked[i]) combined[i] = 0;

  // a seed's peak is inside the range, but its window may reach a little past the edges (the
  // setup can start before the range); only sponsor/muted stretches cut a window short
  const outside = (i: number) => !!opts.range && (i * SEC < opts.range.startMs || i * SEC > opts.range.endMs) && !c.excluded.some((e) => i * SEC >= e.startMs - 3 * SEC && i * SEC <= e.endMs + 3 * SEC);
  // Greedy peak picking with suppression.
  const work = Float32Array.from(combined);
  const seeds: Seed[] = [];
  while (seeds.length < MAX_SEEDS) {
    let peak = 0;
    for (let i = 1; i < n; i++) if (work[i] > work[peak]) peak = i;
    const v = work[peak];
    if (v < 0.3) break;
    // region where the score stays above half the peak
    let a = peak;
    let b = peak;
    while (a > 0 && work[a - 1] >= v * 0.5 && !blocked[a - 1] && peak - a < 90) a--;
    while (b < n - 1 && work[b + 1] >= v * 0.5 && !blocked[b + 1] && b - peak < 60) b++;
    // (outside the range work[] is 0, so the half-peak region stops at the range edge)
    let start = a - 10;
    let end = b + 10;
    if (end - start < 45) {
      start = Math.min(start, peak - 30);
      end = Math.max(end, peak + 15);
    }
    // never cross into an excluded range
    for (let i = peak; i >= start; i--) if (i >= 0 && blocked[i] && i > 20 && !outside(i)) { start = i + 1; break; }
    for (let i = peak; i <= end; i++) if (i < n && blocked[i] && !outside(i)) { end = i - 1; break; }
    start = Math.max(0, start);
    end = Math.min(n - 1, end);
    for (let i = Math.max(0, start - 15); i <= Math.min(n - 1, end + 15); i++) work[i] = 0;
    const range = { startMs: start * SEC, endMs: end * SEC };
    const chapter = meta.chapters.find((ch) => ch.startMs <= peak * SEC && ch.endMs > peak * SEC);
    seeds.push({
      id: '',
      ...range,
      peakMs: peak * SEC,
      score: Math.round(Math.min(1, v / 1.6) * 100),
      sources: signalStrengths(c, range),
      why: describeRange(c, range),
      chapter: chapter?.title,
    });
  }
  seeds.forEach((s, k) => (s.id = `s${String(k + 1).padStart(2, '0')}`));

  const bins = Math.ceil(meta.durationMs / BIN_MS);
  const timeline = Object.fromEntries(
    SIGNALS.map(({ name }) => {
      const arr = c.norm.get(name)!;
      return [
        name,
        Array.from({ length: bins }, (_, b) => {
          let m = 0;
          for (let i = (b * BIN_MS) / SEC; i < Math.min(arr.length, ((b + 1) * BIN_MS) / SEC); i++) m = Math.max(m, arr[i]);
          return Math.round(m * 100) / 100;
        }),
      ];
    }),
  ) as Record<SignalName, number[]>;

  const file: SignalsFile = {
    videoId,
    generatedAt: new Date().toISOString(),
    durationMs: meta.durationMs,
    available: Object.fromEntries(SIGNALS.map((s) => [s.name, c.outputs.get(s.name)!.available])) as Record<SignalName, boolean>,
    binMs: BIN_MS,
    timeline,
    excluded: c.excluded,
    comments: ((c.outputs.get('comments')!.extra?.hits as SignalsFile['comments']) ?? []).slice(0, 200),
    laughs: (c.outputs.get('laughter')!.extra?.times as number[]) ?? [],
    teaser: (c.outputs.get('teaser')!.extra?.matches as SignalsFile['teaser']) ?? [],
    seeds,
    ...(opts.range ? { seedRange: opts.range } : {}),
  };
  writeJson(paths.videoFile(videoId, 'signals.json'), file);
  return file;
}

export function printSignals(f: SignalsFile, log = console.log) {
  const on = Object.entries(f.available).filter(([, v]) => v).map(([k]) => k);
  // only list as missing what this platform could have (Twitch has no comments, heatmap or teaser)
  const possible = (k: string) => (f.videoId.startsWith('tw-') ? !['comments', 'heatmap', 'teaser'].includes(k) : !['chat', 'clips'].includes(k));
  const off = Object.entries(f.available).filter(([k, v]) => !v && possible(k)).map(([k]) => k);
  log(`signals: ${on.join(', ') || 'none'}${off.length ? `  (missing: ${off.join(', ')})` : ''}`);
  if (f.excluded.length) log(`excluded: ${f.excluded.map((e) => `${e.category} ${fmtTime(e.startMs, 0)}–${fmtTime(e.endMs, 0)}`).join(', ')}`);
  if (!f.seeds.length) {
    log('No seeds: signals are too weak. The judge should read the whole transcript.');
    return;
  }
  log(`\n${f.seeds.length} seeds (strongest first):`);
  for (const s of f.seeds) {
    log(`${s.id}  ${fmtTime(s.startMs, 0).padStart(7)}–${fmtTime(s.endMs, 0).padEnd(7)}  score ${String(s.score).padStart(3)}  ${s.chapter ? `[${s.chapter}]` : ''}`);
    for (const w of s.why) log(`       · ${w}`);
  }
}
