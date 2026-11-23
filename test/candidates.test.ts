// The candidate validator on a small made-up stream: the extraction buffer survives snapping, a
// wordless moment is accepted on evidence instead of a quote, invented moments are still refused, and
// the judge's scores are cross-checked against what the transcript shows.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Word } from '../src/core/schemas';

const { paths, writeJson } = await import('../src/core/paths');
const { addCandidates, loadCandidates, scoreChecks, spreadNote, expertRiskWarnings, refreshCandidates } = await import('../src/candidates');
const { DOUBT_MIN } = await import('../src/discover/chatAnalysis');
const { BUFFER_BEFORE_MS, BUFFER_AFTER_MS } = await import('../src/extract/window');

const MIN = 60_000;
const VID = 'tw-2000000001';
const SILENT = 'tw-2000000002';

/** `n` six-word sentences from `start`: 0.3 s a word, 0.4 s between sentences. */
function block(tag: string, start: number, n: number, i0: number): Word[] {
  const out: Word[] = [];
  for (let s = 0; s < n; s++) for (let k = 0; k < 6; k++) {
    const at = start + s * 2200 + k * 300;
    out.push({ i: i0 + out.length, startMs: at, endMs: at + 250, text: `${tag}${s}w${k}${k === 5 ? '.' : ''}` });
  }
  return out;
}
const a = block('a', 10 * MIN, 9, 0); // 10:00.0 → 10:19.35, then silence
const b = block('b', 12 * MIN, 9, a.length); // a second, separate stretch of talk
const words = [...a, ...b];
const lastA = a[a.length - 1];

const meta = (id: string) => ({ id, url: `https://www.twitch.tv/videos/${id.slice(3)}`, platform: 'twitch', title: 'Test stream', channel: 'Tester', login: 'tester', durationMs: 40 * MIN, hasHeatmap: false, chapters: [], heatmap: [], captions: 'none', commentCount: 0, ingestedAt: new Date(0).toISOString() });
const scream = { durationMs: 40 * MIN, windowMs: 1500, hopMs: 750, events: [{ ms: 20 * MIN, label: 'screaming', confidence: 0.9 }, { ms: 20 * MIN + 750, label: 'screaming', confidence: 0.85 }] };
for (const id of [VID, SILENT]) {
  writeJson(paths.videoFile(id, 'meta.json'), meta(id));
  writeJson(paths.videoFile(id, 'info.json'), {});
  writeJson(paths.videoFile(id, 'audio-events.json'), scream);
}
writeJson(paths.videoFile(VID, 'transcript.json'), { videoId: VID, source: 'whisper', lang: 'en', words, tags: [], covered: [{ startMs: 9 * MIN, endMs: 14 * MIN }] });

const base = { title: 'A test moment', hook: 'Wait for it', reason: 'setup then payoff', score: 80, lens: 'stream-moments' };
const add = (id: string, input: Record<string, unknown>) => addCandidates(id, [{ ...base, ...input }], { footage: false });

test('an invented quote is refused, and so is a missing one', () => {
  const invented = add(VID, { start: '9:59.7', end: '10:19.75', quote: 'this was never said by anyone here' });
  assert.equal(invented.accepted.length, 0);
  assert.match(invented.rejected[0].errors.join(' '), /quote not found/);
  const missing = add(VID, { start: '9:59.7', end: '10:19.75' });
  assert.match(missing.rejected[0].errors.join(' '), /no quote: cite 5–20 words/);
});

test('a window from the extractor keeps its 300 ms / 400 ms buffer, and remembers the queue it came from', () => {
  const r = add(VID, { start: 10 * MIN - BUFFER_BEFORE_MS, end: lastA.endMs + BUFFER_AFTER_MS, quote: 'a3w0 a3w1 a3w2 a3w3 a3w4 a3w5', kind: 'clip', queueId: 'clip@0:10:00' });
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  const c = r.accepted[0];
  assert.equal(c.startMs, 10 * MIN - 300);
  assert.equal(c.endMs, lastA.endMs + 400);
  assert.equal(c.kind, 'clip');
  assert.equal(c.queueId, 'clip@0:10:00');
  assert.ok(!c.visual);
  assert.equal(loadCandidates(VID).candidates[0].queueId, 'clip@0:10:00');
});

test('bare numbers are milliseconds, and a judge who meant seconds is told so', () => {
  const r = add(VID, { start: 599.7, end: 619.75, quote: 'a3w0 a3w1 a3w2 a3w3 a3w4 a3w5' });
  assert.match(r.rejected[0].errors.join(' '), /numbers are milliseconds/);
});

