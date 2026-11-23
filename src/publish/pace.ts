// How fast the channel posts (reports/censorship-review-2026-11-22.md, C4; user, 2026-11-22). It had
// posted 26 in a day, in one title template, right after 62 refused upload calls, and YouTube's spam
// policy names repetitive, mass-produced uploads. So: at most `perDay` uploads in any 24 hours, `everyMin`
// apart, and never more than YouTube's own limit let through the last time it said no. A limit that
// refuses an upload is waited out to when it lifts, not tried every hour: each refused call is counted
// by the project's "Video Uploads per day" quota. Pure, apart from reading the records.
import { readUploadLog, uploadTimes } from './uploadStatus';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** Tried this long after the moment a limit should lift, so the try is not a minute early. */
export const LIFT_MARGIN_MS = 10 * MIN;
/** When the channel's limit refuses with no upload in the last 24 hours, there is nothing to count from. */
export const UNKNOWN_LIFT_MS = 6 * H;
/** A refusal by YouTube's limit lowers the cap for this long after it. */
export const ALLOWANCE_MS = 2 * DAY;

export interface PaceRule {
  perDay: number;
  everyMin: number;
}

export interface Pace extends PaceRule {
  /** Uploads allowed in any 24 hours: `perDay`, or fewer when YouTube's limit last let fewer through. */
  cap: number;
  /** Uploads in the 24 hours before now. */
  inDay: number;
  /** When the next upload may go; at or before now, it may go now. */
  nextAt: number;
  /** What it waits for: the gap after the last upload, or the day's cap. */
  waitsFor?: 'spacing' | 'cap';
  /** YouTube's limit refused an upload after it let this many through in 24 hours (the cap's source when lower). */
  allowance?: { allowed: number; refusedAt: number };
}

/** When the next upload may go. `uploads` and `limitRefusals` are times in ms, any order. */
export function paceAt(o: PaceRule & { uploads: number[]; limitRefusals: number[]; now: number }): Pace {
  const ups = o.uploads.filter((t) => t <= o.now).sort((a, b) => a - b);
  const inWindow = (end: number) => ups.filter((t) => t > end - DAY && t <= end);
  // never above what YouTube let through the last time its limit said no (within ALLOWANCE_MS)
  const refusedAt = Math.max(-Infinity, ...o.limitRefusals.filter((t) => t <= o.now && o.now - t < ALLOWANCE_MS));
  const allowed = Number.isFinite(refusedAt) ? inWindow(refusedAt).length : null;
  const cap = allowed !== null && allowed >= 1 && allowed < o.perDay ? allowed : o.perDay;
  const day = inWindow(o.now);
  const spacingAt = ups.length ? ups[ups.length - 1] + o.everyMin * MIN : -Infinity;
  // the day's cap lifts when enough of the last 24 hours' uploads are a day old
  const capAt = day.length >= cap ? day[day.length - cap] + DAY : -Infinity;
  const nextAt = Math.max(spacingAt, capAt, o.now);
  return {
    perDay: o.perDay,
    everyMin: o.everyMin,
    cap,
    inDay: day.length,
    nextAt,
    ...(nextAt > o.now ? { waitsFor: capAt >= spacingAt ? ('cap' as const) : ('spacing' as const) } : {}),
    ...(allowed !== null ? { allowance: { allowed, refusedAt } } : {}),
  };
}

/**
 * When the channel's upload limit (`uploadLimitExceeded`) should let the next one through: a day after
 * the first upload of the last 24 hours (on 2026-11-19 and 11-20 the 11th was refused until about then).
 * If it is refused again then, the next try counts from the next upload, so the wait follows the limit.
 */
export function limitLiftsAt(uploads: number[], now: number): number {
  const day = uploads.filter((t) => t > now - DAY && t <= now).sort((a, b) => a - b);
  return day.length ? day[0] + DAY + LIFT_MARGIN_MS : now + UNKNOWN_LIFT_MS;
}

/** The next midnight in Pacific time, when the Cloud project's YouTube quotas reset. */
export function pacificMidnightAfter(now: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(now));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const into = ((n('hour') * 60 + n('minute')) * 60 + n('second')) * 1000 + (now % 1000);
  return now + DAY - into;
}

/** The scheduler's pace now, from the publish records and the upload log. */
export function paceNow(rule: PaceRule, now = Date.now()): Pace {
  const refusals = readUploadLog(2000)
    .filter((t) => t.outcome === 'held' && t.hold === 'upload-limit')
    .map((t) => Date.parse(t.at));
  return paceAt({ ...rule, uploads: uploadTimes(), limitRefusals: refusals, now });
}

/** "3 hours apart", "8 in 24 hours": the rule in words, for logs and the review page. */
export function paceWords(p: Pace): string {
  const gap = p.everyMin % 60 === 0 ? `${p.everyMin / 60} hour${p.everyMin === 60 ? '' : 's'}` : `${p.everyMin} minutes`;
  const capped = p.cap < p.perDay && p.allowance ? `, held to ${p.cap} because YouTube's limit refused the ${p.allowance.allowed + 1}th` : '';
  return `at most ${p.cap} in 24 hours, ${gap} apart${capped}`;
}
