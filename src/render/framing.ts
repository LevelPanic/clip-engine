// The ffmpeg version of FramedVideo.tsx: blur-fit, fill-and-crop, or the split facecam/gameplay layout,
// into 1080×1920 at 30 fps. Pure string building (no Node imports) so the tests can check it.
//
// Reframe keys can pan the crop (a crop-x expression over cut-relative seconds) and switch between
// blur-fit, crop and split part-way through. Every framing that is used gets its own branch and the
// non-base ones are overlaid only while active, driven by an ffmpeg `enable` expression.
// Mirrors framingAt() in src/markers/define.ts.
import type { Framing, FramingBox } from '../core/schemas';
import { resolveKeys, type FrameMode, type FramingKey } from '../markers/define';
import { soloGeometry, splitGeometry } from '../core/layout';

const even = (n: number) => 2 * Math.round(n / 2);

/** Seconds spans where each framing other than blur-fit is showing, plus the panning crop-x expression.
 *  Keys go through resolveKeys first: a facecam-only span ends on the framing before it, and does nothing
 *  outside a split. */
function framingSpans(f: Framing, keys: (FramingKey & { atMs: number })[], cutStartMs: number) {
  let mode: FrameMode = f.mode;
  let x = String(f.cropX);
  const spans: Record<FrameMode, [number, number][]> = { blur: [], crop: [], split: [], cam: [], game: [] };
  let from: number | null = mode === 'blur' ? null : 0;

  for (const k of resolveKeys(keys, f)) {
    const t = (k.atMs - cutStartMs) / 1000;
    const T = t.toFixed(3);
    if (k.mode !== mode) {
      if (mode !== 'blur' && from !== null && t > from) spans[mode].push([from, t]);
      mode = k.mode;
      from = mode === 'blur' ? null : t;
      if (mode === 'crop') x = `if(lt(t,${T}),${x},${k.cropX})`;
      continue;
    }
    if (k.mode !== 'crop') continue; // blur → blur or split → split: nothing changes
    if (k.easeMs <= 0) {
      // a hard cut between crop positions
      x = `if(lt(t,${T}),${x},${k.cropX})`;
      continue;
    }
    const E = (k.easeMs / 1000).toFixed(3);
    const P = `((t-${T})/${E})`;
    const ease = `if(lt(${P},0.5),2*${P}*${P},1-pow(-2*${P}+2,2)/2)`;
    x = `if(lt(t,${T}),${x},if(lt(t,${T}+${E}),(${x})+(${k.cropX}-(${x}))*${ease},${k.cropX}))`;
  }
  if (mode !== 'blur' && from !== null) spans[mode].push([from, Infinity]);
  return { x, crop: spans.crop, split: spans.split, cam: spans.cam, game: spans.game };
}

/** Fill-and-crop: scale up until the window is covered, then take the 9:16 slice at crop-x. */
function cropChain(f: Framing, input: string, x: string, out: string) {
  return (
    `${input}scale=${even(1080 * f.zoom)}:${even(1920 * f.zoom)}:force_original_aspect_ratio=increase,` +
    `crop=1080:1920:'(iw-1080)*(${x})':'(ih-1920)/2'${out}`
  );
}

/** The blurred cover of the whole frame: quarter size, zoomed 1.2, blurred, darkened, scaled up (same as the CSS). */
function coverChain(input: string, out: string) {
  return (
    `${input}scale=324:576:force_original_aspect_ratio=increase,crop=270:480,gblur=sigma=10,` +
    `eq=saturation=1.2,colorchannelmixer=rr=0.5:gg=0.5:bb=0.5,scale=1080:1920${out}`
  );
}

/** Blur-fit: the whole picture at full width on the blurred cover. */
function blurChain(f: Framing, inA: string, inB: string, out: string) {
  return `${coverChain(inA, '[bg]')};${inB}scale=${even(1080 * f.zoom)}:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${out}`;
}

/** One box of the source, scaled to cover a target rectangle (the box is zoomed around its centre). */
function boxChain(b: FramingBox, zoom: number, w: number, h: number, out: string, topAlign = false) {
  const bw = b.w / zoom;
  const bh = b.h / zoom;
  const bx = b.x + (b.w - bw) / 2;
  const by = b.y + (b.h - bh) / 2;
  const crop = topAlign ? `crop=${w}:${h}:(iw-${w})/2:0` : `crop=${w}:${h}`;
  return (
    `crop=iw*${bw.toFixed(4)}:ih*${bh.toFixed(4)}:iw*${bx.toFixed(4)}:ih*${by.toFixed(4)},` +
    `scale=${w}:${h}:force_original_aspect_ratio=increase,${crop}${out}`
  );
}

