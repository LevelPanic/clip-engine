// Moments first (src/scan/moments.ts): where in a stream the community says the moments are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alternateOrder, clipMoments, duplicatesOf, laughLevels, laughMoments, mergeMoments, momentWindow, overBar, planMoments, rankMoments, sameMoment, MIN_LAUGHERS, MIN_VIEWS, type KnownMoment, type Moment, type RankedMoment } from '../src/scan/moments';
import type { ChatMessage, ViewerClip } from '../src/ingest/twitch';

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const clip = (o: Partial<ViewerClip> & { offsetMs: number; views: number }): ViewerClip => ({
  slug: `s${o.offsetMs}-${o.views}`,
  title: 'clip',
  durationMs: 30 * S,
  createdAt: '2026-11-18T00:00:00Z',
  exact: true,
  curator: `u${o.offsetMs}`,
  ...o,
});

test('clips over the same seconds are one moment; their views add up and two clippers count', () => {
  const ms = clipMoments([
    clip({ offsetMs: 5 * H + 54 * MIN + 33 * S, views: 120_110, title: 'strip club private dance', curator: 'a' }),
    clip({ offsetMs: 5 * H + 54 * MIN + 8 * S, views: 12_509, title: 'WHAT?!', curator: 'b' }),
    clip({ offsetMs: 3 * H + 36 * MIN, views: 4549, title: 'neuron activation' }),
  ]);
  assert.equal(ms.length, 2);
  const big = ms.find((m) => m.views > 100_000)!;
  assert.equal(big.views, 132_619);
  assert.equal(big.clippers, 2);
  assert.equal(big.peakMs, 5 * H + 54 * MIN + 33 * S, 'the most-viewed clip places the moment');
  assert.ok(big.toMs - big.fromMs <= 120 * S, 'a region, not a segment');
  assert.equal(big.titles[0], 'strip club private dance');
});

const chat = (at: number, who: string, text: string): ChatMessage => [at, who, text];

test('a burst of different people laughing is a moment placed before the spike', () => {
  const msgs: ChatMessage[] = [];
  // a normal hum: one laugh a minute
  for (let t = 0; t < 30 * MIN; t += MIN) msgs.push(chat(t, `hum${t}`, 'lol'));
  // 9 different people laughing at 20:10–20:16, one person spamming laughs, a bot
  for (let i = 0; i < 9; i++) msgs.push(chat(20 * MIN + 10 * S + i * 700, `fan${i}`, i % 2 ? 'KEKW' : 'LMAO 😭'));
  for (let i = 0; i < 6; i++) msgs.push(chat(20 * MIN + 11 * S + i * 300, 'spammer', 'lol'));
  msgs.push(chat(20 * MIN + 12 * S, 'nightbot', 'lol'));
  const levels = laughLevels(msgs, [{ startMs: 0, endMs: 30 * MIN }], 30 * MIN);
  const ms = laughMoments(levels, 30 * MIN);
  assert.equal(ms.length, 1);
  assert.equal(ms[0].laughers, 10, 'nine fans and one spammer, the bot not counted');
  assert.ok(ms[0].peakMs < 20 * MIN + 10 * S && ms[0].peakMs > 19 * MIN + 50 * S, `chat trails: the moment is before the spike (${ms[0].peakMs / 1000} s)`);
});

test('unknown chat is not quiet: no moment where chat was not fetched', () => {
  const msgs = Array.from({ length: 12 }, (_, i) => chat(20 * MIN + i * 500, `p${i}`, 'LMAO'));
  const levels = laughLevels(msgs, [{ startMs: 0, endMs: 10 * MIN }], 30 * MIN);
  assert.equal(laughMoments(levels, 30 * MIN).length, 0);
  assert.ok(Number.isNaN(levels[Math.floor((20 * MIN) / (5 * S))]));
});

