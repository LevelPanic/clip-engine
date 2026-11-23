#!/usr/bin/env tsx
// The upload cron: take one approved clip the review DB has not picked, upload it private, schedule it
// LEAD_MIN minutes later, and mark it picked/uploaded. At most UPLOADS_PER_DAY (8) in any 24 hours,
// UPLOAD_MIN (180) minutes apart, and never more than YouTube's own limit let through the last time it
// said no (src/publish/pace.ts; reports/censorship-review-2026-11-22.md, C4). While channel.json has a
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
import { paths, readJsonIf } from '../src/core/paths';
import { loadProject, suggestedPost } from '../src/core/project';
import { postFor } from '../src/core/post';
import { sexualTitleWords } from '../src/qa/adult';
import { checkCareful, neverPost, neverPostText } from '../src/qa/unsafe';
import { carefulUntil } from '../src/core/channel';
import { limitLiftsAt, LIFT_MARGIN_MS, pacificMidnightAfter, paceNow, paceWords, type Pace } from '../src/publish/pace';
import { loadQa } from '../src/qa';
import { pickApproved, markUploaded, markFailed, releasePick, blockTitle, blockAuth, deferPick, listReviews, noteAttempt, holdPick, type ReviewRow } from '../src/review/db';
import { youtubeAccessToken } from '../src/publish/youtube';
import { appendUploadLog, holdOf, passingError, readUploadStatus, refusalText, uploadTimes, writePace, writeUploadStatus, type UploadTry } from '../src/publish/uploadStatus';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
/** The posting pace (user, 2026-11-22: change 2 of the censorship review): this many in any 24 hours, this far apart. */
const UPLOADS_PER_DAY = Number(process.env.UPLOADS_PER_DAY ?? 8);
const UPLOAD_MIN = Number(process.env.UPLOAD_MIN ?? 180);
const PACE = { perDay: UPLOADS_PER_DAY, everyMin: UPLOAD_MIN };
const LEAD_MIN = Number(process.env.LEAD_MIN ?? 5);
/** How often a clip held by a passing error is tried again (a YouTube limit is waited out to when it lifts). */
const HOLD_RETRY_MIN = Number(process.env.HOLD_RETRY_MIN ?? process.env.QUOTA_MIN ?? 60);
/** A pause after YouTube refused an upload for good, so a fault that refuses every clip does not set the whole line aside in minutes. */
const REFUSED_PAUSE_MIN = Number(process.env.REFUSED_PAUSE_MIN ?? 20);
const MIN_UPLOAD_S = Number(process.env.MIN_UPLOAD_S ?? 5);
const ONCE = has('--once');
const DRY = has('--dry-run');
const log = (s: string) => console.log(`${new Date().toISOString()}  ${s}`);
/** Audience numbers for what was uploaded: `clip analytics` once a day (YouTube's data lags 2–3 days). */
const ANALYTICS_HOURS = Number(process.env.ANALYTICS_HOURS ?? 24);
const analyticsFile = path.join(paths.cache, 'analytics-last.json');

