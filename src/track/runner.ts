// What a failed watchlist job becomes (tools/watchlist.ts `afterError` does the writing). Pure, tested in
// test/watchlist-runner.test.ts. docs/operations.md → "The watchlist".
import { isSubscriberOnly, unreadable } from './rank';

/** Worth retrying: a stage timed out, or the network or an API hiccuped. Not: a broadcast nobody may read. */
const TRANSIENT = /timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|HTTP Error 5\d\d|\b5\d\d\b|rate limit|429|Temporary failure/i;

export const retryable = (msg: string) => TRANSIENT.test(msg) && !isSubscriberOnly(msg);

export type JobEnding =
  /** a later step found the broadcast unreadable: skip the stream once, not each of its moments in turn */
  | { kind: 'skip-stream'; why: string }
  /** a restart stopped it: back in line at its checkpoint (three restarts at most) */
  | { kind: 'requeue-interrupted' }
  /** a timeout or a network error: one more go from the last checkpoint */
  | { kind: 'retry'; error: string }
  | { kind: 'fail' };

export function jobEnding(job: { kind: string; attempts: number; interrupted: number }, msg: string, maxRetries: number): JobEnding {
  const gone = unreadable(msg);
  if (gone && job.kind === 'twitch-moment') return { kind: 'skip-stream', why: gone };
  if (/\binterrupted\b/.test(msg) && job.interrupted < 3) return { kind: 'requeue-interrupted' };
  if (retryable(msg) && job.attempts < maxRetries) return { kind: 'retry', error: `attempt ${job.attempts + 1} failed: ${msg.split('\n')[0]}` };
  return { kind: 'fail' };
}
