// Weighted extraction: the same queue produces a tighter window for a meme and a fuller one for a story.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreWindow, bufferWindow, bestWindows } from '../src/extract/window';
import type { Queue } from '../src/scan/queues';
import type { Word } from '../src/core/schemas';

const word = (i: number, text: string, startMs: number, endMs = startMs + 350): Word => ({ i, text, startMs, endMs });
const words = [
  word(0, 'He', 5200, 5500),
  word(1, 'stole', 5500, 5900),
  word(2, 'the', 5900, 6100),
  word(3, 'car.', 6100, 6600),
  word(4, 'Then', 14_500, 14_900),
  word(5, 'he', 14_900, 15_100),
  word(6, 'laughed', 15_100, 15_700),
  word(7, 'at', 15_700, 15_900),
  word(8, 'everyone.', 15_900, 16_500),
  word(9, 'That', 24_000, 24_300),
  word(10, 'was', 24_300, 24_600),
  word(11, 'insane.', 24_600, 25_200),
];

test('a tight reaction window scores high for a meme queue', () => {
  const r = scoreWindow({
    kind: 'meme',
    startMs: 14_000,
    endMs: 30_000,
    peakMs: 22_000,
    words,
    reactions: [{ startMs: 25_000, kind: 'laugh' }],
    clips: [],
  });
  assert.ok(r.score >= 50, `${r.score}`);
  assert.ok(r.components.hook > 0.5);
  assert.ok(r.components.payoff > 0.4);
});

test('a setup-through-payoff window scores higher for a clip queue than a tight meme window', () => {
  const full = scoreWindow({
    kind: 'clip',
    startMs: 5_000,
    endMs: 30_000,
    peakMs: 22_000,
    words,
    reactions: [{ startMs: 25_000, kind: 'laugh' }],
    clips: [],
  });
  const tight = scoreWindow({
    kind: 'clip',
    startMs: 14_000,
    endMs: 30_000,
    peakMs: 22_000,
    words,
    reactions: [{ startMs: 25_000, kind: 'laugh' }],
    clips: [],
  });
  assert.ok(full.score > tight.score, `${full.score} vs ${tight.score}`);
  assert.ok(full.components.context > tight.components.context);
});

test('muted footage makes a window unusable', () => {
  const r = scoreWindow({
    kind: 'viral',
    startMs: 10_000,
    endMs: 30_000,
    peakMs: 20_000,
    words,
    reactions: [],
    clips: [],
    muted: [{ startMs: 12_000, endMs: 13_000 }],
  });
  assert.equal(r.score, 0);
});

test('the extraction buffer is part of the clip and respects the video end', () => {
  const b = bufferWindow(10_000, 30_000);
  assert.equal(b.startMs, 9_700);
  assert.equal(b.endMs, 30_400);
  const clipped = bufferWindow(10_000, 59_900, 60_200);
  assert.equal(clipped.endMs, 60_200);
});

const queue = (over: Partial<Queue>): Queue => ({ id: 'meme@0:00:20', kind: 'meme', startMs: 8_000, endMs: 34_000, peakMs: 22_000, anchor: 'audio', score: 50, confidence: 0.67, sources: 2, witnesses: ['chat', 'reaction'], signals: {} as Queue['signals'], why: [], risks: [], context: [], ...over });

test('a window that stops before the reaction says so', () => {
  const r = scoreWindow({ kind: 'meme', startMs: 5_000, endMs: 21_000, peakMs: 22_000, words, reactions: [{ startMs: 23_500, kind: 'laugh' }], clips: [] });
  assert.ok(r.why.some((w) => /a laugh follows 2\.5s after the end/.test(w)), r.why.join(' · '));
  const lands = scoreWindow({ kind: 'meme', startMs: 5_000, endMs: 25_300, peakMs: 22_000, words, reactions: [{ startMs: 23_500, kind: 'laugh' }], clips: [] });
  assert.ok(lands.components.payoff > r.components.payoff);
});

test('a region with no words still gets windows, cut around the moment and marked', () => {
  const w = bestWindows({ queue: queue({}), words: [], reactions: [{ startMs: 22_000, kind: 'shout' }], clips: [] });
  assert.ok(w.length >= 1);
  assert.ok(w.every((x) => x.noWords && x.startMs < 22_000 && x.endMs > 22_000 && x.endMs - x.startMs >= 15_000));
  assert.ok(w[0].why[0].includes('no transcript words'));
  assert.equal(w[0].quote, undefined);
});

test('windows on speech carry the buffer and a quote the validator can find', () => {
  const w = bestWindows({ queue: queue({ kind: 'clip', startMs: 4_000, endMs: 30_000 }), words, reactions: [{ startMs: 25_000, kind: 'laugh' }], clips: [] });
  assert.ok(w.length >= 1);
  assert.ok(!w[0].noWords);
  assert.ok(w[0].quote && w[0].quote.split(' ').length <= 20);
});
