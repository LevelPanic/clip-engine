// The split layout's geometry, in one place: the ffmpeg framing (src/render/framing.ts), the Studio
// preview (src/composition/FramedVideo.tsx), the credit's seam and the editors' hook line all read it.
// Pure and browser-safe.
//
// The 9:16 canvas is a blurred cover of the whole source frame. On it sit two pictures:
//   - the cam band at the top: the facecam panel, cropped INTO the panel and never widened out of it
//     (widening is what pulled the game, the browser or a sponsor logo in beside the face);
//   - the content band under it, one of two fits:
//       fill — a window of the source cropped to cover the band (shooters, third-person games);
//       fit  — the whole 16:9 frame at full width (Just Chatting, websites, menus, desktops,
//              videos played on stream), with the blurred cover showing below it.
// Nothing is black: where the pictures end, the blurred cover shows.
import type { FramingBox, SplitLayout } from './schemas';

export const CANVAS_W = 1080;
export const CANVAS_H = 1920;
/** The cam band is sized to the panel's shape, within these shares of the canvas. */
export const CAM_SHARE_MIN = 0.26;
export const CAM_SHARE_MAX = 0.42;
export const DEFAULT_CANVAS_PAD = 0.04;
export const DEFAULT_CAM_TOP_PAD = 0.04;
/** A cam is never enlarged more than this: a small webcam gets a smaller window, not a blurry close-up. */
export const MAX_CAM_ZOOM = 2.6;
/** The band of a small cam may go this low (the content band gets the room). */
const CAM_SHARE_FLOOR = 0.2;
/** A panel at least this close to the band's shape fills the width (cropped a little); a taller one is shown whole in a narrower window. */
export const FILL_WIDTH_MIN = 0.75;

export type ContentFit = 'fill' | 'fit';

const even = (n: number) => 2 * Math.round(n / 2);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Twitch categories that are not a game being played. Their screen is a website, a desktop, a video
 * or a room: cropping the middle half of it cuts the words, so the whole frame is shown.
 */
const NOT_GAMES = new Set(
  [
    'Just Chatting', 'IRL', 'Special Events', 'Talk Shows & Podcasts', 'Music', 'Art', 'Sports', 'Travel & Outdoors',
    'Food & Drink', 'Science & Technology', 'Software and Game Development', 'Makers & Crafting', 'Politics', 'ASMR',
    'Fitness & Health', 'Pools, Hot Tubs, and Beaches', 'Animals, Aquariums, and Zoos', 'Beauty & Body Art',
    'Co-working & Studying', 'Watch Party', 'The Streamer Awards', 'Chess', 'Games + Demos', 'Crypto', 'Writing & Reading',
  ].map((s) => s.toLowerCase()),
);

/** How the content band shows the stream for this category (the chapter the clip is in). */
export function contentFitFor(category: string | undefined): ContentFit {
  return category && NOT_GAMES.has(category.trim().toLowerCase()) ? 'fit' : 'fill';
}

/** The cam box with a little headroom above it, so the hat and forehead are not cut. */
export function camWithHeadroom(s: Pick<SplitLayout, 'cam' | 'camTopPad'>): FramingBox {
  const topPad = s.camTopPad ?? DEFAULT_CAM_TOP_PAD;
  const y = Math.max(0, s.cam.y - topPad);
  return { ...s.cam, y, h: Math.min(1 - y, s.cam.h + (s.cam.y - y)) };
}

/**
 * The cam band's share of the canvas for this cam panel: tall enough to show it whole at full width
 * (a 16:9 panel gets about a third, a 4:3 one the most allowed), but never so tall that the panel is
 * enlarged more than MAX_CAM_ZOOM. Never widened out of the panel.
 */
export function camShareFor(cam: FramingBox, srcW = 1920, srcH = 1080, opts: { canvasPad?: number; camTopPad?: number } = {}): number {
  const box = camWithHeadroom({ cam, camTopPad: opts.camTopPad });
  const aspect = (box.w * srcW) / (box.h * srcH);
  const contentH = CANVAS_H - 2 * even(CANVAS_H * (opts.canvasPad ?? DEFAULT_CANVAS_PAD));
  const byShape = clamp(CANVAS_W / aspect / contentH, CAM_SHARE_MIN, CAM_SHARE_MAX);
  const bySize = Math.max(CAM_SHARE_FLOOR, (MAX_CAM_ZOOM * box.h * srcH) / contentH);
  return round3(Math.min(byShape, bySize));
}

/** True when this cam box fills the band's width (cropped to it); false when it is shown whole in a narrower window. */
export function camFillsWidth(boxAspect: number, bandAspect: number): boolean {
  return boxAspect >= bandAspect * FILL_WIDTH_MIN;
}

/** A game window widened to the band's shape (only ever wider: a game window is already a crop of the game). */
function widenTo(b: FramingBox, targetW: number, targetH: number, srcW: number, srcH: number): FramingBox {
  const w = Math.min(1, Math.max(0.04, (b.h * srcH * (targetW / targetH)) / srcW));
  const width = Math.max(b.w, w);
  const x = Math.min(1 - width, Math.max(0, b.x + (b.w - width) / 2));
  return { ...b, x, w: width };
}

export interface Band {
  top: number;
  left: number;
  width: number;
  height: number;
  /** The part of the source that covers this band (cropped to the band's shape around its centre). */
  box: FramingBox;
}