test('a clip moment and a chat moment on the same seconds become one, with both kinds of evidence', () => {
  const c = clipMoments([clip({ offsetMs: 10 * MIN, views: 300 })]);
  const l = [{ ...c[0], id: 'x', peakMs: 10 * MIN - 5 * S, fromMs: 10 * MIN - 30 * S, toMs: 10 * MIN + 10 * S, views: 0, clippers: 0, clips: 0, laughers: 8, titles: [], score: 96, why: ['8 laughing'] }];
  const m = mergeMoments(c, l);
  assert.equal(m.length, 1);
  assert.equal(m[0].views, 300);
  assert.equal(m[0].laughers, 8);
  assert.equal(m[0].why.length, 2);
});

test('the bar: views, two clippers or real laughter; one quiet clip is not a moment', () => {
  assert.equal(overBar({ views: MIN_VIEWS, clippers: 1, laughers: 0 }), true);
  assert.equal(overBar({ views: 7, clippers: 2, laughers: 0 }), true, 'two people clipped the same seconds');
  assert.equal(overBar({ views: 0, clippers: 0, laughers: MIN_LAUGHERS }), true);
  assert.equal(overBar({ views: 5, clippers: 1, laughers: 2 }), false);
});

test('ranking: best first, nothing under the bar, nothing past the live edge, nothing already scanned', () => {
  const clips = [
    clip({ offsetMs: 1 * H, views: 840 }),
    clip({ offsetMs: 2 * H, views: 120 }),
    clip({ offsetMs: 3 * H, views: 3 }), // under the bar
    clip({ offsetMs: 4 * H + 58 * MIN, views: 900 }), // still past the live edge
  ];
  const ranked = rankMoments({ clips, durationMs: 5 * H, liveEdgeMs: 4 * H + 57 * MIN });
  assert.deepEqual(ranked.map((m) => m.views), [840, 120]);
  // the hour-one moment was scanned already (by a creator check, a topic or by hand)
  const after = rankMoments({ clips, durationMs: 5 * H, done: [{ startMs: 1 * H - 2 * MIN, endMs: 1 * H + 2 * MIN }] });
  assert.deepEqual(after.map((m) => m.views), [900, 120]);
  // a stream with nothing over the bar gives nothing: a bar, not a quota
  assert.deepEqual(rankMoments({ clips: [clip({ offsetMs: H, views: 4 })], durationMs: 5 * H }), []);
});

test('the job scans the region with a minute before and 45 s after, inside the broadcast', () => {
  assert.deepEqual(momentWindow({ fromMs: 30 * S, toMs: 90 * S }, 2 * H), { startMs: 0, endMs: 135 * S });
  assert.deepEqual(momentWindow({ fromMs: 2 * H - 30 * S, toMs: 2 * H }, 2 * H), { startMs: 2 * H - 90 * S, endMs: 2 * H });
});

// --- identity and the shadow ranker ---------------------------------------------------------------
const mo = (peakS: number, o: Partial<Moment> = {}): Moment => ({ id: `moment@${peakS}`, peakMs: peakS * S, fromMs: (peakS - 20) * S, toMs: (peakS + 20) * S, views: 0, clips: 0, clippers: 0, laughers: 0, titles: [], score: 0, why: [], ...o });
const ranked = (m: Moment, skip?: string): RankedMoment => ({ ...m, window: momentWindow(m, 10 * H), ...(skip ? { skip } : {}) });
const known = (m: Moment, status: string, note: string | null = null): KnownMoment => ({ momentId: m.id, peakMs: m.peakMs, fromMs: m.fromMs, toMs: m.toMs, windowFromMs: m.fromMs - 60 * S, windowToMs: m.toMs + 45 * S, score: m.score, status, note });

test('a moment is a region: a peak that moved 20 s, or regions half overlapping, are the same moment', () => {
  assert.ok(sameMoment(mo(1000), mo(1020)));
  assert.ok(sameMoment(mo(1000), { peakMs: 1100 * S, fromMs: 990 * S, toMs: 1110 * S }), 'half of the shorter region overlaps');
  assert.ok(!sameMoment(mo(1000), mo(1100)));
});

