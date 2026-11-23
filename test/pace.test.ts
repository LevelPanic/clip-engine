// Change 2 of docs/research/censorship-review-2026-11-22.md (user, 2026-11-22): the uploader posts at most 8 in
// any 24 hours, 3 hours apart, never more than YouTube's limit let through the last time it said no, and
// waits a limit out to when it lifts instead of trying every hour (C4, src/publish/pace.ts). While
// channel.json has a careful period, an approval with a sexual flag, an 18+ tick or an f-word in its
// first 3 s waits for it to end (C5, src/qa/unsafe.ts).
import { DATA } from './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../src/core/schemas';

const { paceAt, limitLiftsAt, pacificMidnightAfter, paceNow, LIFT_MARGIN_MS, UNKNOWN_LIFT_MS } = await import('../src/publish/pace');
const { openSwears, carefulReasons, checkCareful } = await import('../src/qa/unsafe');
const { carefulUntil, ChannelSchema } = await import('../src/core/channel');
const { defaultCaptions, defaultFraming } = await import('../src/core/schemas');
const { saveProject } = await import('../src/project');
const { writeJson, paths } = await import('../src/core/paths');

const H = 3_600_000;
const NOW = Date.parse('2026-11-22T18:00:00Z');
const RULE = { perDay: 8, everyMin: 180 };
const ago = (h: number) => NOW - h * H;

test('pace: nothing uploaded goes now; the next waits 3 hours after the last', () => {
  assert.equal(paceAt({ ...RULE, uploads: [], limitRefusals: [], now: NOW }).nextAt, NOW);
  const p = paceAt({ ...RULE, uploads: [ago(30), ago(1)], limitRefusals: [], now: NOW });
  assert.equal(p.nextAt, ago(1) + 3 * H);
  assert.equal(p.waitsFor, 'spacing');
  assert.equal(p.inDay, 1, 'the one 30 hours ago is outside the day');
  assert.equal(paceAt({ ...RULE, uploads: [ago(4)], limitRefusals: [], now: NOW }).waitsFor, undefined, '4 hours later it may go');
});

test('pace: the eighth upload in 24 hours closes the day until the oldest of them is a day old', () => {
  const eight = [22, 19, 16, 13, 10, 7, 5, 4].map(ago);
  const p = paceAt({ ...RULE, uploads: eight, limitRefusals: [], now: NOW });
  assert.equal(p.inDay, 8);
  assert.equal(p.nextAt, ago(22) + 24 * H, 'at 20:00, two hours from now');
  assert.equal(p.waitsFor, 'cap');
  // uploads by hand count too: with 10 in the day, three must age out
  const ten = [23, 22, 21, 19, 16, 13, 10, 7, 5, 4].map(ago);
  assert.equal(paceAt({ ...RULE, uploads: ten, limitRefusals: [], now: NOW }).nextAt, ago(21) + 24 * H);
});

test("pace: never above what YouTube's limit let through the last time it said no, for two days", () => {
  // five went up, then the channel's limit refused the sixth (10 hours ago)
  const five = [30, 26, 22, 18, 14].map(ago);
  const p = paceAt({ ...RULE, uploads: five, limitRefusals: [ago(10)], now: NOW });
  assert.equal(p.cap, 5);
  assert.deepEqual(p.allowance, { allowed: 5, refusedAt: ago(10) });
  // three of the five are in today's 24 hours: under the lowered cap of 5, it may go
  assert.equal(p.inDay, 3);
  assert.equal(paceAt({ ...RULE, uploads: [...five, ago(6), ago(3.5)], limitRefusals: [ago(10)], now: NOW }).waitsFor, 'cap');
  // when it let 10 through (2026-11-19), our own 8 is lower anyway; a refusal three days old is forgotten
  const ten = Array.from({ length: 10 }, (_, i) => ago(70 - i * 2));
  assert.equal(paceAt({ ...RULE, uploads: ten, limitRefusals: [ago(50)], now: NOW }).cap, 8);
  assert.equal(paceAt({ ...RULE, uploads: five.map((t) => t - 60 * H), limitRefusals: [ago(75)], now: NOW }).cap, 8);
  // a refusal with nothing uploaded before it says nothing about the limit (and must not stop every upload)
  assert.equal(paceAt({ ...RULE, uploads: [], limitRefusals: [ago(2)], now: NOW }).cap, 8);
});

test("the channel's limit is waited out to a day after the first upload of the last 24 hours, not tried hourly", () => {
  assert.equal(limitLiftsAt([ago(30), ago(20), ago(12), ago(2)], NOW), ago(20) + 24 * H + LIFT_MARGIN_MS, 'at 22:10, four hours from now');
  assert.equal(limitLiftsAt([ago(30)], NOW), NOW + UNKNOWN_LIFT_MS, 'nothing in the day to count from: six hours');
});

test("the project's quotas reset at midnight Pacific, summer time or not", () => {
  assert.equal(new Date(pacificMidnightAfter(Date.parse('2026-11-22T12:00:00Z'))).toISOString(), '2026-11-23T08:00:00.000Z');
  assert.equal(new Date(pacificMidnightAfter(Date.parse('2026-11-23T07:59:59Z'))).toISOString(), '2026-11-23T08:00:00.000Z');
  assert.equal(new Date(pacificMidnightAfter(Date.parse('2026-07-01T06:30:00Z'))).toISOString(), '2026-07-01T07:00:00.000Z');
});

