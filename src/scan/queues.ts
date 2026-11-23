// Typed queue extraction: find moments worth looking at, with the evidence attached.
//
// A queue is not a clip. It is a region around a moment where independent witnesses agree that
// something happened: chat went faster than usual, people laughed or screamed, viewers clipped it.
// Fast speech and title words are context, not witnesses: they raise a score but never make a queue.
//
// Three checkers read the same evidence with different weights and a different gate:
//   meme  — a quick, loopable gag: needs a reaction (a laugh or a scream in the audio, or chat
//           laughing, gasping or mocking). Short window.
//   viral — a moment with reach: needs two witnesses, or viewer clips that people actually watched.
//   clip  — a story with a setup and a payoff: needs speech plus a witness. Long window.
//
// Everything is in "moment time". Chat reacts 5–25 s after the thing it reacts to (measured on this
// library: median 17.5 s from an audio reaction to the chat peak), so each 5 s step looks that far
// ahead for its chat evidence. A laugh and the chat spike it caused then land on the same step, and
// the queue is placed on the moment instead of on its aftermath.
//
// Unknown is not quiet: chat, audio and the transcript exist only where a stream was scanned.
// `coverageOf` says what is missing, and every queue lists what it could not see.
import { paths, readJsonIf } from '../core/paths';
import { covers, mergeRanges, subtractRanges, type Range } from '../core/ranges';
import type { Transcript, Word } from '../core/schemas';
import { chatLevels, readChat, DOUBT_MIN, MIN_CHATTERS, SPIKE_RATIO, type ChatMessage, type Reaction } from '../discover/chatAnalysis';
import { reactionWeight, type AudioDetection, type ReactionKind } from '../discover/signals/audio';
import { clipNearness } from '../ingest/twitch';
import { chatSlurs, riskTerms } from '../core/risk';

export { riskTerms };

export type QueueKind = 'meme' | 'viral' | 'clip';
export const QUEUE_KINDS: QueueKind[] = ['meme', 'viral', 'clip'];
export type Witness = 'chat' | 'reaction' | 'clips';
/**
 * What fixed the moment's time. `chat` is an estimate from the chat lag, good to about ±10 s; `clip` a
 * viewer clip's offset, good to about one clip length; `expert` is where an expert saw it in frames.
 */
export type Anchor = 'audio' | 'clip' | 'chat' | 'expert';

export interface QueueEvidence {
  chat: {
    fetched: boolean;
    spike: boolean;
    /** Distinct chatters in the busiest 10 s after the moment, and the channel's normal for 10 s. */
    chatters: number;
    normal: number;
    multiple: number;
    /** When chat peaked (it trails the moment). */
    atMs: number | null;
    mood: Reaction | 'neutral';
    moods: Partial<Record<Reaction, number>>;
    /** The most repeated messages, by distinct people. */
    top: { text: string; count: number }[];
    clipRequests: number;
    raid: boolean;
    /** Distinct people calling it fake, staged or AI, over the whole region (not only at a spike). */
    doubt: number;
    /** Chat messages in the region that contain a slur. If the stream shows chat on screen, they are in the frame. */
    slurs: number;
  };
  audio: { covered: boolean; reactions: { kind: ReactionKind; ms: number; peak: number }[] };
  clips: { count: number; views: number; titles: string[]; offsets: number[] };
  speech: { covered: boolean; words: number; wpm: number; excerpt?: string };
  title: { match: number; terms: string[] };
}

export interface Queue {
  /** Stable for the same data: the kind and the moment's time, e.g. "meme@1:46:25". */
  id: string;
  kind: QueueKind;
  startMs: number;
  endMs: number;
  /** The moment itself (not the chat peak). The window scorer places its clip around this. */
  peakMs: number;
  anchor: Anchor;
  score: number;
  confidence: number;
  /** How many independent witnesses saw it (0–3). */
  sources: number;
  witnesses: Witness[];
  signals: QueueEvidence;
  why: string[];
  risks: string[];
  context: string[];
}

/** Everything the checkers read, loaded once. Tests build this by hand. */
export interface QueueData {
  durationMs: number;
  platform?: 'youtube' | 'twitch';
  chat?: { messages: ChatMessage[]; fetched: Range[]; disabled?: boolean };
  reactions: AudioDetection[];
  audioAnalysed: boolean;
  /** Ranges of audio analysed so far; absent with `audioAnalysed` = the whole video. */
  audioCovered?: Range[];
  clips: { offsetMs: number; durationMs: number; views: number; title: string; slug?: string; createdAt?: string }[];
  /** When the broadcast started (its 0:00), to tell which side of its offset a viewer clip sits on. */
  startedAt?: string;
  /** False when viewer clips were never fetched (as opposed to fetched and empty). */
  clipsFetched: boolean;
  transcript?: Pick<Transcript, 'words' | 'tags' | 'covered'>;
  /** Where the video title's rarer words are said. */
  titleHits: { ms: number; term: string; weight: number }[];
  /** Ranges no clip may overlap: muted stretches, sponsor reads, intros. */
  excluded: { startMs: number; endMs: number; category: string }[];
}

