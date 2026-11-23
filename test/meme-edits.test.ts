// The meme-edit vocabulary from reports/meme-edits-2026-11-22.md (user, 2026-11-22: "Yes, build them"): the
// tilt, the zoom-out reveal, black and white (a `filter` hook), the counter and the pointer, the premise box
// and chat card text looks, the caption repeat counter "X3", four new sounds, and the meme editor's rules
// that place them on the words and reactions.
import { DATA } from './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Candidate } from '../src/core/schemas';

const { memeSuggestions, failEnding, countdownIn, tintBeat, punchReactions, chatCardAt } = await import('../src/edit/editors');
const { pickChatLine, cardable } = await import('../src/edit/chatCard');
const { collapseRepeats, captionTokens } = await import('../src/composition/Captions');
const { filterAt, filterSpans, timeMarkers } = await import('../src/markers/define');
const { buildTimeMap } = await import('../src/core/timeline');
const { loadMarkerSchemas } = await import('../src/markers/registry-node');
const { tiltCover } = await import('../markers/tilt/render');
const { counterAt } = await import('../markers/counter/schema');
const { arrowTail } = await import('../markers/pointer/schema');
const { defaultCaptions } = await import('../src/core/schemas');
type EditorMetrics = import('../src/edit/editors').EditorMetrics;

const ctx = { frame: 0, durationInFrames: 30, fps: 30, width: 1080, height: 1920, markerId: 'm' };

test('tilt: rotates about the centre, scaled just enough that no corner shows', async () => {
  assert.equal(tiltCover(0, 1080, 1920), 1);
  assert.ok(Math.abs(tiltCover(6, 1080, 1920) - (Math.cos(Math.PI / 30) + (1920 / 1080) * Math.sin(Math.PI / 30))) < 1e-9);
  const { default: render } = await import('../markers/tilt/render');
  const snap = render.camera!({ degrees: -6, easing: 'snap', rampMs: 250 }, ctx);
  assert.match(snap, /^translate\(540px, 960px\) rotate\(-6deg\) scale\(1\.18\d*\) translate\(-540px, -960px\)$/);
  const eased = render.camera!({ degrees: 6, easing: 'smooth', rampMs: 250 }, ctx);
  assert.match(eased, /rotate\(0deg\) scale\(1\)/, 'smooth starts level');
});

test('zoom out: starts zoomed in and is back to the whole picture after its ramp', async () => {
  const { default: render } = await import('../markers/zoom/render');
  const p = { scale: 1.3, easing: 'smooth' as const, rampMs: 700, focusX: 0.5, focusY: 0.5, direction: 'out' as const };
  assert.match(render.camera!(p, ctx), /scale\(1\.3\)$/);
  assert.match(render.camera!(p, { ...ctx, frame: 25 }), /scale\(1\)$/);
  assert.match(render.camera!({ ...p, direction: 'in' }, { ...ctx, frame: 15 }), /scale\(1\.3\)$/, 'in still pushes in');
});

test('black and white: a filter on the picture that drains over its ramp, on the edited timeline', async () => {
  const types = await loadMarkerSchemas();
  const typeOf = (t: string) => types.get(t);
  const mono = types.get('mono')!;
  assert.equal(mono.filter!({ amount: 1, rampMs: 300, contrast: 0.15 } as never, 0), 'grayscale(0.000) contrast(1.000)');
  assert.equal(mono.filter!({ amount: 1, rampMs: 300, contrast: 0.15 } as never, 600), 'grayscale(1.000) contrast(1.150)');
  const markers = [
    { id: 'c', type: 'cut', startMs: 101_000, endMs: 103_000, params: { transition: 'none' } },
    { id: 'b', type: 'mono', startMs: 108_000, endMs: 110_000, params: {} },
  ];
  const map = buildTimeMap({ startMs: 100_000, endMs: 120_000 }, timeMarkers(markers, typeOf));
  const spans = filterSpans(markers, typeOf, map);
  assert.equal(filterAt(spans, 5_900), '', 'before it (the cut moved it 2 s earlier)');
  assert.match(filterAt(spans, 6_500), /^grayscale\(1\.000\)/);
});

test('counter: steps from one number to another and stays on the last; the stopwatch reads seconds', () => {
  const p = { mode: 'count' as const, from: 3, to: 1, stepMs: 800 };
  assert.deepEqual([0, 900, 1700, 5000].map((ms) => counterAt(p, ms).text), ['3', '2', '1', '1']);
  assert.equal(counterAt({ ...p, from: 0, to: 10 }, 2500).text, '3', 'counting up');
  assert.equal(counterAt({ ...p, mode: 'stopwatch' }, 1970).text, '01.97');
});

