// The queue dossier's pure parts: which seconds an expert is shown first, which words, and when the
// two minutes after a queue are part of the reading.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Queue } from '../src/scan/queues';

const { dossierTimes, dossierWindow, readOnAsked, batchesOf, DOSSIER_BATCH, DOSSIER_STILLS, MOMENT_OFFSETS_MS } = await import('../src/scan/dossier');
const { chatAsksReadOn, DOUBT_MIN } = await import('../src/scan/queues');

const chat = (over: Record<string, unknown> = {}) => ({ doubt: 0, mood: 'neutral', ...over }) as Queue['signals']['chat'];
const q = (over: Partial<Queue> = {}) => ({ kind: 'meme', startMs: 600_000, endMs: 630_000, peakMs: 612_000, anchor: 'audio', signals: { chat: chat() }, ...over }) as Queue;

test('an exact moment is looked at just before it, at it and after it, and the rest of the region every few seconds', () => {
  // region 10:00–10:30, a laugh at 10:12
  assert.deepEqual(dossierTimes(q()), [600_000, 605_000, 609_000, 612_000, 614_000, 618_000, 620_000, 625_000, 630_000]);
  assert.deepEqual(dossierTimes(q({ anchor: 'expert' })), dossierTimes(q()));
  for (const o of MOMENT_OFFSETS_MS) assert.ok(dossierTimes(q()).includes(612_000 + o));
  // the case this was measured on: a shout at 1:52:18, the hand over the mouth at 1:52:27, the reveal at 1:52:33
  const gag = dossierTimes(q({ startMs: 6_728_000, endMs: 6_752_000, peakMs: 6_738_000 }));
  assert.deepEqual(gag, [6_728_000, 6_733_000, 6_735_000, 6_738_000, 6_740_000, 6_742_000, 6_744_000, 6_747_000, 6_752_000]);
  assert.ok(gag.includes(6_747_000), 'the realisation is in the first look');
  // nothing before 0:00
  assert.deepEqual(dossierTimes(q({ startMs: 0, endMs: 20_000, peakMs: 1000 })), [0, 1000, 3000, 5000, 7000, 10_000, 15_000, 20_000]);
});

test('an estimated moment gets the same sweep: the whole region, and the estimate itself', () => {
  // chat places a moment to about ±10 s; a viewer clip's offset to about one clip length
  assert.deepEqual(dossierTimes(q({ anchor: 'chat' })), [600_000, 604_000, 608_000, 612_000, 615_000, 619_000, 623_000, 626_000, 630_000]);
  const clip = dossierTimes(q({ anchor: 'clip', startMs: 580_000, endMs: 650_000 }));
  assert.equal(clip.length, DOSSIER_STILLS.meme);
  assert.deepEqual([clip[0], clip.at(-1)], [580_000, 650_000], 'edge to edge');
  assert.ok(clip.includes(612_000));
  assert.ok(clip.every((t, k) => k === 0 || t - clip[k - 1] >= 2000), 'no two stills a second apart');
});

test('a story gets four stills: its first second, the moment, one between, its last second', () => {
  const story = dossierTimes(q({ kind: 'clip', startMs: 590_000 }));
  assert.deepEqual(story, [590_000, 610_000, 612_000, 630_000]);
  assert.equal(story.length, DOSSIER_STILLS.clip);
  // a long region: still four, and both edges kept
  assert.deepEqual(dossierTimes(q({ kind: 'clip', startMs: 560_000, endMs: 650_000 })), [560_000, 605_000, 612_000, 650_000]);
  // an estimated moment the same way
  assert.equal(dossierTimes(q({ kind: 'clip', anchor: 'clip', startMs: 560_000, endMs: 650_000 })).length, DOSSIER_STILLS.clip);
});

test('the read-on: always for a story; for a gag when chat calls it fake, is ahead of the streamer, or tense', () => {
  assert.equal(readOnAsked(q()), false);
  assert.equal(readOnAsked(q({ kind: 'clip' })), true);
  assert.equal(readOnAsked(q({ signals: { chat: chat({ doubt: DOUBT_MIN }) } as Queue['signals'] })), true);
  assert.equal(readOnAsked(q({ signals: { chat: chat({ doubt: DOUBT_MIN - 1 }) } as Queue['signals'] })), false);
  assert.equal(readOnAsked(q({ signals: { chat: chat({ mood: 'irony' }) } as Queue['signals'] })), true);
  assert.equal(readOnAsked(q({ signals: { chat: chat({ mood: 'tension' }) } as Queue['signals'] })), true);
  assert.equal(readOnAsked(q({ signals: { chat: chat({ mood: 'funny' }) } as Queue['signals'] })), false);
  // a moment an expert found has no chat evidence at all
  assert.equal(readOnAsked(q({ signals: {} as Queue['signals'] })), false);
  assert.equal(chatAsksReadOn(undefined), false);
});

test('the words: 15 s before the region to 25 s after it, and two minutes on when the read-on is asked', () => {
  const d = 40 * 60_000;
  assert.deepEqual(dossierWindow(q(), d), { fromMs: 585_000, toMs: 655_000 });
  assert.deepEqual(dossierWindow(q({ kind: 'clip' }), d), { fromMs: 585_000, toMs: 655_000, readOnToMs: 750_000 });
  assert.deepEqual(dossierWindow(q({ kind: 'clip' }), 640_000), { fromMs: 585_000, toMs: 640_000 }, 'nothing past the end of the video');
  assert.equal(dossierWindow(q({ startMs: 5000 }), d).fromMs, 0);
});

test('the rest comes in batches of four', () => {
  assert.equal(DOSSIER_BATCH, 4);
  assert.deepEqual(batchesOf(['a', 'b', 'c', 'd', 'e']), [['a', 'b', 'c', 'd'], ['e']]);
  assert.deepEqual(batchesOf([]), []);
});
