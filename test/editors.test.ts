// The meme and expert editors: they find the moments first (the laugh, the word before it, the quoted
// line, the pauses) and place edits on them, and they leave captions and the review note alone.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate, Project, Word } from '../src/core/schemas';

const { memeScore, expertScore, memeSuggestions, expertSuggestions, clipMetrics, hookText, applyEditorSuggestions, cuttableGaps } = await import('../src/edit/editors');
const { defaultCaptions, defaultFraming } = await import('../src/core/schemas');
const { paths, writeJson } = await import('../src/core/paths');
const { saveProject, loadProject } = await import('../src/project');
type EditorMetrics = import('../src/edit/editors').EditorMetrics;

const metrics = (over: Partial<EditorMetrics> = {}): EditorMetrics => ({
  clipWords: [],
  skips: [],
  chatLine: null,
  split: false,
  hookY: 0.18,
  hookStyle: 'hook',
  durationMs: 30_000,
  durationS: 30,
  words: 60,
  firstWordMs: 100_900,
  lastWordMs: 129_000,
  firstWordRelMs: 900,
  lastWordRelMs: 29_000,
  endsQuestion: false,
  laughs: 3,
  screams: 2,
  reactions: [{ kind: 'laugh', ms: 112_000, endMs: 113_500 }],
  reactionMs: 112_000,
  reactionKind: 'laugh',
  punchMs: 111_200,
  punchWord: 'dribble',
  keyLineMs: 108_000,
  keyLineEndMs: 111_500,
  deadAirMs: 0,
  deadAirGaps: [],
  comicPauses: [],
  captions: true,
  hasHookText: true,
  currentMarkers: [],
  signalChat: 0.8,
  signalAudio: 0.7,
  signalClips: 0.5,
  rendered: true,
  qaPassed: true,
  qaWarnings: [],
  ...over,
});

const cand = { hook: 'He baited everybody.', title: 'Test clip', quote: 'what was that dribble', signals: { chat: 0.8 } } as unknown as Candidate;
const START = 100_000;

test('meme score likes short, loud, chat-heavy clips', () => {
  const loud = memeScore(metrics({ laughs: 6, screams: 5, durationS: 18 }));
  const quiet = memeScore(metrics({ laughs: 0, screams: 0, durationS: 58 }));
  assert.ok(loud > quiet, `${loud} vs ${quiet}`);
  assert.ok(loud >= 60);
});

test('expert score penalizes a late first word, dead air and an ending question', () => {
  const clean = expertScore(metrics());
  const messy = expertScore(metrics({ firstWordRelMs: 4000, deadAirMs: 3000, endsQuestion: true }));
  assert.ok(clean > messy, `${clean} vs ${messy}`);
  assert.ok(clean >= 70);
  assert.equal(expertScore(metrics({ captions: false })), clean, 'captions are the subtitle expert\'s call, not part of this score');
});

test('the meme punch-in lands on the punch word and the emoji on the reaction, not at a fixed fraction of the clip', () => {
  const { suggestions } = memeSuggestions(metrics({ hasHookText: false, deadAirGaps: [{ startMs: 104_000, endMs: 106_000 }] }), cand, START);
  const zoom = suggestions.find((x) => x.type === 'zoom')!;
  const emoji = suggestions.find((x) => x.type === 'emoji')!;
  const flash = suggestions.find((x) => x.type === 'flash')!;
  const text = suggestions.find((x) => x.type === 'text')!;
  assert.equal(zoom.startMs, 111_200);
  assert.match(zoom.why, /"dribble".*laugh/);
  assert.equal(emoji.startMs, 112_150);
  assert.equal(emoji.params.emoji, '😂');
  assert.equal(flash.startMs, 111_200);
  assert.ok(text.endMs! <= 111_200 - 300, 'the hook text is gone before the hit');
  assert.ok(suggestions.some((x) => x.type === 'cut' && x.startMs === 104_080));
  assert.equal(memeSuggestions(metrics({ reactionKind: 'shout' }), cand, START).suggestions.find((x) => x.type === 'emoji')!.params.emoji, '😱');
});

test('with no reaction heard, the meme editor places no punch-in and says so', () => {
  const r = memeSuggestions(metrics({ reactions: [], reactionMs: null, reactionKind: null, punchMs: null, punchWord: null }), cand, START);
  // a punch-in is a zoom in; the reveal at a silent open (direction out) is not one
  assert.ok(!r.suggestions.some((x) => ['zoom', 'emoji', 'flash', 'tilt'].includes(x.type) && x.params.direction !== 'out'));
  assert.ok(r.notes.some((n) => /no laugh or scream heard/.test(n)));
});

