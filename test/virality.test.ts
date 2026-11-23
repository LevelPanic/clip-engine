// The virality funnel, signal convergence and the ordering they produce, plus the first-second QA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viralityScore, convergenceScore, rankScore, rankCandidates, verdictOf, type ViralityScores } from '../src/candidates/virality';
import { endingWarnings, hookWarnings } from '../src/qa/hook';

const scores = (s: Partial<ViralityScores> = {}): ViralityScores => ({ stop: 8, hold: 7, share: 8, standalone: 8, payoff: 8, ...s });
const stream = 'stream-moments';
const talk = 'podcast-general';

test('a strong funnel scores high in both formats', () => {
  const s = scores({ stop: 9, hold: 8, share: 9, standalone: 8, payoff: 9, delivery: 9 });
  assert.equal(viralityScore(s, stream), 87);
  assert.equal(viralityScore(s, talk), 86);
});

test('stream gates a weak opening; talk does not', () => {
  const slow = scores({ stop: 3, hold: 9, share: 9, standalone: 8, payoff: 8, delivery: 8 });
  assert.ok(viralityScore(slow, stream) < 65);
  assert.ok(viralityScore(slow, talk) > 70);
});

test('talk still gates weak context, payoff and delivery', () => {
  for (const weak of [{ standalone: 4 }, { payoff: 4 }, { delivery: 3 }] as Partial<ViralityScores>[]) {
    const v = viralityScore(scores({ hold: 9, share: 9, ...weak }), talk);
    assert.ok(v < 65, `${JSON.stringify(weak)} → ${v}`);
  }
});

test('a failed gate cannot be saved by the other qualities', () => {
  assert.ok(viralityScore(scores({ stop: 0, hold: 10, share: 10, standalone: 10, payoff: 10 }), stream) < 50);
});

test('a hook that does not deliver is capped, even with a huge opening', () => {
  const cheat = viralityScore(scores({ stop: 10, hold: 9, share: 9, standalone: 8, payoff: 7, delivery: 4 }), stream);
  const honest = viralityScore(scores({ stop: 8, hold: 8, share: 8, standalone: 8, payoff: 8, delivery: 8 }), stream);
  assert.ok(cheat < 60, `cheat ${cheat}`);
  assert.ok(honest > cheat + 20, `honest ${honest} vs cheat ${cheat}`);
});

test('a 10 hook with 7 delivery is not a cheat: 7 clears the post bar', () => {
  const v = viralityScore(scores({ stop: 10, hold: 9, share: 9, standalone: 8, payoff: 7, delivery: 7 }), stream);
  assert.ok(v > 80, `${v}`);
});

test('verdicts are format-aware', () => {
  const slow = scores({ stop: 3, hold: 9, share: 9, standalone: 8, payoff: 8, delivery: 8 });
  assert.equal(verdictOf(slow, viralityScore(slow, talk), 85, talk), 'post');
  assert.equal(verdictOf(slow, viralityScore(slow, stream), 85, stream), 'recut');
  const empty = scores({ stop: 9, hold: 8, share: 8, standalone: 8, payoff: 3, delivery: 3 });
  assert.equal(verdictOf(empty, viralityScore(empty, talk), 80, talk), 'recut');
  assert.equal(verdictOf(scores({ stop: 5 }), 45, 55, talk), 'skip'); // not a good moment at all
});

test('postable clips outrank a hookier-but-empty clip in the list', () => {
  type C = { id: string; score: number; signals: Record<string, number>; scores: ViralityScores; lens: string };
  const post = scores({ stop: 7, hold: 7, share: 7, standalone: 8, payoff: 8, delivery: 8 });
  const empty = scores({ stop: 10, hold: 9, share: 9, standalone: 8, payoff: 3, delivery: 2 });
  const ranked = rankCandidates<C>([
    { id: 'empty', score: 85, signals: { chat: 0.9, clips: 0.9, audio: 0.9 }, scores: empty, lens: talk },
    { id: 'post', score: 72, signals: {}, scores: post, lens: talk },
  ]);
  assert.equal(ranked[0].id, 'post');
  assert.equal(ranked[0].verdict, 'post');
  assert.equal(ranked[1].verdict, 'recut');
});

