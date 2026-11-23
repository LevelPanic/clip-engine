// The subtitle expert: word-level fixes and the caption on/off/style/position decision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewWords, captionDecision } from '../src/edit/subtitles';
import type { CaptionSettings, Word } from '../src/core/schemas';

const settings = (over: Partial<CaptionSettings> = {}): CaptionSettings => ({
  enabled: true,
  style: 'bold',
  position: 0.72,
  fontSize: 78,
  uppercase: true,
  highlightColor: '#FFE14D',
  combineMs: 900,
  fixes: {},
  censor: true,
  repeats: true,
  ...over,
});

const word = (i: number, text: string, startMs = i * 500, endMs = startMs + 400): Word => ({ i, text, startMs, endMs });

test('duplicate consecutive words are hidden', () => {
  const r = reviewWords([word(0, 'the'), word(1, 'the'), word(2, 'cat')], settings());
  assert.ok(r.issues.some((i) => i.kind === 'duplicate' && i.wordIndex === 1 && i.fix === ''));
});

test('intentional three-word repetition is flagged, not hidden', () => {
  const r = reviewWords([word(0, 'swim'), word(1, 'swim'), word(2, 'swim')], settings());
  const rep = r.issues.find((i) => i.kind === 'repetition');
  assert.ok(rep);
  assert.equal(rep!.fix, 'swim');
  assert.equal(rep!.severity, 'info');
});

test('non-speech tags and filler are hidden', () => {
  const r = reviewWords([word(0, 'so'), word(1, 'hello'), word(2, '[music]')], settings());
  assert.ok(r.issues.some((i) => i.kind === 'filler' && i.wordIndex === 0));
  assert.ok(r.issues.some((i) => i.kind === 'censor' && i.wordIndex === 2));
});

test('profanity is flagged but not a hard fail', () => {
  const r = reviewWords([word(0, 'this'), word(1, 'fucking'), word(2, 'sucks')], settings());
  const p = r.issues.find((i) => i.kind === 'profanity');
  assert.ok(p);
  assert.equal(p!.severity, 'info');
});

test('long words flag an overflow', () => {
  const r = reviewWords([word(0, 'supercalifragilisticexpialidocious')], settings());
  assert.ok(r.issues.some((i) => i.kind === 'overflow'));
});

test('no speech means captions off', () => {
  const d = captionDecision({ meta: { game: 'Just Chatting', title: '', platform: 'twitch' }, project: { framing: { mode: 'blur', cropX: 0.5, zoom: 1, split: { cam: { x: 0, y: 0, w: 1, h: 1 }, game: { x: 0, y: 0, w: 1, h: 1 }, camShare: 0.35 } }, captions: settings() }, words: [], tags: [], reactions: 0, durationMs: 20_000 });
  assert.equal(d.enabled, false);
});

test('gameplay gets street captions (short italic caps with an outline) in the lower safe zone', () => {
  const d = captionDecision({ meta: { game: 'Fortnite', title: '', platform: 'twitch' }, project: { framing: { mode: 'crop', cropX: 0.5, zoom: 1, split: { cam: { x: 0, y: 0, w: 1, h: 1 }, game: { x: 0, y: 0, w: 1, h: 1 }, camShare: 0.35 } }, captions: settings() }, words: [word(0, 'a'), word(1, 'b'), word(2, 'c'), word(3, 'd'), word(4, 'e')], tags: [], reactions: 0, durationMs: 20_000 });
  assert.equal(d.enabled, true);
  assert.equal(d.style, 'street');
  assert.equal(d.uppercase, true);
  assert.equal(d.position, 0.74);
  assert.equal(d.fontSize, 96);
});

test('a calm talk clip gets sentence-case commentary captions', () => {
  const d = captionDecision({ meta: { game: 'Just Chatting', title: '', platform: 'twitch' }, project: { framing: { mode: 'blur', cropX: 0.5, zoom: 1, split: { cam: { x: 0, y: 0, w: 1, h: 1 }, game: { x: 0, y: 0, w: 1, h: 1 }, camShare: 0.35 } }, captions: settings() }, words: [word(0, 'a'), word(1, 'b'), word(2, 'c'), word(3, 'd'), word(4, 'e')], tags: [], reactions: 0, durationMs: 20_000 });
  assert.equal(d.enabled, true);
  assert.equal(d.style, 'commentary');
  assert.equal(d.uppercase, false);
});