test('pointer: the arrow comes from its angle and ends on the point', () => {
  const r = arrowTail({ x: 0.5, y: 0.5, angle: 0, size: 200 }, 1080, 1920);
  assert.deepEqual([r.hx, r.hy, Math.round(r.tx), Math.round(r.ty)], [540, 960, 740, 960]);
  const up = arrowTail({ x: 0.5, y: 0.5, angle: 270, size: 200 }, 1080, 1920);
  assert.equal(Math.round(up.ty), 760, 'from above');
});

test('captions: a line said three or more times is one caption with X3, shown until the last repeat ends', () => {
  const w = (text: string, s: number) => ({ text, t0: s * 1000, t1: s * 1000 + 300 });
  const sit = collapseRepeats([w('Sit', 0), w('down.', 0.4), w('Sit', 1), w('down.', 1.4), w('Sit', 2), w('down!', 2.4), w('okay', 3)]);
  assert.deepEqual(sit.map((x) => x.text), ['Sit', 'down X3', 'okay']);
  assert.equal(sit[1].t1, 2700, 'held to the end of the last "down"');
  assert.deepEqual(collapseRepeats([w('What?', 0), w('What?', 0.5), w('What?!', 1)]).map((x) => x.text), ['What X3']);
  assert.deepEqual(collapseRepeats([w('no', 0), w('no', 0.5), w('way', 1)]).map((x) => x.text), ['no', 'no', 'way'], 'twice is not a run');
  const words = ['go', 'go', 'go', 'go'].map((text, i) => ({ i, text, startMs: 100_000 + i * 400, endMs: 100_000 + i * 400 + 300 }));
  const map = buildTimeMap({ startMs: 100_000, endMs: 110_000 }, []);
  assert.deepEqual(captionTokens(words, { ...defaultCaptions(), repeats: true }, map).map((t) => t.text), ['go X4']);
  assert.equal(captionTokens(words, { ...defaultCaptions(), repeats: false }, map).length, 4);
});

test("chat card: the line chat echoed, readable and safe; one person's line only when it reacts", () => {
  const msg = (s: number, user: string, text: string): [number, string, string] => [s * 1000, user, text];
  const chat = [
    msg(1, 'nightbot', 'Follow the stream for more content today'),
    msg(2, 'a', 'Greenland is crazy check it out'),
    msg(3, 'b', 'greenland is crazy check it out'),
    msg(4, 'c', 'KEKW KEKW KEKW KEKW'),
    msg(5, 'd', 'go to www.example.com for free stuff'),
    msg(6, 'e', 'he is so retarded lmao'),
  ];
  const line = pickChatLine(chat, 0, 10_000)!;
  assert.equal(line.user, 'a');
  assert.equal(line.echoes, 2);
  assert.equal(pickChatLine([msg(1, 'x', 'what a fucking play LMAO')], 0, 10_000)?.text, 'what a f***ing play LMAO', 'a reacting line, with the swear masked');
  assert.equal(pickChatLine([msg(1, 'x', 'I am eating dinner right now')], 0, 10_000), null, 'one person, no reaction');
  assert.ok(!cardable('KEKW KEKW KEKW KEKW'));
  assert.ok(!cardable('LUL LUL LUL'), 'three-letter emotes are emotes too');
  assert.ok(!cardable('go go go go go'), 'one word repeated is not a sentence');
  assert.ok(cardable('THATS CRAZY BRO NO WAY'), 'all caps is how chat writes');
  assert.ok(!cardable('he is so retarded lmao'));
  assert.ok(!cardable('send nudes to the chat now'));
});

const metrics = (over: Partial<EditorMetrics> = {}): EditorMetrics => ({
  clipWords: [], skips: [], chatLine: null, split: false, hookY: 0.18, hookStyle: 'street', durationMs: 30_000, durationS: 30, words: 60,
  firstWordMs: 100_300, lastWordMs: 129_000, firstWordRelMs: 300, lastWordRelMs: 29_000, endsQuestion: false, laughs: 1, screams: 2,
  reactions: [{ kind: 'shout', ms: 106_000, endMs: 107_000 }, { kind: 'laugh', ms: 108_000, endMs: 109_000 }, { kind: 'shout', ms: 113_000, endMs: 114_000 }, { kind: 'shout', ms: 119_000, endMs: 120_000 }, { kind: 'shout', ms: 125_000, endMs: 126_000 }],
  reactionMs: 106_000, reactionKind: 'shout', punchMs: 105_400, punchWord: 'jump', keyLineMs: null, keyLineEndMs: null, deadAirMs: 0, deadAirGaps: [], comicPauses: [],
  captions: true, hasHookText: false, currentMarkers: [], signalChat: 0, signalAudio: 0, signalClips: 0, rendered: false, qaPassed: false, qaWarnings: [], ...over,
});
const cand = { hook: 'Speed tries the jump nobody makes.', title: 'T' } as unknown as Candidate;
const START = 100_000;

