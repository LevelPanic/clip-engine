// The split layout's geometry (src/core/layout.ts), the framed-picture check (src/qa/layout.ts) and
// the review's reject reasons.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { camShareFor, captionPositionForSplit, contentFitFor, splitGeometry, CAM_SHARE_MAX, CAM_SHARE_MIN, MAX_CAM_ZOOM } from '../src/core/layout';
import { deadShare, faceShareIn, layoutIssues, needsBlurFallback, DEAD_MAX, FACE_MIN } from '../src/qa/layout';
import { findFacecam, fitCamToBand } from '../src/reframe/cam';
import { DATA } from './helpers/sandbox';

const split = { cam: { x: 0, y: 0, w: 0.36, h: 0.36 }, game: { x: 0.26, y: 0, w: 0.48, h: 1 }, camShare: 0.35 };

// ---------- geometry ----------

test('the cam band is sized to the panel: a 16:9 panel gets about a third, a squarer one the most allowed', () => {
  // a 16:9 panel (0.3 × 0.3 of a 16:9 frame), no headroom: 1080 / (16/9) = 608 px of 1768 → 0.344
  assert.equal(camShareFor({ x: 0, y: 0.1, w: 0.3, h: 0.3 }, 1920, 1080, { camTopPad: 0 }), 0.344);
  // a 4:3 panel would need 810 px: capped, and the cover fit crops into it
  assert.equal(camShareFor({ x: 0, y: 0.1, w: 0.225, h: 0.3 }, 1920, 1080, { camTopPad: 0 }), CAM_SHARE_MAX);
  // a very wide strip: never thinner than the floor
  assert.equal(camShareFor({ x: 0, y: 0.1, w: 0.9, h: 0.2 }, 1920, 1080, { camTopPad: 0 }), CAM_SHARE_MIN);
});

test('a facecam found by the detector gets a band sized to its panel, not a fixed 35%', () => {
  const r = findFacecam({ width: 1920, height: 1080, samples: Array.from({ length: 10 }, (_, i) => ({ ms: i * 500, faces: [{ x: 0.02, y: 0.04, w: 0.13, h: 0.2, confidence: 0.9 }] })) });
  assert.ok(r);
  assert.equal(r.camShare, camShareFor(r.cam, 1920, 1080));
  assert.ok(r.camShare >= CAM_SHARE_MIN && r.camShare <= CAM_SHARE_MAX);
});

test('a panel a little taller than the band is cut around the face, not from its top', () => {
  // a 4:3-ish panel with the face low in it (leaning to a phone)
  const panel = { x: 0, y: 0.6, w: 0.221, h: 0.287 };
  const face = { x: 0.07, y: 0.78, w: 0.07, h: 0.11, confidence: 0.9 };
  const res = { width: 1920, height: 1080, samples: Array.from({ length: 8 }, (_, i) => ({ ms: i * 500, faces: [face] })) };
  const box = fitCamToBand(res, panel, CAM_SHARE_MAX);
  const cy = face.y + face.h / 2;
  assert.ok(box.y > panel.y, `moved down from the panel top: ${box.y}`);
  assert.ok(cy > box.y && cy < box.y + box.h, `the face (${cy}) is inside ${box.y}–${box.y + box.h}`);
  assert.ok(box.y + box.h <= panel.y + panel.h + 1e-9, 'still inside the panel');
  // with the 0.04 headroom the renderer adds above it, the window has the band's shape and fills the width
  assert.ok(Math.abs((box.w * 1920) / ((box.h + 0.04) * 1080) - 1080 / 742) < 0.02, 'the band shape');
  assert.equal(splitGeometry({ ...split, cam: box, camShare: CAM_SHARE_MAX }).cam.width, 1080);
});

