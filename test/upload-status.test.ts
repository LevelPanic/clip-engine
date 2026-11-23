// The upload scheduler tells YouTube's two limits apart and records what it is doing for the review
// page (src/publish/uploadStatus.ts).
import { DATA } from './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { holdOf, readUploadStatus, recentUploads, refusalText, writeUploadStatus } from '../src/publish/uploadStatus';

// what `clip publish` printed on 2026-11-20 (the channel's limit), and the API-units refusal
const LIMIT = `Error: YouTube upload init failed (400): {
  "error": {
    "code": 400,
    "message": "The user has exceeded the number of videos they may upload.",
    "errors": [ { "message": "The user has exceeded the number of videos they may upload.", "domain": "youtube.video", "reason": "uploadLimitExceeded" } ]
  }
}`;
const UNITS = `Error: YouTube upload init failed (403): {"error":{"code":403,"message":"The request cannot be completed because you have exceeded your quota.","errors":[{"message":"The request cannot be completed because you have exceeded your quota.","domain":"youtube.quota","reason":"quotaExceeded"}]}}`;
// 2026-11-21 00:38 UTC, after 26 refused tries in one Pacific day: the project's daily upload calls
const UPLOADS = `Error: YouTube upload init failed (403): {"error":{"code":403,"message":"Quota exceeded for quota metric 'Video Uploads' and limit 'Video Uploads per day' of service 'youtube.googleapis.com' for consumer 'project_number:1'.","errors":[{"message":"Quota exceeded for quota metric 'Video Uploads' and limit 'Video Uploads per day' of service 'youtube.googleapis.com' for consumer 'project_number:1'.","domain":"global","reason":"rateLimitExceeded"}]}}`;

test("the channel's upload limit and the project's API quota are different holds", () => {
  assert.equal(holdOf(LIMIT), 'upload-limit');
  assert.equal(holdOf(UNITS), 'api-quota');
  assert.equal(holdOf(UPLOADS), 'api-quota');
  assert.match(refusalText(UPLOADS), /^rateLimitExceeded: Quota exceeded for quota metric 'Video Uploads'/);
  assert.equal(holdOf('YouTube upload failed (500): backend error'), null);
  assert.equal(refusalText(LIMIT), 'uploadLimitExceeded: The user has exceeded the number of videos they may upload.');
  assert.match(refusalText(UNITS), /^quotaExceeded: The request cannot be completed/);
});

test('the status keeps when a hold began across hourly retries, and resets when uploads flow again', () => {
  const first = writeUploadStatus('upload-limit', { reason: 'r', nextTryAt: '2026-11-20T12:18:00Z' }, new Date('2026-11-20T11:18:00Z'));
  const again = writeUploadStatus('upload-limit', { reason: 'r', nextTryAt: '2026-11-20T13:18:00Z', retryEveryMin: 60 }, new Date('2026-11-20T12:18:00Z'));
  assert.equal(again.since, first.since);
  assert.equal(readUploadStatus()?.retryEveryMin, 60);
  assert.equal(readUploadStatus()?.nextTryAt, '2026-11-20T13:18:00Z');
  const ok = writeUploadStatus('ok', {}, new Date('2026-11-21T01:05:00Z'));
  assert.equal(ok.since, '2026-11-21T01:05:00.000Z');
  assert.equal(ok.reason, undefined);
});

test('uploads in the last 24 hours come from the publish records', () => {
  const ex = path.join(DATA, 'exports');
  fs.mkdirSync(ex, { recursive: true });
  const rec = (id: string, at: string) => fs.writeFileSync(path.join(ex, `${id}.publish.json`), JSON.stringify({ clipId: id, at }));
  rec('a', '2026-11-19T10:20:08Z'); // over a day before
  rec('b', '2026-11-20T01:05:03Z');
  rec('c', '2026-11-20T04:05:47Z');
  fs.writeFileSync(path.join(ex, 'c.json'), '{}'); // not a publish record
  assert.deepEqual(recentUploads(Date.parse('2026-11-20T16:25:00Z')), ['2026-11-20T01:05:03Z', '2026-11-20T04:05:47Z']);
});