/** Import YouTube Analytics when the last import is ANALYTICS_HOURS old. A failure is logged and tried at the next interval. */
function analyticsIfDue() {
  if (DRY || !ANALYTICS_HOURS) return;
  const last = readJsonIf<{ at: string }>(analyticsFile)?.at;
  if (last && Date.now() - Date.parse(last) < ANALYTICS_HOURS * 3_600_000) return;
  const r = spawnSync('./clip', ['analytics', '--days', '28'], { cwd: paths.root, encoding: 'utf8', timeout: 15 * 60_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const rows = (out.match(/ views \d+/g) ?? []).length;
  fs.writeFileSync(analyticsFile, JSON.stringify({ at: new Date().toISOString(), ok: r.status === 0, rows }));
  log(r.status === 0 ? `analytics: ${rows} clip${rows === 1 ? '' : 's'} with audience numbers (performance.jsonl)` : `analytics failed: ${out.trim().split('\n').pop()}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

/** The YouTube login is gone (expired, revoked, never made): every upload would fail the same way. */
const AUTH_RE = /YouTube is not connected|token refresh failed|token exchange failed|invalid_grant|expired or revoked|auth youtube/i;
const AUTH_RETRY_MIN = Number(process.env.AUTH_RETRY_MIN ?? 10);

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
  const file = path.join(paths.exports, `${row.clipId}.mp4`);
  if (!fs.existsSync(file)) {
    setAside(row, 'no export');
    return 'next';
  }
  const project = loadProject(row.clipId);
  const report = readJsonIf<{ durationS?: number }>(path.join(paths.exports, `${row.clipId}.json`));
  const qa = loadQa(row.clipId);
  const duration = report?.durationS ?? qa?.durationS ?? 0;
  if (/review clip/i.test(project.title)) {
    blockTitle(row.clipId);
    record({ clipId: row.clipId, try: row.attempts, outcome: 'failed', reason: 'placeholder title (uploads by itself once the title is edited)' });
    log(`held ${row.clipId}: placeholder title`);
    return 'next';
  }
  // YouTube Shorts have no minimum length: 15 s is the editing target, and an approval below it is the
  // reviewer's call (a 13.6 s clip was approved as perfect and then refused here). Over 60 s stays out:
  // YouTube blocks a Short over a minute that gets a Content ID claim. Under MIN_UPLOAD_S is a broken export.
  if (duration < MIN_UPLOAD_S || duration > 60) {
    setAside(row, `duration ${duration.toFixed(1)} s is outside ${MIN_UPLOAD_S}–60 s`);
    return 'next';
  }
  // QA does not hold an approval back (user, 2026-11-22): the reviewer saw its report and approved.
  // What it failed is logged with the try. The credit and the never-post list (below) are the
  // exceptions: the publisher refuses an uncredited export whatever QA says (src/core/channel.ts).
  if (fs.existsSync(path.join(paths.exports, `${row.clipId}.publish.json`)) && !DRY) {
    const rec = readJsonIf<{ url?: string; publishAt?: string }>(path.join(paths.exports, `${row.clipId}.publish.json`));
    markUploaded(row.clipId, { youtubeUrl: rec?.url ?? '', publishAt: rec?.publishAt ?? '' });
    log(`already uploaded ${row.clipId} ${rec?.url ?? ''}`);
    return 'did';
  }
  // The never-post list (src/qa/unsafe.ts; reports/censorship-review-2026-11-22.md) stops an approval:
  // nudity, a slur said, a minor, a sexual title. Checked here, before an upload call is spent; the
  // publisher refuses it too. A title can be fixed in place, so that one is held until it is edited.
  const unsafe = await neverPost(row.clipId, { look: !DRY });
  if (unsafe.some((r) => r.kind !== 'title')) {
    setAside(row, neverPostText(row.clipId, unsafe));
    return 'next';
  }
  if (unsafe.length) {
    blockTitle(row.clipId, `the title sells it on sex (${sexualTitleWords(postFor(project.post, suggestedPost(project)).title).join(', ')}); edit the title and it uploads automatically`);
    record({ clipId: row.clipId, try: row.attempts, outcome: 'failed', reason: unsafe[0].why });
    log(`held ${row.clipId}: ${unsafe[0].why}`);
    return 'next';
  }
  // The careful period (channel.json → careful): only the cleanest approvals go up until it ends; the
  // rest wait for it (`deferred`) instead of being refused. Checked here, before an upload call is spent.
  const until = carefulUntil();
  if (until) {
    const careful = await checkCareful(row.clipId, row.adult ?? qa?.adult?.detected ?? false);
    if (careful.length) {
      const why = `careful period until ${until} (channel.json): ${careful.map((c) => c.why).join('; ')}. It goes up by itself after that`;
      if (!DRY) deferPick(row.clipId, why);
      record({ clipId: row.clipId, try: row.attempts, outcome: 'deferred', reason: why });
      log(`${DRY ? '[dry] ' : ''}deferred ${row.clipId}: ${why}`);
      return 'next';
    }
  }
  const qaFailed = qa && !qa.passed ? qa.issues.filter((i) => i.level === 'fail').map((i) => `${i.check}: ${i.detail}`).join('; ') : '';
  if (qaFailed) log(`${row.clipId}: QA failed (${qaFailed.slice(0, 200)}); uploading it anyway, as approved`);
  const at = isoIn(LEAD_MIN);
  const n = DRY ? row.attempts + 1 : noteAttempt(row.clipId);
  const since = row.uploadStatus === 'held' && row.pickedAt ? `, current since ${row.pickedAt.slice(11, 16)}` : '';
  log(`${DRY ? '[dry] ' : ''}${n > 1 ? 'trying again' : 'picking'} ${row.clipId} (try ${n}${since}) → publishAt ${at}`);
  const r = publish(row.clipId, at);
  if (!r.ok) {
    const error = r.error ?? '';
    const hold = holdOf(error) ?? (passingError(error) && !AUTH_RE.test(error) ? 'error' : null);
    if (hold) {
      // the clip stays the current one; the channel's upload limit, the project's API units and a
      // passing error are told apart in the log and on the review page
      const said = hold === 'error' ? (error.trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? 'error') : refusalText(error);
      if (!DRY) holdPick(row.clipId, said);
      record({ clipId: row.clipId, try: n, outcome: 'held', hold, reason: said });
      const what = hold === 'upload-limit' ? "YouTube refused it (the channel's upload limit)" : hold === 'api-quota' ? "YouTube refused it (the project's API quota)" : 'the upload failed (network or YouTube)';
      // a limit is waited out to when it lifts: each refused call counts against the project's daily uploads
      const now = Date.now();
      nextTryAt =
        hold === 'upload-limit' ? limitLiftsAt(uploadTimes(), now) : hold === 'api-quota' ? pacificMidnightAfter(now) + LIFT_MARGIN_MS : now + HOLD_RETRY_MIN * 60_000;
      const when = hold === 'upload-limit' ? 'a day after the first upload of the last 24 hours' : hold === 'api-quota' ? 'after midnight Pacific, when the quotas reset' : `in ${HOLD_RETRY_MIN}m`;
      log(`held ${row.clipId}: ${what}: ${said}; trying it again at ${iso(nextTryAt)} (${when})`);
      if (!DRY) writeUploadStatus(hold, { reason: said, nextTryAt: iso(nextTryAt), ...(hold === 'error' ? { retryEveryMin: HOLD_RETRY_MIN } : {}) });
      return 'held';
    }
    if (AUTH_RE.test(error)) {
      record({ clipId: row.clipId, try: n, outcome: 'held', hold: 'auth', reason: 'the YouTube login expired or was revoked' });
      blockAuth(row.clipId);
      if (!DRY) writeUploadStatus('auth', { reason: 'the YouTube login expired or was revoked: run ./clip auth youtube', nextTryAt: isoIn(AUTH_RETRY_MIN) });
      log(`held ${row.clipId}: the YouTube login expired or was revoked. Run ./clip auth youtube; uploads resume by themselves.`);
      return 'auth';
    }
    // a refusal retrying cannot fix (bad metadata, an uncredited export): set aside with Retry upload
    setAside({ ...row, attempts: n }, error.trim() ? refusalText(error) : 'upload failed');
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
