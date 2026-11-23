#!/usr/bin/env tsx
// The upload cron: take one approved clip the review DB has not picked, upload it private, schedule it
// LEAD_MIN minutes later, and mark it picked/uploaded. At most UPLOADS_PER_DAY (8) in any 24 hours,
// UPLOAD_MIN (180) minutes apart, and never more than YouTube's own limit let through the last time it
// said no (src/publish/pace.ts; docs/research/censorship-review-2026-11-22.md, C4). While channel.json has a
// careful period, an approval with a sexual flag, an 18+ tick or an f-word in its first 3 s waits for
// the period to end (`deferred`) and the next approval goes instead (C5).
//
//   npx tsx tools/upload-cron.ts --daemon
//   npx tsx tools/upload-cron.ts --once --dry-run
//
// The review page (Studio) is the approval UI; `clip review <clip> approve` writes the same DB row.
// This script never approves anything and never uploads an approval twice: `picked` is set before
// the upload. It stays on one clip until that clip uploads: a YouTube limit or a passing error holds
// the clip (`held`) and the next approval waits behind it. The channel's upload limit is waited out to a
// day after the first upload of the last 24 hours, the project's quotas to midnight Pacific, and a
// passing error is tried again every HOLD_RETRY_MIN (60) minutes. A restart picks the held clip up again, at the try time already set. Every
// try is an upload call, refused or not, and the project's "Video Uploads per day" quota counts them
// (2026-11-21: refused at the 27th call of a Pacific day, 26 of them refused by the channel's limit),
// so a held clip is not tried often. The channel's own upload limit (`uploadLimitExceeded`) and the
// project's quotas (`quotaExceeded`, `rateLimitExceeded`) are told apart in the log and in library/upload-status.json, which the review page
// shows (src/publish/uploadStatus.ts). Every try is also a line in library/upload-log.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, readJsonIf, writeJson } from '../src/core/paths';
import { loadProject, suggestedPost } from '../src/project';
import { postFor } from '../src/core/post';
import { sexualTitleWords } from '../src/qa/adult';
import { checkCareful, neverPost, neverPostText } from '../src/qa/unsafe';
import { carefulUntil } from '../src/core/channel';
import { paceNow, paceWords, type Pace } from '../src/publish/pace';
import { gateApproval, readFailure, type ApprovalFacts } from '../src/publish/scheduler';
import { loadQa } from '../src/qa';
import { pickApproved, markUploaded, markFailed, releasePick, blockTitle, blockAuth, deferPick, listReviews, noteAttempt, holdPick, type ReviewRow } from '../src/review/db';
import { youtubeAccessToken } from '../src/publish/youtube';
import { appendUploadLog, readUploadStatus, uploadTimes, writePace, writeUploadStatus, type UploadTry } from '../src/publish/uploadStatus';
import { setting } from '../src/core/config';
import { sleep } from '../src/core/time';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
/** The posting pace (user, 2026-11-22: change 2 of the censorship review): this many in any 24 hours, this far apart. */
const UPLOADS_PER_DAY = setting('UPLOADS_PER_DAY');
const UPLOAD_MIN = setting('UPLOAD_MIN');
const PACE = { perDay: UPLOADS_PER_DAY, everyMin: UPLOAD_MIN };
const LEAD_MIN = setting('LEAD_MIN');
/** How often a clip held by a passing error is tried again (a YouTube limit is waited out to when it lifts). */
const HOLD_RETRY_MIN = setting('HOLD_RETRY_MIN');
/** A pause after YouTube refused an upload for good, so a fault that refuses every clip does not set the whole line aside in minutes. */
const REFUSED_PAUSE_MIN = setting('REFUSED_PAUSE_MIN');
const ONCE = has('--once');
const DRY = has('--dry-run');
const log = (s: string) => console.log(`${new Date().toISOString()}  ${s}`);
/** Audience numbers for what was uploaded: `clip analytics` once a day (YouTube's data lags 2–3 days). */
const ANALYTICS_HOURS = setting('ANALYTICS_HOURS');
const analyticsFile = path.join(paths.cache, 'analytics-last.json');

