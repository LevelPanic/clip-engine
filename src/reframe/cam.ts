// Find a stream's facecam from face detections and lay out the split 9:16 frame around it.
// Pure functions (no Node imports), so the Studio and the tests can use them.
//
// A facecam is a face that keeps coming back in the same small region near an edge of the 16:9 frame
// (a corner, or centred on the top/bottom strip). A talking-head close-up covers too much of the frame
// and sits too central to count. The cam box is that face's box grown to a webcam rectangle (wider than
// tall, a little headroom, shoulders below) and snapped to the frame border; the game box is the
// largest target-aspect window that avoids it.
import type { FaceRect, FaceResult } from './faces';
import type { FramingBox, SplitLayout } from '../core/schemas';
import { camFillsWidth, camShareFor, camWithHeadroom, CANVAS_H, CANVAS_W, DEFAULT_CANVAS_PAD } from '../core/layout';
import { clamp } from '../core/time';

const even = (n: number) => 2 * Math.round(n / 2);
/** The canvas height inside the default margin (the bands share it). */
const contentHeight = () => CANVAS_H - 2 * even(CANVAS_H * DEFAULT_CANVAS_PAD);

const MIN_SAMPLES_FRACTION = 0.35; // the cam must be seen in this many samples
const CLUSTER_DISTANCE = 0.1; // faces within this much of a cluster's centre belong to it
const MAX_EDGE_DISTANCE = 0.28; // the cam's centre must be this close to a frame edge
const MAX_FACE_W = 0.5; // bigger than this is a close-up, not a facecam
const MAX_FACE_H = 0.62;
const CAM_GROW_W = 4.2; // a webcam shows more than the face: width ≈ this × the face width
const CAM_GROW_H = 2.6; // ...and the shoulders below it
const CAM_MIN_W = 0.15;
const CAM_MIN_H = 0.15;
const CAM_MAX_W = 0.5;
const CAM_MAX_H = 0.45;
const CAM_HEADROOM = 0.1; // the face sits near the top of a webcam: this much of the box above it