/** Facecam band on top, the stream under it, both on the blurred cover of the frame (src/core/layout.ts
 *  places them). The cam is top-aligned so the cover fit crops the shoulders, not the hat. */
function splitChain(f: Framing, input: string, out: string, src: { width: number; height: number }) {
  const g = splitGeometry(f.split, src.width, src.height);
  return (
    `${input}split=3[spb][spc][spg];` +
    `${coverChain('[spb]', '[spbg]')};` +
    `[spc]${boxChain(g.cam.box, f.zoom, g.cam.width, g.cam.height, '[cam]', true)};` +
    `[spg]${boxChain(g.content.box, f.zoom, g.content.width, g.content.height, '[game]')};` +
    `[spbg][cam]overlay=${g.cam.left}:${g.cam.top}[spt];[spt][game]overlay=${g.content.left}:${g.content.top}${out}`
  );
}

/** One picture of the split alone on the blurred cover (soloGeometry; FramedVideo.tsx draws the same). */
function soloChain(f: Framing, which: 'cam' | 'game', input: string, out: string, src: { width: number; height: number }) {
  const g = soloGeometry(f.split, which, src.width, src.height);
  const id = which === 'cam' ? 'sc' : 'sg';
  return (
    `${input}split=2[${id}b][${id}p];` +
    `${coverChain(`[${id}b]`, `[${id}bg]`)};` +
    `[${id}p]${boxChain(g.box, f.zoom, g.width, g.height, `[${id}fg]`, which === 'cam')};` +
    `[${id}bg][${id}fg]overlay=${g.left}:${g.top}${out}`
  );
}

const enableOf = (spans: [number, number][]) =>
  spans
    .map(([a, z]) => (z === Infinity ? `gte(t,${a.toFixed(3)})` : `between(t,${a.toFixed(3)},${z.toFixed(3)})`))
    .join('+');

/** The seconds of a cut that are in the split layout (the face check looks only there). */
export function splitSpans(f: Framing, keys: (FramingKey & { atMs: number })[] = [], cutStartMs = 0): [number, number][] {
  return framingSpans(f, keys, cutStartMs).split;
}

/** `src` is the source's size (only the whole-frame plate of a `fit` split depends on it). */
export function framingFilter(f: Framing, keys: (FramingKey & { atMs: number })[] = [], cutStartMs = 0, src = { width: 1920, height: 1080 }): string {
  const { x, crop, split, cam, game } = framingSpans(f, keys, cutStartMs);
  const end = ',fps=30,format=yuv420p[v]';
  const whole = (sp: [number, number][]) => sp.length === 1 && sp[0][0] <= 0 && sp[0][1] === Infinity;
  const solo = cam.length + game.length;

  // whole clip in one framing: no branches and no overlays
  if (!crop.length && !split.length && !solo) return `[0:v]split=2[a][b];${blurChain(f, '[a]', '[b]', end)}`;
  if (!split.length && !solo && whole(crop)) return cropChain(f, '[0:v]', x, end);
  if (!crop.length && !solo && whole(split)) return splitChain(f, '[0:v]', end, src);

  // mixed: blur-fit underneath, then whichever framing is active on top of it
  const parts: ('crop' | 'split' | 'cam' | 'game')[] = [];
  if (crop.length) parts.push('crop');
  if (split.length) parts.push('split');
  if (cam.length) parts.push('cam');
  if (game.length) parts.push('game');
  const n = 2 + parts.length; // the blur branch alone takes two inputs
  const inputs = Array.from({ length: n }, (_, i) => `[s${i}]`).join('');
  const graph = [`[0:v]split=${n}${inputs}`];
  graph.push(blurChain(f, '[s0]', '[s1]', '[bf]'));
  let next = 2;
  if (crop.length) graph.push(cropChain(f, `[s${next++}]`, x, '[cr]'));
  if (split.length) graph.push(splitChain(f, `[s${next++}]`, '[sp]', src));
  if (cam.length) graph.push(soloChain(f, 'cam', `[s${next++}]`, '[sc]', src));
  if (game.length) graph.push(soloChain(f, 'game', `[s${next++}]`, '[sg]', src));
  const label = { crop: '[cr]', split: '[sp]', cam: '[sc]', game: '[sg]' } as const;
  const spansOf = { crop, split, cam, game };
  let base = '[bf]';
  let k = 0;
  for (const part of parts) {
    const out = `[o${k++}]`;
    graph.push(`${base}${label[part]}overlay=0:0:enable='${enableOf(spansOf[part])}'${out}`);
    base = out;
  }
  graph.push(`${base}${end.replace(/^,/, '')}`);
  return graph.join(';');
}