export interface QueueCoverage {
  range: Range;
  chat: { state: 'full' | 'partial' | 'none' | 'disabled' | 'n/a'; missing: Range[] };
  audio: { state: 'full' | 'partial' | 'none'; missing: Range[] };
  transcript: { state: 'full' | 'partial' | 'none'; missing: Range[] };
  viewerClips: { state: 'fetched' | 'none' | 'n/a'; count: number };
  /** No chat and no audio anywhere in the range: only viewer clips (if any) can make a queue here. */
  blind: boolean;
}

const STEP = 5_000;
const EVIDENCE_MS = 10_000; // each step reads the 10 s that start at it
/** Chat evidence for a step comes from the steps 0–25 s after it; most weight on a 10–15 s lag. */
const CHAT_LAG_WEIGHTS = [0.8, 0.9, 1, 1, 0.9, 0.8];
/** A moment placed from chat or a viewer clip alone is uncertain, so its region is wider. */
const UNCERTAIN_PAD_MS = 6_000;
/** A region is where the expert looks, not the clip: it may be wider than the 60 s a clip can be. */
const MAX_QUEUE_MS = 90_000;

const WEIGHTS: Record<QueueKind, { chat: number; reaction: number; clips: number; speech: number; title: number }> = {
  meme: { chat: 0.3, reaction: 0.4, clips: 0.2, speech: 0.05, title: 0.05 },
  viral: { chat: 0.3, reaction: 0.3, clips: 0.25, speech: 0.1, title: 0.05 },
  clip: { chat: 0.2, reaction: 0.2, clips: 0.2, speech: 0.3, title: 0.1 },
};

/** The region around the moment each kind's expert should look at. */
const WINDOW: Record<QueueKind, { before: number; after: number }> = {
  meme: { before: 10_000, after: 14_000 },
  viral: { before: 18_000, after: 24_000 },
  clip: { before: 30_000, after: 28_000 },
};

/**
 * Chat moods that mean "we are reacting to a gag": laughing, gasping, mocking, wincing, watching the
 * streamer lose it, or knowing what is about to happen. Cheering (hype), agreeing and suspense are
 * real reactions too, but to a play, a take or a build-up, which the other two checkers look for.
 */
const REACTION_MOODS = new Set<Reaction | 'neutral'>(['funny', 'shock', 'fail', 'cringe', 'rage', 'irony']);

/** Chunks of a scanned stream leave seconds-long seams between them; shorter gaps are not "missing". */
const MIN_GAP_MS = 20_000;

const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));

