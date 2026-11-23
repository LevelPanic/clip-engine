// A queue dossier: what an expert needs to judge a queue, gathered in one call. The words around the
// region, the read-on when chat (or the kind) asks for it, and stills at the seconds that matter.
//
// Why it exists: on the first trial of the three experts (2026-11-12) 20 queues took 269 model turns
// and 323 stills, because every read and every look was its own command. An agent re-reads its whole
// conversation on every turn, so its cost is turns × context, not the size of the answer. The engine
// can do the gathering for nothing; the expert's turns are for looking and deciding.
import { mergeRanges } from '../core/ranges';
import { chatAsksReadOn, coverageOf, describeCoverage, loadQueueData, queuesFrom, type Queue, type QueueData, type QueueKind } from './queues';

/** Words either side of a queue's region: the setup before it, the reaction after it. */
export const DOSSIER_BEFORE_MS = 15_000;
export const DOSSIER_AFTER_MS = 25_000;
/** How far past the region the read-on goes: the reveal, the "I was joking", the better landing. */
export const READ_ON_MS = 120_000;
/** Queues per call: what an expert can look at in one turn. */
export const DOSSIER_BATCH = 4;
/** Text per call: a command's output is cut off somewhere past this, and half a dossier is worse than a short one. */
export const DOSSIER_CHARS = 20_000;

/** Around an exact moment: just before it, the moment, the reaction, the aftermath. */
export const MOMENT_OFFSETS_MS = [-3000, 0, 2000, 6000];
/**
 * The most stills a queue is shown at first. A story's words carry it: it gets its first second, the
 * moment, one between and its last second. (Measured: shown seven a queue, a story expert read 37 of
 * 100 and said so. An instruction to read every still has to be one that can be followed.)
 */
export const DOSSIER_STILLS: Record<QueueKind, number> = { meme: 9, viral: 9, clip: 4 };

/**
 * The seconds to look at first. Pure.
 *  - an exact moment (heard in the audio, or seen by an expert): just before it, the moment, the
 *    reaction, the aftermath;
 *  - and for every queue the rest of its region, edge to edge, every few seconds. The moment a queue
 *    is built on is where somebody reacted; what they reacted to can be earlier, and what it turned
 *    into later. (Measured: with stills only around a shout at 1:52:18, an expert never saw the hand
 *    over the mouth at 1:52:27 and rejected the gag.) For an estimated moment this is the sweep.
 */
export function dossierTimes(q: Pick<Queue, 'kind' | 'startMs' | 'endMs' | 'peakMs' | 'anchor'>): number[] {
  const sec = (t: number) => Math.max(0, Math.round(t / 1000) * 1000);
  const exact = q.anchor === 'audio' || q.anchor === 'expert';
  const cap = DOSSIER_STILLS[q.kind];
  // a gag is looked at around its hit; a story only needs to know who is on screen
  const around = exact && q.kind !== 'clip';
  const must = [...new Set((around ? MOMENT_OFFSETS_MS.map((o) => q.peakMs + o) : [q.peakMs]).map(sec))];
  const span = Math.max(0, q.endMs - q.startMs);
  const n = Math.max(2, Math.min(cap - (around ? 2 : q.kind === 'clip' ? 1 : 0), Math.round(span / (exact ? 5000 : 4000)) + 1));
  const grid = Array.from({ length: n }, (_, k) => sec(q.startMs + (span * k) / (n - 1)));
  const chosen = [...must];
  // two stills a second apart show the same thing
  for (const t of grid) if (chosen.every((c) => Math.abs(c - t) >= 2000)) chosen.push(t);
  chosen.sort((x, y) => x - y);
  // over the cap: drop the still that adds least, the one whose neighbours are closest together.
  // The moment's own stills and the region's two edges stay.
  while (chosen.length > cap) {
    let drop = -1;
    let least = Infinity;
    for (let k = 1; k < chosen.length - 1; k++) {
      if (must.includes(chosen[k])) continue;
      const gap = chosen[k + 1] - chosen[k - 1];
      if (gap < least) {
        least = gap;
        drop = k;
      }
    }
    if (drop < 0) break;
    chosen.splice(drop, 1);
  }
  return chosen;
}

