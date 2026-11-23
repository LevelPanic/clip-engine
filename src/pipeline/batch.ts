// The batch pipeline: each stage queues the next, so a list of links becomes a review queue of
// rendered, QA'd shorts. ingest → discover → judge → make top N → autoedit → render → qa → review
import { enqueue, type Job } from '../jobs/queue';
import { loadCandidates, makeClip } from '../candidates';
import { loadProject } from '../project';

export interface BatchOptions {
  lens: string;
  perVideo: number; // clips to make per video
  judge: 'claude' | 'none'; // none: stop after discovery and wait for /clip in a session
  autoedit: boolean;
  reframe: boolean;
  render: boolean;
  style?: string; // edit style for autoedit (clean | punch | hype | story)
}

export const DEFAULT_BATCH: BatchOptions = { lens: 'podcast-general', perVideo: 5, judge: 'claude', autoedit: true, reframe: false, render: true };

const opts = (j: Job): BatchOptions | null => (j.payload.batch as BatchOptions | undefined) ?? null;
const carry = (j: Job, extra: Record<string, unknown> = {}) => ({ batchId: j.batchId ?? undefined, payload: { batch: j.payload.batch, ...extra } });

export function afterIngest(j: Job) {
  if (!opts(j)) return;
  // a Twitch broadcast has no captions or comments: one scan pass over all of it instead of discover
  if (j.videoId?.startsWith('tw-')) enqueue('scan', { videoId: j.videoId, ...carry(j), dedupe: true });
  else enqueue('discover', { videoId: j.videoId!, ...carry(j), dedupe: true });
}

export function afterDiscover(j: Job) {
  const o = opts(j);
  if (!o || o.judge === 'none') return;
  enqueue('judge', { videoId: j.videoId!, ...carry(j, j.payload.range ? { range: j.payload.range } : {}), dedupe: true });
}

/**
 * Make clips from the best new candidates: under a minute first, then in rank order (post before
 * recut, then virality + signal agreement). Never by the judge's quality score alone, and never a
 * candidate the engine marked `skip`. Unjudged candidates (no verdict) are still eligible.
 */
export function pickForBatch<T extends { status: string; score: number; verdict?: string; rank?: number; startMs: number; endMs: number }>(cands: T[], n: number): T[] {
  return cands
    .filter((c) => c.status === 'new' && c.score >= 60 && c.verdict !== 'skip')
    .sort((a, b) => Number(a.endMs - a.startMs > 60_000) - Number(b.endMs - b.startMs > 60_000) || (a.rank ?? 999) - (b.rank ?? 999) || b.score - a.score)
    .slice(0, n);
}

export async function afterJudge(j: Job): Promise<string[]> {
  const o = opts(j);
  if (!o) return [];
  const cands = pickForBatch(loadCandidates(j.videoId!).candidates, o.perVideo);
  const made: string[] = [];
  for (const c of cands) {
    const clipId = await makeClip(j.videoId!, c.id);
    made.push(clipId);
    if (o.autoedit) enqueue('autoedit', { videoId: j.videoId!, clipId, ...carry(j, { accept: true, reframe: o.reframe, style: o.style }) });
    else if (o.render) enqueue('render', { videoId: j.videoId!, clipId, ...carry(j) });
  }
  return made;
}

export function afterAutoedit(j: Job) {
  const o = opts(j);
  if (o?.render) enqueue('render', { videoId: j.videoId!, clipId: j.clipId!, ...carry(j) });
}

export function afterRender(j: Job) {
  if (opts(j)) enqueue('qa', { videoId: j.videoId!, clipId: j.clipId!, ...carry(j) });
  else if (j.payload.qa) enqueue('qa', { videoId: j.videoId!, clipId: j.clipId! }); // Studio export: check it, leave review alone
}

export async function afterQa(j: Job) {
  if (!opts(j)) return;
  const { setReview } = await import('../review');
  const p = loadProject(j.clipId!);
  if (!p.review || p.review.status === 'editing' || p.review.status === 'changes') setReview(j.clipId!, 'review');
}
