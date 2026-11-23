// The tracker (src/track/db.ts): streams, their moments, what is done and what is next.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { upsertStream, upsertMoments, setMomentStatus, setStreamStatus, listMoments, nextMoments, getStream, wrongStream } = await import('../src/track/db');
const { momentWindow } = await import('../src/scan/moments');

const MIN = 60_000;
const moment = (videoId: string, at: number, views: number) => ({
  id: `moment@${at}`,
  peakMs: at * MIN,
  fromMs: at * MIN - 20_000,
  toMs: at * MIN + 20_000,
  views,
  clips: 1,
  clippers: 1,
  laughers: 0,
  titles: [`clip at ${at}`],
  score: views,
  why: [`${views} views`],
  window: { startMs: at * MIN - 80_000, endMs: at * MIN + 65_000 },
});
const stream = (videoId: string, creator: string) =>
  upsertStream({ videoId, platform: 'twitch', creator, login: creator.toLowerCase(), title: `${creator} stream`, game: 'Grand Theft Auto VI', source: `creator:${creator}`, live: true, startedAt: '2026-11-18T10:00:00Z', durationMs: 5 * 60 * MIN });

test("each stream's best moment comes before anyone's second, biggest first within a round", () => {
  stream('tw-1', 'Ohne');
  stream('tw-2', 'Kai');
  upsertMoments('tw-1', [moment('tw-1', 354, 238_000), moment('tw-1', 294, 15_800), moment('tw-1', 216, 12_000)]);
  upsertMoments('tw-2', [moment('tw-2', 173, 5400), moment('tw-2', 31, 4700)]);
  const next = nextMoments(4);
  assert.deepEqual(next.map((m) => `${m.videoId} ${m.views}`), ['tw-1 238000', 'tw-2 5400', 'tw-1 15800', 'tw-2 4700']);
});

test('a moment worked on stays as it is when it is ranked again; new views only update the numbers', () => {
  setMomentStatus('tw-1', 'moment@354', 'clipped', { clipIds: ['tw-1-c01'], note: 'full pipeline: 1 review clip' });
  upsertMoments('tw-1', [{ ...moment('tw-1', 354, 300_000) }]);
  const m = listMoments({ videoId: 'tw-1' }).find((x) => x.momentId === 'moment@354')!;
  assert.equal(m.status, 'clipped');
  assert.equal(m.views, 300_000);
  assert.deepEqual(m.clipIds, ['tw-1-c01']);
  // and it no longer counts as waiting: tw-2 leads now, and tw-1's done moment uses up one of its slots
  assert.deepEqual(nextMoments(2).map((m) => `${m.videoId} ${m.views}`), ['tw-2 5400', 'tw-1 15800']);
});

test('a stream gives at most its share of moments', () => {
  stream('tw-3', 'Big');
  upsertMoments('tw-3', Array.from({ length: 6 }, (_, i) => moment('tw-3', 10 + i * 10, 1000 - i)));
  for (const m of ['moment@10', 'moment@20', 'moment@30']) setMomentStatus('tw-3', m, 'no-clip');
  const fromBig = nextMoments(20, 4).filter((m) => m.videoId === 'tw-3');
  assert.equal(fromBig.length, 1, 'three were worked on already; one more is allowed');
});

test('a skipped stream gives nothing, and the reason is kept', () => {
  stream('tw-4', 'Tester');
  upsertMoments('tw-4', [moment('tw-4', 5, 99_999)]);
  setStreamStatus('tw-4', 'skipped', 'a test stream');
  assert.equal(getStream('tw-4')?.skipReason, 'a test stream');
  assert.ok(!nextMoments(20).some((m) => m.videoId === 'tw-4'));
  // refreshing the stream (the next check) does not undo the skip
  stream('tw-4', 'Tester');
  assert.equal(getStream('tw-4')?.status, 'skipped');
});

test('a moment in a chapter we never clip is recorded as skipped, with why', () => {
  stream('tw-5', 'Gambler');
  upsertMoments('tw-5', [{ ...moment('tw-5', 40, 50_000), skip: 'a Slots chapter: never clipped' }]);
  const m = listMoments({ videoId: 'tw-5' })[0];
  assert.equal(m.status, 'skipped');
  assert.equal(m.note, 'a Slots chapter: never clipped');
  assert.ok(!nextMoments(20).some((x) => x.videoId === 'tw-5'));
});