const frame = { framing: { mode: 'blur' as const, cropX: 0.5, zoom: 1, split: { cam: { x: 0, y: 0, w: 1, h: 1 }, game: { x: 0, y: 0, w: 1, h: 1 }, camShare: 0.35, camTopPad: 0.04 } }, captions: settings() };
const spoken = (n: number) => Array.from({ length: n }, (_, k) => word(k, 'word'));

test('a spoken clip keeps captions however many laugh tags the rest of the video has', () => {
  // 148 words in 55 s with two laughs inside the clip: a normal comedy-podcast clip
  const d = captionDecision({ meta: { game: '', title: '', platform: 'youtube' }, project: frame, words: spoken(148), tags: [{ tag: 'laughter' }, { tag: 'laughter' }], reactions: 2, durationMs: 55_000 });
  assert.equal(d.enabled, true);
});

test('a few words over a crowd or music turn captions off; sparse speech alone only warns', () => {
  const crowd = captionDecision({ meta: { game: 'Special Events', title: '', platform: 'twitch' }, project: frame, words: spoken(6), tags: [], reactions: 5, durationMs: 30_000 });
  assert.equal(crowd.enabled, false);
  assert.match(crowd.why, /over crowd, laughter or music/);
  const music = captionDecision({ meta: { game: '', title: '', platform: 'youtube' }, project: frame, words: spoken(20), tags: Array.from({ length: 8 }, () => ({ tag: 'music' })), reactions: 0, durationMs: 30_000 });
  assert.equal(music.enabled, false);
  const quiet = captionDecision({ meta: { game: '', title: '', platform: 'twitch' }, project: frame, words: spoken(7), tags: [], reactions: 0, durationMs: 30_000 });
  assert.equal(quiet.enabled, true);
  assert.ok(quiet.risks.some((r) => /sparse speech/.test(r)));
});

// ---------- caption looks (src/core/captionLooks.ts) ----------

test('a look shows a few words at a time, split evenly and keeping each word\'s timing', async () => {
  const { splitPages } = await import('../src/core/captionLooks');
  const tok = (k: number) => ({ text: `${k ? ' ' : ''}w${k}`, fromMs: k * 300, toMs: k * 300 + 250 });
  const page = { text: '', startMs: 0, durationMs: 2350, tokens: Array.from({ length: 8 }, (_, k) => tok(k)) };
  const out = splitPages([page], 3);
  assert.deepEqual(out.map((p) => p.tokens.length), [3, 3, 2]);
  assert.equal(out[1].startMs, 900);
  assert.equal(out[1].durationMs, 1750 - 900);
  assert.equal(out[1].text, 'w3 w4 w5');
  assert.deepEqual(splitPages([page], 0), [page], '0 = no limit (the karaoke looks)');
  // 7 words read better as 3+2+2 than 3+3+1
  assert.deepEqual(splitPages([{ ...page, tokens: page.tokens.slice(0, 7) }], 3).map((p) => p.tokens.length), [3, 2, 2]);
  assert.deepEqual(splitPages([{ ...page, tokens: page.tokens.slice(0, 3) }], 3).map((p) => p.tokens.length), [3], 'a page that fits is left alone');
});

test('a phrase is loud when it is shouted or exclaimed, not when it is a question', async () => {
  const { isLoud } = await import('../src/core/captionLooks');
  assert.equal(isLoud([{ text: 'chew' }, { text: ' it!' }]), true);
  assert.equal(isLoud([{ text: 'NO' }, { text: ' WAY' }]), true);
  assert.equal(isLoud([{ text: 'throat' }, { text: ' at?' }]), false);
  assert.equal(isLoud([{ text: 'I' }, { text: ' am' }]), false, 'a one-letter capital is not shouting');
  assert.equal(isLoud([{ text: 'okay', id: 7 }], new Set(['7'])), true, 'a word the editor marked');
});

test('every look has the numbers the renderer and QA need, and the default is not the karaoke look', async () => {
  const { CAPTION_LOOKS } = await import('../src/core/captionLooks');
  const { CHAR_EM } = await import('../src/core/captionMetrics');
  const { defaultCaptions } = await import('../src/core/schemas');
  for (const l of Object.values(CAPTION_LOOKS)) {
    assert.ok(l.em > 0.3 && l.em < 0.9, `${l.key} em`);
    assert.equal(CHAR_EM[l.key], l.em);
    assert.ok(l.fontSize >= 50 && l.fontSize <= 120, `${l.key} size`);
  }
  assert.equal(defaultCaptions().style, 'street');
  assert.notEqual(CAPTION_LOOKS.street.highlight, 'word');
});