test('a much taller or a small cam is shown whole in a narrower window, never enlarged past 2.6x', () => {
  // NickEh30's portrait-ish panel: left whole, in a window of its own shape
  const tall = { x: 0, y: 0.564, w: 0.221, h: 0.399 };
  const res = { width: 1920, height: 1080, samples: [{ ms: 0, faces: [{ x: 0.06, y: 0.8, w: 0.08, h: 0.12, confidence: 0.9 }] }] };
  assert.deepEqual(fitCamToBand(res, tall, CAM_SHARE_MAX), tall);
  const g = splitGeometry({ ...split, cam: tall, camShare: camShareFor(tall) });
  assert.ok(g.cam.width < 1080 && g.cam.left === (1080 - g.cam.width) / 2, `a centred window: ${g.cam.width} px`);
  // a small face-grown box (309 × 213 px with headroom) gets a band it fills at 2.6x, not a 3.5x close-up
  const small = { x: 0.009, y: 0.715, w: 0.161, h: 0.157 };
  const share = camShareFor(small);
  const gs = splitGeometry({ ...split, cam: small, camShare: share });
  const zoom = gs.cam.width / (0.161 * 1920);
  assert.ok(zoom <= MAX_CAM_ZOOM + 0.02, `enlarged ${zoom.toFixed(2)}x`);
  assert.ok(share < CAM_SHARE_MAX, `a smaller band: ${share}`);
});

test('Just Chatting and other non-game categories show the whole frame; games fill the band', () => {
  assert.equal(contentFitFor('Just Chatting'), 'fit');
  assert.equal(contentFitFor('just chatting '), 'fit');
  assert.equal(contentFitFor('IRL'), 'fit');
  assert.equal(contentFitFor('Special Events'), 'fit');
  assert.equal(contentFitFor('Fortnite'), 'fill');
  assert.equal(contentFitFor('Grand Theft Auto V'), 'fill');
  assert.equal(contentFitFor(undefined), 'fill');
});

