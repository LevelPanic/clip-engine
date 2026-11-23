// The queue experts' verdicts, validated and kept: library/<id>/queue-review.json.
//
// A queue is a lead; an expert turns it into a verdict by looking: confirm (with the frame they saw
// and what kind of moment it is), reject (with the reason), or merge (it is the setup or the tail of
// another queue). The ledger is the hand-off to the extractor, so it is checked the way candidates
// are: ids must resolve to a real queue, a confirm must cite a frame, the words come from the shared
// vocabulary. An expert that skips the looking gets an error, not a silent pass.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { paths, readJsonIf, writeJson } from '../core/paths';
import { parseTime } from '../core/time';
import { ARCHETYPES, REJECT_GROUNDS, RISK_FLAGS, SHARE_TRIGGERS, keysOf } from '../core/vocabulary';
import { findQueue, queueId, queuesFrom, queueTime, QUEUE_KINDS, type Queue, type QueueData, type QueueKind } from './queues';

const QUEUE_ID = /^(meme|viral|clip)@(\d+):(\d{2}):(\d{2})$/;
const time = z.union([z.string(), z.number()]);

export const QueueVerdictInputSchema = z.object({
  queueId: z.string().regex(QUEUE_ID, 'a queue id looks like meme@1:46:25 (copy it from `clip queues`)'),
  verdict: z.enum(['confirm', 'reject', 'merge']),
  /** What kind of moment it is (`clip vocab archetypes`). Needed to confirm. */
  archetype: z.enum(keysOf(ARCHETYPES)).optional(),
  /** Why a stranger would send it (`clip vocab triggers`). Needed to confirm a viral queue. */
  trigger: z.enum(keysOf(SHARE_TRIGGERS)).optional(),
  /** Why it is not a clip (`clip vocab rejects`). Needed to reject. */
  rejected: z.enum(keysOf(REJECT_GROUNDS)).optional(),
  /** The queue this one belongs to. Needed to merge. */
  mergeInto: z.string().regex(QUEUE_ID).optional(),
  /** Where the moment really is, once seen in frames (the queue's own time is an estimate). */
  moment: time.optional(),
  /** Where the clip should start and end, if the expert can already tell. */
  start: time.optional(),
  end: time.optional(),
  /** What was looked at and what it showed: "frame 1:46:37: he tips the chair", "said: my mom dated Train". */
  seen: z.array(z.string().min(8)).default([]),
  /** What a viewer who has never seen the stream must be told for it to make sense (one line), if anything. */
  context: z.string().optional(),
  /** What the extractor must know about the cut: what has to be inside, what fills the time, where not to cut. */
  cut: z.string().optional(),
  /** Nothing is said, or the words are not the point. */
  visual: z.boolean().optional(),
  /**
   * A moment the checkers have no queue for, found while reading (a story nobody laughed at, a line
   * with no chat spike). Needs `moment`, `start` and `end`; the id is your kind and the moment's time.
   */
  found: z.boolean().optional(),
  risks: z.array(z.enum(keysOf(RISK_FLAGS))).default([]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(12, 'say why in a sentence'),
});

export interface QueueVerdict {
  queueId: string;
  kind: QueueKind;
  verdict: 'confirm' | 'reject' | 'merge';
  archetype?: string;
  trigger?: string;
  rejected?: string;
  mergeInto?: string;
  momentMs?: number;
  startMs?: number;
  endMs?: number;
  seen: string[];
  context?: string;
  cut?: string;
  visual?: boolean;
  /** The expert found it; no checker queue pointed here. */
  found?: boolean;
  risks: string[];
  confidence: number;
  reason: string;
  /** The queue as the engine saw it when the verdict was given. */
  queue: { startMs: number; endMs: number; peakMs: number; anchor: string; score: number; witnesses: string[] };
  at: string;
}

export interface QueueReviewFile {
  videoId: string;
  updatedAt: string;
  verdicts: QueueVerdict[];
}

/** Verdicts this close together are about one moment. */
const SAME_MOMENT_MS = 20_000;
const momentOf = (v: QueueVerdict) => v.momentMs ?? v.queue.peakMs;

const file = (videoId: string) => paths.videoFile(videoId, 'queue-review.json');
export const loadQueueReview = (videoId: string): QueueReviewFile => readJsonIf<QueueReviewFile>(file(videoId)) ?? { videoId, updatedAt: '', verdicts: [] };

/**
 * The risk flags the queue experts put on a moment, each with the kinds of expert that raised it: the
 * verdicts on the queue itself, or on a moment inside the range (5 s either side). Null when the video
 * has no ledger (nobody looked). Read by the candidate warnings, the 18+ check, curation and the
 * never-post check, so all of them mean the same moment.
 */
export function expertFlags(videoId: string, r: { startMs: number; endMs: number }, queueId?: string): Map<string, string[]> | null {
  const ledger = readJsonIf<{ verdicts?: { queueId: string; kind?: string; risks?: string[]; momentMs?: number; queue?: { peakMs: number } }[] }>(file(videoId));
  if (!ledger) return null;
  const by = new Map<string, Set<string>>();
  for (const v of ledger.verdicts ?? []) {
    const at = v.momentMs ?? v.queue?.peakMs;
    const here = (queueId !== undefined && v.queueId === queueId) || (at !== undefined && at >= r.startMs - 5000 && at <= r.endMs + 5000);
    if (!here) continue;
    for (const f of v.risks ?? []) by.set(f, (by.get(f) ?? new Set()).add(v.kind ?? v.queueId.split('@')[0]));
  }
  return new Map([...by].map(([f, who]) => [f, [...who]]));
}

/**
 * The flags that keep a moment off this channel (docs/research/censorship-review-2026-11-22.md): `sexual`
 * from two kinds of expert (one alone is often innuendo or a gag), any `slur`, any `minor`. As
 * "flag (experts)" lines; empty when there is none.
 */
export function unsafeFlags(flags: Map<string, string[]> | null): string[] {
  if (!flags) return [];
  const out: string[] = [];
  const sexual = flags.get('sexual') ?? [];
  if (sexual.length >= 2) out.push(`sexual (${sexual.join(', ')})`);
  for (const f of ['slur', 'minor']) if (flags.get(f)?.length) out.push(`${f} (${flags.get(f)!.join(', ')})`);
  return out;
}

const idTime = (id: string) => {
  const m = QUEUE_ID.exec(id)!;
  return (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000;
};

/** The queue an id points at, looked up around the id's own time. */
export function resolveQueue(data: QueueData, id: string): Queue | undefined {
  const m = QUEUE_ID.exec(id);
  if (!m) return undefined;
  const at = idTime(id);
  return findQueue(queuesFrom(data, { kind: m[1] as QueueKind, fromMs: Math.max(0, at - 120_000), toMs: at + 120_000, limit: 50 }), id);
}

const FRAME_LINE = /^frames?\s+\d/i;
const WORDS_LINE = /^(said|transcript)\b/i;
const FRAME_TIME = /^frames?\s+(\d+(?::\d{1,2}){0,2}(?:\.\d+)?)/i;
/** A cited frame counts as looked at when a still exists within this of it. */
const STILL_TOLERANCE_MS = 1000;

/** The times a verdict's `frame …` lines cite. Pure. */
export function citedFrames(seen: string[]): number[] {
  const out: number[] = [];
  for (const line of seen) {
    const m = FRAME_TIME.exec(line.trim());
    if (!m) continue;
    try {
      out.push(parseTime(m[1]));
    } catch {
      // not a time: the line does not count as a frame, and the confirm check says so
    }
  }
  return out;
}

/** Every still saved for a video, at any width, by the second it shows. Fetching a still is how an expert looks. */
export function stillFiles(videoId: string): { ms: number; file: string }[] {
  const dir = paths.videoFile(videoId, 'frames');
  if (!fs.existsSync(dir)) return [];
  const out: { ms: number; file: string }[] = [];
  for (const f of fs.readdirSync(dir)) {
    const m = /^(\d+)(?:_\d+)?\.jpg$/.exec(f);
    if (m) out.push({ ms: Number(m[1]), file: path.join(dir, f) });
  }
  return out;
}

/** The still a `frame <time>` line can stand on: the nearest one within a second, the plain 640 px one first. */
export function stillNear(stills: { ms: number; file: string }[], ms: number): string | undefined {
  const near = stills.filter((x) => Math.abs(x.ms - ms) <= STILL_TOLERANCE_MS);
  // nearest first; at the same second, the ordinary 640 px still before a wide one
  const wide = (file: string) => Number(/_\d+\.jpg$/.test(file) && !/_640\.jpg$/.test(file));
  near.sort((a, b) => Math.abs(a.ms - ms) - Math.abs(b.ms - ms) || wide(a.file) - wide(b.file) || Number(/_640\.jpg$/.test(b.file)) - Number(/_640\.jpg$/.test(a.file)));
  return near[0]?.file;
}

const SAID_TEXT = /^(?:said|transcript)\b[^:]*:\s*(.+)$/i;
const tokens = (text: string) => text.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
/** How far either side of a moment a quoted line may be: the setup before it, the reveal after it. */
const SAID_BEFORE_MS = 180_000;
const SAID_AFTER_MS = 240_000;

/** The quoted parts of a verdict's `said: …` lines ("a … b" and "a / b" are two parts). Pure. */
export function saidParts(seen: string[]): string[] {
  return seen.flatMap((line) => {
    const m = SAID_TEXT.exec(line.trim());
    return m ? m[1].split(/…|\.{3}|\s\/\s/).map((p) => p.trim()).filter(Boolean) : [];
  });
}

/**
 * Where a quoted line is said: four of its words in a row (or all of a shorter line), found in a row
 * in the transcript between two times. `known: false` when there are no words there to check against
 * (not transcribed: unknown, not wrong). Pure.
 */
export function findSaid(words: { startMs: number; text: string }[], line: string, fromMs: number, toMs: number): { known: boolean; atMs?: number } {
  const want = tokens(line);
  // compared without spaces, so "Cybertruck" finds "cyber truck"
  let have = '';
  const at: number[] = [];
  for (const w of words) {
    if (w.startMs < fromMs || w.startMs > toMs) continue;
    for (const t of tokens(w.text)) {
      for (let k = 0; k < t.length; k++) at.push(w.startMs);
      have += t;
    }
  }
  if (!want.length || !have) return { known: false };
  const need = Math.min(4, want.length);
  for (let i = 0; i + need <= want.length; i++) {
    const j = have.indexOf(want.slice(i, i + need).join(''));
    if (j >= 0) return { known: true, atMs: at[j] };
  }
  return { known: true };
}

/** A quote this short proves nothing either way ("Oh. It's not"), so it is not checked. */
export const saidCheckable = (part: string) => tokens(part).length >= 3;

/** The stretch of transcript a verdict's quotes are checked against. */
export const saidRange = (queue: Pick<Queue, 'startMs' | 'endMs' | 'peakMs'>, momentMs?: number) => {
  const at = momentMs ?? queue.peakMs;
  return { fromMs: Math.min(queue.startMs, at) - SAID_BEFORE_MS, toMs: Math.max(queue.endMs, at) + SAID_AFTER_MS };
};

/** Check one verdict against the queue it is about. Pure: returns the errors, empty when it stands. */
export function checkVerdict(v: z.output<typeof QueueVerdictInputSchema>, queue: Queue | undefined, known: (id: string) => boolean): { errors: string[]; momentMs?: number; startMs?: number; endMs?: number } {
  const errors: string[] = [];
  if (!queue) return { errors: [`no ${v.queueId.split('@')[0]} queue near ${v.queueId.split('@')[1]}: the id is wrong or the evidence changed. List the queues again with \`clip queues\``] };
  let momentMs: number | undefined;
  let startMs: number | undefined;
  let endMs: number | undefined;
  try {
    if (v.moment !== undefined) momentMs = parseTime(v.moment);
    if (v.start !== undefined) startMs = parseTime(v.start);
    if (v.end !== undefined) endMs = parseTime(v.end);
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (momentMs !== undefined && (momentMs < queue.startMs - 60_000 || momentMs > queue.endMs + 60_000)) errors.push(`moment ${queueTime(momentMs)} is more than a minute outside the queue's region (${queueTime(queue.startMs)}–${queueTime(queue.endMs)}): that is a different moment`);
  if (startMs !== undefined && endMs !== undefined) {
    if (endMs <= startMs) errors.push('end is before start');
    else if (endMs - startMs > 60_000) errors.push(`the suggested window is ${Math.round((endMs - startMs) / 1000)} s; a clip is 15–60 s. Give the 60 s that matter, and put what does not fit in "context" or "cut"`);
  }
  if (v.verdict === 'confirm') {
    if (!v.archetype) errors.push('a confirm names the moment: set "archetype" (`clip vocab archetypes` lists them)');
    if (!v.seen.some((s) => FRAME_LINE.test(s))) errors.push('a confirm cites a frame you looked at: add a "seen" line like "frame 1:46:37: he tips the chair over" (`clip frames <id> <time>`)');
    if (queue.kind === 'clip' && !v.visual && !v.seen.some((s) => WORDS_LINE.test(s))) errors.push('a story confirm cites the words: add a "seen" line like "said: my mom dated Train" (`clip transcript <id> --from … --to …`)');
    if (queue.kind === 'viral' && !v.trigger) errors.push('a viral confirm names why a stranger would send it: set "trigger" (`clip vocab triggers`)');
    if (queue.kind === 'viral' && v.trigger === 'none') errors.push('trigger "none" means it has no reach: reject it with "rejected": "no-reach" instead of confirming');
    if (v.rejected) errors.push('"rejected" belongs on a reject, not a confirm');
    if (v.confidence < 0.5) errors.push(`confidence ${v.confidence} is too low to confirm: under 0.5, reject with the ground that fits, or leave the queue without a verdict and say why`);
  }
  if (v.verdict === 'reject') {
    if (!v.rejected) errors.push('a reject names its ground: set "rejected" (`clip vocab rejects`)');
    if (!v.seen.length) errors.push('a reject says what was checked: add at least one "seen" line (a frame, the words, the chat)');
  }
  if (v.verdict === 'merge') {
    if (!v.mergeInto) errors.push('a merge names the queue it belongs to: set "mergeInto"');
    else if (v.mergeInto === v.queueId || v.mergeInto === queue.id) errors.push('a queue cannot merge into itself');
    else if (!known(v.mergeInto)) errors.push(`mergeInto ${v.mergeInto} is not a queue: copy the id from \`clip queues\``);
  }
  return { errors, momentMs, startMs, endMs };
}

export interface VerdictResult {
  saved: QueueVerdict[];
  refused: { input: unknown; errors: string[] }[];
}

/** Validate verdicts and merge them into the ledger (the latest verdict for a queue wins). */
export function applyQueueVerdicts(videoId: string, data: QueueData, inputs: unknown[], now = new Date().toISOString()): VerdictResult {
  const ledger = loadQueueReview(videoId);
  const res: VerdictResult = { saved: [], refused: [] };
  // "frame 1:36:27: …" is a claim of having looked. It only stands if a still for that second was fetched.
  let fetched: { ms: number; file: string }[] | undefined;
  const looked = (ms: number) => !!stillNear((fetched ??= stillFiles(videoId)), ms);
  for (const raw of inputs) {
    const parsed = QueueVerdictInputSchema.safeParse(raw);
    if (!parsed.success) {
      res.refused.push({ input: raw, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'verdict'}: ${i.message}`) });
      continue;
    }
    const v = parsed.data;
    let queue = resolveQueue(data, v.queueId);
    if (v.found) {
      // a moment with no queue: the expert supplies what a queue would have (where it is, where to cut)
      const need = (['moment', 'start', 'end'] as const).filter((k) => v[k] === undefined);
      const errors: string[] = [];
      if (v.verdict !== 'confirm') errors.push('"found" is for a moment you are confirming: there is no queue to reject or merge');
      if (need.length) errors.push(`a found moment says where it is: set ${need.map((k) => `"${k}"`).join(', ')}`);
      if (queue) errors.push(`there is already a queue here (${queue.id}): give your verdict on that one, without "found"`);
      let found: Queue | undefined;
      if (!errors.length) {
        try {
          const [moment, start, end] = [parseTime(v.moment!), parseTime(v.start!), parseTime(v.end!)];
          const kind = v.queueId.split('@')[0] as QueueKind;
          if (Math.abs(idTime(v.queueId) - moment) > 15_000) errors.push(`the id's time (${v.queueId.split('@')[1]}) is not the moment (${queueTime(moment)}): a found moment's id is your kind and its moment, e.g. ${queueId(kind, moment)}`);
          else found = { id: queueId(kind, moment), kind, startMs: Math.max(0, start - 5000), endMs: Math.min(data.durationMs, end + 5000), peakMs: moment, anchor: 'expert', score: 0, confidence: 0, sources: 0, witnesses: [], signals: {} as Queue['signals'], why: [], risks: [], context: [] };
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      if (errors.length || !found) {
        res.refused.push({ input: raw, errors });
        continue;
      }
      queue = found;
    }
    const check = checkVerdict(v, queue, (id) => !!resolveQueue(data, id) || ledger.verdicts.some((x) => x.queueId === id));
    if (queue) {
      const unseen = citedFrames(v.seen).filter((ms) => !looked(ms));
      if (unseen.length) check.errors.push(`cites frame ${unseen.map((ms) => queueTime(ms)).join(', ')}, but no still was ever fetched for ${unseen.length > 1 ? 'those seconds' : 'that second'}: run \`clip frames ${videoId} ${unseen.map((ms) => queueTime(ms)).join(' ')}\`, read the image${unseen.length > 1 ? 's' : ''}, and cite what ${unseen.length > 1 ? 'they show' : 'it shows'}`);
      // "said: …" is a claim about the words. Where the transcript has words, the line has to be in them.
      const span = saidRange(queue, check.momentMs);
      for (const part of saidParts(v.seen)) {
        if (!saidCheckable(part)) continue;
        const hit = findSaid(data.transcript?.words ?? [], part, span.fromMs, span.toMs);
        if (hit.known && hit.atMs === undefined) check.errors.push(`"${part.slice(0, 70)}" is not in the transcript within a few minutes of the moment: a "said:" line is copied from the words as transcribed, even where they are misheard (say what was really said in "cut")`);
      }
    }
    if (check.errors.length || !queue) {
      res.refused.push({ input: raw, errors: check.errors });
      continue;
    }
    res.saved.push({
      queueId: queue.id,
      kind: queue.kind,
      verdict: v.verdict,
      ...(v.archetype ? { archetype: v.archetype } : {}),
      ...(v.trigger ? { trigger: v.trigger } : {}),
      ...(v.rejected ? { rejected: v.rejected } : {}),
      ...(v.mergeInto ? { mergeInto: v.mergeInto } : {}),
      ...(check.momentMs !== undefined ? { momentMs: check.momentMs } : {}),
      ...(check.startMs !== undefined ? { startMs: check.startMs } : {}),
      ...(check.endMs !== undefined ? { endMs: check.endMs } : {}),
      seen: v.seen,
      ...(v.context ? { context: v.context } : {}),
      ...(v.cut ? { cut: v.cut } : {}),
      ...(v.visual ? { visual: true } : {}),
      ...(v.found ? { found: true } : {}),
      risks: v.risks,
      confidence: v.confidence,
      reason: v.reason,
      queue: { startMs: queue.startMs, endMs: queue.endMs, peakMs: queue.peakMs, anchor: queue.anchor, score: queue.score, witnesses: queue.witnesses },
      at: now,
    });
  }
  if (res.saved.length) {
    const ids = new Set(res.saved.map((v) => v.queueId));
    const verdicts = [...ledger.verdicts.filter((v) => !ids.has(v.queueId)), ...res.saved].sort((a, b) => a.queue.peakMs - b.queue.peakMs || a.kind.localeCompare(b.kind));
    writeJson(file(videoId), { videoId, updatedAt: now, verdicts } satisfies QueueReviewFile);
  }
  return res;
}

export interface Moment {
  /** The verdict to extract from: the most confident one. */
  primary: QueueVerdict;
  /** Other confirmed queues of the same moment (another expert saw it too, or it was merged in). */
  also: QueueVerdict[];
  momentMs: number;
}


/**
 * The confirmed moments, one per moment however many experts flagged it. Two experts confirming the
 * same 20 seconds is one clip with two readings, not two clips: the validator would refuse the second
 * as a duplicate anyway.
 */
export function confirmedMoments(ledger: QueueReviewFile): Moment[] {
  const confirmed = ledger.verdicts.filter((v) => v.verdict === 'confirm').sort((a, b) => momentOf(a) - momentOf(b));
  const groups: QueueVerdict[][] = [];
  for (const v of confirmed) {
    const last = groups[groups.length - 1];
    if (last && momentOf(v) - momentOf(last[last.length - 1]) <= SAME_MOMENT_MS) last.push(v);
    else groups.push([v]);
  }
  const byId = new Map(ledger.verdicts.map((v) => [v.queueId, v]));
  return groups.map((g) => {
    const order = [...g].sort((a, b) => b.confidence - a.confidence || QUEUE_KINDS.indexOf(a.kind) - QUEUE_KINDS.indexOf(b.kind));
    const merged = ledger.verdicts.filter((v) => v.verdict === 'merge' && v.mergeInto && g.some((x) => x.queueId === v.mergeInto) && byId.has(v.queueId));
    return { primary: order[0], also: [...order.slice(1), ...merged], momentMs: momentOf(order[0]) };
  });
}

/**
 * Queues in a range that no expert has given a verdict on yet. A queue counts as judged when a verdict
 * of its kind sits on the same moment (within 20 s): ids are the moment's time, and new chat or a
 * new transcript window can move a queue a few seconds without making it a new moment.
 */
export function pendingQueues(ledger: QueueReviewFile, queues: Queue[]): Queue[] {
  return queues.filter((q) => !ledger.verdicts.some((v) => v.queueId === q.id || (v.kind === q.kind && Math.abs(v.queue.peakMs - q.peakMs) <= SAME_MOMENT_MS)));
}

/**
 * The queue a verdict was given on, rebuilt from the ledger: for a moment an expert found (no checker
 * queue ever existed) and for a queue the checkers no longer list because the evidence changed since.
 */
export function queueFromVerdict(v: QueueVerdict): Queue {
  return { id: v.queueId, kind: v.kind, startMs: v.queue.startMs, endMs: v.queue.endMs, peakMs: v.momentMs ?? v.queue.peakMs, anchor: v.momentMs !== undefined ? 'expert' : (v.queue.anchor as Queue['anchor']), score: v.queue.score, confidence: v.confidence, sources: v.queue.witnesses.length, witnesses: v.queue.witnesses as Queue['witnesses'], signals: { speech: { covered: true } } as Queue['signals'], why: [], risks: [], context: [] };
}

/**
 * Moments every expert who looked passed to someone else, so nobody judged them. A verdict passes a
 * moment on when it is an `other-kind` reject, or the virality expert's `no-reach` (which says nothing
 * about whether it is a gag or a story). Everything else is a judgment: a confirm, a reject on any
 * other ground, `no-reach` from the meme or the story expert, and a merge (it says the moment is part
 * of another one, which has its own verdict).
 */
export function orphanedMoments(ledger: QueueReviewFile): QueueVerdict[][] {
  const sorted = [...ledger.verdicts].sort((a, b) => momentOf(a) - momentOf(b));
  const groups: QueueVerdict[][] = [];
  for (const v of sorted) {
    const last = groups[groups.length - 1];
    if (last && momentOf(v) - momentOf(last[last.length - 1]) <= SAME_MOMENT_MS) last.push(v);
    else groups.push([v]);
  }
  const passedOn = (v: QueueVerdict) => v.verdict === 'reject' && (v.rejected === 'other-kind' || (v.rejected === 'no-reach' && v.kind === 'viral'));
  return groups.filter((g) => g.some((v) => v.rejected === 'other-kind') && g.every(passedOn));
}