test('a long run-up is sped in the middle, never right before the hit', () => {
  const far = memeSuggestions(metrics({ reactionMs: 120_000, punchMs: 119_000 }), cand, START).suggestions.find((x) => x.type === 'speed')!;
  assert.ok(far.startMs >= START + 3000 && far.endMs! <= 120_000 - 3000, `${far.startMs}–${far.endMs}`);
  assert.equal(memeSuggestions(metrics(), cand, START).suggestions.find((x) => x.type === 'speed'), undefined, 'a 12 s run-up is not long');
});

test('expert edits: trim the silent open, cut dead air, context hook, push in on the quoted line', () => {
  const { suggestions, notes } = expertSuggestions(metrics({ firstWordRelMs: 2500, firstWordMs: 102_500, hasHookText: false, deadAirGaps: [{ startMs: 110_000, endMs: 111_000 }], endsQuestion: true, captions: false }), cand, START);
  assert.ok(suggestions.some((x) => x.type === 'cut' && x.startMs === START && x.endMs === 102_300));
  assert.ok(suggestions.some((x) => x.type === 'text'));
  const zoom = suggestions.find((x) => x.type === 'zoom')!;
  assert.equal(zoom.startMs, 108_000, 'on the key line, not at 30% of the clip');
  assert.ok(notes.some((n) => /ends on a question/.test(n)));
  assert.ok(notes.some((n) => /subtitle expert/.test(n)), 'captions are reported, not switched');
  // a scream before the first word is the open, not dead air
  const scare = expertSuggestions(metrics({ firstWordRelMs: 2500, firstWordMs: 102_500, reactions: [{ kind: 'shout', ms: 101_000, endMs: 102_500 }] }), cand, START);
  assert.ok(!scare.suggestions.some((x) => x.type === 'cut' && x.startMs === START));
});

test('hook text keeps a short hook whole and marks a shortened one', () => {
  assert.deepEqual(hookText({ hook: 'Wait for the dribble', title: 'x' } as Candidate), { text: 'Wait for the dribble', shortened: false });
  const long = hookText({ hook: 'He called the dagger, then completely forgot how to dribble a basketball', title: 'A very long descriptive title that goes on and on' } as Candidate);
  assert.equal(long.text, 'He called the dagger');
  assert.equal(long.shortened, true);
});

// ---------- metrics and applying, on a small made-up clip ----------

const VID = 'tw-3000000001';
const w = (i: number, text: string, startMs: number, endMs = startMs + 300): Word => ({ i, text, startMs, endMs });
// "So he pulls up" … [1.4 s pause] … "what was that dribble?" [beat] LAUGH … [3 s of nothing] … "anyway next game."
const words = [w(0, 'So', 100_500), w(1, 'he', 100_900), w(2, 'pulls', 101_300), w(3, 'up.', 101_700), w(4, 'what', 103_400), w(5, 'was', 103_800), w(6, 'that', 104_200), w(7, 'dribble?', 104_600, 105_000), w(8, 'anyway', 110_500), w(9, 'next', 110_900), w(10, 'game.', 111_300)];
const laugh = { windowMs: 1500, hopMs: 750, events: [{ ms: 106_200, label: 'laughter', confidence: 0.9 }, { ms: 106_950, label: 'laughter', confidence: 0.8 }, { ms: 108_000, label: 'gasp', confidence: 0.9 }] };
writeJson(paths.videoFile(VID, 'meta.json'), { id: VID, url: '', platform: 'twitch', title: 'T', channel: 'C', durationMs: 600_000, hasHeatmap: false, chapters: [], heatmap: [], captions: 'none', commentCount: 0, ingestedAt: '' });
writeJson(paths.videoFile(VID, 'transcript.json'), { videoId: VID, source: 'whisper', lang: 'en', words, tags: [] });
writeJson(paths.videoFile(VID, 'audio-events.json'), { durationMs: 600_000, ...laugh });
const project = (id: string, over: Partial<Project> = {}): Project => ({ version: 1, rev: 0, id, videoId: VID, title: 'T', sourceDurationMs: 600_000, fps: 30, segments: [{ startMs: 100_000, endMs: 118_000 }], markers: [], captions: { ...defaultCaptions(), enabled: false }, framing: defaultFraming(), createdAt: '', updatedAt: '', ...over });

test('metrics: the reaction, the word that set it off, real dead air and the comic pause', () => {
  const m = clipMetrics(project('m1'), cand, { words, tags: [] }, laugh);
  assert.equal(m.laughs, 1, 'two windows of one laugh are one laugh; a gasp is noise');
  assert.equal(m.reactionMs, 106_200);
  assert.equal(m.punchWord, 'dribble?');
  assert.equal(m.punchMs, 104_600);
  assert.equal(m.keyLineMs, 103_400, 'where the quote is said');
  // the 5.5 s gap after "dribble?" holds the laugh: only what is left once it dies down is dead air
  assert.deepEqual(m.deadAirGaps, [{ startMs: 102_000, endMs: 103_400 }, { startMs: 108_950, endMs: 110_500 }]);
  assert.deepEqual(m.comicPauses, []);
  assert.equal(m.rendered, false);
});

