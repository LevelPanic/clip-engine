// Regression tests for the pure core: time parsing, the time map and per-span framing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, fmtTime } from '../src/core/time';
import { buildTimeMap, srcToT, tToSrc } from '../src/core/timeline';
import { framingAt } from '../src/markers/define';

test('parseTime reads every format and rejects junk', () => {
  assert.equal(parseTime('14:50'), 890_000);
  assert.equal(parseTime('1:02:03.5'), 3_723_500);
  assert.equal(parseTime('90'), 90_000);
  assert.equal(parseTime('250ms'), 250);
  assert.equal(parseTime('+3.5', 10_000), 13_500);
  assert.throws(() => parseTime('+3'), /reference point/);
  assert.throws(() => parseTime('soon'), /Can't read time/);
  assert.equal(fmtTime(3_723_500), '1:02:03.5');
});

test('fmtTime carries rounding into the next minute and hour', () => {
  assert.equal(fmtTime(4_019_970), '1:07:00.0'); // 1:06:59.97 (a real Whisper word time)
  assert.equal(fmtTime(59_960, 1), '1:00.0');
  assert.equal(fmtTime(3_599_960, 1), '1:00:00.0');
  assert.equal(fmtTime(59_400, 0), '0:59');
  assert.equal(fmtTime(59_600, 0), '1:00');
  assert.equal(fmtTime(-1_500), '-0:01.5');
});

test('time map: a cut removes its span and later source times shift back', () => {
  const map = buildTimeMap({ startMs: 10_000, endMs: 40_000 }, [{ id: 'c', startMs: 20_000, endMs: 25_000, effect: { kind: 'remove' } }]);
  assert.equal(map.durationMs, 25_000);
  assert.equal(srcToT(map, 22_000), null); // inside the cut
  assert.equal(srcToT(map, 30_000), 15_000);
  assert.equal(tToSrc(map, 15_000), 30_000);
});

test('time map: speed and freeze change the edited length', () => {
  const sped = buildTimeMap({ startMs: 0, endMs: 20_000 }, [{ id: 's', startMs: 0, endMs: 10_000, effect: { kind: 'speed', rate: 2 } }]);
  assert.equal(sped.durationMs, 15_000);
  const held = buildTimeMap({ startMs: 0, endMs: 20_000 }, [{ id: 'f', startMs: 5_000, effect: { kind: 'hold', durationMs: 1_000 } }]);
  assert.equal(held.durationMs, 21_000);
});

test('framingAt: a blur span inside a crop clip, then back', () => {
  const keys = [
    { atMs: 5_000, mode: 'blur' as const, cropX: 0.5, easeMs: 0 },
    { atMs: 9_000, mode: 'crop' as const, cropX: 0.3, easeMs: 0 },
  ];
  const base = { mode: 'crop' as const, cropX: 0.5 };
  assert.deepEqual(framingAt(keys, base, 1_000), { mode: 'crop', cropX: 0.5 });
  assert.equal(framingAt(keys, base, 6_000).mode, 'blur');
  assert.deepEqual(framingAt(keys, base, 9_500), { mode: 'crop', cropX: 0.3 });
});

test('stills that are the same picture for different seconds are not trusted', async () => {
  const { identicalStills } = await import('../src/ingest/frames');
  // 1:36:10, 1:36:12 and 1:36:13 came back as one file (seen in the library); 1:36:31 is its own
  assert.deepEqual(identicalStills(['aa', 'aa', 'aa', 'bb'], [5_770_000, 5_772_000, 5_773_000, 5_791_000]), [0, 1, 2]);
  assert.deepEqual(identicalStills(['aa', 'bb'], [1000, 4000]), []);
  assert.deepEqual(identicalStills(['aa', 'aa'], [1000, 1400]), [], 'the same frame asked for twice is fine');
  assert.deepEqual(identicalStills(['aa', undefined, 'aa'], [1000, 2000, 9000]), [0, 2], 'a missing still is not a match');
});

test('reading a second past what is transcribed does not start a transcription', async () => {
  const { untranscribed } = await import('../src/ingest/windowed');
  const t = (covered?: { startMs: number; endMs: number }[]) => ({ videoId: 'x', source: 'whisper' as const, lang: 'en', words: [], tags: [], ...(covered ? { covered } : {}) });
  const covered = [{ startMs: 60_000, endMs: 120_000 }];
  // "the region plus 20 s" reaches 0.8 s past the covered part: nothing to do
  assert.deepEqual(untranscribed(t(covered), [{ startMs: 70_000, endMs: 120_800 }]), []);
  // a real gap is still transcribed
  assert.deepEqual(untranscribed(t(covered), [{ startMs: 70_000, endMs: 135_000 }]), [{ startMs: 120_000, endMs: 135_000 }]);
  // a stream nobody has transcribed: even a short window asked for on purpose is done
  assert.deepEqual(untranscribed(t([]), [{ startMs: 0, endMs: 2000 }]), [{ startMs: 0, endMs: 2000 }]);
  assert.deepEqual(untranscribed(undefined, [{ startMs: 0, endMs: 2000 }]), [{ startMs: 0, endMs: 2000 }]);
  // a video with full captions never needs it
  assert.deepEqual(untranscribed(t(), [{ startMs: 0, endMs: 600_000 }]), []);
});

test('a still carries its time under the picture, drawn without a font', async () => {
  const { stillLabelFilter } = await import('../src/ingest/frames');
  const f = stillLabelFilter('1:27:55');
  assert.match(f, /^pad=iw:ih\+26:0:0:black,drawbox=/, 'a strip under the picture: nothing in it is covered');
  const boxes = (label: string) => stillLabelFilter(label).split(',').length - 1;
  // seven-segment digits: 1 lights two bars, 7 three, 8 all seven; a colon is two dots
  assert.deepEqual([boxes('1'), boxes('7'), boxes('8'), boxes(':'), boxes('0')], [2, 3, 7, 2, 6]);
  assert.equal(boxes('1:27:55'), 2 + 2 + 5 + 3 + 2 + 5 + 5);
  assert.equal(boxes('x'), 0, 'anything else is not drawn');
  // a wide still gets a bigger label
  assert.match(stillLabelFilter('8', 2), /^pad=iw:ih\+52:0:0:black/);
  // no two characters overlap: every character starts right of the one before
  const xs = [...stillLabelFilter('88').matchAll(/drawbox=x=(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(Math.min(...xs.slice(7)) > Math.max(...xs.slice(0, 7)) - 10 && Math.min(...xs.slice(7)) >= Math.min(...xs.slice(0, 7)) + 14);
});

