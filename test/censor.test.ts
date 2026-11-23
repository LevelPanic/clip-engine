// Change 3 of docs/research/censorship-review-2026-11-22.md (user, 2026-11-22): captions mask strong swears
// and slurs by default (B1), QA measures swearing (A4), a bleep marker mutes the clip's sound over a word
// and `clip censor` places it (B2), and a blur marker hides part of the picture (B3). A word under a
// bleep is not said, so it no longer trips the never-post slur rule or the careful period's open f-word.
import { DATA } from './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Project } from '../src/core/schemas';

const { maskSwearing, swearIn } = await import('../src/core/risk');
const { captionText } = await import('../src/composition/Captions');
const { censorTargets, censorSpans, censorClip, CENSOR_SOURCE } = await import('../src/edit/censor');
const { checkLanguage, languageWarnings } = await import('../src/qa/language');
const { checkUnsafe, checkCareful } = await import('../src/qa/unsafe');
const { wordsThatPlay } = await import('../src/qa/adult');
const { gainAt, gainSpans } = await import('../src/markers/define');
const { buildTimeMap } = await import('../src/core/timeline');
const { loadMarkerSchemas } = await import('../src/markers/registry-node');
const { defaultCaptions, defaultFraming, CaptionSettingsSchema } = await import('../src/core/schemas');
const { saveProject, loadProject } = await import('../src/core/project');
const { writeJson, paths } = await import('../src/core/paths');

test('captions mask strong swears at the root and slurs whole; ordinary words that contain them are left alone', () => {
  assert.equal(maskSwearing('what the FUCK, bro'), 'what the F***, bro');
  assert.equal(maskSwearing('fucking motherfucker'), 'f***ing motherf***er');
  assert.equal(maskSwearing('that is bullshit! shitty'), 'that is bulls***! s***ty');
  assert.equal(maskSwearing('you bitch, asshole'), 'you b****, a**hole');
  assert.equal(maskSwearing('you are retarded'), 'you are ********');
  for (const fine of ['shiitake', 'Scunthorpe', 'Dickens', 'assassin', 'class', 'he sped past', 'damn hell crap ass']) assert.equal(maskSwearing(fine), fine);
  assert.equal(swearIn('Fuckin'), 'f-word');
  assert.equal(swearIn('bullshit.'), 's-word');
  assert.equal(swearIn('fun'), undefined);
});

test('a caption is masked unless the clip turned censor off; a project from before the setting masks too', () => {
  const w = { i: 3, text: 'fucking', startMs: 0, endMs: 300 };
  assert.equal(captionText(w, {}), 'f***ing');
  assert.equal(captionText(w, {}, false), 'fucking');
  assert.equal(captionText({ ...w, text: '[__]' }, {}), '****');
  assert.equal(captionText(w, { '3': 'freaking' }), 'freaking', 'a fix is the text');
  const old = CaptionSettingsSchema.parse({ enabled: true, style: 'street', position: 0.7, fontSize: 96, uppercase: true, highlightColor: '#fff', combineMs: 900, fixes: {} });
  assert.equal(old.censor, true);
});

const word = (i: number, raw: string, atS: number, muted = false) => ({ i, raw, startMs: 100_000 + atS * 1000, endMs: 100_000 + atS * 1000 + 300, atMs: atS * 1000, muted });

test('censor targets: every slur, the f-words in the open by default, all swears or none on request; a bleeped word is skipped', () => {
  const words = [word(0, 'FUCK!', 0.8), word(1, 'he', 1.5), word(2, 'sped', 2), word(3, 'retarded', 6), word(4, 'fucking', 9), word(5, 'shit', 10), word(6, 'fuck', 1, true)];
  assert.deepEqual(censorTargets(words).map((h) => [h.word, h.why]), [['FUCK', 'f-word in the open'], ['retarded', 'slur']]);
  assert.deepEqual(censorTargets(words, { swears: 'all' }).map((h) => h.why), ['f-word', 'slur', 'f-word', 's-word']);
  assert.deepEqual(censorTargets(words, { swears: 'none' }).map((h) => h.why), ['slur']);
});

test('censor spans: each word padded 80 ms, kept inside the clip, and joined when they touch', () => {
  const hits = censorTargets([word(0, 'fuck', 0), word(1, 'fucking', 0.4), word(2, 'retarded', 6)], { swears: 'all' });
  const spans = censorSpans(hits, { startMs: 100_000, endMs: 106_200 });
  assert.equal(spans.length, 2);
  assert.deepEqual([spans[0].startMs, spans[0].endMs], [100_000, 100_780], 'starts at the clip, not before it; the two f-words are one bleep');
  assert.deepEqual([spans[1].startMs, spans[1].endMs], [105_920, 106_200], 'ends at the clip');
});