test('the whole-frame plate sits right under the cam at full width', () => {
  const g = splitGeometry({ ...split, content: 'fit', canvasPad: 0.04 });
  assert.equal(g.fit, 'fit');
  assert.deepEqual([g.cam.top, g.cam.height], [76, 618]);
  assert.deepEqual([g.content.top, g.content.left, g.content.width, g.content.height], [694, 0, 1080, 608]);
  assert.deepEqual(g.content.box, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(g.seam, 0.361);
});

test('a cam band too tall for a full-width plate shrinks the plate and centres it', () => {
  const g = splitGeometry({ ...split, camShare: 0.8, content: 'fit', canvasPad: 0.04 });
  const room = 1768 - g.cam.height;
  assert.ok(g.content.height <= room, `${g.content.height} fits in ${room}`);
  assert.ok(g.content.width < 1080);
  assert.equal(g.content.left, (1080 - g.content.width) / 2);
  assert.ok(Math.abs(g.content.width / g.content.height - 16 / 9) < 0.02, 'still 16:9');
});

test('captions on a whole-frame split go under the plate, inside the safe zone', () => {
  // plate bottom: 76 + 618 + 608 = 1302 px = 0.678, captions 0.06 below
  assert.equal(captionPositionForSplit({ ...split, content: 'fit', canvasPad: 0.04 }), 0.738);
  assert.equal(captionPositionForSplit({ ...split, camShare: 0.42, content: 'fit', canvasPad: 0.04 }), 0.78, 'never below 1500 px');
  assert.equal(captionPositionForSplit({ ...split, content: 'fill' }), undefined, 'a fill split keeps the usual position');
});

test('a fill split covers the whole room under the cam', () => {
  const g = splitGeometry({ ...split, canvasPad: 0.04 });
  assert.equal(g.fit, 'fill');
  assert.equal(g.content.top + g.content.height, 1920 - 76);
});

// ---------- the framed-picture check ----------

const W = 108;
const H = 192;
const frame = (fill: (x: number, y: number) => number) => {
  const f = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = fill(x, y);
  return f;
};
const noise = (seed: number) => (x: number, y: number) => 40 + ((x * 31 + y * 17 + seed * 7) % 150);

test('a black bar for the whole clip counts; a dark corner of a game does not', () => {
  // a black strip across the top, the rest moving picture
  const bar = [0, 1, 2].map((s) => frame((x, y) => (y < 20 ? 0 : noise(s)(x, y))));
  assert.equal(deadShare(bar), Math.round((20 / H) * 1000) / 1000);
  // the black sides of a phone video in the middle of the frame
  const pillars = [0, 1, 2].map((s) => frame((x, y) => (y > 60 && y < 160 && (x < 25 || x > 82) ? 2 : noise(s)(x, y))));
  assert.ok(deadShare(pillars) > DEAD_MAX, `pillars: ${deadShare(pillars)}`);
  // a small dark corner (a dim room, a horror game's shadow) stays below the bar size
  const corner = [0, 1, 2].map((s) => frame((x, y) => (x < 12 && y < 30 ? 0 : noise(s)(x, y))));
  assert.equal(deadShare(corner), 0);
  // dark only some of the time is not dead
  const flicker = [0, 1, 2].map((s) => frame((x, y) => (y < 20 && s !== 1 ? 0 : noise(s)(x, y))));
  assert.equal(deadShare(flicker), 0);
});

test('the face check counts samples with a face centred in the camera band', () => {
  const inBand = { x: 0.3, y: 0.1, w: 0.3, h: 0.15 }; // centre 0.175
  const below = { x: 0.3, y: 0.6, w: 0.2, h: 0.1 }; // centre 0.65: a face in the game
  assert.equal(faceShareIn([{ faces: [inBand] }, { faces: [inBand] }, { faces: [below] }, { faces: [] }], 0.04, 0.36), 0.5);
  assert.equal(faceShareIn([], 0.04, 0.36), null);
});

test('what the numbers mean: black area anywhere, a missing face only in a split', () => {
  assert.deepEqual(layoutIssues({ mode: 'split', dead: 0, faceInCam: 0.9 }), []);
  assert.match(layoutIssues({ mode: 'blur', dead: 0.07, faceInCam: null })[0], /7% of the picture is black/);
  assert.match(layoutIssues({ mode: 'split', dead: 0, faceInCam: 0.3 })[0], /face is in the camera band in only 30%/);
  assert.match(layoutIssues({ mode: 'split', dead: 0, faceInCam: 0.67 })[0], /only 67%/, 'a scene change a third of the way in');
  assert.deepEqual(layoutIssues({ mode: 'split', dead: 0, faceInCam: FACE_MIN }), []);
  assert.deepEqual(layoutIssues({ mode: 'blur', dead: 0, faceInCam: 0.1 }), [], 'blur-fit needs no face in a band');
  assert.deepEqual(layoutIssues({ mode: 'split', dead: 0, faceInCam: null }), [], 'no detector: not a failure');
});

test('only a missing face turns a split into blur-fit; black from the source is reported, not switched', () => {
  assert.equal(needsBlurFallback({ mode: 'split', faceInCam: 0.32 }), true, 'an IRL shot taken for a facecam');
  assert.equal(needsBlurFallback({ mode: 'split', faceInCam: 0.97 }), false, 'a phone video with black sides: blur-fit shows the same black');
  assert.equal(needsBlurFallback({ mode: 'split', faceInCam: null }), false, 'no detector: leave it');
  assert.equal(needsBlurFallback({ mode: 'blur', faceInCam: 0.1 }), false);
});

// ---------- reject reasons ----------

test('reject reasons are checked, deduplicated and counted in the stats', async () => {
  const { parseReasons, stats } = await import('../src/review');
  assert.deepEqual(parseReasons('boring, layout,boring'), ['boring', 'layout']);
  assert.deepEqual(parseReasons(['cut']), ['cut']);
  assert.equal(parseReasons(''), undefined);
  assert.throws(() => parseReasons('meh'), /unknown reason meh/);

  const rows = [
    { at: '2026-11-18T10:00:00Z', clipId: 'a', videoId: 'v', status: 'rejected', reasons: ['layout'], durationMs: 1, markers: {}, autoEdits: 0 },
    { at: '2026-11-18T10:01:00Z', clipId: 'b', videoId: 'v', status: 'rejected', reasons: ['boring', 'layout'], durationMs: 1, markers: {}, autoEdits: 0 },
    { at: '2026-11-18T10:02:00Z', clipId: 'c', videoId: 'v', status: 'rejected', durationMs: 1, markers: {}, autoEdits: 0 },
    { at: '2026-11-18T10:03:00Z', clipId: 'd', videoId: 'v', status: 'approved', durationMs: 1, markers: {}, autoEdits: 0 },
  ];
  fs.mkdirSync(path.join(DATA, 'library'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'library', 'feedback.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const s = stats();
  assert.equal(s.turnedDown, 3);
  assert.deepEqual(
    s.byReason.map((r) => [r.key, r.clips, r.share]),
    [['layout', 2, 67], ['boring', 1, 33], ['(no reason given)', 1, 33]],
  );
});