test('wrong content is caught from what the stream says about itself', () => {
  assert.equal(wrongStream({ title: "Test stream, don't tune in", durationMs: 40 * MIN, live: false }), 'a test stream');
  assert.equal(wrongStream({ title: 'Official HappyHappyGal VOD Channel ❤️', durationMs: 5 * 60 * MIN, live: true, login: 'happyhappygal_vod' }), 'a rerun or a VOD replay');
  assert.equal(wrongStream({ title: 'gm', durationMs: 12 * MIN, live: false }), 'ended under 20 minutes');
  assert.equal(wrongStream({ title: '🔴 GTA 6 EARLY ACCESS 🔴 24/7 MARATHON', durationMs: 7 * 60 * MIN, live: true }), undefined, 'a marathon is not a rerun');
  assert.equal(wrongStream({ title: 'short and live', durationMs: 5 * MIN, live: true }), undefined, 'a live stream that just started is fine');
});

test('a stream added by hand goes first, then the listed creators, then the topics', () => {
  const t = (videoId: string, creator: string, source: string) =>
    upsertStream({ videoId, platform: 'twitch', creator, login: creator.toLowerCase(), title: `${creator} stream`, game: 'Grand Theft Auto VI', source, live: true, startedAt: '2026-11-18T10:00:00Z', durationMs: 5 * 60 * MIN });
  t('tw-10', 'BigTopic', 'topic:GTA 6');
  t('tw-11', 'Listed', 'creator:Listed');
  t('tw-12', 'AskedFor', 'manual');
  upsertMoments('tw-10', [moment('tw-10', 20, 900_000)]);
  upsertMoments('tw-11', [moment('tw-11', 20, 300), moment('tw-11', 40, 200)]);
  upsertMoments('tw-12', [moment('tw-12', 20, 60), moment('tw-12', 40, 55)]);
  const order = nextMoments(50).map((m) => m.videoId).filter((v) => ['tw-10', 'tw-11', 'tw-12'].includes(v));
  assert.deepEqual(order, ['tw-12', 'tw-12', 'tw-11', 'tw-11', 'tw-10'], 'a 900k-view topic moment still waits for the listed creator');
});

test('asking for a stream by hand sticks: a creator or topic check does not demote it, a topic does not demote a creator', () => {
  const t = (videoId: string, source: string) =>
    upsertStream({ videoId, platform: 'twitch', creator: 'X', login: 'x', title: 'x', game: null, source, live: true, startedAt: null, durationMs: 60 * MIN });
  t('tw-20', 'creator:X');
  t('tw-20', 'manual');
  assert.equal(getStream('tw-20')?.source, 'manual', 'a listed creator\'s stream can be asked for');
  t('tw-20', 'creator:X');
  t('tw-20', 'topic:GTA 6');
  assert.equal(getStream('tw-20')?.source, 'manual');
  t('tw-21', 'creator:Y');
  t('tw-21', 'topic:GTA 6');
  assert.equal(getStream('tw-21')?.source, 'creator:Y');
});

test('a stream found by a creator check and two topics is one record with three sources; the creator sets its tier', () => {
  const t = (source: string) =>
    upsertStream({ videoId: 'tw-30', platform: 'twitch', creator: 'Nick', login: 'nick', title: 'GTA', game: null, source, live: true, startedAt: null, durationMs: 60 * MIN });
  t('topic:GTA 6');
  t('creator:Nickmercs');
  t('topic:GTA 5 RP');
  const s = getStream('tw-30')!;
  assert.equal(s.source, 'creator:Nickmercs');
  assert.deepEqual([...s.sources].sort(), ['creator:Nickmercs', 'topic:GTA 5 RP', 'topic:GTA 6']);
});