test('pace from the records: publish records are the uploads, the log has the refusals', () => {
  fs.mkdirSync(paths.exports, { recursive: true });
  const now = Date.now();
  writeJson(path.join(paths.exports, 'pa1.publish.json'), { platform: 'youtube', clipId: 'pa1', at: new Date(now - 1 * H).toISOString() });
  writeJson(path.join(paths.exports, 'pa2.publish.json'), { platform: 'youtube', clipId: 'pa2', at: new Date(now - 26 * H).toISOString() });
  const p = paceNow(RULE, now);
  assert.equal(p.inDay, 1);
  assert.equal(p.nextAt, now - H + 3 * H);
  fs.rmSync(path.join(paths.exports, 'pa1.publish.json'));
  fs.rmSync(path.join(paths.exports, 'pa2.publish.json'));
});

test('careful: an f-word heard in the first 3 s (a caption fix does not mute it), a sexual flag from one expert, an 18+ tick', () => {
  const w = (raw: string, s: number) => ({ raw, atMs: s * 1000 });
  assert.deepEqual(openSwears([w('what', 0.2), w('the', 0.6), w('FUCK!', 1.1), w('fucking', 3.4)]), [{ word: 'FUCK', atMs: 1100 }]);
  assert.deepEqual(openSwears([w('fun', 0.5), w('fuchsia', 1), w('shit', 1.5)]), [], 'not the f-word');
  const r = carefulReasons({ sexual: ['meme'], adult: true, swears: [{ word: 'fucking', atMs: 1100 }] });
  assert.deepEqual(r.map((x) => x.kind), ['sexual', 'adult', 'swear-open']);
  assert.match(r[2].why, /^an f-word in the first 3 s \("f\*+" at 0:01\): `clip censor` bleeps it$/);
  assert.deepEqual(carefulReasons({ sexual: [], adult: false, swears: [] }), []);
});

test('careful: a clip in the sandbox, from its words and the experts’ ledger', async () => {
  const VID = 'tw-careful';
  const words = ['oh', 'fuck', 'no', 'the', 'car', 'flipped'].map((text, i) => ({ i, text, startMs: 100_500 + i * 1000, endMs: 100_500 + i * 1000 + 800 }));
  writeJson(paths.videoFile(VID, 'transcript.json'), { videoId: VID, source: 'whisper', lang: 'en', words, tags: [] });
  writeJson(paths.videoFile(VID, 'queue-review.json'), { videoId: VID, updatedAt: '', verdicts: [{ queueId: 'meme@1:45', kind: 'meme', verdict: 'confirm', risks: ['sexual'], momentMs: 105_000 }] });
  const project: Project = { version: 1, rev: 0, id: 'cf1', videoId: VID, title: 'T', sourceDurationMs: 600_000, fps: 30, segments: [{ startMs: 100_000, endMs: 120_000 }], markers: [], captions: { ...defaultCaptions(), enabled: true, fixes: { '1': 'f***' } }, framing: defaultFraming(), createdAt: '', updatedAt: '', post: { title: 'Lirik flips the car' } };
  saveProject(project);
  assert.deepEqual((await checkCareful('cf1', false)).map((r) => r.kind), ['sexual', 'swear-open'], 'one expert’s flag is enough here (it takes two to refuse)');
  // cut the open: the f-word is gone from what plays
  saveProject({ ...project, segments: [{ startMs: 102_000, endMs: 120_000 }] });
  assert.deepEqual((await checkCareful('cf1', false)).map((r) => r.kind), ['sexual']);
  assert.ok(fs.existsSync(path.join(DATA, 'clips', 'cf1')));
});

test('careful: on until its date, off after it, off when channel.json has none', () => {
  const ch = ChannelSchema.parse({ careful: { until: '2026-12-06', why: 'two videos removed' } });
  assert.equal(carefulUntil(ch, Date.parse('2026-11-22T18:00:00Z')), '2026-12-06');
  assert.equal(carefulUntil(ch, Date.parse('2026-12-06T00:00:01Z')), undefined);
  assert.equal(carefulUntil(ChannelSchema.parse({}), NOW), undefined);
});

test('a deferred approval leaves the line without being a failure, and goes back in when released', async () => {
  const { recordReview, pickApproved, deferPick, releasePick, listReviews } = await import('../src/review/db');
  const at = (m: number) => new Date(Date.parse('2026-11-22T10:00:00Z') + m * 60_000).toISOString();
  recordReview({ clipId: 'cf-a', videoId: 'v', title: 'a', status: 'approved', at: at(0) });
  recordReview({ clipId: 'cf-b', videoId: 'v', title: 'b', status: 'approved', at: at(1) });
  const first = pickApproved()!;
  assert.equal(first.clipId, 'cf-a');
  deferPick('cf-a', 'careful period until 2026-12-06 (channel.json): it is 18+');
  const row = listReviews('approved').find((r) => r.clipId === 'cf-a')!;
  assert.equal(row.uploadStatus, 'deferred');
  assert.match(row.note ?? '', /\[gate\] careful period until 2026-12-06/);
  assert.equal(pickApproved()!.clipId, 'cf-b', 'the next approval goes; the deferred one is not the current clip');
  releasePick('cf-a');
  assert.equal(listReviews('approved').find((r) => r.clipId === 'cf-a')!.uploadStatus, 'pending');
});