test('the same moment twice is a duplicate, whichever expert sends it', () => {
  const r = add(VID, { start: '10:02', end: '10:19.5', quote: 'a4w0 a4w1 a4w2 a4w3', kind: 'meme' });
  assert.match(r.rejected[0].errors.join(' '), /duplicates c01/);
});

test('a wordless moment is accepted on the evidence inside it, not on a quote', () => {
  const r = add(VID, { start: '19:57', end: '20:14', visual: true, kind: 'meme' });
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  const c = r.accepted[0];
  assert.equal(c.visual, true);
  assert.equal(c.quote, '');
  assert.equal(c.startMs, 19 * MIN + 57_000, 'no words nearby, so the start is kept as given');
  assert.ok(c.warnings.some((w) => /^visual: accepted on a shout at 20:00/.test(w)), c.warnings.join(' | '));
  assert.ok(!c.warnings.some((w) => /mid-sentence/.test(w)), 'silence is not mid-sentence');
});

test('a wordless moment with nothing in it is refused: evidence replaces the quote, it does not waive it', () => {
  const r = add(VID, { start: '5:00', end: '5:20', visual: true });
  assert.equal(r.accepted.length, 0);
  assert.match(r.rejected[0].errors.join(' '), /visual candidate with no evidence/);
});

test('a stream nobody has transcribed yet can still take a visual candidate', () => {
  const r = add(SILENT, { start: '19:57', end: '20:14', visual: true });
  assert.equal(r.accepted.length, 1, JSON.stringify(r.rejected));
  assert.match(add(SILENT, { start: '25:00', end: '25:20', quote: 'some words that nobody transcribed' }).rejected[0].errors.join(' '), /quote not found/);
});

test('scores the transcript contradicts get a note next to them', () => {
  const w = (i: number, text: string, startMs: number): Word => ({ i, text, startMs, endMs: startMs + 250 });
  const range = { startMs: 0, endMs: 25_000 };
  const high = { stop: 8, hold: 8, share: 9, standalone: 8, payoff: 8, delivery: 8 };
  const talk = (from: number, n: number, i0 = 0) => Array.from({ length: n }, (_, k) => w(i0 + k, 'word', from + k * 300));
  const filler = scoreChecks(high, [w(0, 'So', 200), ...talk(600, 70, 1), w(99, 'that?', 24_000)], range);
  assert.ok(filler.some((x) => /opens on the filler "So"/.test(x)), filler.join(' | '));
  assert.ok(filler.some((x) => /last line is a question/.test(x)));
  assert.ok(filler.some((x) => /share 9, but nothing in range backs it/.test(x)));
  assert.ok(filler.every((x) => x.startsWith('score check:')));
  const late = scoreChecks(high, talk(3000, 60), range, { witnesses: ['chat 3.0× normal'], reactionTimes: [] });
  assert.ok(late.some((x) => /first word is 3\.0 s in/.test(x)), late.join(' | '));
  assert.ok(!late.some((x) => /share/.test(x)), 'a witness backs the share score');
  assert.ok(!scoreChecks(high, talk(3000, 60), range, { witnesses: ['a shout'], reactionTimes: [500] }).some((x) => /first word/.test(x)), 'a scream is an opening');
  const sag = scoreChecks(high, [...talk(0, 20), ...talk(13_000, 30, 20)], range, { witnesses: ['x'], reactionTimes: [] });
  assert.ok(sag.some((x) => /hold 8, but there is a 7\.\d s stretch/.test(x)), sag.join(' | '));
  // honest scores draw no notes, and an unjudged candidate is left alone
  assert.deepEqual(scoreChecks({ stop: 5, hold: 6, share: 6, standalone: 7, payoff: 6, delivery: 6 }, [w(0, 'So', 200), ...talk(600, 70, 1), w(99, 'that?', 24_000)], range), []);
  assert.deepEqual(scoreChecks(undefined, [], range), []);
});

test('a batch where every clip scores the same is called out', () => {
  const same = { scores: { stop: 8, hold: 7, share: 8, standalone: 8, payoff: 8, delivery: 8 } };
  assert.match(spreadNote([same, same, same, { scores: { ...same.scores, stop: 7 } }]) ?? '', /within 1 point of each other/);
  assert.equal(spreadNote([same, same, same]), undefined, 'three clips are too few to say');
  const spread = [{ scores: { stop: 9, hold: 7, share: 8, standalone: 8, payoff: 8 } }, { scores: { stop: 4, hold: 5, share: 3, standalone: 6, payoff: 5 } }, same, same];
  assert.equal(spreadNote(spread), undefined);
});

