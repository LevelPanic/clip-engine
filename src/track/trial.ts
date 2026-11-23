// The blind ranker trial's tally (2026-11-19): per arm, what its moment jobs came to and what the
// reviewer decided, counted per job (the same cost each). Pure.
import type { WatchJob } from './jobs';

export interface ArmRow {
  arm: string;
  jobs: number;
  finished: number;
  clips: number;
  approved: number;
  changes: number;
  rejected: number;
  /** Clips in review, no decision yet. */
  waiting: number;
  /** Finished jobs that made no clip (the experts or the curator found nothing to post). */
  noClip: number;
  /** Jobs that say nothing about the ranking: the broadcast could not be read, or a stage failed. */
  void: number;
}

/** `decided`: the latest review decision per clip id. */
export function trialSummary(jobs: Pick<WatchJob, 'arm' | 'state' | 'clipIds' | 'result'>[], decided: Map<string, string>): ArmRow[] {
  const by = new Map<string, ArmRow>();
  for (const j of jobs) {
    if (!j.arm) continue;
    const r = by.get(j.arm) ?? { arm: j.arm, jobs: 0, finished: 0, clips: 0, approved: 0, changes: 0, rejected: 0, waiting: 0, noClip: 0, void: 0 };
    by.set(j.arm, r);
    r.jobs++;
    if (j.state !== 'done' && j.state !== 'failed') continue;
    // a subscriber-only or deleted broadcast, or a stage that failed: not a verdict on the moment
    if (j.state === 'failed' || /; skipped$/.test(j.result ?? '')) {
      r.void++;
      continue;
    }
    r.finished++;
    if (!j.clipIds.length) r.noClip++;
    for (const c of j.clipIds) {
      r.clips++;
      const d = decided.get(c);
      if (d === 'approved') r.approved++;
      else if (d === 'changes') r.changes++;
      else if (d === 'rejected') r.rejected++;
      else r.waiting++;
    }
  }
  const order = ['score', 'alternate', 'both'];
  return [...by.values()].sort((a, b) => order.indexOf(a.arm) - order.indexOf(b.arm));
}