test('the scheduler stays on one clip until it uploads; then it moves to the next approval', async () => {
  const { recordReview, pickApproved, noteAttempt, holdPick, markUploaded, listReviews } = await import('../src/review/db');
  const approve = (clipId: string, at: string) => recordReview({ clipId, videoId: 'tw-1', title: clipId, status: 'approved', at });
  approve('q-old', '2026-11-20T11:18:00Z');
  approve('q-new', '2026-11-20T11:19:00Z');
  const first = pickApproved()!;
  assert.equal(first.clipId, 'q-old');
  assert.equal(noteAttempt('q-old'), 1);
  holdPick('q-old', 'uploadLimitExceeded: The user has exceeded the number of videos they may upload.');
  // twenty minutes later, and after a restart: the same clip, not the next one
  assert.equal(pickApproved()!.clipId, 'q-old');
  assert.equal(noteAttempt('q-old'), 2);
  // a restart while a try was running: still the same clip (the publish record decides if it went up)
  assert.equal(pickApproved()!.clipId, 'q-old');
  const row = listReviews().find((r) => r.clipId === 'q-old')!;
  assert.equal(row.attempts, 2);
  assert.equal(row.picked, 1);
  markUploaded('q-old', { youtubeUrl: 'https://youtu.be/x', publishAt: '2026-11-21T01:10:00Z' });
  assert.equal(listReviews().find((r) => r.clipId === 'q-old')!.lastError, null);
  assert.equal(pickApproved()!.clipId, 'q-new');
});

test('an approval taken back while it is the current clip stops holding the line', async () => {
  const { recordReview, pickApproved, holdPick, markUploaded } = await import('../src/review/db');
  recordReview({ clipId: 'r-a', videoId: 'tw-2', title: 'a', status: 'approved', at: '2026-11-20T12:00:00Z' });
  recordReview({ clipId: 'r-b', videoId: 'tw-2', title: 'b', status: 'approved', at: '2026-11-20T12:01:00Z' });
  // finish whatever an earlier test left current
  for (let c = pickApproved(); c && c.clipId !== 'r-a'; c = pickApproved()) markUploaded(c.clipId, { youtubeUrl: '', publishAt: '' });
  holdPick('r-a', 'held');
  recordReview({ clipId: 'r-a', videoId: 'tw-2', title: 'a', status: 'changes', at: '2026-11-20T12:30:00Z' });
  assert.equal(pickApproved()!.clipId, 'r-b');
});

test('the attempt log keeps every try, newest first when read', async () => {
  const { appendUploadLog, readUploadLog, passingError } = await import('../src/publish/uploadStatus');
  appendUploadLog({ at: '2026-11-20T16:28:44Z', clipId: 'c1', try: 1, outcome: 'held', hold: 'upload-limit', reason: 'uploadLimitExceeded' });
  appendUploadLog({ at: '2026-11-20T16:48:44Z', clipId: 'c1', try: 2, outcome: 'held', hold: 'upload-limit', reason: 'uploadLimitExceeded' });
  appendUploadLog({ at: '2026-11-21T01:08:44Z', clipId: 'c1', try: 27, outcome: 'uploaded', url: 'https://youtu.be/x' });
  assert.deepEqual(readUploadLog(2).map((t) => t.try), [27, 2]);
  assert.equal(readUploadLog().length, 3);
  assert.ok(passingError('TypeError: fetch failed'));
  assert.ok(passingError('YouTube upload failed (503): backend error'));
  assert.ok(passingError('timed out (killed by SIGTERM)\nuploading 4.2 MB'));
  assert.ok(!passingError('YouTube upload init failed (400): invalid title'));
});
