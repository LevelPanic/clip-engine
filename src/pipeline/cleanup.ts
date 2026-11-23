// What the hourly cleanup (tools/cleanup.ts) may delete. Pure, tested in test/cleanup.test.ts: these decide
// what is deleted for good, so the rules are pinned. docs/operations.md → "The daemons".
//
//   1. A rejected clip once its grace period is over (the rejection stays in feedback.jsonl).
//   2. A source's heavy media (footage, audio) once nothing waits on it: no clip of it waiting for a
//      decision, changes or an upload, no job queued or running for it, it has been analysed, and it
//      has been quiet for the grace period. Small files (metadata, transcript, chat, candidates) stay.

export interface ReviewFacts {
  clipId: string;
  videoId: string;
  status: string;
  uploadStatus: string | null;
  decisionAt: string;
}

/** Rejected clips whose grace period is over. */
export const rejectedToDelete = <R extends ReviewFacts>(reviews: R[], now: number, graceMin: number): R[] =>
  reviews.filter((r) => r.status === 'rejected' && Date.parse(r.decisionAt) <= now - graceMin * 60_000);

/**
 * The videos whose footage is still needed. A clip waiting for a decision or an upload needs it (a change
 * means a re-render); one already on YouTube does not. Counting uploaded approvals as active kept every
 * posted stream's gigabytes forever (17.9 GB of footage with the disk at 97%, 2026-11-18).
 */
export function videosInUse(reviews: ReviewFacts[], jobVideoIds: (string | undefined | null)[]): Set<string> {
  const out = new Set<string>();
  for (const r of reviews) {
    if (r.status === 'review' || r.status === 'changes' || (r.status === 'approved' && r.uploadStatus !== 'uploaded')) out.add(r.videoId);
  }
  for (const v of jobVideoIds) if (v) out.add(v);
  return out;
}

/** Whether a source's media may go: not in use, analysed, and quiet for the grace period. */
export const sourceMayGo = (o: { videoId: string; inUse: Set<string>; analysed: boolean; lastActivityMs: number; now: number; graceHours: number }): boolean =>
  !o.inUse.has(o.videoId) && o.analysed && o.lastActivityMs > 0 && o.lastActivityMs <= o.now - o.graceHours * 3_600_000;

/** Footage and audio (and their temp folders) in a source's folder; everything else is small and stays. */
export const isHeavyMedia = (name: string): boolean => {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  return (
    name === 'audio' ||
    name === 'sections' ||
    name.startsWith('audio.') ||
    name.startsWith('sections.') ||
    ['.mp4', '.mkv', '.webm', '.m4a', '.ts', '.flv'].includes(ext)
  );
};
