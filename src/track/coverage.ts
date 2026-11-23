// The coverage ledger (docs/research/stream-pipeline-spec-2026-11-19.md, section 5): for each stream and
// layer, which stretches of VOD time are queued, claimed by a running job, done, failed or skipped.
// Dedupe is one rule, wanted − done − claimed − skipped, merged into what is queued. That covers a
// live stream growing between checks (a queued first 40 minutes becomes the whole hour, same job), a
// first 40 minutes already running (only 40:00 onwards is queued, as a new job), and a job that died
// part-way (what it finished is done, the rest goes back in line). Pure: the tracker stores the spans.
import { mergeRanges, subtractRanges, type Range } from '../core/ranges';

export type CoverState = 'queued' | 'claimed' | 'done' | 'failed' | 'skipped';
export interface Span extends Range {
  state: CoverState;
  /** The job that owns it: the queued job, the job that claimed it, or the one that did it. */
  jobId?: string;
  /** Why, for done-from-elsewhere, failed and skipped spans ("chat off", "subscriber-only"). */
  reason?: string;
}

const key = (s: Span) => `${s.state}|${s.jobId ?? ''}|${s.reason ?? ''}`;

/** Sorted, non-overlapping, with touching spans of the same state, job and reason joined. */
export function normalize(spans: Span[]): Span[] {
  const groups = new Map<string, Span[]>();
  for (const s of spans) if (s.endMs > s.startMs) groups.set(key(s), [...(groups.get(key(s)) ?? []), s]);
  const out: Span[] = [];
  for (const g of groups.values()) {
    const { state, jobId, reason } = g[0];
    for (const r of mergeRanges(g)) out.push({ ...r, state, ...(jobId ? { jobId } : {}), ...(reason ? { reason } : {}) });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** `ranges` set to `fields`, whatever was there before. */
export function paint(spans: Span[], ranges: Range[], fields: Omit<Span, 'startMs' | 'endMs'>): Span[] {
  if (!ranges.length) return normalize(spans);
  const kept = spans.flatMap((s) => subtractRanges([s], ranges).map((r) => ({ ...s, ...r })));
  return normalize([...kept, ...ranges.map((r) => ({ ...r, ...fields }))]);
}

const of = (spans: Span[], states: CoverState[], jobId?: string) => spans.filter((s) => states.includes(s.state) && (!jobId || s.jobId === jobId));

/** What is still to do of `wanted`: not done, not claimed by a running job, not skipped. */
export const todoOf = (spans: Span[], wanted: Range[]): Range[] => subtractRanges(wanted, of(spans, ['done', 'claimed', 'skipped']));

/**
 * Ask for `wanted` to be covered. What is left to do is merged into the one queued job (its id kept,
 * so a queued 40 minutes grows into the hour in place); with no queued job, `newJobId` holds it. A failed
 * stretch is asked for again.
 */
export function want(spans: Span[], wanted: Range[], newJobId: string): { spans: Span[]; jobId: string | null; added: Range[] } {
  const todo = todoOf(spans, wanted);
  const queued = of(spans, ['queued']);
  const jobId = queued[0]?.jobId ?? newJobId;
  const added = subtractRanges(todo, queued);
  if (!todo.length && !queued.length) return { spans: normalize(spans), jobId: null, added: [] };
  // one queued job per stream and layer: every queued stretch belongs to it
  const out = paint(paint(spans, queued, { state: 'queued', jobId }), todo, { state: 'queued', jobId });
  return { spans: out, jobId, added };
}

/**
 * A worker takes `jobId`'s queued stretches from the earliest, at most `maxMs` of them: those become
 * claimed. Anything the job held beyond that stays queued, under `restJobId` (the claim says exactly
 * where processing stops, so the rest is counted from there).
 */
export function claim(spans: Span[], jobId: string, maxMs: number, restJobId: string): { spans: Span[]; claimed: Range[] } {
  const queued = mergeRanges(of(spans, ['queued'], jobId));
  const claimed: Range[] = [];
  let left = maxMs;
  for (const q of queued) {
    if (left <= 0) break;
    const end = Math.min(q.endMs, q.startMs + left);
    claimed.push({ startMs: q.startMs, endMs: end });
    left -= end - q.startMs;
  }
  const rest = subtractRanges(queued, claimed);
  let out = paint(spans, claimed, { state: 'claimed', jobId });
  out = paint(out, rest, { state: 'queued', jobId: restJobId });
  return { spans: out, claimed };
}

/**
 * The job finished: what it did (`doneRanges`, inside its claim) is done; anything it claimed and did
 * not do goes back in line, into the queued job if there is one (a crash part-way loses nothing).
 */
export function complete(spans: Span[], jobId: string, doneRanges: Range[], requeueJobId: string): Span[] {
  const claimed = of(spans, ['claimed'], jobId);
  const did = claimed.flatMap((c) => subtractRanges([c], subtractRanges([c], doneRanges)));
  const undone = subtractRanges(claimed, did);
  const queueId = of(spans, ['queued'])[0]?.jobId ?? requeueJobId;
  return paint(paint(spans, did, { state: 'done', jobId }), undone, { state: 'queued', jobId: queueId });
}

/** The job failed: its claim is recorded failed, with why (the next `want` asks for it again). */
export const fail = (spans: Span[], jobId: string, reason: string): Span[] => paint(spans, of(spans, ['claimed'], jobId), { state: 'failed', jobId, reason });

/**
 * Facts from elsewhere: `ranges` are already done (chat a scan fetched; a stream whose chat is off).
 * A running job's claim is left alone: it finds the work done and completes.
 */
export function markDone(spans: Span[], ranges: Range[], reason?: string): Span[] {
  const free = subtractRanges(ranges, of(spans, ['claimed']));
  const fresh = subtractRanges(free, of(spans, ['done']));
  return paint(spans, fresh, { state: 'done', ...(reason ? { reason } : {}) });
}

/**
 * How far a live stream's reading should go now: to the live edge once at least `batchMs` is new past
 * what has been read or claimed; until then only to where reading stopped (older gaps stay wanted). A
 * stream that has ended goes to its end, so the last partial stretch is flushed. Without the batch, a
 * live stream's few new seconds jumped the line every loop: 383 of 400 reads were under 10 s and the
 * backlog grew (2026-11-19). Pure.
 */
export function readUpTo(spans: Span[], edgeMs: number, live: boolean, batchMs: number): number {
  const reached = Math.max(0, ...of(spans, ['done', 'claimed']).map((s) => s.endMs));
  return live && edgeMs - reached < batchMs ? Math.min(reached, edgeMs) : edgeMs;
}

/** Queued stretches from `t` on are no longer wanted (a live tail waiting for its batch): unqueued. */
export function unqueueFrom(spans: Span[], t: number): Span[] {
  return normalize(spans.flatMap((s) => (s.state !== 'queued' || s.endMs <= t ? [s] : s.startMs >= t ? [] : [{ ...s, endMs: t }])));
}

/** A worker died with claims open: what it finished (`doneRanges`) is done, the rest back in line. */
export function recover(spans: Span[], doneRanges: Range[], requeueJobId: string): Span[] {
  let out = spans;
  for (const jobId of new Set(of(spans, ['claimed']).map((s) => s.jobId!))) out = complete(out, jobId, doneRanges, requeueJobId);
  return out;
}

/** How much of [0, toMs) is done, and what is not (with the state that holds it). */
export function summary(spans: Span[], toMs: number): { doneMs: number; totalMs: number; byState: Record<CoverState, number> } {
  const all = [{ startMs: 0, endMs: toMs }];
  const byState = { queued: 0, claimed: 0, done: 0, failed: 0, skipped: 0 } as Record<CoverState, number>;
  for (const s of spans) {
    const inside = subtractRanges([s], subtractRanges([s], all));
    byState[s.state] += inside.reduce((n, r) => n + r.endMs - r.startMs, 0);
  }
  return { doneMs: byState.done, totalMs: toMs, byState };
}