test('meme editor: a snap zoom on up to 3 reactions 5 s apart, a tilt with it on a shout (alternating sides)', () => {
  const m = metrics();
  assert.deepEqual(punchReactions(m, START).map((r) => r.ms), [106_000, 113_000, 119_000]);
  const s = memeSuggestions(m, cand, START).suggestions;
  const zooms = s.filter((x) => x.type === 'zoom' && x.params.direction !== 'out');
  const tilts = s.filter((x) => x.type === 'tilt');
  assert.equal(zooms.length, 3);
  assert.deepEqual(tilts.map((x) => x.params.degrees), [6, -6, 6]);
  assert.deepEqual(tilts.map((x) => x.startMs), zooms.map((x) => x.startMs), 'each tilt rides its zoom');
});

test('meme editor: the premise box opens the clip, in TikTok style with an emoji, gone before the hit', () => {
  const box = memeSuggestions(metrics({ punchMs: 108_000, reactionMs: 108_500 }), cand, START).suggestions.find((x) => x.type === 'text' && x.params.style === 'box')!;
  assert.equal(box.params.text, 'Speed tries the jump nobody makes 😱');
  assert.equal(box.startMs, START);
  assert.equal(box.endMs, START + 3500);
  const early = memeSuggestions(metrics({ punchMs: 103_000, reactionMs: 103_500 }), cand, START).suggestions.find((x) => x.params.style === 'box')!;
  assert.equal(early.endMs, 103_000 - 300, 'gone 0.3 s before the punch word');
});

test('meme editor: a fail ending holds the last frame and drains it; not when it would pass a minute', () => {
  const words = [{ text: 'and', startMs: 126_000, endMs: 126_200 }, { text: 'died.', startMs: 128_000, endMs: 128_400 }];
  assert.deepEqual(failEnding({ clipWords: words }, 130_000), { word: 'died.', ms: 128_000 });
  const s = memeSuggestions(metrics({ clipWords: words }), cand, START).suggestions;
  assert.equal(s.find((x) => x.type === 'freeze')?.startMs, 129_880);
  assert.deepEqual(s.filter((x) => x.type === 'mono').map((x) => [x.startMs, x.endMs]), [[129_600, 130_000]]);
  assert.ok(!memeSuggestions(metrics({ clipWords: words, durationMs: 59_000, durationS: 59 }), cand, START).suggestions.some((x) => x.type === 'freeze'), '59 s + 1 s is over a minute');
  assert.equal(failEnding({ clipWords: [{ text: 'died', startMs: 110_000, endMs: 110_300 }] }, 130_000), null, 'a death mid-clip is not the ending');
});

test('meme editor: one tint beat (green on a win, pink on affection), a counter on "three, two, one", a time-skip card on a long cut', () => {
  const w = (text: string, s: number) => ({ text, startMs: START + s * 1000, endMs: START + s * 1000 + 300 });
  assert.deepEqual(tintBeat([w('we', 4), w('won!', 4.5)], START + 1500)?.color, '#22c55e');
  assert.equal(tintBeat([w('I', 4), w('love', 4.3), w('this', 4.6)], START + 1500)?.color, '#ff4fa3');
  assert.equal(tintBeat([w('won', 0.5)], START + 1500), null, 'not in the open');
  const count = countdownIn([w('okay', 1), w('three,', 2), w('two,', 2.8), w('one!', 3.6), w('go', 4)]);
  assert.deepEqual(count, { from: 3, to: 1, startMs: START + 2000, endMs: START + 3600 + 300 + 600, stepMs: 800 });
  assert.equal(countdownIn([w('1', 1), w('2', 2), w('3', 3)]), null, 'counting up is not a countdown');
  const s = memeSuggestions(metrics({ clipWords: [w('three', 2), w('two', 2.8), w('one', 3.6)], skips: [{ startMs: 110_000, endMs: 135_000 }] }), cand, START).suggestions;
  assert.equal(s.find((x) => x.type === 'counter')?.params.from, 3);
  assert.equal(s.find((x) => x.type === 'text' && /LATER/.test(String(x.params.text)))?.params.text, '*25 SECONDS LATER*');
});