export interface SplitGeometry {
  fit: ContentFit;
  pad: number;
  cam: Band;
  content: Band;
  /** Where the cam band ends, as a fraction of the canvas height: the credit sits on it. */
  seam: number;
}

/** Where everything goes on the 1080×1920 canvas. `srcW`/`srcH` only matter for the fit plate's height. */
export function splitGeometry(s: SplitLayout, srcW = 1920, srcH = 1080): SplitGeometry {
  const pad = even(CANVAS_H * (s.canvasPad ?? DEFAULT_CANVAS_PAD));
  const contentH = CANVAS_H - 2 * pad;
  const camH = even(contentH * s.camShare);
  const fit: ContentFit = s.content ?? 'fill';
  // a panel near the band's shape fills the width; a taller or small one is shown whole, centred,
  // in a window of its own shape on the blurred cover (no face cut off, no blurry close-up)
  const camBox = camWithHeadroom(s);
  const boxAspect = (camBox.w * srcW) / (camBox.h * srcH);
  const camW = camFillsWidth(boxAspect, CANVAS_W / camH) ? CANVAS_W : Math.min(CANVAS_W, even(camH * boxAspect));
  const cam: Band = { top: pad, left: (CANVAS_W - camW) / 2, width: camW, height: camH, box: camBox };
  const seam = round3((pad + camH) / CANVAS_H);
  const room = contentH - camH;
  if (fit === 'fit') {
    // the whole frame at full width; if the cam band leaves too little room, smaller and centred
    let h = even((CANVAS_W * srcH) / srcW);
    let w = CANVAS_W;
    if (h > room) {
      h = even(room);
      w = even((h * srcW) / srcH);
    }
    return { fit, pad, cam, seam, content: { top: pad + camH, left: (CANVAS_W - w) / 2, width: w, height: h, box: { x: 0, y: 0, w: 1, h: 1 } } };
  }
  return { fit, pad, cam, seam, content: { top: pad + camH, left: 0, width: CANVAS_W, height: room, box: widenTo(s.game, CANVAS_W, room, srcW, srcH) } };
}

/**
 * Where captions go on a whole-frame split: just under the plate, on the blurred cover, instead of over
 * the bottom of the website or menu; never below 0.78 (1500 px, the bottom of the Shorts safe zone).
 * Undefined for a fill split, whose game reaches the margin: there the usual position stands.
 */
export function captionPositionForSplit(s: SplitLayout, srcW = 1920, srcH = 1080): number | undefined {
  const g = splitGeometry(s, srcW, srcH);
  if (g.fit !== 'fit') return undefined;
  return round3(Math.min(0.78, (g.content.top + g.content.height) / CANVAS_H + 0.06));
}

/** The seam of a split layout as a fraction of the height (where the credit goes). */
export const seamOf = (s: SplitLayout) => splitGeometry(s).seam;

/** The most a facecam is enlarged when it fills the frame on its own: past this a stream's cam turns to mush. */
export const MAX_SOLO_ZOOM = 3.5;
/** A facecam-only span keeps at least this share of the cam's width (it never crops in past the face). */
const SOLO_MIN_WIDTH = 0.5;

/**
 * One picture of a split alone, for a span (reports/meme-edits-2026-11-22.md: the facecam alone on the
 * laugh in 21% of top clip Shorts, the stream alone in 16%). Read by FramedVideo.tsx and the ffmpeg chain
 * (src/render/framing.ts), so the Studio and the export match.
 *   cam:  the cam box (with its headroom) enlarged up to MAX_SOLO_ZOOM, as wide as the canvas allows,
 *         centred on the blurred cover: about half as big again as in the split's band.
 *   game: a `fill` split's game box covering the whole canvas inside the margin (a tall slice of the
 *         game around its centre); a `fit` split's whole frame at full width, centred.
 */
export function soloGeometry(s: SplitLayout, which: 'cam' | 'game', srcW = 1920, srcH = 1080): Band {
  const pad = even(CANVAS_H * (s.canvasPad ?? DEFAULT_CANVAS_PAD));
  const roomH = CANVAS_H - 2 * pad;
  if (which === 'game') {
    if ((s.content ?? 'fill') === 'fit') {
      const h = even(Math.min(roomH, (CANVAS_W * srcH) / srcW));
      const w = even((h * srcW) / srcH);
      return { top: (CANVAS_H - h) / 2, left: (CANVAS_W - w) / 2, width: w, height: h, box: { x: 0, y: 0, w: 1, h: 1 } };
    }
    return { top: pad, left: 0, width: CANVAS_W, height: roomH, box: widenTo(s.game, CANVAS_W, roomH, srcW, srcH) };
  }
  const box = camWithHeadroom(s);
  const pxW = box.w * srcW;
  const pxH = box.h * srcH;
  const scale = Math.min(MAX_SOLO_ZOOM, CANVAS_W / (SOLO_MIN_WIDTH * pxW));
  const f = Math.min(1, CANVAS_W / (scale * pxW)); // the share of the cam's width that shows
  const visH = Math.min(pxH, roomH / scale);
  const width = even(f * pxW * scale);
  const height = even(visH * scale);
  return {
    top: even((CANVAS_H - height) / 2),
    left: (CANVAS_W - width) / 2,
    width,
    height,
    // centred across, top-aligned down (the forehead stays; the cover fit crops the shoulders)
    box: { x: box.x + (box.w * (1 - f)) / 2, y: box.y, w: box.w * f, h: visH / srcH },
  };
}