function tstr(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
export const queueTime = tstr;

export { DOUBT_MIN };
/**
 * Chat says the outcome is not in the region: people call it fake, or chat is ahead of the streamer
 * (irony) or tense. The queue's warnings and the dossier's read-on both ask this.
 */
export const chatAsksReadOn = (chat: Pick<QueueEvidence['chat'], 'doubt' | 'mood'> | undefined): boolean => !!chat && (chat.doubt >= DOUBT_MIN || chat.mood === 'irony' || chat.mood === 'tension');
export const queueId = (kind: QueueKind, momentMs: number) => `${kind}@${tstr(Math.floor(momentMs / STEP) * STEP)}`;

/** The first index whose time is ≥ `ms` in a list sorted by time. */
function lowerBound<T>(list: T[], ms: number, at: (x: T) => number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(list[mid]) < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
const between = <T>(list: T[], a: number, b: number, at: (x: T) => number): T[] => list.slice(lowerBound(list, a, at), lowerBound(list, b, at));

function excerptOf(words: Word[], maxChars = 260): string | undefined {
  if (!words.length) return undefined;
  const lines: string[][] = [];
  let cur: string[] = [];
  let lastEnd = 0;
  for (const w of words) {
    if (cur.length && w.startMs - lastEnd > 700) {
      lines.push(cur);
      cur = [];
    }
    cur.push(w.text);
    lastEnd = w.endMs;
  }
  if (cur.length) lines.push(cur);
  const text = lines.map((l) => l.join(' ')).join(' / ');
  return text.length > maxChars ? `…${text.slice(text.length - maxChars)}` : text;
}

/** 0–1 strength of each kind of evidence on one step, and the kind's weighted score. Pure. */
export function queueBinScore(input: {
  kind: QueueKind;
  /** Distinct chatters in the busiest 10 s that follows, and the channel's normal. */
  chatUnique: number;
  chatBaseline: number;
  /** Reactions heard (already thresholded): a lone weak detection counts 0.5. */
  reactions: Partial<Record<ReactionKind, number>>;
  /** Viewer clips near the step, weighted by nearness, and their views. */
  clipCount: number;
  clipViews: number;
  speechWpm: number;
  hasSpeech: boolean;
  titleMatch: number;
}): { score: number; parts: { chat: number; reaction: number; clips: number; speech: number; title: number }; witnesses: Witness[] } {
  const ratio = input.chatBaseline > 0 ? input.chatUnique / input.chatBaseline : 0;
  const chat = clamp((ratio - 1) / 2.5);
  const laugh = input.reactions.laugh ?? 0;
  const shout = input.reactions.shout ?? 0;
  const cheer = input.reactions.cheer ?? 0;
  const reaction = clamp(laugh * 0.45 + shout * 0.3 + cheer * 0.2);
  const clips = clamp(input.clipCount * 0.3 + input.clipViews / 200);
  const speech = input.hasSpeech ? clamp((input.speechWpm - 120) / 120) : 0;
  const title = clamp(input.titleMatch);
  const parts = { chat, reaction, clips, speech, title };
  const w = WEIGHTS[input.kind];
  const score = Math.round(100 * (w.chat * chat + w.reaction * reaction + w.clips * clips + w.speech * speech + w.title * title));
  const witnesses: Witness[] = [];
  if (input.chatUnique >= MIN_CHATTERS && ratio >= SPIKE_RATIO) witnesses.push('chat');
  if (laugh + shout + cheer >= 1) witnesses.push('reaction');
  if (input.clipCount >= 0.5) witnesses.push('clips');
  return { score, parts, witnesses };
}

/** Does this step make a queue of this kind? Pure: the three experts differ here, not only in weights. */
export function queueGate(kind: QueueKind, e: { witnesses: Witness[]; mood: Reaction | 'neutral'; clipViews: number; hasSpeech: boolean; speechCovered: boolean; titleMatch: number }): boolean {
  const has = (w: Witness) => e.witnesses.includes(w);
  if (kind === 'meme') return has('reaction') || (has('chat') && REACTION_MOODS.has(e.mood));
  if (kind === 'viral') return e.witnesses.length >= 2 || (has('clips') && e.clipViews >= 25);
  // a story needs words; where nothing is transcribed yet that is unknown, so a witness is enough,
  // except one viewer clip nobody watched: on its own, in a part nobody has read, that is not a lead
  if (!e.hasSpeech && e.witnesses.length === 1 && e.witnesses[0] === 'clips' && e.clipViews < 25) return false;
  const words = e.hasSpeech || !e.speechCovered;
  return words && (e.witnesses.length >= 1 || (e.hasSpeech && e.titleMatch >= 0.6));
}

/** What the range can and cannot show. */
export function coverageOf(data: QueueData, range: Range): QueueCoverage {
  const missing = (have: Range[] | undefined) => subtractRanges([range], mergeRanges(have ?? [], MIN_GAP_MS)).filter((r) => r.endMs - r.startMs >= MIN_GAP_MS);
  const state = (m: Range[]) => (!m.length ? 'full' : m.length === 1 && m[0].startMs === range.startMs && m[0].endMs === range.endMs ? 'none' : 'partial') as 'full' | 'partial' | 'none';
  const stream = data.platform === 'twitch';
  const chatMissing = data.chat ? missing(data.chat.fetched) : [range];
  const chat: QueueCoverage['chat'] = !stream ? { state: 'n/a', missing: [] } : data.chat?.disabled ? { state: 'disabled', missing: [] } : { state: state(chatMissing), missing: chatMissing };
  const audioMissing = !data.audioAnalysed ? [range] : data.audioCovered ? missing(data.audioCovered) : [];
  const trMissing = !data.transcript ? [range] : data.transcript.covered ? missing(data.transcript.covered) : [];
  const audio = { state: state(audioMissing), missing: audioMissing };
  const noChat = chat.state === 'none' || chat.state === 'disabled' || chat.state === 'n/a';
  return {
    range,
    chat,
    audio,
    transcript: { state: state(trMissing), missing: trMissing },
    viewerClips: !stream ? { state: 'n/a', count: 0 } : { state: data.clipsFetched ? 'fetched' : 'none', count: data.clips.filter((c) => c.offsetMs >= range.startMs && c.offsetMs < range.endMs).length },
    // viewer clips cover the whole broadcast, so they alone can still make a queue; chat and audio are what a scan adds
    blind: noChat && audio.state === 'none' && !(data.transcript?.tags ?? []).some((t) => t.ms >= range.startMs && t.ms < range.endMs),
  };
}

/** One line per kind of evidence that is missing, for people and agents. */
export function describeCoverage(c: QueueCoverage): string[] {
  const span = (rs: Range[]) => rs.map((r) => `${tstr(r.startMs)}–${tstr(r.endMs)}`).join(', ');
  const out: string[] = [];
  if (c.chat.state === 'disabled') out.push('chat replay is turned off for this broadcast: no chat evidence');
  if (c.chat.state === 'none') out.push(`chat not fetched for any of this range (${span(c.chat.missing)})`);
  if (c.chat.state === 'partial') out.push(`chat not fetched for ${span(c.chat.missing)}`);
  if (c.audio.state === 'none') out.push(`audio not analysed for any of this range (${span(c.audio.missing)})`);
  if (c.audio.state === 'partial') out.push(`audio not analysed for ${span(c.audio.missing)}`);
  if (c.viewerClips.state === 'none') out.push('viewer clips were never fetched');
  if (c.transcript.state !== 'full') {
    const gaps = c.transcript.missing;
    const where = gaps.length > 6 ? `${span(gaps.slice(0, 6))} and ${gaps.length - 6} more` : span(gaps);
    out.push(`transcript ${c.transcript.state === 'none' ? 'missing' : `not there for ${where}`}: speech there is unknown, and story queues need words (\`clip queues … --transcribe\` fills the queue regions)`);
  }
  return out;
}

/** The queues of one kind in a range, strongest first. Pure. */
export function queuesFrom(data: QueueData, opts: { kind: QueueKind; fromMs?: number; toMs?: number; limit?: number }): Queue[] {
  const kind = opts.kind;
  const from = Math.max(0, Math.floor((opts.fromMs ?? 0) / STEP) * STEP);
  const to = Math.min(data.durationMs, opts.toMs ?? data.durationMs);
  if (to <= from) return [];

  // ---- chat, on the whole broadcast's clock so "normal" follows the stream
  const messages = data.chat && !data.chat.disabled ? data.chat.messages : [];
  const fetched = data.chat && !data.chat.disabled ? data.chat.fetched : [];
  const chatEnd = Math.max(data.durationMs, ...fetched.map((r) => r.endMs));
  const levels = fetched.length ? chatLevels(messages, fetched, chatEnd) : undefined;
  const sorted = [...messages].sort((a, b) => a[0] - b[0]);
  // runs of consecutive busy steps: one chat spike, however long it lasts
  const spikeRun = new Int32Array(levels ? levels.rate.length : 0).fill(-1);
  if (levels) {
    let run = -1;
    for (let k = 0; k < levels.rate.length; k++) {
      const hot = !Number.isNaN(levels.rate[k]) && levels.rate[k] >= MIN_CHATTERS && levels.rate[k] / levels.normal[k] >= SPIKE_RATIO;
      if (hot) spikeRun[k] = k > 0 && spikeRun[k - 1] >= 0 ? run : ++run;
    }
  }
  const chatReads = new Map<number, ReturnType<typeof readChat>>();
  const chatReadAt = (k: number) => {
    let r = chatReads.get(k);
    if (!r) chatReads.set(k, (r = readChat(between(sorted, k * STEP - 5_000, k * STEP + 20_000, (m) => m[0]), k * STEP - 5_000, k * STEP + 20_000)));
    return r;
  };

  // ---- the other evidence, sorted for range lookups
  const reactions = [...data.reactions].sort((a, b) => a.startMs - b.startMs);
  const words = data.transcript?.words ?? [];
  const captionLaughs = (data.transcript?.tags ?? []).filter((t) => /laugh|applause|cheer|chuckl/.test(t.tag)).map((t) => t.ms).sort((a, b) => a - b);
  const audioCovered = (r: Range) => data.audioAnalysed && (!data.audioCovered || data.audioCovered.some((c) => c.startMs < r.endMs && c.endMs > r.startMs));
  const speechCovered = (r: Range) => !!data.transcript && (!data.transcript.covered || data.transcript.covered.some((c) => c.startMs < r.endMs && c.endMs > r.startMs));

  interface Step {
    a: number;
    score: number;
    witnesses: Witness[];
    chatK: number | null; // the 5 s step where chat peaked
    mood: Reaction | 'neutral';
    raid: boolean;
    firstReactionMs: number | null;
    clipViews: number;
    /** How well the step lines up with its evidence; breaks ties between neighbours with the same score. */
    align: number;
    /** The viewer clip that best marks this step, if any. */
    clip: { offsetMs: number; durationMs: number } | null;
  }
  const steps: Step[] = [];
  for (let a = from; a < to; a += STEP) {
    if (data.excluded.some((e) => e.startMs <= a && e.endMs >= a + STEP)) continue; // muted or a sponsor read: never a clip
    const k = Math.floor(a / STEP);

    // chat: the busiest step in the lag window after this one
    let chatUnique = 0;
    let chatBaseline = 0;
    let chatK: number | null = null;
    let best = -1;
    if (levels) {
      for (let j = 0; j < CHAT_LAG_WEIGHTS.length; j++) {
        const r = levels.rate[k + j];
        const n = levels.normal[k + j];
        if (r === undefined || Number.isNaN(r) || Number.isNaN(n)) continue;
        // unclamped, so the step 10–15 s before the true chat peak wins, not every step near a big spike
        const v = CHAT_LAG_WEIGHTS[j] * Math.max(0, r / n - 1);
        if (v > best) (best = v), (chatUnique = r), (chatBaseline = n), (chatK = k + j);
      }
    }
    let mood: Reaction | 'neutral' = 'neutral';
    let raid = false;
    if (chatK !== null && best > 0.4) {
      const read = chatReadAt(chatK);
      mood = read.reaction ?? 'neutral';
      raid = !!read.event; // a raid, a burst of subs, or a yes/no vote: busy chat, nothing happened on stream
    }
    if (raid) chatUnique = chatBaseline; // a raid is busy chat without a moment

    // reactions heard in the 10 s from here (a laugh and the scream after it add up)
    const heard = between(reactions, a, a + EVIDENCE_MS, (d) => d.startMs);
    const count: Partial<Record<ReactionKind, number>> = {};
    for (const d of heard) count[d.kind] = (count[d.kind] ?? 0) + reactionWeight(d);
    const tags = lowerBound(captionLaughs, a + EVIDENCE_MS, (x) => x) - lowerBound(captionLaughs, a, (x) => x);
    count.laugh = Math.max(count.laugh ?? 0, Math.min(2, tags)); // a caption [laughter] tag and the audio hear the same laugh

    // viewer clips near here
    let clipCount = 0;
    let clipViews = 0;
    let clip: Step['clip'] = null;
    let clipBest = 0;
    for (const c of data.clips) {
      const w = clipNearness(c, a + STEP / 2);
      if (!w) continue;
      clipCount += w;
      clipViews += w * (c.views ?? 0);
      const v = w * Math.log10((c.views ?? 0) + 10);
      if (v > clipBest) (clipBest = v), (clip = c);
    }

    const near = between(words, a - 5_000, a + EVIDENCE_MS, (w) => w.startMs);
    const hasSpeech = near.length >= 8;
    const titleMatch = Math.max(0, ...data.titleHits.filter((h) => h.ms >= a - 15_000 && h.ms < a + 20_000).map((h) => h.weight));
    const scored = queueBinScore({ kind, chatUnique, chatBaseline, reactions: count, clipCount, clipViews, speechWpm: near.length * 4, hasSpeech, titleMatch });
    if (!queueGate(kind, { witnesses: scored.witnesses, mood, clipViews, hasSpeech, speechCovered: speechCovered({ startMs: a - 5_000, endMs: a + EVIDENCE_MS }), titleMatch })) continue;
    steps.push({ a, score: scored.score, witnesses: scored.witnesses, chatK: scored.witnesses.includes('chat') || best > 0.4 ? chatK : null, mood, raid, firstReactionMs: heard[0]?.startMs ?? null, clipViews, align: raid ? 0 : Math.max(0, best), clip });
  }

  // ---- strongest step first; each queue claims its region
  const order = [...steps].sort((x, y) => y.score - x.score || y.align - x.align || x.a - y.a);
  const taken: Range[] = [];
  const claimedSpikes = new Set<number>();
  const out: Queue[] = [];
  for (const s of order) {
    if (out.length >= (opts.limit ?? 8)) break;
    if (taken.some((r) => s.a >= r.startMs - STEP && s.a < r.endMs + STEP)) continue;
    // chat keeps going after a moment; the tail of a spike another queue already explains is not a second moment
    const spike = s.chatK !== null ? (spikeRun[s.chatK] ?? -1) : -1;
    if (spike >= 0 && claimedSpikes.has(spike) && s.witnesses.length === 1 && s.witnesses[0] === 'chat') continue;
    const anchor: Anchor = s.firstReactionMs !== null && s.witnesses.includes('reaction') ? 'audio' : s.witnesses.includes('clips') && s.clip ? 'clip' : s.witnesses.includes('chat') || s.firstReactionMs === null ? 'chat' : 'audio';
    const moment = anchor === 'audio' ? s.firstReactionMs! : anchor === 'clip' ? s.clip!.offsetMs : s.a;
    // a reaction pins the moment; chat is ±10 s; a viewer clip's offset is good to about its own length
    const pad = anchor === 'audio' ? 0 : anchor === 'clip' ? Math.max(UNCERTAIN_PAD_MS, Math.min(20_000, s.clip!.durationMs)) : UNCERTAIN_PAD_MS;
    const w = WINDOW[kind];
    const start = Math.max(0, moment - w.before - pad);
    const end = Math.min(data.durationMs, Math.max(start + 15_000, Math.min(start + MAX_QUEUE_MS, moment + w.after + pad)));
    const region = { startMs: start, endMs: end };
    // one scene, one queue: a region that mostly repeats a stronger one adds nothing for the expert
    if (taken.some((r) => Math.min(r.endMs, end) - Math.max(r.startMs, start) > 0.5 * Math.min(r.endMs - r.startMs, end - start))) continue;
    const chatFetched = !!levels && fetched.some((r) => r.startMs < end + 25_000 && r.endMs > start);
    // what chat said over the whole region, spike or not: a queue found by a viewer clip or a laugh has
    // no spike to read, and chat can still be calling the moment fake, or typing slurs into the frame
    const regionChat = chatFetched ? readChat(between(sorted, start, end + 25_000, (m) => m[0]), start, end + 25_000, 5) : undefined;
    // the busiest ten seconds can look like a reaction while the region as a whole is a vote, a raid or
    // a sub burst; with no other witness, that is not a queue
    if (regionChat?.event && s.witnesses.length === 1 && s.witnesses[0] === 'chat') continue;
    taken.push(region);
    if (spike >= 0 && s.witnesses.includes('chat')) claimedSpikes.add(spike);

    // evidence over the whole region, for the expert
    const inRegion = steps.filter((x) => x.a >= start && x.a < end);
    const chat = s.chatK !== null ? chatReadAt(s.chatK) : undefined;
    const rate = s.chatK !== null && levels ? levels.rate[s.chatK] : NaN;
    const normal = s.chatK !== null && levels ? levels.normal[s.chatK] : NaN;
    // typed a little before the region starts is still on an on-screen chat when it does
    const slurs = chatFetched ? chatSlurs(between(sorted, start - 15_000, end, (m) => m[0]), start - 15_000, end) : { count: 0, people: 0, firstMs: null };
    const heard = between(reactions, start, end, (d) => d.startMs);
    const clipsHere = data.clips.filter((c) => c.offsetMs >= start - 15_000 && c.offsetMs <= end + 15_000);
    const uniqueClips = [...new Map(clipsHere.map((c) => [c.slug ?? `${c.offsetMs}:${c.title}`, c])).values()].sort((x, y) => y.views - x.views);
    const said = between(words, start, end, (x) => x.startMs);
    const terms = [...new Set(data.titleHits.filter((h) => h.ms >= start && h.ms < end).map((h) => h.term))];
    const fullyTranscribed = !!data.transcript && (!data.transcript.covered || covers(data.transcript.covered, region, 1000));
    const evidence: QueueEvidence = {
      chat: {
        fetched: chatFetched,
        spike: s.witnesses.includes('chat'),
        chatters: Number.isNaN(rate) ? 0 : rate,
        normal: Number.isNaN(normal) ? 0 : Math.round(normal * 10) / 10,
        multiple: Number.isNaN(rate) || !normal ? 0 : Math.round((rate / normal) * 10) / 10,
        atMs: s.chatK !== null ? s.chatK * STEP : null,
        mood: s.mood !== 'neutral' ? s.mood : (regionChat?.reaction ?? 'neutral'),
        moods: chat?.reactions ?? regionChat?.reactions ?? {},
        top: chat?.top.length ? chat.top : (regionChat?.top ?? []),
        clipRequests: Math.max(chat?.clipRequests ?? 0, regionChat?.clipRequests ?? 0),
        raid: s.raid,
        doubt: Math.max(chat?.doubt ?? 0, regionChat?.doubt ?? 0),
        slurs: slurs.count,
      },
      audio: { covered: audioCovered(region), reactions: heard.map((d) => ({ kind: d.kind, ms: d.startMs, peak: d.peak })) },
      clips: { count: uniqueClips.length, views: uniqueClips.reduce((n, c) => n + (c.views ?? 0), 0), titles: [...new Set(uniqueClips.map((c) => c.title))].slice(0, 5), offsets: uniqueClips.slice(0, 5).map((c) => c.offsetMs) },
      speech: { covered: fullyTranscribed, words: said.length, wpm: Math.round(said.length / ((end - start) / 60_000)), excerpt: excerptOf(between(words, moment - 14_000, moment + 8_000, (x) => x.startMs)) },
      title: { match: terms.length ? 1 : 0, terms },
    };

    const why: string[] = [];
    if (evidence.chat.spike) why.push(`chat ${evidence.chat.chatters} chatters/10 s vs ${evidence.chat.normal} normal (${evidence.chat.multiple}×, ${evidence.chat.mood}) at ${tstr(evidence.chat.atMs!)}`);
    else if (evidence.chat.top.length && evidence.chat.mood !== 'neutral') why.push(`chat mood over the region: ${evidence.chat.mood} (no spike)`);
    const byKind = (['laugh', 'shout', 'cheer'] as ReactionKind[]).map((r) => [r, heard.filter((d) => d.kind === r).length] as const).filter(([, n]) => n > 0);
    if (byKind.length) why.push(`heard ${byKind.map(([r, n]) => `${n} ${r}${n > 1 ? 's' : ''}`).join(', ')}`);
    if (uniqueClips.length) why.push(`${uniqueClips.length} viewer clip${uniqueClips.length > 1 ? 's' : ''}, ${evidence.clips.views.toLocaleString('en-US')} views`);
    if (evidence.chat.clipRequests >= 2) why.push(`${evidence.chat.clipRequests} asked to clip it`);
    if (said.length >= 8 && evidence.speech.wpm >= 170) why.push(`fast speech ${evidence.speech.wpm} wpm`);
    if (terms.length) why.push(`title words said here: ${terms.join(', ')}`);

    const risks: string[] = [];
    if (anchor === 'chat') risks.push('moment time estimated from chat (±10 s): find it in frames before cutting');
    if (anchor === 'clip') {
      // a clip made sooner after its offset than its own length cannot start at the offset: its content is before it
      const c = s.clip as { offsetMs: number; durationMs: number; createdAt?: string };
      const made = c.createdAt && data.startedAt ? Date.parse(c.createdAt) - Date.parse(data.startedAt) - c.offsetMs : NaN;
      const side = Number.isNaN(made) ? 'look both sides of it' : made < c.durationMs - 3000 ? `this clip was made ${Math.round(made / 1000)} s after its offset, sooner than its own ${Math.round(c.durationMs / 1000)} s, so its content is BEFORE the offset: look there first` : 'look after the offset first, then before';
      risks.push(`moment time from a viewer clip offset (good to about one clip length): ${side}, and find the moment in frames before cutting`);
    }
    if (!chatFetched && data.platform === 'twitch' && !data.chat?.disabled) risks.push('chat not fetched here');
    if (!evidence.audio.covered) risks.push('audio not analysed here');
    if (!fullyTranscribed) risks.push(`not fully transcribed: run \`clip transcript <id> --from ${tstr(Math.max(0, start - 5_000))} --to ${tstr(end + 5_000)}\` before choosing a window`);
    else if (said.length < 5) risks.push('no speech here: a visual or sound-only moment; check frames, and add it as a visual candidate');
    const event = chat?.event ?? regionChat?.event;
    if (event) risks.push(event === 'raid' ? 'a raid (another channel arriving), not a moment' : event === 'subs' ? 'a burst of subs or a hype train, not a moment' : 'chat is voting yes and no on a question the streamer asked: answers, not a reaction (reject ground `chat-answer` if that is all this is)');
    if (evidence.chat.doubt >= DOUBT_MIN) risks.push(`${evidence.chat.doubt} chatters call it fake, staged or AI: read on past the region to see what it really was, and do not title it as fact`);
    if (slurs.count) risks.push(`${slurs.count} chat message${slurs.count > 1 ? 's' : ''} in this region contain${slurs.count > 1 ? '' : 's'} a slur (typed at ${tstr(slurs.firstMs!)}; an on-screen chat shows it about 5 s later): if this stream shows chat in the frame, it is in the picture. Check the frames there`);
    if (chat?.copypasta) risks.push('chat is pasting one long message (copypasta): usually boredom or a chat meme, not a reaction to the stream');
    if (evidence.chat.mood === 'irony' || evidence.chat.mood === 'tension') risks.push(`chat is ${evidence.chat.mood === 'irony' ? 'ahead of the streamer (irony/anticipation)' : 'tense'}: the payoff may come after this region, so read on before cutting`);
    if (evidence.chat.mood === 'cringe') risks.push('chat reads this as awkward or as innuendo: check what was said before posting');
    for (const r of riskTerms([...evidence.chat.top.map((t) => t.text), ...evidence.clips.titles, evidence.speech.excerpt ?? ''].join(' | '))) risks.push(`check before posting — ${r}`);
    const ex = data.excluded.find((e) => e.startMs < end && e.endMs > start);
    if (ex) risks.push(`overlaps ${ex.category} ${tstr(ex.startMs)}–${tstr(ex.endMs)}: the clip must stay outside it`);

    const context: string[] = [];
    if (evidence.speech.excerpt) context.push(`said: ${evidence.speech.excerpt}`);
    if (evidence.chat.top.length) context.push(`chat: ${evidence.chat.top.map((t) => `${t.text} ×${t.count}`).join(' | ')}`);
    if (evidence.clips.titles.length) context.push(`viewer clips: ${evidence.clips.titles.map((t) => `"${t}"`).join(' | ')}`);

    const mean = inRegion.length ? inRegion.reduce((n, x) => n + x.score, 0) / inRegion.length : s.score;
    out.push({
      id: queueId(kind, moment),
      kind,
      startMs: start,
      endMs: end,
      peakMs: moment,
      anchor,
      score: Math.round((s.score * 0.7 + mean * 0.3) * 10) / 10,
      confidence: Math.round((s.witnesses.length / 3) * 100) / 100,
      sources: s.witnesses.length,
      witnesses: s.witnesses,
      signals: evidence,
      why,
      risks,
      context,
    });
  }
  return out.sort((x, y) => y.score - x.score);
}

/** A queue by id. Ids carry the moment's time, so one that moved a little after new data still resolves. */
export function findQueue(queues: Queue[], id: string): Queue | undefined {
  const exact = queues.find((q) => q.id === id);
  if (exact) return exact;
  const m = /^(meme|viral|clip)@(\d+):(\d{2}):(\d{2})$/.exec(id);
  if (!m) return undefined;
  const ms = (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000;
  return queues.filter((q) => q.kind === m[1] && Math.abs(Math.floor(q.peakMs / STEP) * STEP - ms) <= 15_000).sort((a, b) => Math.abs(a.peakMs - ms) - Math.abs(b.peakMs - ms))[0];
}

// ---------- loading ----------

/** Read everything the checkers need for a video from the library. */
export async function loadQueueData(videoId: string): Promise<QueueData> {
  const { loadMeta, loadSponsors } = await import('../ingest/ingest');
  const { EXCLUDED_CATEGORIES } = await import('../ingest/sponsorblock');
  const { loadChat, loadViewerClips } = await import('../ingest/chat');
  const { loadReactions } = await import('../discover/signals/audio');
  const { title } = await import('../discover/signals/title');
  const meta = loadMeta(videoId);
  const transcript = readJsonIf<Transcript>(paths.videoFile(videoId, 'transcript.json'));
  const chat = loadChat(videoId);
  const viewer = loadViewerClips(videoId);
  const audio = loadReactions(videoId);
  const sponsors = loadSponsors(videoId);
  const hits = title.compute({ meta, transcript, info: {}, sponsors }).events as { startMs: number; weight: number; term?: string }[];
  return {
    durationMs: meta.durationMs,
    platform: meta.platform ?? (videoId.startsWith('tw-') ? 'twitch' : 'youtube'),
    chat: chat ? { messages: chat.messages, fetched: mergeRanges(chat.fetched), disabled: chat.disabled } : undefined,
    reactions: audio.detections,
    audioAnalysed: audio.analysed,
    audioCovered: audio.covered,
    clips: viewer?.clips ?? [],
    startedAt: meta.startedAt,
    clipsFetched: !!viewer,
    transcript,
    titleHits: hits.map((e) => ({ ms: e.startMs + 20_000, term: e.term ?? '', weight: e.weight })), // the title signal's events start 20 s before the word
    excluded: sponsors.filter((s) => EXCLUDED_CATEGORIES.has(s.category)),
  };
}