test('a bleep turns the clip sound to 0 over its span, on the edited timeline (a cut before it moves it)', async () => {
  const types = await loadMarkerSchemas();
  const typeOf = (t: string) => types.get(t);
  const seg = { startMs: 100_000, endMs: 120_000 };
  const bleep = { id: 'b', type: 'bleep', startMs: 105_000, endMs: 105_500, params: {} };
  const cut = { id: 'c', type: 'cut', startMs: 101_000, endMs: 102_000, params: { transition: 'none' } };
  const { timeMarkers } = await import('../src/markers/define');
  const map = buildTimeMap(seg, timeMarkers([cut], typeOf));
  const g = gainSpans([bleep, cut], typeOf, map);
  assert.equal(g.length, 1);
  assert.equal(gainAt(g, 4_200), 0, '5 s into the source is 4 s into the edit');
  assert.equal(gainAt(g, 3_900), 1);
  assert.equal(gainAt(g, 4_600), 1);
});

test('swearing in QA: heard, in the open, unmasked in the captions, in the title; bleeped words do not count as heard', () => {
  const w = (raw: string, atS: number, muted = false) => ({ raw, text: raw, atMs: atS * 1000, muted });
  const c = checkLanguage({ words: [w('fuck', 1.2), w('shit', 4), w('fucking', 8), w('fuck', 9, true)], captions: { enabled: true, censor: false }, title: 'Lirik says WHAT THE FUCK at a GTA NPC' });
  assert.deepEqual(c.heard, { 'f-word': 2, 's-word': 1 });
  assert.equal(c.bleeped, 1);
  assert.equal(c.openAtMs, 1200);
  assert.equal(c.captionsUnmasked, 3);
  assert.deepEqual(c.title, ['FUCK']);
  const out = languageWarnings(c);
  assert.equal(out[0], '3 strong swears heard (f-word ×2, s-word ×1), 1 bleeped');
  assert.match(out[1], /^an f-word is heard in the first 3 s \(at 0:01\.2\): the careful period holds it; `clip censor` bleeps it$/);
  assert.match(out[2], /unmasked \(captions\.censor is off\)$/);
  assert.equal(languageWarnings(checkLanguage({ words: [w('hello', 1)], captions: { enabled: true }, title: 'fine' })).length, 0);
});

test('clip censor on a clip: the bleeps clear the slur and the open f-word; a re-run replaces them; proposed bleeps mute nothing', async () => {
  const VID = 'tw-censor';
  const words = ['fuck', 'no', 'you', 'are', 'so', 'retarded', 'bro'].map((text, i) => ({ i, text, startMs: 100_500 + i * 1000, endMs: 100_500 + i * 1000 + 400 }));
  writeJson(paths.videoFile(VID, 'transcript.json'), { videoId: VID, source: 'whisper', lang: 'en', words, tags: [] });
  const project: Project = { version: 1, rev: 0, id: 'cs1', videoId: VID, title: 'T', sourceDurationMs: 600_000, fps: 30, segments: [{ startMs: 100_000, endMs: 120_000 }], markers: [], captions: { ...defaultCaptions(), enabled: true }, framing: defaultFraming(), createdAt: '', updatedAt: '', post: { title: 'Lirik crashes the car' } };
  saveProject(project);
  assert.deepEqual((await checkUnsafe('cs1')).reasons.map((r) => r.kind), ['slur']);
  assert.match((await checkUnsafe('cs1')).reasons[0].why, /bleep it \(`clip censor`\) or cut it out/);
  assert.deepEqual((await checkCareful('cs1', false)).map((r) => r.kind), ['swear-open']);

  const review = await censorClip('cs1', { review: true });
  assert.equal(review.hits.length, 2);
  assert.equal(loadProject('cs1').markers.length, 0, 'review changes nothing');

  const proposed = await censorClip('cs1', { propose: true });
  assert.equal(proposed.spans.length, 2);
  assert.ok(loadProject('cs1').markers.every((m) => m.proposed && m.source === CENSOR_SOURCE));
  assert.deepEqual((await checkUnsafe('cs1')).reasons.map((r) => r.kind), ['slur'], 'a proposed bleep is not in the export');

  const placed = await censorClip('cs1');
  assert.equal(placed.replaced, 2);
  const ms = loadProject('cs1').markers;
  assert.equal(ms.length, 2, 'the re-run replaced the proposed pass');
  assert.ok(ms.every((m) => m.type === 'bleep' && !m.proposed));
  assert.deepEqual((await checkUnsafe('cs1')).reasons, []);
  assert.deepEqual(await checkCareful('cs1', false), []);
  const heard = await wordsThatPlay('cs1');
  assert.deepEqual(heard.filter((w) => w.muted).map((w) => w.raw), ['fuck', 'retarded']);
  assert.ok(fs.existsSync(DATA));
});

test('the blur marker: a box in the frame, under the captions and the credit', async () => {
  const types = await loadMarkerSchemas();
  const blur = types.get('blur')!;
  const p = blur.params.parse({}) as { x: number; w: number; look: string };
  assert.equal(p.look, 'blur');
  assert.ok(p.x + p.w <= 1);
  assert.ok((blur.zIndex ?? 0) < (types.get('credit')!.zIndex ?? 0) && (blur.zIndex ?? 0) < 20);
  assert.equal(types.get('bleep')!.gain?.({} as never, 0), 0);
});
