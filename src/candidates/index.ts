// Candidates: the judge proposes, this module checks. Every candidate must sit inside the video,
// last 15–90 s, start on a sentence, avoid sponsor reads and cite words actually spoken in it.
import fs from 'node:fs';
import { paths, readJsonIf, writeJson } from '../core/paths';
import {
  CandidateInputSchema,
  CandidatesFileSchema,
  type Candidate,
  type CandidateInput,
  type CandidatesFile,
  type Transcript,
  type Word,
} from '../core/schemas';
import { loadMeta } from '../ingest/ingest';
import { endsSentence } from '../ingest/transcript';
import { computeSignals, signalStrengths, describeRange, type Computed } from '../discover';
import type { CommentHit } from '../discover/signals/comments';
import { reactionWeight, type AudioDetection } from '../discover/signals/audio';
import { readChat, DOUBT_MIN, type ChatSpike } from '../discover/chatAnalysis';
import { clipSpan, type ViewerClip } from '../ingest/twitch';
import { fmtTime, parseTime } from '../core/time';
import { enqueue } from '../jobs/queue';
import { ensureWorker } from '../jobs/worker';
import { SECTION_MARGIN_MS, missingRanges } from '../ingest/media';
import { projectFromCandidate, saveProject, loadPreset, applyPreset, listPresets, loadProject } from '../project';
import { viralityScore, convergenceScore, rankScore, rankCandidates, verdictOf, type ViralityScores } from './virality';
import { BUFFER_AFTER_MS, BUFFER_BEFORE_MS } from '../extract/window';
import { OPENING_FILLERS } from '../core/vocabulary';
import { chatSlurs } from '../core/risk';
import { expertFlags } from '../scan/review';
import path from 'node:path';

export const MIN_MS = 15_000;
export const MAX_MS = 90_000;
export const SHORTS_CAP_MS = 60_000;

const file = (videoId: string) => paths.videoFile(videoId, 'candidates.json');

/** Fill in the computed ranking fields and sort strongest first. Every load and save goes through it,
 *  so old candidate files pick up a rank without a migration. */
function ranked(f: CandidatesFile): CandidatesFile {
  return { ...f, candidates: rankCandidates(f.candidates) };
}

export function loadCandidates(videoId: string): CandidatesFile {
  const f = readJsonIf<CandidatesFile>(file(videoId));
  return f ? ranked(CandidatesFileSchema.parse(f)) : { videoId, candidates: [] };
}

export function saveCandidates(f: CandidatesFile): CandidatesFile {
  const out = CandidatesFileSchema.parse(ranked(f));
  writeJson(file(f.videoId), out);
  return out;
}

// ---------- word helpers ----------

const PAUSE = 600;
const isStart = (w: Word[], n: number) =>
  n === 0 || !!w[n].speakerChange || endsSentence(w[n - 1]) || w[n].startMs - w[n - 1].endMs >= PAUSE;
const isEnd = (w: Word[], n: number) =>
  n === w.length - 1 || endsSentence(w[n]) || !!w[n + 1].speakerChange || w[n + 1].startMs - w[n].endMs >= PAUSE;

