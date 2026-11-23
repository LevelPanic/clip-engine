// The split facecam/gameplay layout: the ffmpeg filter strings and facecam detection on fixed faces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framingFilter } from '../src/render/framing';
import { findFacecam } from '../src/reframe/cam';
import { defaultFraming } from '../src/core/schemas';
import type { FaceBox, FaceResult } from '../src/reframe/faces';

const splitFraming = () => ({
  ...defaultFraming(),
  mode: 'split' as const,
  split: { cam: { x: 0, y: 0, w: 0.36, h: 0.36 }, game: { x: 0.26, y: 0, w: 0.48, h: 1 }, camShare: 0.35, canvasPad: 0 },
});

test('split framing puts a 35% facecam band over the gameplay, on the blurred cover', () => {
  const g = framingFilter(splitFraming());
  assert.match(g, /^\[0:v\]split=3\[spb\]\[spc\]\[spg\];\[spb\]scale=324:576.*gblur.*scale=1080:1920\[spbg\]/); // the cover underneath
  assert.match(g, /crop=iw\*0\.3600:ih\*0\.3600:iw\*0\.0000:ih\*0\.0000/); // the cam box
  assert.match(g, /scale=1080:672:force_original_aspect_ratio=increase,crop=1080:672:\(iw-1080\)\/2:0\[cam\]/); // top-aligned cam
  assert.match(g, /scale=1080:1248:force_original_aspect_ratio=increase,crop=1080:1248\[game\]/); // the rest
  assert.match(g, /\[spbg\]\[cam\]overlay=0:0\[spt\];\[spt\]\[game\]overlay=0:672,fps=30,format=yuv420p\[v\]$/);
  assert.doesNotMatch(g, /black|vstack/);
});

test('the canvas margin shows the blurred cover, never black', () => {
  const f = { ...splitFraming(), split: { ...splitFraming().split, canvasPad: 0.04 } };
  const g = framingFilter(f);
  assert.doesNotMatch(g, /pad=|black/);
  assert.match(g, /\[spbg\]\[cam\]overlay=0:76\[spt\]/); // 0.04 × 1920 = 76.8 → 76
  assert.match(g, /\[spt\]\[game\]overlay=0:694/); // under a 618 px cam band
  assert.match(g, /crop=iw\*0\.5283/); // the game window widened from 0.48 to fill the shorter band
});

test('the cam band is cropped into the panel, never widened out of it', () => {
  // a 4:3 panel in a band whose shape is wider than 4:3: the old renderer widened the box and showed
  // the game beside the face; now the box stays the panel and the cover fit crops its bottom
  const f = { ...splitFraming(), split: { ...splitFraming().split, cam: { x: 0.05, y: 0.06, w: 0.25, h: 0.3 }, camTopPad: 0 } };
  const g = framingFilter(f);
  assert.match(g, /\[spc\]crop=iw\*0\.2500:ih\*0\.3000:iw\*0\.0500:ih\*0\.0600,scale=1080:672:force_original_aspect_ratio=increase,crop=1080:672:\(iw-1080\)\/2:0\[cam\]/);
});

test('a whole-frame split shows the full 16:9 frame under the cam', () => {
  const f = { ...splitFraming(), split: { ...splitFraming().split, content: 'fit' as const, canvasPad: 0.04 } };
  const g = framingFilter(f);
  assert.match(g, /\[spg\]crop=iw\*1\.0000:ih\*1\.0000:iw\*0\.0000:ih\*0\.0000,scale=1080:608:force_original_aspect_ratio=increase,crop=1080:608\[game\]/);
  assert.match(g, /\[spt\]\[game\]overlay=0:694/);
});

test('the cam band adds headroom above the box and crops from the top', () => {
  const f = { ...splitFraming(), split: { ...splitFraming().split, cam: { x: 0, y: 0.5, w: 0.36, h: 0.2 }, camTopPad: 0.04 } };
  const g = framingFilter(f);
  assert.match(g, /crop=iw\*0\.3600:ih\*0\.2400:iw\*0\.0000:ih\*0\.4600/); // 0.5 - 0.04, 0.2 + 0.04
  assert.match(g, /crop=1080:672:\(iw-1080\)\/2:0/); // top of the padded box stays
});

test('blur-fit is still a single branch when nothing changes', () => {
  assert.match(framingFilter(defaultFraming()), /^\[0:v\]split=2\[a\]\[b\];/);
});

test('a crop pan stays one branch with the crop-x expression', () => {
  const f = { ...defaultFraming(), mode: 'crop' as const };
  const g = framingFilter(f, [{ atMs: 2_000, mode: 'crop', cropX: 0.2, easeMs: 500 }], 0);
  assert.match(g, /^\[0:v\]scale=/);
  assert.match(g, /if\(lt\(t,2\.000\),0\.5/);
  assert.doesNotMatch(g, /overlay=0:0:enable/);
});

test('switching from split to crop overlays the crop only for its span', () => {
  const g = framingFilter(splitFraming(), [{ atMs: 5_000, mode: 'crop', cropX: 0.3, easeMs: 0 }], 0);
  assert.match(g, /^\[0:v\]split=4/); // blur (2 inputs), crop, split
  assert.match(g, /\[bf\]\[cr\]overlay=0:0:enable='gte\(t,5\.000\)'\[o0\]/); // crop from 5 s on
  assert.match(g, /\[o0\]\[sp\]overlay=0:0:enable='between\(t,0\.000,5\.000\)'/); // split before it
  assert.match(g, /\[o1\]fps=30,format=yuv420p\[v\]$/); // no empty filter after the last label
  assert.doesNotMatch(g, /\],fps=/);
});

