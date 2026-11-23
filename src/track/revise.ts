// Change requests (C in the review page, with a note): which ones become a `revise` job. Pure.
import type { ReviewRow } from '../review/db';

/** One job per request: the clip and the time it was sent back (a new request on the same clip is a new key). */
export const revisionKey = (r: Pick<ReviewRow, 'clipId' | 'decisionAt'>) => `${r.clipId}@${r.decisionAt}`;

/**
 * The requests to queue: waiting for changes, with a note, not asked before (done or failed: a failed
 * request is not retried by itself), and not a clip whose footage editing cannot fix (`broken`: cut from
 * a YouTube stream while it was live).
 */
export function revisionsToQueue<R extends Pick<ReviewRow, 'clipId' | 'videoId' | 'status' | 'note' | 'decisionAt'>>(reviews: R[], asked: Set<string>, broken: (videoId: string) => boolean): R[] {
  return reviews.filter((r) => r.status === 'changes' && !!(r.note ?? '').trim() && !asked.has(revisionKey(r)) && !broken(r.videoId));
}