test('meme editor: a chat card after the premise box, clear of the end; a reveal only on a silent open', () => {
  const s = memeSuggestions(metrics({ chatLine: { user: 'sunburst', text: 'Greenland is crazy', ms: 118_000, echoes: 3 } }), cand, START).suggestions;
  const card = s.find((x) => x.params.style === 'chat')!;
  assert.equal(card.params.text, 'sunburst: Greenland is crazy');
  assert.equal(card.startMs, 112_000, 'six seconds before chat said it (chat trails the moment)');
  assert.ok(!s.some((x) => x.params.direction === 'out'), 'the clip opens on a word: no reveal');
  const cut = memeSuggestions(metrics({ chatLine: { user: 'sunburst', text: 'Greenland is crazy', ms: 118_000, echoes: 3 }, skips: [{ startMs: 111_000, endMs: 113_000 }] }), cand, START).suggestions.find((x) => x.params.style === 'chat')!;
  assert.equal(cut.startMs, 113_100, 'moved past the cut so all of it shows');
  assert.equal(chatCardAt(5000, 2200, [{ startMs: 4000, endMs: 9000 }], 3800, 10_000), null, 'no room anywhere');
  const quiet = memeSuggestions(metrics({ firstWordRelMs: 1500, firstWordMs: 101_500 }), cand, START).suggestions;
  assert.ok(quiet.some((x) => x.type === 'zoom' && x.params.direction === 'out' && x.startMs === START));
});

test('running the meme editor again keeps its premise box (it no longer sees its own old box as "a hook is there")', async () => {
  const { applyEditorSuggestions } = await import('../src/edit/editors');
  const { saveProject, loadProject } = await import('../src/core/project');
  const { writeJson, paths } = await import('../src/core/paths');
  const VID = 'tw-memebox';
  const words = ['okay', 'watch', 'this', 'jump', 'right', 'here'].map((text, i) => ({ i, text, startMs: 100_300 + i * 900, endMs: 100_300 + i * 900 + 500 }));
  writeJson(paths.videoFile(VID, 'meta.json'), { id: VID, url: '', platform: 'twitch', title: 'T', channel: 'C', durationMs: 600_000, hasHeatmap: false, chapters: [], heatmap: [], captions: 'none', commentCount: 0, ingestedAt: '' });
  writeJson(paths.videoFile(VID, 'transcript.json'), { videoId: VID, source: 'whisper', lang: 'en', words, tags: [] });
  writeJson(paths.videoFile(VID, 'audio-events.json'), { durationMs: 600_000, windowMs: 1500, hopMs: 750, events: [{ ms: 108_000, label: 'laughter', confidence: 0.9 }, { ms: 108_750, label: 'laughter', confidence: 0.9 }] });
  writeJson(paths.videoFile(VID, 'candidates.json'), { videoId: VID, candidates: [{ id: 'c01', startMs: 100_000, endMs: 120_000, title: 'He tries the jump', reason: 'r', hook: 'He swears he can make this jump', quote: 'watch this jump', lens: 'stream-moments', score: 7, signals: {}, why: [], warnings: [], status: 'made', createdAt: '' }] });
  saveProject({ version: 1, rev: 0, id: 'mb1', videoId: VID, candidateId: 'c01', title: 'T', sourceDurationMs: 600_000, fps: 30, segments: [{ startMs: 100_000, endMs: 120_000 }], markers: [], captions: { ...defaultCaptions(), enabled: true }, framing: { mode: 'blur', cropX: 0.5, zoom: 1 } as never, createdAt: '', updatedAt: '' });
  const box = () => loadProject('mb1').markers.filter((m) => m.source === 'editor:meme' && m.params.style === 'box').map((m) => m.params.text);
  await applyEditorSuggestions('mb1', 'meme');
  assert.deepEqual(box(), ['He tries the jump 😂'], 'the 7-word hook is over 6 words: the title is the box');
  await applyEditorSuggestions('mb1', 'meme');
  assert.deepEqual(box(), ['He tries the jump 😂'], 'still there after the re-run');
});

test('the new marker types load, and the four new sounds are in assets/sfx', async () => {
  const types = await loadMarkerSchemas();
  for (const t of ['tilt', 'mono', 'counter', 'pointer']) assert.ok(types.get(t), t);
  for (const style of ['box', 'chat']) assert.equal(types.get('text')!.params.safeParse({ style }).success, true, style);
  for (const f of ['air-horn', 'record-scratch', 'glass-break', 'boing']) assert.ok(fs.statSync(path.join('assets', 'sfx', `${f}.wav`)).size > 10_000, f);
  assert.ok(DATA);
});