test('a reframe at the clip start replaces the base framing instead of adding a zero-length span', () => {
  const g = framingFilter(splitFraming(), [{ atMs: 0, mode: 'crop', cropX: 0.66, easeMs: 0 }], 0);
  assert.match(g, /^\[0:v\]scale=/);
  assert.doesNotMatch(g, /overlay=0:0:enable/);
});

// ---------- facecam detection ----------

function faces(box: FaceBox, n = 10): FaceResult {
  return {
    width: 1920,
    height: 1080,
    samples: Array.from({ length: n }, (_, i) => ({ ms: i * 500, faces: [{ ...box }] })),
  };
}

const overlapping = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('a face that stays in the top-left corner becomes the facecam', () => {
  const r = findFacecam(faces({ x: 0.02, y: 0.04, w: 0.13, h: 0.2, confidence: 0.9 }));
  assert.ok(r, 'split layout found');
  assert.ok(r.cam.x <= 0.03 && r.cam.y <= 0.03, `cam snapped to the corner: ${JSON.stringify(r.cam)}`);
  assert.ok(r.cam.w >= 0.3 && r.cam.h >= 0.3);
  // the gameplay pane is the 1080 × (1920 − cam band) aspect, and doesn't cover the cam
  assert.ok(Math.abs((r.game.w * 1920) / (r.game.h * 1080) - 1080 / (1920 * (1 - r.camShare))) < 0.02);
  assert.equal(overlapping(r.cam, r.game), false);
});

test('a bottom-right facecam pushes the gameplay pane to the left', () => {
  const r = findFacecam(faces({ x: 0.86, y: 0.82, w: 0.08, h: 0.11, confidence: 0.9 }));
  assert.ok(r);
  assert.ok(r.cam.x > 0.5 && r.cam.y > 0.5, `cam at the bottom right: ${JSON.stringify(r.cam)}`);
  assert.equal(overlapping(r.cam, r.game), false);
  assert.ok(r.game.x < 0.2, `game pane moved left: ${r.game.x}`);
});

test('a small face in a left-side webcam grows to the panel, not the whole frame', () => {
  // the face xQc's webcam actually produces in tw-2924308181 (1920×1080 source)
  const r = findFacecam(faces({ x: 0.108, y: 0.373, w: 0.047, h: 0.078, confidence: 0.8 }));
  assert.ok(r);
  assert.equal(r.cam.x, 0); // the panel is flush against the left border
  assert.ok(Math.abs(r.cam.w - 0.2) < 0.04 && Math.abs(r.cam.h - 0.2) < 0.04, `cam box ${JSON.stringify(r.cam)}`);
  assert.ok(Math.abs(r.cam.y - 0.37) < 0.05, `cam near the face's top: ${r.cam.y}`);
});

test('a detected webcam panel wins over the face-grown box', () => {
  const r: FaceResult = {
    width: 1920,
    height: 1080,
    samples: Array.from({ length: 10 }, (_, i) => ({
      ms: i * 500,
      faces: [{ x: 0.833, y: 0.464, w: 0.068, h: 0.121, confidence: 0.7 }],
      // the panel border is only detected in two frames; the face track covers the rest
      rects: i < 2 ? [{ x: 0.776, y: 0.339, w: 0.213, h: 0.321, confidence: 1 }] : [],
    })),
  };
  const split = findFacecam(r);
  assert.ok(split);
  // the panel (0.776, 0.339, 0.213 × 0.321) is squarer than the band, so the band shows a window of it
  // around the face: inside the panel's borders, never the gameplay beside or under it
  const c = split.cam;
  assert.ok(Math.abs(c.x - 0.776) < 0.02 && c.y >= 0.339 - 0.01, JSON.stringify(c));
  assert.ok(c.x + c.w <= 0.776 + 0.213 + 0.01 && c.y + c.h <= 0.339 + 0.321 + 0.01, 'inside the panel');
  const fy = 0.464 + 0.121 / 2;
  assert.ok(fy > c.y && fy < c.y + c.h, 'the face is in the window');
});

test('a centred talking-head close-up is not a facecam', () => {
  assert.equal(findFacecam(faces({ x: 0.3, y: 0.25, w: 0.4, h: 0.4, confidence: 0.9 })), null);
});

test('a face seen once is not a facecam', () => {
  const r: FaceResult = {
    width: 1920,
    height: 1080,
    samples: Array.from({ length: 10 }, (_, i) => ({
      ms: i * 500,
      faces: i === 3 ? [{ x: 0.02, y: 0.04, w: 0.13, h: 0.2, confidence: 0.9 }] : [],
    })),
  };
  assert.equal(findFacecam(r), null);
});