test('the silence that runs into a laugh is a comic pause, and is never cut', () => {
  const talk = [w(0, 'I', 200_000), w(1, 'am', 200_400), w(2, 'the', 200_800), w(3, 'best.', 201_200, 201_600), w(4, 'ok', 208_000)];
  const beat = { windowMs: 1500, hopMs: 750, events: [{ ms: 204_000, label: 'laughter', confidence: 0.9 }, { ms: 204_750, label: 'laughter', confidence: 0.9 }] };
  const m = clipMetrics(project('m2', { segments: [{ startMs: 199_000, endMs: 215_000 }] }), cand, { words: talk, tags: [] }, beat);
  assert.deepEqual(m.comicPauses, [{ startMs: 201_600, endMs: 203_500 }], 'the beat between the boast and the laugh');
  assert.deepEqual(m.deadAirGaps, [{ startMs: 206_750, endMs: 208_000 }], 'what is left after the laugh');
  const { suggestions, notes } = memeSuggestions(m, cand, 199_000);
  assert.ok(!suggestions.some((x) => x.type === 'cut' && x.startMs < 204_000), 'no cut before the laugh');
  assert.ok(notes.some((n) => /kept 1 pause/.test(n)));
});

test('applying leaves captions and the review note alone, and never stacks an edit on one that is there', async () => {
  saveProject(project('e1', { review: { status: 'changes', note: 'make the hook shorter', at: '2026-11-12T00:00:00Z' }, markers: [{ id: 'x1', type: 'cut', startMs: 102_100, endMs: 103_300, params: { transition: 'none' }, proposed: true, source: 'autoedit' }] }));
  const meme = await applyEditorSuggestions('e1', 'meme');
  const expert = await applyEditorSuggestions('e1', 'expert');
  const p = loadProject('e1');
  assert.equal(p.captions.enabled, false, 'the subtitle expert turned captions off; an editor must not turn them back on');
  assert.deepEqual(p.review, { status: 'changes', note: 'make the hook shorter', at: '2026-11-12T00:00:00Z' });
  const cuts = p.markers.filter((m) => m.type === 'cut');
  assert.equal(cuts.filter((m) => m.startMs < 104_000).length, 1, 'autoedit already cut the first gap: no second cut on it');
  assert.equal(cuts.length, 2, 'the silence after the laugh is a new cut, proposed once although both editors found it');
  assert.ok(cuts.every((a) => cuts.every((b) => a === b || a.endMs! <= b.startMs || b.endMs! <= a.startMs)), 'no two cuts overlap');
  assert.ok(meme.skipped >= 1);
  assert.equal(p.markers.filter((m) => m.type === 'zoom').length, 2, 'the punch-in and the push-in are different moments');
  assert.ok(p.markers.filter((m) => m.source?.startsWith('editor:')).every((m) => m.proposed));
  assert.ok(expert.review.notes.some((n) => /subtitle expert/.test(n)));
  // running an editor again replaces its own pass instead of adding to it
  const before = p.markers.length;
  const memeText = (q: ReturnType<typeof loadProject>) => q.markers.filter((m) => m.source === 'editor:meme' && m.type === 'text').map((m) => m.params.style);
  await applyEditorSuggestions('e1', 'meme');
  assert.equal(loadProject('e1').markers.length, before);
  assert.deepEqual(memeText(loadProject('e1')), memeText(p), 'the same text edits after a re-run');
});

test('the subtitle engine never turns captions back on by itself, and --no-settings leaves a hand-made look alone', async () => {
  const { applySubtitleFixes } = await import('../src/edit/subtitles');
  // someone looked at the frames, saw burned-in captions and turned ours off, with a raised position
  saveProject(project('s1', { captions: { ...defaultCaptions(), enabled: false, style: 'boxed', position: 0.68 } }));
  const first = await applySubtitleFixes('s1');
  assert.equal(first.review.decision.enabled, true, 'the engine, blind to frames, would caption this spoken clip');
  assert.equal(loadProject('s1').captions.enabled, false, 'but it does not overrule the decision');
  assert.ok(first.kept.some((k) => /stay OFF/.test(k)));
  assert.ok(first.changed.some((c) => /style boxed → street/.test(c)), 'the change it did make is reported');
  // word fixes only
  saveProject({ ...loadProject('s1'), captions: { ...loadProject('s1').captions, style: 'clean', position: 0.68 } });
  const wordsOnly = await applySubtitleFixes('s1', { settings: false });
  assert.deepEqual(wordsOnly.changed, []);
  assert.equal(loadProject('s1').captions.style, 'clean');
  assert.equal(loadProject('s1').captions.position, 0.68);
  // turning them back on is an explicit act
  await applySubtitleFixes('s1', { enable: true });
  assert.equal(loadProject('s1').captions.enabled, true);
});