test('a re-ranked moment keeps its row: a waiting one takes the new bounds, a worked one only the numbers', () => {
  const waiting = mo(1000, { score: 500 });
  const worked = mo(5000, { id: 'moment@5000', score: 900 });
  const plan = planMoments([known(waiting, 'pending'), known(worked, 'clipped')], [ranked(mo(1020, { id: 'moment@1020', score: 800 })), ranked(mo(5015, { id: 'moment@5015', score: 1200 }))]);
  assert.deepEqual(plan.insert, [], 'no second row for either');
  assert.deepEqual(plan.update.map((u) => [u.momentId, u.bounds]).sort(), [['moment@1000', true], ['moment@5000', false]]);
});

test('a waiting moment that moved into a gambling chapter is skipped, and one that left it waits again', () => {
  const m = mo(1000);
  const into = planMoments([known(m, 'pending')], [ranked(mo(1010), 'a Slots chapter: never clipped')]);
  assert.equal(into.update[0].status, 'skipped');
  const out = planMoments([known(m, 'skipped', 'a Slots chapter: never clipped')], [ranked(mo(1010))]);
  assert.equal(out.update[0].status, 'pending');
  const other = planMoments([known(m, 'skipped', 'subscriber-only')], [ranked(mo(1010))]);
  assert.equal(other.update[0].status, undefined, 'any other skip stays');
});

test('a new moment inside a worked window is recorded covered, not queued again', () => {
  const worked = mo(1000);
  const plan = planMoments([known(worked, 'no-clip')], [ranked(mo(1060, { id: 'moment@1060', score: 300 }))]); // its window runs to 1065 s
  assert.equal(plan.insert[0].status, 'covered');
  assert.equal(plan.insert[0].coveredBy, 'moment@1000');
});

test('rows that were already duplicates are folded into the stronger or worked one', () => {
  const rows = [known(mo(1000, { score: 900 }), 'pending'), known(mo(1025, { id: 'moment@1025', score: 300 }), 'pending'), known(mo(3000, { id: 'moment@3000' }), 'clipped'), known(mo(3050, { id: 'moment@3050', score: 999 }), 'pending'), known(mo(7000, { id: 'moment@7000' }), 'pending')];
  assert.deepEqual(duplicatesOf(rows).map((d) => [d.momentId, d.by]), [['moment@3050', 'moment@3000'], ['moment@1025', 'moment@1000']]);
});

test('the shadow ranker alternates viewer clips and laughter, so a big laugh is not buried by a mature clip', () => {
  const clipsOnly = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => mo(i * 1000, { id: `c${i}`, views: 5000 - i * 100, clippers: 1, score: 5000 - i * 100 }));
  const laugh = mo(20_000, { id: 'moped', laughers: 96, score: 1152 });
  const all = [...clipsOnly, laugh].sort((a, b) => b.score - a.score);
  assert.equal(all.indexOf(laugh) + 1, 9, 'ninth by the combined score');
  const alt = alternateOrder(all);
  assert.equal(alt.indexOf(laugh) + 1, 2, 'second when the lists take turns');
  // a nomination within 30 s of a chosen moment is passed over, then listed last
  const twin = mo(1020, { id: 'twin', laughers: 50, score: 600 });
  const alt2 = alternateOrder([...all, twin]);
  assert.equal(alt2.at(-1), twin);
});

test('ranking records both orders', () => {
  const clips = [clip({ offsetMs: 1 * H, views: 900 }), clip({ offsetMs: 2 * H, views: 300 })];
  const r = rankMoments({ clips, durationMs: 5 * H });
  assert.deepEqual(r.map((m) => [m.rank, m.altRank]), [[1, 1], [2, 2]]);
});
