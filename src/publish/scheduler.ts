// The upload scheduler's decisions, kept pure so they are tested (test/scheduler.test.ts). The daemon
// (tools/upload-cron.ts) gathers the facts, asks these, and does what they say: they decide what goes
// public, so the order of the checks is the behaviour. docs/operations.md → "Upload scheduler".
import { holdOf, passingError, refusalText, type UploadHold } from './uploadStatus';
import { limitLiftsAt, LIFT_MARGIN_MS, pacificMidnightAfter } from './pace';
import { setting } from '../core/config';

/** Under this is a broken export; YouTube Shorts have no minimum of their own (15 s is the editing target). */
export const MIN_UPLOAD_S = setting('MIN_UPLOAD_S');
/** Over a minute, a Short with a Content ID claim is blocked worldwide. */
export const MAX_UPLOAD_S = 60;

/** The YouTube login is gone (expired, revoked, never made): every upload would fail the same way. */
export const AUTH_RE = /YouTube is not connected|token refresh failed|token exchange failed|invalid_grant|expired or revoked|auth youtube/i;

export interface ApprovalFacts {
  clipId: string;
  /** exports/<clip>.mp4 exists. */
  hasExport: boolean;
  title: string;
  /** From the render report, else QA; 0 when neither says. */
  durationS: number;
  /** exports/<clip>.publish.json exists: it went up before (a retry must not post it twice). */
  alreadyUploaded: boolean;
  /** The never-post list's reasons (src/qa/unsafe.ts `neverPost`); a `title` reason can be fixed in place. */
  unsafe: { kind: string; why: string }[];
  /** The never-post list as one line, for the set-aside reason. */
  unsafeText: string;
  /** The sexual words in the title as posted, for the hold reason. */
  sexualWords: string[];
  /** The careful period's end while one is on (channel.json), and what in this clip it would hold. */
  careful?: { until: string; reasons: string[] };
  /** The reviewer chose Upload anyway on it (`review.uploadAnyway`): the careful period does not hold it. */
  uploadAnyway?: boolean;
}

export type Gate =
  | { action: 'set-aside'; why: string }
  | { action: 'hold-title'; why: string; logged: string }
  | { action: 'already-uploaded' }
  | { action: 'defer'; why: string }
  | { action: 'upload' };

/** What to do with the approval the scheduler picked, before any upload call is spent. */
export function gateApproval(f: ApprovalFacts): Gate {
  if (!f.hasExport) return { action: 'set-aside', why: 'no export' };
  if (/review clip/i.test(f.title)) return { action: 'hold-title', why: '', logged: 'placeholder title (uploads by itself once the title is edited)' };
  // Shorts have no minimum length: an approval under 15 s is the reviewer's call (a 13.6 s clip was
  // approved as perfect and then refused). Under MIN_UPLOAD_S is a broken export.
  if (f.durationS < MIN_UPLOAD_S || f.durationS > MAX_UPLOAD_S) return { action: 'set-aside', why: `duration ${f.durationS.toFixed(1)} s is outside ${MIN_UPLOAD_S}–${MAX_UPLOAD_S} s` };
  // QA does not hold an approval back (user, 2026-11-22): the reviewer saw its report. The credit and
  // the never-post list are the exceptions, and the publisher refuses those itself as well.
  if (f.alreadyUploaded) return { action: 'already-uploaded' };
  if (f.unsafe.some((r) => r.kind !== 'title')) return { action: 'set-aside', why: f.unsafeText };
  if (f.unsafe.length) {
    return { action: 'hold-title', why: `the title sells it on sex (${f.sexualWords.join(', ')}); edit the title and it uploads automatically`, logged: f.unsafe[0].why };
  }
  // the careful period: only the cleanest approvals go up until it ends; the rest wait for it, unless the
  // reviewer chose Upload anyway (that skips this check only: the ones above still refuse)
  if (f.careful?.reasons.length && !f.uploadAnyway) return { action: 'defer', why: `careful period until ${f.careful.until} (channel.json): ${f.careful.reasons.join('; ')}. It goes up by itself after that` };
  return { action: 'upload' };
}

export type Failure =
  | { kind: 'hold'; hold: Exclude<UploadHold, 'auth'>; said: string; nextTryAt: number }
  | { kind: 'auth' }
  | { kind: 'refused'; why: string };

/**
 * What a failed upload means. A YouTube limit or a passing error holds the clip (it stays the current
 * one) until the limit should lift: the channel's limit a day after the first upload of the last 24 hours,
 * the project's quotas at midnight Pacific, a passing error after `retryMin`. Each try is an upload call
 * and the project's daily quota counts refused ones, so a held clip is not tried often. A broken login
 * holds every approval; anything else is a refusal retrying cannot fix.
 */
export function readFailure(error: string, o: { now: number; uploads: number[]; retryMin: number }): Failure {
  const hold: Exclude<UploadHold, 'auth'> | null = holdOf(error) ?? (passingError(error) && !AUTH_RE.test(error) ? 'error' : null);
  if (hold) {
    const said = hold === 'error' ? (error.trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? 'error') : refusalText(error);
    const nextTryAt = hold === 'upload-limit' ? limitLiftsAt(o.uploads, o.now) : hold === 'api-quota' ? pacificMidnightAfter(o.now) + LIFT_MARGIN_MS : o.now + o.retryMin * 60_000;
    return { kind: 'hold', hold, said, nextTryAt };
  }
  if (AUTH_RE.test(error)) return { kind: 'auth' };
  return { kind: 'refused', why: error.trim() ? refusalText(error) : 'upload failed' };
}