test('convergence needs independent signals and ignores fast talking', () => {
  assert.equal(convergenceScore({}), 0);
  assert.equal(convergenceScore({ speech: 1 }), 0);
  assert.ok(Math.abs(convergenceScore({ chat: 0.8 }) - 0.306) < 0.01);
  const three = convergenceScore({ chat: 0.8, clips: 0.9, audio: 0.7 });
  assert.ok(three > 0.9, `${three}`);
  assert.ok(convergenceScore({ chat: 0.8, clips: 0.9 }) < three);
});

test('one laugh is one witness: caption laughter and audio laughter are merged', () => {
  assert.equal(convergenceScore({ laughter: 1, audio: 1 }), convergenceScore({ audio: 1 }));
  assert.equal(convergenceScore({ laughter: 0.8, audio: 0.6 }), convergenceScore({ laughter: 0.8 }));
});

test('signal agreement lifts a lower-scored moment above a high-scored lonely one', () => {
  assert.ok(rankScore(70, 0.9, 70) > rankScore(80, 0.1, 80));
  assert.equal(rankScore(80, 0, 80), 0.48);
});

test('candidates rank by virality plus convergence, and old files still rank', () => {
  type TestCand = { id: string; score: number; signals: Record<string, number>; virality?: number };
  const list: TestCand[] = [
    { id: 'judge-only', score: 85, signals: {}, virality: 85 },
    { id: 'signal-backed', score: 75, signals: { chat: 0.9, clips: 0.8, audio: 0.7 }, virality: 75 },
    { id: 'old-file', score: 80, signals: { comments: 0.6, laughter: 0.5 } },
  ];
  const ranked = rankCandidates(list);
  assert.equal(ranked[0].id, 'signal-backed');
  assert.deepEqual(ranked.map((c) => c.rank), [1, 2, 3]);
  assert.ok(ranked[2].rankScore !== undefined);
});

test('payoff QA flags a question or an unfinished ending', () => {
  assert.deepEqual(endingWarnings({ lastLine: "What'd you mean by that?" }), ['ends on an unfinished line or transition']);
  assert.deepEqual(endingWarnings({ lastLine: 'So what happened next?' }), ['ends on a question; the payoff may be outside the cut']);
  assert.deepEqual(endingWarnings({ lastLine: 'And that was that.' }), []);
});

test('hook QA flags silence, black, a late first word and filler', () => {
  assert.deepEqual(hookWarnings({ silenceAtStartS: 1.2 }), ['opens with 1.2 s of silence']);
  assert.deepEqual(hookWarnings({ blackAtStartS: 0 }), ['opens on a black frame']);
  assert.deepEqual(hookWarnings({ firstWordOffsetMs: 2200, firstWord: 'bro' }), ['first word at 2.2 s']);
  assert.deepEqual(hookWarnings({ firstWordOffsetMs: 200, firstWord: 'So' }), ['opens on filler "So"']);
  assert.deepEqual(hookWarnings({ firstWordOffsetMs: 200, firstWord: 'Look' }), []);
});

test('a batch makes clips in rank order, never by quality alone and never a skip', async () => {
  const { pickForBatch } = await import('../src/jobs/pipeline');
  const c = (id: string, over: object) => ({ id, status: 'new', score: 70, startMs: 0, endMs: 30_000, ...over });
  const picked = pickForBatch(
    [
      c('hooky-but-empty', { score: 95, verdict: 'recut', rank: 3 }),
      c('postable', { score: 72, verdict: 'post', rank: 1 }),
      c('skipped-by-engine', { score: 90, verdict: 'skip', rank: 4 }),
      c('long', { score: 80, verdict: 'post', rank: 2, endMs: 75_000 }),
      c('made', { status: 'made', verdict: 'post', rank: 0 }),
      c('unjudged', { score: 65 }),
    ],
    4,
  ).map((x) => x.id);
  assert.deepEqual(picked, ['postable', 'hooky-but-empty', 'unjudged', 'long']);
});