const median = (vs: number[]) => {
  const s = [...vs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const round = (v: number) => Math.round(v * 1000) / 1000;

interface ClusterFace {
  box: { x: number; y: number; w: number; h: number };
  sample: number;
}

const overlap = (a: FramingBox, b: FramingBox) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const area = (b: FramingBox) => b.w * b.h;
const iou = (a: FramingBox, b: FramingBox) => {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = x * y;
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
};
const medianBox = (bs: FramingBox[]): FramingBox => ({
  x: round(median(bs.map((b) => b.x))),
  y: round(median(bs.map((b) => b.y))),
  w: round(median(bs.map((b) => b.w))),
  h: round(median(bs.map((b) => b.h))),
});

/**
 * A webcam panel is a stable rectangle near an edge that contains the persistent face.
 * Vision's rectangle detection supplies these when the overlay has a visible border; streams with
 * borderless overlays fall back to the face-grown box.
 */
function panelBox(result: FaceResult, face: { x: number; y: number; w: number; h: number }): FramingBox | null {
  const cx = face.x + face.w / 2;
  const cy = face.y + face.h / 2;
  const clusters: { boxes: FramingBox[]; samples: Set<number> }[] = [];
  result.samples.forEach((s, si) => {
    for (const r of s.rects ?? []) {
      const b: FramingBox = { x: r.x, y: r.y, w: r.w, h: r.h };
      const aspect = (b.w * result.width) / (b.h * result.height);
      if (area(b) < 0.02 || area(b) > 0.35 || aspect < 0.8 || aspect > 2.4) continue;
      const nearEdge = b.x < 0.3 || b.x + b.w > 0.7 || b.y < 0.3 || b.y + b.h > 0.7;
      if (!nearEdge) continue;
      if (cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h) continue;
      const hit = clusters.find((c) => iou(medianBox(c.boxes), b) > 0.55);
      if (hit) {
        hit.boxes.push(b);
        hit.samples.add(si);
      } else clusters.push({ boxes: [b], samples: new Set([si]) });
    }
  });
  const best = clusters.filter((c) => c.samples.size >= 2).sort((a, b) => b.samples.size - a.samples.size)[0];
  if (!best) return null;
  const panel = medianBox(best.boxes);
  // keep the whole face inside the panel even if its border was slightly under-detected
  const x1 = Math.min(panel.x, face.x);
  const y1 = Math.min(panel.y, face.y);
  const x2 = Math.max(panel.x + panel.w, face.x + face.w);
  const y2 = Math.max(panel.y + panel.h, face.y + face.h);
  return { x: round(clamp(x1)), y: round(clamp(y1)), w: round(Math.min(1 - x1, x2 - x1)), h: round(Math.min(1 - y1, y2 - y1)) };
}

/** Grow the face box to a webcam rectangle, snapped to the frame border it sits against. */
function camBox(fx: number, fy: number, faceW: number, faceH: number): FramingBox {
  const w = Math.min(CAM_MAX_W, Math.max(CAM_MIN_W, faceW * CAM_GROW_W));
  const h = Math.min(CAM_MAX_H, Math.max(CAM_MIN_H, faceH * CAM_GROW_H));
  let x = clamp(fx + faceW / 2 - w / 2);
  let y = clamp(fy - h * CAM_HEADROOM);
  // webcams sit flush against the frame edge
  if (x < 0.06) x = 0;
  else if (x + w > 0.94) x = 1 - w;
  if (y < 0.06) y = 0;
  else if (y + h > 0.94) y = 1 - h;
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

/**
 * The split layout for this clip, or null when there's no stable facecam.
 * `camShare` is the facecam band's height as a fraction of the 9:16 frame; by default it is sized to
 * the cam panel's shape (`camShareFor`), so the band shows the panel and nothing beside it.
 */
export function findFacecam(result: FaceResult, opts: { camShare?: number } = {}): SplitLayout | null {
  const total = result.samples.length;
  if (total < 3) return null;
  const faces: ClusterFace[] = result.samples.flatMap((s, sample) => s.faces.map((box) => ({ box, sample })));
  if (!faces.length) return null;

  // group detections that stay put over time (single-linkage by median centre)
  const clusters: ClusterFace[][] = [];
  for (const f of faces) {
    const cx = f.box.x + f.box.w / 2;
    const cy = f.box.y + f.box.h / 2;
    const hit = clusters.find((c) => {
      const mx = median(c.map((g) => g.box.x + g.box.w / 2));
      const my = median(c.map((g) => g.box.y + g.box.h / 2));
      return Math.hypot(cx - mx, cy - my) < CLUSTER_DISTANCE;
    });
    if (hit) hit.push(f);
    else clusters.push([f]);
  }

  const minSamples = Math.max(2, Math.ceil(total * MIN_SAMPLES_FRACTION));
  const found = clusters
    .map((c) => {
      const x = median(c.map((f) => f.box.x));
      const y = median(c.map((f) => f.box.y));
      const cx = median(c.map((f) => f.box.x + f.box.w / 2));
      const cy = median(c.map((f) => f.box.y + f.box.h / 2));
      const w = median(c.map((f) => f.box.w));
      const h = median(c.map((f) => f.box.h));
      return { samples: new Set(c.map((f) => f.sample)).size, x, y, cx, cy, w, h, edge: Math.min(cx, 1 - cx, cy, 1 - cy) };
    })
    .filter((c) => c.samples >= minSamples && c.edge <= MAX_EDGE_DISTANCE && c.w <= MAX_FACE_W && c.h <= MAX_FACE_H)
    .sort((a, b) => b.samples - a.samples || b.w * b.h - a.w * a.h);
  if (!found.length) return null;
  const best = found[0];

  const cam = panelBox(result, best) ?? camBox(best.x, best.y, best.w, best.h);
  return layoutForCam(result, cam, opts.camShare);
}

/**
 * Cut a cam panel to the band's shape around the face. A panel a little taller than the band, or wider
 * than it, loses the part furthest from the face, not simply its bottom (cropping from the top cut
 * NickEh30's face whenever he leaned down to his phone). A panel much taller than the band is left
 * whole: the band shows it in a narrower window. Pure.
 */
export function fitCamToBand(result: FaceResult, cam: FramingBox, camShare: number): FramingBox {
  const W = result.width;
  const H = result.height;
  const bandAspect = CANVAS_W / even(contentHeight() * camShare);
  const inCam = result.samples.flatMap((s) => s.faces).filter((f) => {
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    return cx >= cam.x && cx <= cam.x + cam.w && cy >= cam.y && cy <= cam.y + cam.h;
  });
  const cx = inCam.length ? median(inCam.map((f) => f.x + f.w / 2)) : cam.x + cam.w / 2;
  const cy = inCam.length ? median(inCam.map((f) => f.y + f.h / 2)) : cam.y + cam.h * 0.4;
  // the band shows the box with its headroom (camWithHeadroom), so that is the shape to fit
  const head = camWithHeadroom({ cam });
  const lift = cam.y - head.y;
  const aspect = (head.w * W) / (head.h * H);
  // much taller than the band: shown whole in a narrower window (src/core/layout.ts), not cut
  if (!camFillsWidth(aspect, bandAspect)) return cam;
  if (aspect < bandAspect * 0.98) {
    // too tall: keep a band-shaped window with the face 40% of the way down (room for a lean)
    const h = (head.w * W) / bandAspect / H;
    const y = Math.min(head.y + head.h - h, Math.max(head.y, cy - 0.4 * h));
    return { x: cam.x, y: round(y + lift), w: cam.w, h: round(h - lift) };
  }
  if (aspect > bandAspect * 1.02) {
    // too wide: keep a band-shaped window centred on the face
    const w = (head.h * H * bandAspect) / W;
    const x = Math.min(cam.x + cam.w - w, Math.max(cam.x, cx - w / 2));
    return { x: round(x), y: cam.y, w: round(w), h: cam.h };
  }
  return cam;
}

/** Place the gameplay window around a known cam box. Used by findFacecam and the panel refiner. */
export function layoutForCam(result: FaceResult, panel: FramingBox, share?: number): SplitLayout {
  const camShare = share ?? camShareFor(panel, result.width, result.height);
  // a band sized from the panel shows it whole; where the limits stop that, cut it around the face.
  // The game window still avoids the whole panel, so no part of the cam shows up in the game band.
  const cam = share === undefined ? fitCamToBand(result, panel, camShare) : panel;
  const gameAspect = 1080 / (1920 * (1 - camShare));
  const unit = gameAspect * (result.height / result.width); // box width per unit of height
  const fit = (avail: FramingBox): FramingBox => {
    const h = Math.min(avail.h, avail.w / unit);
    const w = h * unit;
    return { x: avail.x + (avail.w - w) / 2, y: avail.y + (avail.h - h) / 2, w, h };
  };

  let game = fit({ x: 0, y: 0, w: 1, h: 1 });
  if (overlap(game, panel)) {
    // first try sliding the window to one side of the cam, keeping its full height
    const right = { ...game, x: panel.x + panel.w };
    const left = { ...game, x: panel.x - game.w };
    if (right.x + right.w <= 1 + 1e-9) game = right;
    else if (left.x >= -1e-9) game = left;
    else {
      // a centred cam: use the larger band above or below it
      const above = { x: 0, y: 0, w: 1, h: panel.y };
      const below = { x: 0, y: panel.y + panel.h, w: 1, h: 1 - (panel.y + panel.h) };
      game = fit(above.h >= below.h ? above : below);
    }
  }
  game = { x: round(clamp(game.x)), y: round(clamp(game.y)), w: round(game.w), h: round(game.h) };
  return { cam, game, camShare };
}