/**
 * Does this queue need the two minutes after it read before a verdict? A story always does (people
 * retract and retell); the others when chat is ahead of the streamer, tense, or calling it fake.
 */
export function readOnAsked(q: Pick<Queue, 'kind' | 'signals'>): boolean {
  return q.kind === 'clip' || chatAsksReadOn(q.signals?.chat);
}

export interface DossierWindow {
  fromMs: number;
  toMs: number;
  /** Set when the read-on is asked for: the words from `toMs` to here. */
  readOnToMs?: number;
}

/** The words an expert reads for a queue. Pure. */
export function dossierWindow(q: Pick<Queue, 'kind' | 'startMs' | 'endMs' | 'signals'>, durationMs: number): DossierWindow {
  const fromMs = Math.max(0, q.startMs - DOSSIER_BEFORE_MS);
  const toMs = Math.min(durationMs, q.endMs + DOSSIER_AFTER_MS);
  const readOnToMs = Math.min(durationMs, q.endMs + READ_ON_MS);
  return readOnAsked(q) && readOnToMs > toMs ? { fromMs, toMs, readOnToMs } : { fromMs, toMs };
}

export const batchesOf = <T>(items: T[], size = DOSSIER_BATCH): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, k) => items.slice(k * size, (k + 1) * size));

export interface DossierEntry {
  queue: Queue;
  window: DossierWindow;
  /** The transcript lines of the window, as `clip transcript` prints them. */
  words: string;
  readOn?: string;
  stills: { ms: number; file?: string }[];
}

export interface Dossier {
  videoId: string;
  kind: QueueKind;
  range: { startMs: number; endMs: number };
  /** False when only queue ids were given: the list and the coverage are then about those queues, not a range. */
  scoped: boolean;
  /** `⚠` lines: what was never fetched, stills that could not be trusted. */
  warnings: string[];
  /** Every queue of the kind in the range, in time order, and whether it has a verdict. */
  all: { queue: Queue; judged: boolean }[];
  entries: DossierEntry[];
  /** Ids still to come, in the batches to ask for them in. */
  rest: string[][];
  /** Ids that were asked for and are not queues (any more). */
  missing: string[];
}

/**
 * Build the dossier for the next queues without a verdict in a range (time order), or for the ids
 * given. Reads, transcribes what nobody has read yet, and saves stills; judges nothing.
 */