/** Import YouTube Analytics when the last import is ANALYTICS_HOURS old. A failure is logged and tried at the next interval. */
function analyticsIfDue() {
  if (DRY || !ANALYTICS_HOURS) return;
  const last = readJsonIf<{ at: string }>(analyticsFile)?.at;
  if (last && Date.now() - Date.parse(last) < ANALYTICS_HOURS * 3_600_000) return;
  const r = spawnSync('./clip', ['analytics', '--days', '28'], { cwd: paths.root, encoding: 'utf8', timeout: 15 * 60_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const rows = (out.match(/ views \d+/g) ?? []).length;
  writeJson(analyticsFile, { at: new Date().toISOString(), ok: r.status === 0, rows });
  log(r.status === 0 ? `analytics: ${rows} clip${rows === 1 ? '' : 's'} with audience numbers (performance.jsonl)` : `analytics failed: ${out.trim().split('\n').pop()}`);
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const isoIn = (min: number) => iso(Date.now() + min * 60_000);
/** When the held clip is tried again (set by `one()` on a hold). */
let nextTryAt = 0;

/** Every try and every clip set aside goes to library/upload-log.jsonl as well as this process's log. */
const record = (t: Omit<UploadTry, 'at'>) => {
  if (!DRY) appendUploadLog({ at: new Date().toISOString(), ...t });
};
/** A clip that cannot be uploaded as it is (no export, QA, length) is set aside so it does not block the line. */
function setAside(row: ReviewRow, why: string) {
  markFailed(row.clipId, why);
  record({ clipId: row.clipId, try: row.attempts, outcome: 'failed', reason: why });
  log(`failed ${row.clipId}: ${why.slice(0, 300)}`);
}

const AUTH_RETRY_MIN = setting('AUTH_RETRY_MIN');

function publish(clipId: string, publishAt: string): { ok: boolean; url?: string; error?: string; publishAt?: string; heldPrivate?: string; ageRestricted?: boolean } {
  if (DRY) return { ok: true, url: 'https://youtu.be/dry-run' };
  const r = spawnSync('./clip', ['publish', clipId, '--publish-at', publishAt, '--force'], { encoding: 'utf8', timeout: 15 * 60_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // a run killed by the timeout is a passing error (tried again), not a refusal
  if (r.status !== 0) return { ok: false, error: `${r.signal ? `timed out (killed by ${r.signal})\n` : ''}${out.slice(-1200) || `exit ${r.status}`}` };
  const rec = readJsonIf<{ url?: string; publishAt?: string; heldPrivate?: string; ageRestricted?: boolean }>(path.join(paths.exports, `${clipId}.publish.json`));
  return { ok: true, url: rec?.url, publishAt: rec?.publishAt, heldPrivate: rec?.heldPrivate, ageRestricted: rec?.ageRestricted };
}

/** An approved clip held for its title (a placeholder, or a sexual word) becomes uploadable as soon as the title is edited. */
function requeueFixedTitles() {
  for (const r of listReviews('approved')) {
    if (r.uploadStatus !== 'blocked-title') continue;
    try {
      const p = loadProject(r.clipId);
      if (!/review clip/i.test(p.title) && !sexualTitleWords(postFor(p.post, suggestedPost(p)).title).length) {
        releasePick(r.clipId);
        log(`requeued ${r.clipId}: title fixed`);
      }
    } catch {
      // A missing project stays held; the next pass will try again.
    }
  }
}

/** Once the careful period is over (or channel.json no longer has one), the approvals it held go back in line. */
function requeueDeferred() {
  if (carefulUntil()) return;
  const held = listReviews('approved').filter((r) => r.uploadStatus === 'deferred');
  for (const r of held) releasePick(r.clipId);
  if (held.length) log(`the careful period is over: ${held.length} held approval${held.length === 1 ? '' : 's'} back in line`);
}

/**
 * While the YouTube login is broken nothing is picked, so approvals wait instead of each being marked
 * failed in turn. A cheap token refresh tells when it works again; then the held clips go back in line.
 */
async function authHeld(): Promise<boolean> {
  const held = listReviews('approved').filter((r) => r.uploadStatus === 'blocked-auth');
  if (!held.length) return false;
  try {
    await youtubeAccessToken();
  } catch (e) {
    if (!DRY) writeUploadStatus('auth', { reason: `the YouTube login is broken: run ./clip auth youtube (${(e as Error).message.split('\n')[0].slice(0, 160)})`, nextTryAt: isoIn(AUTH_RETRY_MIN) });
    log(`waiting for the YouTube login (${held.length} approved clip${held.length === 1 ? '' : 's'} held): ${(e as Error).message.split('\n')[0]}`);
    return true;
  }
  for (const r of held) releasePick(r.clipId);
  log(`the YouTube login works again: ${held.length} held clip${held.length === 1 ? '' : 's'} back in line`);
  return false;
}

/**
 * One pass. The scheduler stays on one clip until it uploads: a YouTube limit or a passing error keeps
 * it as the current clip (`held`), tried again at `nextTryAt`; only an upload, a refusal that retrying
 * cannot fix, or the reviewer taking the approval back moves it to the next. `next`: nothing was sent
 * to YouTube (a gate held or set the clip aside), so the next approval goes at once.
 */
async function one(): Promise<'did' | 'refused' | 'next' | 'idle' | 'held' | 'auth'> {
  requeueFixedTitles();
  requeueDeferred();
  if (await authHeld()) return 'auth';
  const row = pickApproved();
  if (!row) return 'idle';
  // the cheap facts first; the never-post list (which may look at stills) and the careful period only
  // once those pass, the order gateApproval checks them in (src/publish/scheduler.ts)
  const hasExport = fs.existsSync(path.join(paths.exports, `${row.clipId}.mp4`));
  const project = hasExport ? loadProject(row.clipId) : undefined;
  const report = readJsonIf<{ durationS?: number }>(path.join(paths.exports, `${row.clipId}.json`));
  const qa = hasExport ? loadQa(row.clipId) : undefined;
  const facts: ApprovalFacts = {
    clipId: row.clipId,
    hasExport,
    title: project?.title ?? '',
    durationS: report?.durationS ?? qa?.durationS ?? 0,
    alreadyUploaded: fs.existsSync(path.join(paths.exports, `${row.clipId}.publish.json`)) && !DRY,
    unsafe: [],
    unsafeText: '',
    sexualWords: [],
  };
  let gate = gateApproval(facts);
  if (gate.action === 'upload' && project) {
    const unsafe = await neverPost(row.clipId, { look: !DRY });
    const until = carefulUntil();
    const careful = until ? { until, reasons: (await checkCareful(row.clipId, row.adult ?? qa?.adult?.detected ?? false)).map((c) => c.why) } : undefined;
    gate = gateApproval({ ...facts, unsafe, unsafeText: neverPostText(row.clipId, unsafe), sexualWords: sexualTitleWords(postFor(project.post, suggestedPost(project)).title), careful });
  }
  if (gate.action === 'set-aside') {
    setAside(row, gate.why);
    return 'next';
  }
  if (gate.action === 'hold-title') {
    blockTitle(row.clipId, ...(gate.why ? [gate.why] : []));
    record({ clipId: row.clipId, try: row.attempts, outcome: 'failed', reason: gate.logged });
    log(`held ${row.clipId}: ${gate.logged}`);
    return 'next';
  }
  if (gate.action === 'already-uploaded') {
    const rec = readJsonIf<{ url?: string; publishAt?: string }>(path.join(paths.exports, `${row.clipId}.publish.json`));
    markUploaded(row.clipId, { youtubeUrl: rec?.url ?? '', publishAt: rec?.publishAt ?? '' });
    log(`already uploaded ${row.clipId} ${rec?.url ?? ''}`);
    return 'did';
  }
  if (gate.action === 'defer') {
    if (!DRY) deferPick(row.clipId, gate.why);
    record({ clipId: row.clipId, try: row.attempts, outcome: 'deferred', reason: gate.why });
    log(`${DRY ? '[dry] ' : ''}deferred ${row.clipId}: ${gate.why}`);
    return 'next';
  }
  // QA does not hold an approval back (user, 2026-11-22): what it failed is logged with the try
  const qaFailed = qa && !qa.passed ? qa.issues.filter((i) => i.level === 'fail').map((i) => `${i.check}: ${i.detail}`).join('; ') : '';
  if (qaFailed) log(`${row.clipId}: QA failed (${qaFailed.slice(0, 200)}); uploading it anyway, as approved`);
  const at = isoIn(LEAD_MIN);
  const n = DRY ? row.attempts + 1 : noteAttempt(row.clipId);
  const since = row.uploadStatus === 'held' && row.pickedAt ? `, current since ${row.pickedAt.slice(11, 16)}` : '';
  log(`${DRY ? '[dry] ' : ''}${n > 1 ? 'trying again' : 'picking'} ${row.clipId} (try ${n}${since}) → publishAt ${at}`);
  const r = publish(row.clipId, at);
  if (!r.ok) {
    const f = readFailure(r.error ?? '', { now: Date.now(), uploads: uploadTimes(), retryMin: HOLD_RETRY_MIN });
    if (f.kind === 'hold') {
      // the clip stays the current one; the channel's upload limit, the project's API units and a
      // passing error are told apart in the log and on the review page
      if (!DRY) holdPick(row.clipId, f.said);
      record({ clipId: row.clipId, try: n, outcome: 'held', hold: f.hold, reason: f.said });
      const what = f.hold === 'upload-limit' ? "YouTube refused it (the channel's upload limit)" : f.hold === 'api-quota' ? "YouTube refused it (the project's API quota)" : 'the upload failed (network or YouTube)';
      nextTryAt = f.nextTryAt;
      const when = f.hold === 'upload-limit' ? 'a day after the first upload of the last 24 hours' : f.hold === 'api-quota' ? 'after midnight Pacific, when the quotas reset' : `in ${HOLD_RETRY_MIN}m`;
      log(`held ${row.clipId}: ${what}: ${f.said}; trying it again at ${iso(nextTryAt)} (${when})`);
      if (!DRY) writeUploadStatus(f.hold, { reason: f.said, nextTryAt: iso(nextTryAt), ...(f.hold === 'error' ? { retryEveryMin: HOLD_RETRY_MIN } : {}) });
      return 'held';
    }
    if (f.kind === 'auth') {
      record({ clipId: row.clipId, try: n, outcome: 'held', hold: 'auth', reason: 'the YouTube login expired or was revoked' });
      blockAuth(row.clipId);
      if (!DRY) writeUploadStatus('auth', { reason: 'the YouTube login expired or was revoked: run ./clip auth youtube', nextTryAt: isoIn(AUTH_RETRY_MIN) });
      log(`held ${row.clipId}: the YouTube login expired or was revoked. Run ./clip auth youtube; uploads resume by themselves.`);
      return 'auth';
    }
    // a refusal retrying cannot fix (bad metadata, an uncredited export): set aside with Retry upload
    setAside({ ...row, attempts: n }, f.why);
    return 'refused';
  }
  // an 18+ clip is scheduled only once YouTube's record shows the age restriction; otherwise it stays
  // private and the review page says what to do in YouTube Studio (src/publish/youtube.ts)
  const live = DRY ? at : r.publishAt;
  markUploaded(row.clipId, { youtubeUrl: r.url ?? '', publishAt: live ?? '' });
  record({ clipId: row.clipId, try: n, outcome: 'uploaded', url: r.url, ...(live ? { publishAt: live } : {}), ...(r.heldPrivate ? { reason: `private (18+): ${r.heldPrivate}` } : {}) });
  if (!DRY) writeUploadStatus('ok');
  log(r.heldPrivate ? `uploaded ${row.clipId} ${r.url ?? ''} private (18+): ${r.heldPrivate}` : `uploaded ${row.clipId} ${r.url ?? ''} (live ${live ?? at}${r.ageRestricted ? ', age-restricted' : ''})`);
  return 'did';
}

/** The pace now, recorded for the review page; logged when the next slot changes. */
let lastSlot = '';
function pace(): Pace {
  const p = paceNow(PACE);
  if (!DRY) writePace({ perDay: p.perDay, everyMin: p.everyMin, cap: p.cap, inDay: p.inDay, nextAt: iso(p.nextAt), ...(p.waitsFor ? { waitsFor: p.waitsFor } : {}) });
  const slot = iso(p.nextAt);
  if (p.nextAt > Date.now() && slot !== lastSlot) log(`${p.inDay} uploaded in the last 24 hours (${paceWords(p)}): the next upload is at ${slot}`);
  lastSlot = slot;
  return p;
}

if (ONCE) {
  const p = pace();
  if (p.nextAt > Date.now() && !DRY) log(`not yet: the next upload may go at ${iso(p.nextAt)}`);
  else {
    const r = await one();
    if (r === 'held') log(`held; the next try is at ${iso(nextTryAt)}`);
    if (r === 'auth') log('the YouTube login is broken: run ./clip auth youtube');
  }
} else {
  log(`upload cron: ${paceWords(paceNow(PACE))}, publishAt +${LEAD_MIN}m; a held clip waits until its limit lifts${carefulUntil() ? `; careful period until ${carefulUntil()}` : ''}${DRY ? ' (dry)' : ''}`);
  // A restart keeps the try time a hold set: trying again at once would spend an upload call
  // (the project's daily upload quota counts refused ones) on a limit that is still there.
  const prev = readUploadStatus();
  if (!DRY && prev && prev.state !== 'ok' && prev.state !== 'auth' && prev.nextTryAt && Date.parse(prev.nextTryAt) > Date.now()) {
    log(`held (${prev.state}) before the restart: the next try is at ${prev.nextTryAt}`);
    await sleep(Date.parse(prev.nextTryAt) - Date.now());
  }
  for (;;) {
    analyticsIfDue();
    // the pace: the gap after the last upload and the day's cap, from the publish records (so a
    // restart, or an upload by hand, counts too). Re-read every few minutes while it waits.
    const p = pace();
    if (p.nextAt > Date.now() && !DRY) {
      await sleep(Math.min(p.nextAt - Date.now(), 5 * 60_000));
      continue;
    }
    const r = await one();
    if (r === 'held') {
      await sleep(Math.max(nextTryAt - Date.now(), 60_000));
      continue;
    }
    if (r === 'auth') {
      await sleep(AUTH_RETRY_MIN * 60_000);
      continue;
    }
    // an upload is followed by the pace's wait (above); a gate made no upload call, so the next
    // approval goes at once; a refusal for good pauses so a fault cannot sweep the whole line aside
    await sleep(r === 'refused' ? REFUSED_PAUSE_MIN * 60_000 : r === 'idle' ? 60_000 : 5_000);
  }
}