test('a risk an expert flagged from the frames follows the candidate to the reviewer', () => {
  const RISKY = 'tw-2000000003';
  writeJson(paths.videoFile(RISKY, 'meta.json'), meta(RISKY));
  writeJson(paths.videoFile(RISKY, 'info.json'), {});
  writeJson(paths.videoFile(RISKY, 'audio-events.json'), scream);
  writeJson(paths.videoFile(RISKY, 'queue-review.json'), {
    videoId: RISKY,
    verdicts: [
      { queueId: 'meme@0:20:00', kind: 'meme', verdict: 'confirm', risks: ['privacy', 'profanity'], momentMs: 20 * MIN, queue: { peakMs: 20 * MIN } },
      { queueId: 'viral@0:20:05', kind: 'viral', verdict: 'reject', risks: ['misleading', 'privacy'], queue: { peakMs: 20 * MIN + 5000 } },
      { queueId: 'meme@0:30:00', kind: 'meme', verdict: 'confirm', risks: ['minor'], queue: { peakMs: 30 * MIN } },
    ],
  });
  const c = add(RISKY, { start: '19:57', end: '20:14', visual: true, queueId: 'meme@0:20:00' }).accepted[0];
  const risk = c.warnings.filter((w) => w.startsWith('risk:'));
  assert.equal(risk.length, 1);
  assert.match(risk[0], /privacy \(meme, viral\); misleading \(viral\)/, 'both experts who looked at this moment, including the one who rejected it');
  assert.ok(!/profanity|minor/.test(risk[0]), 'profanity stays in the ledger; a flag on another moment does not leak in');
  assert.deepEqual(expertRiskWarnings(RISKY, { startMs: 5 * MIN, endMs: 6 * MIN }), []);
  // and it survives a refresh, which recomputes every risk warning
  assert.equal(refreshCandidates(RISKY).candidates[0].warnings.filter((w) => w.startsWith('risk:')).length, 1);
  // chat typed a slur while the clip plays: on a stream with chat in the frame, that is on screen
  // (typed 1 s before the clip ends, it shows on screen after the clip is over: not counted)
  writeJson(paths.videoFile(RISKY, 'chat.json'), { videoId: RISKY, fetched: [{ startMs: 0, endMs: 40 * MIN }], messages: [[20 * MIN + 4000, 'someone', 'Retarded purchase'], [20 * MIN + 13_000, 'late', 'sped'], [26 * MIN, 'other', 'retard']] });
  const again = refreshCandidates(RISKY).candidates[0].warnings.filter((w) => w.startsWith('risk:'));
  assert.equal(again.length, 2);
  assert.match(again.join(' | '), /1 chat message during this clip contains a slur \(typed at 20:04/);
});

test('chat calling a moment fake follows the clip to the reviewer, with no expert involved', () => {
  const PRANK = 'tw-2000000004';
  writeJson(paths.videoFile(PRANK, 'meta.json'), meta(PRANK));
  writeJson(paths.videoFile(PRANK, 'info.json'), {});
  writeJson(paths.videoFile(PRANK, 'audio-events.json'), scream);
  const chat = (doubters: [number, string, string][]) => writeJson(paths.videoFile(PRANK, 'chat.json'), { videoId: PRANK, fetched: [{ startMs: 0, endMs: 40 * MIN }], messages: [[20 * MIN + 1000, 'fan', 'LOL'], ...doubters, [26 * MIN, 'late', 'fake']] });
  const doubt = (id: string) => loadCandidates(id).candidates[0].warnings.filter((w) => /fake, staged or AI/.test(w));
  // two people doubting is noise
  chat([[20 * MIN + 6000, 'a', 'fake'], [20 * MIN + 9000, 'b', 'so staged']]);
  assert.equal(add(PRANK, { start: '19:57', end: '20:14', visual: true }).accepted.length, 1);
  assert.deepEqual(doubt(PRANK), []);
  // three is a warning, and chat answers a moment up to 25 s after it: the third doubter typed after the clip ended
  assert.equal(DOUBT_MIN, 3);
  chat([[20 * MIN + 6000, 'a', 'fake'], [20 * MIN + 9000, 'b', 'so staged'], [20 * MIN + 30_000, 'c', 'cap']]);
  refreshCandidates(PRANK);
  assert.equal(doubt(PRANK).length, 1);
  assert.match(doubt(PRANK)[0], /^risk: 3 chatters called this fake, staged or AI while it happened/);
});

