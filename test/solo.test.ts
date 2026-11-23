// Facecam-only and game-only spans (docs/research/meme-edits-2026-11-22.md, rows 12: the facecam alone on the
// laugh in 21% of top clip Shorts, the stream alone in 16%; user, 2026-11-23: "yes, build them"). A `solo`
// span marker frames only itself and goes back to the split; it needs a split to pick from. The geometry is
// one function (soloGeometry) read by the Studio's CSS and the export's ffmpeg chain.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { framingKeys, framingAt, resolveKeys } = await import('../src/markers/define');
const { soloGeometry, splitGeometry, MAX_SOLO_ZOOM, CANVAS_W, CANVAS_H } = await import('../src/core/layout');
const { framingFilter, splitSpans } = await import('../src/render/framing');
const { loadMarkerSchemas } = await import('../src/markers/registry-node');
const { defaultFraming } = await import('../src/core/schemas');
const { memeSuggestions, lookCue } = await import('../src/edit/editors');
type EditorMetrics = import('../src/edit/editors').EditorMetrics;
type Candidate = import('../src/core/schemas').Candidate;

const types = await loadMarkerSchemas();
const typeOf = (t: string) => types.get(t);
const split = { ...defaultFraming(), mode: 'split' as const, split: { cam: { x: 0.74, y: 0.02, w: 0.24, h: 0.24 }, game: { x: 0.2, y: 0, w: 0.6, h: 1 }, camShare: 0.33, camTopPad: 0.04, canvasPad: 0.04 } };
const solo = (show: 'cam' | 'game', startMs: number, endMs: number) => ({ id: `s${startMs}`, type: 'solo', startMs, endMs, params: { show } });

test('a solo span is two keys, and its end goes back to the framing before it', () => {
  const keys = framingKeys([solo('cam', 105_000, 107_000)], typeOf);
  assert.deepEqual(keys.map((k) => [k.atMs, k.mode, !!k.solo, !!k.restore]), [[105_000, 'cam', true, false], [107_000, 'cam', false, true]]);
  assert.equal(framingAt(keys, split, 104_000).mode, 'split');
  assert.equal(framingAt(keys, split, 106_000).mode, 'cam');
  assert.equal(framingAt(keys, split, 107_500).mode, 'split', 'back to the split');
  // a reframe to crop before it: the span is not over a split, so it does nothing (and neither does its end)
  const crop = { id: 'r', type: 'reframe', startMs: 101_000, params: { mode: 'crop', cropX: 0.3, easeMs: 0 } };
  const k2 = framingKeys([crop, solo('cam', 105_000, 107_000)], typeOf);
  assert.equal(framingAt(k2, split, 106_000).mode, 'crop');
  assert.equal(framingAt(k2, split, 108_000).mode, 'crop');
  // a clip whose split fell back to blur-fit: no facecam-only anywhere
  assert.equal(framingAt(keys, { ...split, mode: 'blur' }, 106_000).mode, 'blur');
  assert.deepEqual(resolveKeys(keys, { mode: 'blur', cropX: 0.5 }), []);
});

test('facecam-only: the cam enlarged up to 3.5×, as wide as the canvas, centred; never wider than the cam', () => {
  const g = soloGeometry(split.split, 'cam', 1920, 1080);
  const pxW = 0.24 * 1920;
  const scale = g.width / (g.box.w * 1920);
  assert.ok(Math.abs(scale - Math.min(MAX_SOLO_ZOOM, CANVAS_W / (0.5 * pxW))) < 0.02, `scale ${scale}`);
  assert.equal(g.width, CANVAS_W);
  assert.ok(g.box.w <= 0.24 && g.box.w >= 0.12, 'at least half the cam width shows');
  assert.ok(Math.abs(g.top + g.height / 2 - CANVAS_H / 2) <= 1, 'centred');
  const inSplit = splitGeometry(split.split, 1920, 1080).cam;
  assert.ok(g.height > inSplit.height * 1.3, `bigger than in the split's band (${g.height} vs ${inSplit.height})`);
  // a big cam (a webcam-only stream) is not cropped past half its width, and fills the canvas width
  const big = soloGeometry({ ...split.split, cam: { x: 0.2, y: 0.1, w: 0.6, h: 0.8 } }, 'cam', 1920, 1080);
  assert.ok(big.box.w >= 0.3 - 1e-9 && big.width === CANVAS_W);
});

