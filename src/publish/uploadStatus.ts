// What the upload scheduler (tools/upload-cron.ts) is doing, for the review page: uploading, or held,
// and by what. YouTube refuses an upload for two kinds of limit that need different fixes: the
// channel's own upload limit (`uploadLimitExceeded`: 10 in 24 hours stopped it on 2026-11-19 and 11-20,
// 19 did not on 11-21; it lifts by itself, and a Cloud quota increase does not raise it) and the Google
// Cloud project's quotas, which reset at midnight Pacific: the API units (`quotaExceeded`) and "Video
// Uploads per day" (`rateLimitExceeded`, which counts refused upload calls too). A passing network or server error and a broken
// login are the other holds. The scheduler stays on one clip until it uploads, and every try it makes
// is a line in library/upload-log.jsonl (kept; nothing prunes it).
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJsonIf, writeJson } from '../core/paths';

export type UploadHold = 'upload-limit' | 'api-quota' | 'error' | 'auth';
export interface UploadStatus {
  state: 'ok' | UploadHold;
  /** When this state began; kept while the state stays the same. */
  since: string;
  /** The scheduler's last pass. */
  at: string;
  /** YouTube's own words for a hold. */
  reason?: string;
  /** When the scheduler tries again. */
  nextTryAt?: string;
  /** How often a held clip is tried (HOLD_RETRY_MIN): a passing error only; a limit is waited out to when it lifts. */
  retryEveryMin?: number;
  /** The posting pace (src/publish/pace.ts): the rule, today's count and when the next may go. Kept across state changes. */
  pace?: { perDay: number; everyMin: number; cap: number; inDay: number; nextAt: string; waitsFor?: 'spacing' | 'cap' };
}

export const uploadStatusFile = () => path.join(paths.library, 'upload-status.json');
export const uploadLogFile = () => path.join(paths.library, 'upload-log.jsonl');

/** One upload try, as the scheduler made it. */
export interface UploadTry {
  at: string;
  clipId: string;
  /** This approval's try number. */
  try: number;
  /** `deferred`: held for the careful period (channel.json → careful); it goes up by itself after it. */
  outcome: 'uploaded' | 'held' | 'failed' | 'deferred';
  hold?: UploadHold;
  /** What YouTube or the gate said. */
  reason?: string;
  url?: string;
  publishAt?: string;
  /** Set on the tries before 2026-11-20 19:15 UTC, read back from .cache/upload-cron.log. */
  from?: string;
}

export function appendUploadLog(t: UploadTry) {
  fs.mkdirSync(path.dirname(uploadLogFile()), { recursive: true });
  fs.appendFileSync(uploadLogFile(), JSON.stringify(t) + '\n');
}

/** The last `n` tries, newest first. */
export function readUploadLog(n = 20): UploadTry[] {
  if (!fs.existsSync(uploadLogFile())) return [];
  const lines = fs.readFileSync(uploadLogFile(), 'utf8').trim().split('\n').filter(Boolean);
  const out: UploadTry[] = [];
  for (const l of lines.slice(-n).reverse()) {
    try {
      out.push(JSON.parse(l) as UploadTry);
    } catch {
      // a line being written
    }
  }
  return out;
}

/** A failure worth trying the same clip again for: the network, a timeout, YouTube's 429 or 5xx. */
export const passingError = (error: string) =>
  /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out|failed \((?:429|5\d\d)\)|^exit null$/im.test(error);

/** Which limit a refused upload hit, from the error the publisher printed; null when it is not a limit. */
export function holdOf(error: string): Exclude<UploadHold, 'auth' | 'error'> | null {
  if (/uploadLimitExceeded|exceeded the number of videos/i.test(error)) return 'upload-limit';
  if (/quota/i.test(error)) return 'api-quota';
  return null;
}

/** YouTube's reason and message from a refused upload ("uploadLimitExceeded: The user has exceeded …"). */
export function refusalText(error: string): string {
  const reason = error.match(/"reason":\s*"([^"]+)"/)?.[1];
  const message = error.match(/"message":\s*"([^"]+)"/)?.[1];
  if (!reason && !message) return error.trim().split('\n').pop()?.slice(0, 200) ?? '';
  return [reason, message].filter(Boolean).join(': ');
}

export function readUploadStatus(): UploadStatus | null {
  try {
    return readJsonIf<UploadStatus>(uploadStatusFile()) ?? null;
  } catch {
    return null;
  }
}

/** Record the scheduler's state; `since` carries over while the state is unchanged. */
export function writeUploadStatus(state: UploadStatus['state'], extra: { reason?: string; nextTryAt?: string; retryEveryMin?: number; pace?: UploadStatus['pace'] } = {}, now = new Date()): UploadStatus {
  const prev = readUploadStatus();
  const at = now.toISOString();
  const s: UploadStatus = { state, since: prev?.state === state ? prev.since : at, at, ...(prev?.pace ? { pace: prev.pace } : {}), ...extra };
  writeJson(uploadStatusFile(), s);
  return s;
}

/** Every upload's time as its publish record states it, oldest first (exports/: the scheduler's, and any by hand). */
function uploadStamps(): { at: string; ms: number }[] {
  if (!fs.existsSync(paths.exports)) return [];
  const out: { at: string; ms: number }[] = [];
  for (const f of fs.readdirSync(paths.exports)) {
    if (!f.endsWith('.publish.json')) continue;
    try {
      const at = readJsonIf<{ at?: string }>(path.join(paths.exports, f))?.at;
      if (at && Number.isFinite(Date.parse(at))) out.push({ at, ms: Date.parse(at) });
    } catch {
      // a record being written; the next read sees it
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}

/** Every upload's time (ms), oldest first. */
export const uploadTimes = (): number[] => uploadStamps().map((u) => u.ms);

/** Record the posting pace without touching the state (a hold stays a hold). */
export function writePace(pace: NonNullable<UploadStatus['pace']>, now = new Date()) {
  const prev = readUploadStatus();
  writeJson(uploadStatusFile(), { ...(prev ?? { state: 'ok', since: now.toISOString() }), at: now.toISOString(), pace } satisfies UploadStatus);
}

/** Upload times in the 24 hours before `now`, oldest first, from the publish records in exports/. */
export function recentUploads(now = Date.now()): string[] {
  return uploadStamps()
    .filter((u) => now - u.ms < 24 * 3_600_000 && u.ms <= now)
    .map((u) => u.at);
}