test('cuts never take a clip under 15 s, and a scream at the open is not "nothing heard"', () => {
  // a 15.7 s scare clip with 7 s of silence in it: cutting all of it would leave under 9 s
  const scare = metrics({ durationMs: 15_700, durationS: 15.7, deadAirMs: 7000, deadAirGaps: [{ startMs: 104_000, endMs: 108_300 }, { startMs: 109_500, endMs: 112_200 }], reactions: [{ kind: 'shout', ms: 100_400, endMs: 101_900 }], reactionMs: null, reactionKind: null, punchMs: null, punchWord: null });
  assert.deepEqual(cuttableGaps(scare, 80).cuts, [], '0.7 s of room: neither gap fits');
  const r = memeSuggestions(scare, cand, START);
  assert.ok(!r.suggestions.some((x) => x.type === 'cut'));
  assert.ok(r.notes.some((n) => /left 7\.0 s of dead air.*under 15 s/.test(n)), r.notes.join(' | '));
  assert.ok(r.notes.some((n) => /the shout is in the first 1\.5 s: the open is the hit/.test(n)));
  assert.ok(!r.notes.some((n) => /no laugh or scream heard/.test(n)));
  // with room, the longest gaps go first and the budget is respected
  const roomy = cuttableGaps({ durationMs: 20_000, deadAirGaps: [{ startMs: 0, endMs: 2000 }, { startMs: 5000, endMs: 9000 }, { startMs: 12_000, endMs: 13_500 }] }, 100);
  assert.deepEqual(roomy.cuts, [{ startMs: 5100, endMs: 8900 }], '3.8 s fits in the 5 s of room; the 1.8 s gap after it does not');
  assert.equal(roomy.leftMs, 3500);
});

test('in a split layout the hook line goes under the seam, not across the creator\'s face', async () => {
  const { hookYFor } = await import('../src/edit/editors');
  assert.equal(hookYFor({ mode: 'blur' }), 0.18);
  assert.equal(hookYFor(undefined), 0.18);
  // the seam is under the canvas margin: (76 + 618) / 1920 = 0.361, and the line sits 0.075 below it
  assert.equal(hookYFor({ mode: 'split', split: { camShare: 0.35 } }), 0.436);
  assert.equal(hookYFor({ mode: 'split' }), 0.436);
  assert.equal(hookYFor({ mode: 'split', split: { camShare: 0.35, canvasPad: 0 } }), 0.425);
  assert.equal(hookYFor({ mode: 'split', split: { camShare: 0.8 } }), 0.6, 'never pushed into the captions');
});


test('clip intro rewrites the hook line in whatever style the look gave it, and never adds a second', async () => {
  const { setIntro } = await import('../src/edit/hook');
  // the editors put a street-style hook at the opening; an action line sits later in the clip
  saveProject(project('i1', { captions: { ...defaultCaptions(), style: 'street' }, markers: [
    { id: 'h1', type: 'text', startMs: 100_000, endMs: 102_600, params: { text: 'OLD HOOK', style: 'street', y: 0.436, fontSize: 78, animation: 'pop' }, source: 'editor:meme' },
    { id: 'a1', type: 'text', startMs: 110_000, endMs: 111_200, params: { text: '*TAKES A BITE*', style: 'street', y: 0.6, fontSize: 70, animation: 'pop' }, source: 'edit' },
  ] }));
  assert.equal((await setIntro('i1')).current, 'OLD HOOK');
  await setIntro('i1', { text: 'Nick waited 13 years for this' });
  const texts = loadProject('i1').markers.filter((m) => m.type === 'text');
  assert.equal(texts.length, 2, 'the hook was replaced, not doubled');
  assert.equal(texts.find((m) => m.id === 'h1')?.params.text, 'Nick waited 13 years for this');
  assert.equal(texts.find((m) => m.id === 'a1')?.params.text, '*TAKES A BITE*', 'the action line is not the hook');
  // a clip with no hook gets one in the look's style, under the seam rules
  saveProject(project('i2', { captions: { ...defaultCaptions(), style: 'commentary' } }));
  await setIntro('i2', { text: 'Ludwig grades a mattress quiz' });
  const added = loadProject('i2').markers.find((m) => m.type === 'text');
  assert.equal(added?.params.style, 'comment');
});