test('game-only: a fill split covers the canvas inside the margin; a fit split shows the whole frame', () => {
  const fill = soloGeometry(split.split, 'game', 1920, 1080);
  assert.deepEqual([fill.left, fill.width, fill.top, fill.height], [0, 1080, 76, 1768]);
  const fit = soloGeometry({ ...split.split, content: 'fit' }, 'game', 1920, 1080);
  assert.deepEqual([fit.width, fit.height, fit.box], [1080, 608, { x: 0, y: 0, w: 1, h: 1 }]);
});

test('the export: a split with a facecam-only span overlays the solo chain only while it lasts, and the face check skips it', () => {
  const keys = framingKeys([solo('cam', 105_000, 107_000), solo('game', 110_000, 112_000)], typeOf);
  const fg = framingFilter(split, keys, 100_000);
  assert.match(fg, /\[sc\]overlay=0:0:enable='between\(t,5\.000,7\.000\)'/);
  assert.match(fg, /\[sg\]overlay=0:0:enable='between\(t,10\.000,12\.000\)'/);
  assert.match(fg, /\[sp\]overlay=0:0:enable='between\(t,0\.000,5\.000\)\+between\(t,7\.000,10\.000\)\+gte\(t,12\.000\)'/);
  assert.deepEqual(splitSpans(split, keys, 100_000), [[0, 5], [7, 10], [12, Infinity]], 'the face check reads only the split');
  // over blur-fit it changes nothing: one blur chain, no branches
  assert.match(framingFilter({ ...split, mode: 'blur' }, keys, 100_000), /^\[0:v\]split=2\[a\]\[b\];/);
});

const metrics = (over: Partial<EditorMetrics> = {}): EditorMetrics => ({
  clipWords: [], skips: [], chatLine: null, split: true, hookY: 0.4, hookStyle: 'street', durationMs: 30_000, durationS: 30, words: 60,
  firstWordMs: 100_300, lastWordMs: 129_000, firstWordRelMs: 300, lastWordRelMs: 29_000, endsQuestion: false, laughs: 1, screams: 1,
  reactions: [{ kind: 'shout', ms: 106_000, endMs: 107_000 }, { kind: 'laugh', ms: 113_000, endMs: 115_000 }],
  reactionMs: 106_000, reactionKind: 'shout', punchMs: 105_400, punchWord: 'jump', keyLineMs: null, keyLineEndMs: null, deadAirMs: 0, deadAirGaps: [], comicPauses: [],
  captions: true, hasHookText: true, currentMarkers: [], signalChat: 0, signalAudio: 0, signalClips: 0, rendered: false, qaPassed: false, qaWarnings: [], ...over,
});
const cand = { hook: 'x', title: 'x' } as unknown as Candidate;

test('meme editor: in a split, the first laugh is the facecam alone (no zoom on it); "look at this" is the stream alone', () => {
  const w = (text: string, s: number) => ({ text, startMs: 100_000 + s * 1000, endMs: 100_000 + s * 1000 + 300 });
  const s = memeSuggestions(metrics({ clipWords: [w('look', 20), w('at', 20.3), w('this', 20.6)] }), cand, 100_000).suggestions;
  const solos = s.filter((x) => x.type === 'solo');
  assert.deepEqual(solos.map((x) => [x.params.show, x.startMs, x.endMs]), [['cam', 112_850, 115_400], ['game', 120_000, 122_000]]);
  assert.ok(!s.some((x) => x.type === 'zoom' && x.startMs >= 112_000 && x.startMs < 115_000), 'the laugh is the facecam, not a zoom');
  assert.ok(s.some((x) => x.type === 'zoom' && x.startMs === 105_400), 'the shout keeps its zoom');
  assert.equal(memeSuggestions(metrics({ split: false }), cand, 100_000).suggestions.filter((x) => x.type === 'solo').length, 0, 'no split, no solo');
  assert.deepEqual(lookCue([w('watch', 3), w('this', 3.3)], 101_500), { startMs: 103_000, text: 'watch this' });
  assert.equal(lookCue([w('look', 0.5), w('at', 0.8)], 101_500), null, 'not in the open');
  assert.equal(lookCue([w('look', 3), w('good', 3.3)], 101_500), null);
});