const normWord = (s: string) => s.toLowerCase().replace(/[^a-z0-9']/g, '');

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// The handles kept around the first and last word are the extraction buffer (300 ms before, 400 ms
// after): the same numbers `clip windows` adds, so a window chosen there survives being added here.
function snapStart(words: Word[], ms: number): { ms: number; midSentence: boolean } {
  const near = words.map((w, n) => ({ w, n })).filter(({ w }) => w.startMs >= ms - 2500 && w.startMs <= ms + 1500);
  const starts = near.filter(({ n }) => isStart(words, n));
  const pick = (starts.length ? starts : near).sort((a, b) => Math.abs(a.w.startMs - ms) - Math.abs(b.w.startMs - ms))[0];
  // nobody is speaking around the start (a scare, a fall): keep the time as given; that is not mid-sentence
  if (!pick) return { ms, midSentence: words.some((w) => w.startMs < ms && w.endMs > ms) };
  const prevEnd = words[pick.n - 1]?.endMs ?? 0;
  return { ms: Math.max(prevEnd, pick.w.startMs - BUFFER_BEFORE_MS), midSentence: !starts.length };
}

function snapEnd(t: Transcript, ms: number): number {
  const words = t.words;
  const near = words.map((w, n) => ({ w, n })).filter(({ w }) => w.endMs >= ms - 2000 && w.endMs <= ms + 3000);
  const ends = near.filter(({ n }) => isEnd(words, n));
  const pick = (ends.length ? ends : near).sort((a, b) => Math.abs(a.w.endMs - ms) - Math.abs(b.w.endMs - ms))[0];
  if (!pick) return ms;
  let end = pick.w.endMs + BUFFER_AFTER_MS;
  // let the laugh after a punchline land
  const laugh = t.tags.filter((g) => /laugh|applause|cheer/.test(g.tag) && g.ms >= pick.w.startMs && g.ms <= end + 2500);
  if (laugh.length) end = Math.max(end, laugh[laugh.length - 1].ms + 1500);
  const next = words[pick.n + 1];
  if (next && !laugh.length) end = Math.min(end, next.startMs - 20);
  return end;
}

function quoteFound(quote: string, rangeWords: string[]): boolean {
  const q = quote.split(/\s+/).map(normWord).filter(Boolean);
  if (q.length < 3) return false;
  // longest common subsequence plus a contiguous run, so scattered common words can't pass
  const dp = Array.from({ length: q.length + 1 }, () => new Array(rangeWords.length + 1).fill(0));
  let run = 0;
  const runDp = Array.from({ length: q.length + 1 }, () => new Array(rangeWords.length + 1).fill(0));
  for (let i = 1; i <= q.length; i++)
    for (let j = 1; j <= rangeWords.length; j++) {
      const eq = q[i - 1] === rangeWords[j - 1];
      dp[i][j] = eq ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      runDp[i][j] = eq ? runDp[i - 1][j - 1] + 1 : 0;
      run = Math.max(run, runDp[i][j]);
    }
  return dp[q.length][rangeWords.length] / q.length >= 0.7 && run >= Math.min(3, q.length);
}

/** Auto-captions mishear; top comments often quote the line correctly. Flag likely mistakes. */
function captionWarnings(c: Computed, words: Word[], r: { startMs: number; endMs: number }): string[] {
  const hits = ((c.outputs.get('comments')?.extra?.hits as CommentHit[]) ?? [])
    .filter((h) => h.ms >= r.startMs && h.ms <= r.endMs + 5000)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 5);
  const inRange = words.filter((w) => w.startMs >= r.startMs && w.endMs <= r.endMs);
  const have = new Set(inRange.map((w) => normWord(w.text)));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const cw = [...new Set(h.text.split(/\s+/).map(normWord))].filter((x) => x.length >= 5 && /^[a-z']+$/.test(x) && !have.has(x));
    for (const x of cw) {
      const near = inRange.filter((w) => Math.abs(w.startMs - h.ms) <= 15_000);
      for (const w of near) {
        const y = normWord(w.text);
        const bare = (z: string) => z.replace(/'/g, '');
        const stem = (z: string) => bare(z).replace(/(ing|ed|es|s|d)$/, '');
        const sameWord = stem(x) === stem(y) || x.startsWith(y) || y.startsWith(x); // didnt/didn't, believes/believed
        // the comment dropped letters ("remeber" for "remembers"): a typo in the comment, not a mishearing
        const isSub = (a: string, b: string) => { let k = 0; for (const ch of b) if (ch === a[k]) k++; return k === a.length; };
        if (x.length < y.length && isSub(x, y)) continue;
        if (y.length >= 5 && y[0] === x[0] && !sameWord && lev(x, y) <= 2 && !seen.has(y)) {
          seen.add(y);
          out.push(`captions say "${y}" at ${fmtTime(w.startMs)}; a comment (${h.likes} likes) says "${x}". Check before export (word #${w.i})`);
        }
      }
    }
    if (out.length >= 2) break;
  }
  return out.slice(0, 2);
}

/** Things to check before posting: YouTube's captions mark swearing as [__], and people say "slurs". */
export function riskWarnings(words: Word[], r: { startMs: number; endMs: number }): string[] {
  const inRange = words.filter((w) => w.startMs >= r.startMs && w.endMs <= r.endMs);
  const out: string[] = [];
  const bleeps = inRange.filter((w) => w.text.includes('[__]')).length;
  if (bleeps) out.push(`risk: ${bleeps} censored word${bleeps > 1 ? 's' : ''} ([__]) in the captions. Captions show **** but the audio is uncensored: a bleep (\`clip censor\`) or a cut if it must not be heard`);
  const said = inRange.map((w) => normWord(w.text)).join(' ');
  if (/\bslurs?\b|\bn word\b|\bracist\b/.test(said)) out.push('risk: someone mentions slurs or racism here; listen to the in-game/background audio before posting');
  return out;
}

/**
 * What inside a range says something happened there, in plain words: a reaction heard in the audio, a
 * chat spike (chat trails the moment, so one up to 30 s after the end counts), a viewer clip whose
 * offset is within a clip length, a caption laugh tag, a timestamped comment. The same witnesses the
 * queue checkers use; a signal's 0–1 strength is relative to the whole video and too coarse for this.
 */
export function evidenceIn(c: Computed, r: { startMs: number; endMs: number }): { witnesses: string[]; reactionTimes: number[] } {
  const witnesses: string[] = [];
  const heard = ((c.outputs.get('audio')?.extra?.detections as AudioDetection[]) ?? []).filter((d) => d.startMs >= r.startMs - 500 && d.startMs <= r.endMs && reactionWeight(d) >= 1);
  for (const d of heard.slice(0, 3)) witnesses.push(`a ${d.kind} at ${fmtTime(d.startMs)}`);
  const tags = ((c.outputs.get('laughter')?.extra?.times as number[]) ?? []).filter((ms) => ms >= r.startMs && ms <= r.endMs + 1500);
  if (tags.length) witnesses.push(`${tags.length} laugh/applause tag${tags.length > 1 ? 's' : ''}`);
  const spikes = ((c.outputs.get('chat')?.extra?.spikes as ChatSpike[]) ?? []).filter((x) => !x.raid && x.startMs <= r.endMs + 30_000 && x.endMs >= r.startMs);
  for (const x of spikes.slice(0, 2)) witnesses.push(`chat ${x.ratio.toFixed(1)}× normal at ${fmtTime(x.peakMs, 0)}`);
  const clips = ((c.outputs.get('clips')?.extra?.clips as ViewerClip[]) ?? []).filter((v) => clipSpan(v).startMs <= r.endMs && clipSpan(v).endMs >= r.startMs);
  if (clips.length) witnesses.push(`${clips.length} viewer clip${clips.length > 1 ? 's' : ''} ("${clips[0].title}")`);
  const comments = ((c.outputs.get('comments')?.extra?.hits as CommentHit[]) ?? []).filter((h) => h.ms >= r.startMs && h.ms <= r.endMs + 5000);
  if (comments.length) witnesses.push(`${comments.length} timestamped comment${comments.length > 1 ? 's' : ''}`);
  return { witnesses, reactionTimes: [...heard.map((d) => d.startMs), ...tags] };
}

/**
 * Cheap cross-checks of the judge's funnel scores against what the transcript and signals show.
 * They never reject: they put a note next to a score that the evidence contradicts, so an inflated
 * 8 is visible to the curator and the reviewer. All start with "score check:".
 */
export function scoreChecks(scores: ViralityScores | undefined, words: Word[], r: { startMs: number; endMs: number }, ev: { witnesses: string[]; reactionTimes: number[] } = { witnesses: [], reactionTimes: [] }, visual = false): string[] {
  if (!scores) return [];
  const inRange = words.filter((w) => w.endMs > r.startMs && w.startMs < r.endMs);
  const first = inRange[0];
  const last = inRange[inRange.length - 1];
  const out: string[] = [];
  const reactionOpens = ev.reactionTimes.some((ms) => ms <= r.startMs + 2500);
  if (scores.stop >= 7 && first && !visual) {
    const wait = first.startMs - r.startMs;
    const word = first.text.toLowerCase().replace(/[^a-z]/g, '');
    if (wait > 2000 && !reactionOpens) out.push(`score check: stop ${scores.stop}, but the first word is ${(wait / 1000).toFixed(1)} s in. If the open is visual, say what is on screen in the reason; if not, start later or lower stop`);
    else if (wait <= 1500 && OPENING_FILLERS.has(word)) out.push(`score check: stop ${scores.stop}, but the clip opens on the filler "${first.text}"`);
  }
  const delivery = scores.delivery ?? scores.payoff;
  if (last && /[?]["')\]]?$/.test(last.text.trim()) && (scores.payoff >= 7 || delivery >= 7)) out.push(`score check: payoff ${scores.payoff} / delivery ${delivery}, but the last line is a question ("${inRange.slice(-5).map((w) => w.text).join(' ')}"): is the answer inside the clip?`);
  if (scores.share >= 8 && !ev.witnesses.length) out.push(`score check: share ${scores.share}, but nothing in range backs it (no chat spike, viewer clip, reaction or comment). Check the frames before trusting it`);
  if (scores.hold >= 7 && r.endMs - r.startMs > 20_000) {
    // the longest stretch with no word and no reaction: a sag the viewer can leave in
    const beats = [...inRange.flatMap((w) => [w.startMs, w.endMs]), ...ev.reactionTimes.filter((ms) => ms > r.startMs && ms < r.endMs), r.endMs].sort((x, y) => x - y);
    let gap = 0;
    for (let k = 1; k < beats.length; k++) gap = Math.max(gap, beats[k] - beats[k - 1]);
    if (inRange.length && gap > 5000) out.push(`score check: hold ${scores.hold}, but there is a ${(gap / 1000).toFixed(1)} s stretch with no speech and no reaction`);
  }
  return out;
}

/** When a batch's scores barely differ, the rubric did not discriminate: say so while it can be fixed. */
export function spreadNote(cands: { scores?: ViralityScores }[]): string | undefined {
  const scored = cands.map((c) => c.scores).filter((s): s is ViralityScores => !!s);
  if (scored.length < 4) return undefined;
  const dims = ['stop', 'hold', 'share', 'standalone', 'payoff'] as const;
  const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  const flat = dims.filter((d) => range(scored.map((s) => s[d])) <= 1);
  if (flat.length < 4) return undefined;
  return `all ${scored.length} candidates are within 1 point of each other on ${flat.join(', ')}. Scores that do not differ cannot rank: order the batch from best to worst on each quality first, then score, and use the lens anchors (2 / 5 / 9). Fix with \`clip candidates score\`.`;
}

/**
 * Risk flags the queue experts put on this moment (library/<id>/queue-review.json), as a `risk:`
 * warning. QA shows every `risk:` warning to the reviewer, so a flag an expert raised from the frames
 * reaches the person who decides without depending on any agent repeating it. Profanity is left in
 * the ledger: it is on most stream clips and would bury the flags that matter.
 */
export function expertRiskWarnings(videoId: string, r: { startMs: number; endMs: number }, queueId?: string): string[] {
  const by = [...(expertFlags(videoId, r, queueId) ?? [])].filter(([f]) => f !== 'profanity');
  if (!by.length) return [];
  return [`risk: flagged by the queue experts: ${by.map(([f, who]) => `${f} (${who.join(', ')})`).join('; ')}. A person must check this before it is posted (\`clip queue-review ${videoId}\` has what they saw)`];
}

const CHAT_LINGER_MS = 15_000;
const CHAT_DELAY_MS = 3_000;

/**
 * Slurs typed in chat while the clip plays. Many streams show chat in the frame, so a slur in chat can
 * be a slur on screen in the clip; nothing that reads the transcript would ever see it.
 */
export function chatSlurWarnings(c: Computed, r: { startMs: number; endMs: number }): string[] {
  // An on-screen chat runs a few seconds behind what was typed (about 5 s on the stream this was
  // measured on) and a line stays up for a while. So what is visible during the clip was typed from
  // a little before it starts until about 3 s before it ends.
  const found = chatSlurs(c.ctx.chat?.messages ?? [], r.startMs - CHAT_LINGER_MS, r.endMs - CHAT_DELAY_MS);
  if (!found.count) return [];
  return [`risk: ${found.count} chat message${found.count > 1 ? 's' : ''} during this clip contain${found.count > 1 ? '' : 's'} a slur (typed at ${fmtTime(found.firstMs!, 0)}; an on-screen chat shows it about 5 s later). If this stream shows chat in the frame, it is in the clip: check the frames there, and crop, cut or start after it`];
}

/** Chat answers a moment 5–25 s after it. */
const CHAT_REACTS_MS = 25_000;

/**
 * Chat calling the moment fake, staged or AI while it happened. A prank or a bit titled as fact is the
 * fastest way to lose an audience, and nothing that reads the transcript sees chat's doubt. This does
 * not depend on an expert having flagged it.
 */
export function chatDoubtWarnings(c: Computed, r: { startMs: number; endMs: number }, videoId: string): string[] {
  const doubt = readChat(c.ctx.chat?.messages ?? [], r.startMs, r.endMs + CHAT_REACTS_MS).doubt;
  if (doubt < DOUBT_MIN) return [];
  return [`risk: ${doubt} chatters called this fake, staged or AI while it happened. Find out what it really was before it is titled as fact: read chat over the clip and the two minutes after it (\`clip chat ${videoId} --from ${fmtTime(r.startMs, 0)} --to ${fmtTime(r.endMs + 120_000, 0)}\`)`];
}

// ---------- add ----------

export interface AddResult {
  accepted: Candidate[];
  rejected: { input: unknown; errors: string[] }[];
  /** Things about the batch as a whole worth acting on (e.g. scores that do not discriminate). */
  notes: string[];
}

/** A stream nobody has transcribed yet has no transcript file; a visual candidate can still be added. */
const transcriptOrEmpty = (videoId: string): Transcript =>
  readJsonIf<Transcript>(paths.videoFile(videoId, 'transcript.json')) ?? { videoId, source: 'whisper', lang: 'en', words: [], tags: [], covered: [] };

export function addCandidates(videoId: string, inputs: unknown[], opts: { footage?: boolean } = {}): AddResult {
  const meta = loadMeta(videoId);
  const t = transcriptOrEmpty(videoId);
  const c = computeSignals(videoId);
  const f = loadCandidates(videoId);
  const res: AddResult = { accepted: [], rejected: [], notes: [] };
  let next = Math.max(0, ...f.candidates.map((x) => Number(x.id.replace(/\D/g, '')) || 0)) + 1;

  for (const raw of inputs) {
    const parsed = CandidateInputSchema.safeParse(raw);
    if (!parsed.success) {
      res.rejected.push({ input: raw, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      continue;
    }
    const inp = parsed.data;
    const errors: string[] = [];
    const warnings: string[] = [];
    let startMs: number;
    let endMs: number;
    try {
      startMs = parseTime(inp.start);
      endMs = parseTime(inp.end);
    } catch (e) {
      res.rejected.push({ input: raw, errors: [(e as Error).message] });
      continue;
    }
    const s = snapStart(t.words, startMs);
    startMs = Math.max(0, s.ms);
    const askedEnd = endMs;
    endMs = Math.min(meta.durationMs, snapEnd(t, endMs));
    // snapping and the laugh extension must never push the end into a sponsor read or intro
    // that the judge deliberately stopped before
    for (const e of c.excluded) {
      if (e.startMs > startMs && e.startMs < endMs && askedEnd <= e.startMs + 1000) endMs = Math.min(endMs, e.startMs - 50);
    }
    if (s.midSentence) warnings.push('starts mid-sentence (no sentence start within 2.5 s)');
    const quote = inp.quote.trim();
    const dur = endMs - startMs;
    if (startMs >= endMs) errors.push('end is before start');
    if (startMs < 0 || endMs > meta.durationMs) errors.push('outside the video');
    if (dur < MIN_MS || dur > MAX_MS) errors.push(`lasts ${(dur / 1000).toFixed(1)} s after snapping; must be 15–90 s`);
    // a judge writing "start": 853.4 means seconds, but a bare number is milliseconds
    if (typeof inp.start === 'number' && typeof inp.end === 'number' && inp.end - inp.start < 1000 && inp.end > inp.start)
      errors.push('bare numbers are milliseconds: write times as strings ("14:13.4", "1:02:03") or as whole milliseconds');
    if (dur > SHORTS_CAP_MS && dur <= MAX_MS) warnings.push('over 60 s: YouTube blocks Shorts over 1 min that get a Content ID claim');
    for (const e of c.excluded) {
      const ov = Math.min(endMs, e.endMs) - Math.max(startMs, e.startMs);
      if (ov > 1000) errors.push(`overlaps ${e.category} ${fmtTime(e.startMs, 0)}–${fmtTime(e.endMs, 0)}`);
    }
    const rangeWords = t.words.filter((w) => w.startMs >= startMs - 500 && w.endMs <= endMs + 500).map((w) => normWord(w.text));
    const signals = signalStrengths(c, { startMs, endMs });
    const ev = evidenceIn(c, { startMs, endMs });
    if (quote) {
      if (!quoteFound(quote, rangeWords)) errors.push(`quote not found in ${fmtTime(startMs)}–${fmtTime(endMs)}: cite words actually spoken in the clip`);
    } else if (!inp.visual) {
      errors.push('no quote: cite 5–20 words spoken inside the clip. If nothing is said or the words are not the point, set "visual": true (the clip then needs a chat spike, a reaction heard in the audio or a viewer clip inside it)');
    } else if (!ev.witnesses.length) {
      // the quote rule stops a judge inventing a moment; a wordless clip has to point at evidence instead
      errors.push(`visual candidate with no evidence in ${fmtTime(startMs)}–${fmtTime(endMs)}: there is no chat spike, reaction in the audio or viewer clip inside it. Move the window onto the moment, or scan the range first`);
    }
    for (const o of [...f.candidates.filter((x) => x.status !== 'skipped'), ...res.accepted]) {
      const ov = Math.min(endMs, o.endMs) - Math.max(startMs, o.startMs);
      if (ov > 0.5 * Math.min(dur, o.endMs - o.startMs)) errors.push(`duplicates ${o.id} (${fmtTime(o.startMs, 0)}–${fmtTime(o.endMs, 0)})`);
    }
    if (errors.length) {
      res.rejected.push({ input: raw, errors });
      continue;
    }
    const range = { startMs, endMs };
    warnings.push(...captionWarnings(c, t.words, range), ...riskWarnings(t.words, range), ...chatSlurWarnings(c, range), ...chatDoubtWarnings(c, range, videoId), ...expertRiskWarnings(videoId, range, inp.queueId), ...scoreChecks(inp.scores, t.words, range, ev, !!inp.visual));
    if (inp.visual) warnings.push(`visual: accepted on ${ev.witnesses.join(', ')}, not on a quote. Check the frames`);
    const convergence = convergenceScore(signals);
    const virality = inp.scores ? viralityScore(inp.scores, inp.lens) : undefined;
    const cand: Candidate = {
      id: `c${String(next++).padStart(2, '0')}`,
      startMs,
      endMs,
      title: inp.title,
      hook: inp.hook,
      reason: inp.reason,
      quote,
      ...(inp.visual ? { visual: true } : {}),
      lens: inp.lens,
      ...(inp.kind ? { kind: inp.kind } : {}),
      ...(inp.queueId ? { queueId: inp.queueId } : {}),
      score: inp.score,
      scores: inp.scores,
      virality,
      convergence,
      verdict: verdictOf(inp.scores, virality, inp.score, inp.lens),
      rankScore: rankScore(virality, convergence, inp.score),
      signals,
      why: describeRange(c, range),
      warnings,
      status: 'new',
      createdAt: new Date().toISOString(),
    };
    res.accepted.push(cand);
  }
  f.candidates.push(...res.accepted);
  const note = spreadNote(res.accepted);
  if (note) res.notes.push(note);
  saveCandidates(f);
  if (res.accepted.length && opts.footage !== false) queueFootage(videoId, res.accepted);
  return res;
}

/** Recompute signals, explanations and warnings for stored candidates (after discovery improves). */
export function refreshCandidates(videoId: string): CandidatesFile {
  const t = transcriptOrEmpty(videoId);
  const c = computeSignals(videoId);
  const f = loadCandidates(videoId);
  for (const cand of f.candidates) {
    const r = { startMs: cand.startMs, endMs: cand.endMs };
    cand.signals = signalStrengths(c, r);
    cand.why = describeRange(c, r);
    cand.warnings = [
      ...cand.warnings.filter((w) => !w.startsWith('captions say') && !w.startsWith('risk:') && !w.startsWith('score check:')),
      ...captionWarnings(c, t.words, r),
      ...riskWarnings(t.words, r),
      ...chatSlurWarnings(c, r),
      ...chatDoubtWarnings(c, r, videoId),
      ...expertRiskWarnings(videoId, r, cand.queueId),
      ...scoreChecks(cand.scores, t.words, r, evidenceIn(c, r), !!cand.visual),
    ];
  }
  return saveCandidates(f);
}

/** Queue the video sections around these candidates (with room to trim) so previews and renders work. */
export function queueFootage(videoId: string, cands: { startMs: number; endMs: number }[]) {
  const ranges = cands.map((c) => ({ startMs: c.startMs - SECTION_MARGIN_MS, endMs: c.endMs + SECTION_MARGIN_MS }));
  const meta = loadMeta(videoId);
  if (!missingRanges(videoId, ranges, meta.durationMs).length) return;
  enqueue('sections', { videoId, dedupe: true, payload: { ranges }, priority: 3 });
  ensureWorker();
}

export function readCandidateInputs(src: string): CandidateInput[] {
  const text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  const j = JSON.parse(text);
  return Array.isArray(j) ? j : j.candidates;
}

export function setCandidateStatus(videoId: string, id: string, status: Candidate['status']) {
  const f = loadCandidates(videoId);
  const cand = f.candidates.find((x) => x.id === id);
  if (!cand) throw new Error(`No candidate ${id} for ${videoId}`);
  cand.status = status;
  saveCandidates(f);
  return cand;
}

/** Turn a candidate into an editable clip project (applies presets/default.json if present). */
export async function makeClip(videoId: string, candId: string, opts: { split?: boolean } = {}): Promise<string> {
  const f = loadCandidates(videoId);
  const cand = f.candidates.find((x) => x.id === candId);
  if (!cand) throw new Error(`No candidate ${candId} for ${videoId}`);
  const clipId = `${videoId}-${cand.id}`;
  if (!fs.existsSync(paths.project(clipId))) {
    let p = projectFromCandidate(videoId, cand, loadMeta(videoId));
    if (listPresets().includes('default')) {
      p = await applyPreset(p, loadPreset('default'));
      delete p.autoSplit; // the preset chose the framing
    }
    // A sports/event stream has a full-frame picture, not a gameplay facecam: keep blur/crop.
    if (opts.split === false) delete p.autoSplit;
    saveProject(p);
    if (p.autoSplit) {
      // new Twitch clip: find the facecam and switch to the split layout (a 'split' job, high priority)
      enqueue('split', { videoId, clipId, payload: { auto: true }, priority: 9 });
      ensureWorker();
    }
  }
  cand.status = 'made';
  cand.clipId = clipId;
  saveCandidates(f);
  return clipId;
}

/** A copy of a clip to try a different edit (…-v2, …-v3). Review state and exports aren't copied. */
export function duplicateClip(clipId: string): string {
  const p = loadProject(clipId);
  const base = clipId.replace(/-v\d+$/, '');
  let n = 2;
  while (fs.existsSync(paths.project(`${base}-v${n}`))) n++;
  const id = `${base}-v${n}`;
  const now = new Date().toISOString();
  const { review: _r, ...rest } = p;
  saveProject({ ...rest, id, rev: 0, title: `${p.title.replace(/ \(v\d+\)$/, '')} (v${n})`, createdAt: now, updatedAt: now });
  return id;
}

/**
 * Delete a clip: its project and exports move to clips/.trash/ (recoverable by moving them back),
 * and its candidate goes back to "new" so it can be made again.
 */
export function deleteClip(clipId: string): { trash: string } {
  const p = loadProject(clipId);
  const trash = path.join(paths.clips, '.trash', `${clipId}-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}`);
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(paths.clip(clipId), path.join(trash, 'clip'));
  for (const ext of ['.mp4', '.json', '.qa.json', '.txt']) {
    const f = path.join(paths.exports, clipId + ext);
    if (fs.existsSync(f)) fs.renameSync(f, path.join(trash, path.basename(f)));
  }
  if (p.candidateId) {
    const f = loadCandidates(p.videoId);
    const cand = f.candidates.find((c) => c.id === p.candidateId && c.clipId === clipId);
    if (cand) {
      cand.status = 'new';
      delete cand.clipId;
      saveCandidates(f);
    }
  }
  return { trash };
}

export function printCandidate(c: Candidate, log = console.log) {
  const dur = ((c.endMs - c.startMs) / 1000).toFixed(1);
  const meta = [
    `score ${c.score}`,
    c.virality !== undefined ? `viral ${c.virality}` : '',
    c.convergence !== undefined ? `signal ${Math.round(c.convergence * 100)}%` : '',
    c.verdict ? `verdict ${c.verdict}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  log(`${c.rank ? `#${c.rank} ` : ''}${c.id}  ${fmtTime(c.startMs)}–${fmtTime(c.endMs)} (${dur} s)  ${meta}  [${c.status}]${c.kind ? `  ${c.kind}${c.visual ? ', visual' : ''}` : c.visual ? '  visual' : ''}  ${c.title}`);
  if (c.scores) {
    const s = c.scores;
    log(
      `     funnel: stop ${s.stop} · hold ${s.hold} · share ${s.share} · standalone ${s.standalone} · payoff ${s.payoff}${s.delivery !== undefined ? ` · delivery ${s.delivery}` : ''}`,
    );
  }
  const sig = Object.entries(c.signals).map(([k, v]) => `${k} ${v}`).join(', ');
  log(`     signals: ${sig || 'none (transcript only)'}`);
  for (const w of c.why) log(`     · ${w}`);
  for (const w of c.warnings) log(`     ⚠ ${w}`);
}