test('a re-rank whose peak moved keeps one row with the new bounds; a moment inside a worked window is covered', () => {
  stream('tw-40', 'Mover');
  upsertMoments('tw-40', [moment('tw-40', 100, 500)]);
  const moved = { ...moment('tw-40', 100, 900), id: 'moment@shifted', peakMs: 100 * MIN + 20_000, fromMs: 100 * MIN, toMs: 100 * MIN + 40_000 };
  upsertMoments('tw-40', [{ ...moved, window: momentWindow(moved, 10 * 60 * MIN) }]);
  const rows = listMoments({ videoId: 'tw-40' });
  assert.equal(rows.length, 1, 'no second row for the same seconds');
  assert.equal(rows[0].momentId, 'moment@100');
  assert.equal(rows[0].peakMs, 100 * MIN + 20_000);
  assert.equal(rows[0].views, 900);
  setMomentStatus('tw-40', 'moment@100', 'no-clip');
  const nearby = { ...moment('tw-40', 101, 200), peakMs: 101 * MIN + 20_000, fromMs: 101 * MIN, toMs: 101 * MIN + 40_000 }; // the worked window runs to 101:25
  upsertMoments('tw-40', [{ ...nearby, window: momentWindow(nearby, 10 * 60 * MIN) }]);
  const n = listMoments({ videoId: 'tw-40' }).find((m) => m.momentId === 'moment@101')!;
  assert.equal(n.status, 'covered');
  assert.equal(n.coveredBy, 'moment@100');
  assert.ok(!nextMoments(50).some((m) => m.videoId === 'tw-40'));
});

test('MOMENT_RANKER=alternate orders a stream by the shadow rank', () => {
  stream('tw-41', 'Shadow');
  upsertMoments('tw-41', [{ ...moment('tw-41', 10, 900), altRank: 2, rank: 1 }, { ...moment('tw-41', 50, 100), altRank: 1, rank: 2 }]);
  const first = () => nextMoments(50).find((m) => m.videoId === 'tw-41')!.momentId;
  assert.equal(first(), 'moment@10');
  process.env.MOMENT_RANKER = 'alternate';
  try {
    assert.equal(first(), 'moment@50');
  } finally {
    delete process.env.MOMENT_RANKER;
  }
});

test('blind trial: each arm picks only its own moments; the arms take turns; the tally counts per job', async () => {
  const { inArm, nextArm } = await import('../src/track/db');
  const { trialSummary } = await import('../src/track/trial');
  assert.ok(inArm({ rank: 2, altRank: 9 }, 'score'));
  assert.ok(inArm({ rank: 9, altRank: 2 }, 'alternate'));
  assert.ok(inArm({ rank: 1, altRank: 1 }, 'both'));
  assert.ok(!inArm({ rank: 7, altRank: 8 }, 'score') && !inArm({ rank: 7, altRank: 8 }, 'alternate') && !inArm({ rank: 7, altRank: 8 }, 'both'));
  assert.equal(nextArm({}), 'score');
  assert.equal(nextArm({ score: 3, alternate: 2, both: 2 }), 'alternate');
  assert.equal(nextArm({ score: 0, alternate: 5, both: 9 }, ['alternate', 'both']), 'alternate', 'only the arms that have a moment waiting');
  stream('tw-50', 'Trial');
  upsertMoments('tw-50', [
    { ...moment('tw-50', 10, 900), rank: 1, altRank: 1 },
    { ...moment('tw-50', 20, 800), rank: 2, altRank: 7 },
    { ...moment('tw-50', 30, 100), rank: 9, altRank: 2 },
  ]);
  const pick = (arm: 'score' | 'alternate' | 'both') => nextMoments(50, 4, arm).find((m) => m.videoId === 'tw-50')?.momentId;
  assert.equal(pick('both'), 'moment@10');
  assert.equal(pick('score'), 'moment@20');
  assert.equal(pick('alternate'), 'moment@30');
  const decided = new Map([['a1', 'approved'], ['s1', 'rejected']]);
  const rows = trialSummary([
    { arm: 'alternate', state: 'done', clipIds: ['a1'] },
    { arm: 'alternate', state: 'done', clipIds: [] },
    { arm: 'score', state: 'done', clipIds: ['s1'] },
    { arm: 'score', state: 'running', clipIds: [] },
    { arm: 'score', state: 'done', clipIds: [], result: 'subscriber-only; skipped' },
    { arm: 'alternate', state: 'failed', clipIds: [], result: 'judge failed' },
    { state: 'done', clipIds: ['x'] },
  ], decided);
  assert.deepEqual(rows.map((r) => [r.arm, r.jobs, r.finished, r.approved, r.rejected, r.noClip, r.void]), [['score', 3, 1, 0, 1, 0, 1], ['alternate', 3, 2, 1, 0, 1, 1]], 'an unreadable or failed job is void, not a "no clip"');
});