export async function buildDossier(
  videoId: string,
  kind: QueueKind,
  opts: { fromMs?: number; toMs?: number; ids?: string[]; note?: (line: string) => void } = {},
): Promise<Dossier> {
  const { loadQueueReview, pendingQueues, queueFromVerdict, resolveQueue } = await import('./review');
  const { loadMeta, loadTranscript, loadSponsors } = await import('../ingest/ingest');
  const { renderTranscriptMd } = await import('../ingest/transcript');
  const { grabFrames } = await import('../ingest/frames');
  const fs = await import('node:fs');
  const note = opts.note ?? (() => {});

  let data: QueueData = await loadQueueData(videoId);
  const scoped = opts.fromMs !== undefined || opts.toMs !== undefined;
  let range = { startMs: opts.fromMs ?? 0, endMs: Math.min(data.durationMs, opts.toMs ?? data.durationMs) };
  const missing: string[] = [];
  let all: Dossier['all'] = [];
  const pick = (): Queue[] => {
    const ledger = loadQueueReview(videoId);
    const listed = queuesFrom(data, { kind, fromMs: range.startMs, toMs: range.endMs, limit: 500 }).sort((a, b) => a.peakMs - b.peakMs);
    const pending = new Set(pendingQueues(ledger, listed).map((q) => q.id));
    all = listed.map((queue) => ({ queue, judged: !pending.has(queue.id) }));
    if (!opts.ids?.length) return listed.filter((q) => pending.has(q.id));
    missing.length = 0;
    const out: Queue[] = [];
    for (const id of opts.ids) {
      // a found moment, or a queue the evidence has since moved, still has its place in the ledger
      const saved = ledger.verdicts.find((v) => v.queueId === id);
      const q = resolveQueue(data, id) ?? (saved ? queueFromVerdict(saved) : undefined);
      if (!q || q.kind !== kind) missing.push(id);
      else if (!out.some((x) => x.id === q.id)) out.push(q);
    }
    out.sort((a, b) => a.peakMs - b.peakMs);
    if (!scoped && out.length) {
      // asked for by id, with no range: the list and the coverage are about these queues, not the whole video
      all = out.map((queue) => ({ queue, judged: pendingQueues(ledger, [queue]).length === 0 }));
      range = { startMs: Math.max(0, Math.min(...out.map((q) => q.startMs)) - DOSSIER_BEFORE_MS), endMs: Math.min(data.durationMs, Math.max(...out.map((q) => q.endMs)) + READ_ON_MS) };
    }
    return out;
  };

  let chosen = pick();
  if (data.platform === 'twitch' && chosen.length) {
    // normally a no-op: the coordinator transcribes the whole range before the experts start
    const { ensureTranscribed } = await import('../ingest/windowed');
    const need = (qs: Queue[]) => mergeRanges(qs.slice(0, DOSSIER_BATCH).map((q) => dossierWindow(q, data.durationMs)).map((w) => ({ startMs: w.fromMs, endMs: w.readOnToMs ?? w.toMs })), 20_000);
    const first = await ensureTranscribed(videoId, need(chosen), note);
    if (first.transcribed.length) {
      // new words move scores and can move a story queue: choose again from what is there now
      data = await loadQueueData(videoId);
      chosen = pick();
      const second = await ensureTranscribed(videoId, need(chosen), note);
      if (second.transcribed.length) data = await loadQueueData(videoId);
    }
  }

  const meta = loadMeta(videoId);
  const words = (fromMs: number, toMs: number): string => {
    try {
      return renderTranscriptMd(loadTranscript(videoId), meta, loadSponsors(videoId), { fromMs, toMs }).trimEnd() || '(nothing said here)';
    } catch {
      return '(no transcript)';
    }
  };

  const entries: DossierEntry[] = [];
  let chars = 0;
  for (const queue of chosen) {
    if (entries.length >= DOSSIER_BATCH) break;
    const window = dossierWindow(queue, data.durationMs);
    const text = words(window.fromMs, window.toMs);
    let readOn = window.readOnToMs !== undefined ? words(window.toMs, window.readOnToMs) : undefined;
    if (readOn !== undefined) {
      // the transcript prints whole lines, so the line that straddles the join comes back twice
      const lines = readOn.split('\n');
      if (lines[0] === text.split('\n').at(-1)) readOn = lines.slice(1).join('\n') || '(nothing more said)';
    }
    const size = text.length + (readOn?.length ?? 0) + 1200;
    if (entries.length && chars + size > DOSSIER_CHARS) break;
    chars += size;
    entries.push({ queue, window, words: text, ...(readOn !== undefined ? { readOn } : {}), stills: dossierTimes(queue).map((ms) => ({ ms })) });
  }
  let later = chosen.slice(entries.length).map((q) => q.id);
  if (opts.ids?.length && scoped) {
    // asked for by id inside a range: also say what else in the range still has no verdict
    const here = new Set([...entries.map((e) => e.queue.id), ...later]);
    later = [...later, ...all.filter((x) => !x.judged && !here.has(x.queue.id)).map((x) => x.queue.id)];
  }
  const rest = batchesOf(later);

  // one fetch for every still of the batch
  const warnings = [...describeCoverage(coverageOf(data, range))];
  const times = [...new Set(entries.flatMap((e) => e.stills.map((s) => s.ms)))].sort((a, b) => a - b);
  if (times.length) {
    const files = await grabFrames(videoId, times, 640, (w) => warnings.push(w));
    const at = new Map(times.map((t, k) => [t, files[k]]));
    for (const e of entries) for (const s of e.stills) if (fs.existsSync(at.get(s.ms)!)) s.file = at.get(s.ms);
  }
  return { videoId, kind, range, scoped, warnings, all, entries, rest, missing };
}
