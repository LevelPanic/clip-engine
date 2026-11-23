// Is the 9:16 picture what it should be? Checked on the framed video right after framing, before the
// expensive render, so a bad layout costs seconds and not a second render:
//   - dead area: a part of the canvas that stays black for the whole clip (a black pad, the black
//     sides of a phone video played on stream, a letterboxed source). The blurred cover means the
//     layout itself never leaves black, so what is left is the source's own;
//   - the face: in a split layout the top band is the creator's camera, so a face has to be in it for
//     most of the clip. When it is not, the "facecam" was something else (an IRL shot, other players'
//     cams, a table) or the streamer left, and blur-fit is the honest layout.
import { spawn } from 'node:child_process';
import { splitGeometry, CANVAS_H } from '../core/layout';
import type { Framing } from '../core/schemas';

/** Darkest grey (0–255, after scaling to full range) a pixel may reach in every sample and still be dead. */
export const DEAD_LEVEL = 6;
/** More than this share of the canvas dead for the whole clip fails. */
export const DEAD_MAX = 0.03;
/**
 * In a split, a face in the cam band in fewer than this share of the samples fails. 0.6 let through a
 * clip that changed scene a third of the way in (Ludwig: 67%, the band showing a sponsor logo and a
 * wall for the last third); real cams measured 0.88–1.0 with the hybrid detector.
 */
export const FACE_MIN = 0.8;

const GRID_W = 108;
const GRID_H = 192;
/** A dead region is a bar, not a dark corner of a game: this wide and this tall at least. */
const MIN_RUN_W = 16; // 15% of the width
const MIN_RUN_H = 10; // 5% of the height

export interface LayoutCheck {
  mode: Framing['mode'];
  samples: number;
  /** Share of the canvas that is black in every sample. */
  dead: number;
  /** Split only: share of samples with a face whose centre is inside the cam band. */
  faceInCam: number | null;
  issues: string[];
  ok: boolean;
  /** Set when the layout was changed because the first one failed. */
  fellBack?: string;
}

/**
 * Pure. `frames` are GRID_W×GRID_H grey images. A pixel is dead when it never gets brighter than
 * DEAD_LEVEL; it counts only as part of a bar (a run at least MIN_RUN_W wide and MIN_RUN_H tall),
 * so the dark corners of a horror game or a dim room do not.
 */
export function deadShare(frames: Uint8Array[], w = GRID_W, h = GRID_H): number {
  if (!frames.length) return 0;
  const dead = new Uint8Array(w * h).fill(1);
  for (const f of frames) for (let i = 0; i < w * h; i++) if (f[i] > DEAD_LEVEL) dead[i] = 0;
  const wide = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!dead[y * w + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < w && dead[y * w + e]) e++;
      if (e - x >= MIN_RUN_W) for (let k = x; k < e; k++) wide[y * w + k] = 1;
      x = e;
    }
  }
  let n = 0;
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!wide[y * w + x]) {
        y++;
        continue;
      }
      let e = y;
      while (e < h && wide[e * w + x]) e++;
      if (e - y >= MIN_RUN_H) n += e - y;
      y = e;
    }
  }
  return Math.round((n / (w * h)) * 1000) / 1000;
}

/** Pure. Share of samples with a face whose centre lies between `top` and `bottom` (fractions of the height). */
export function faceShareIn(samples: { faces: { x: number; y: number; w: number; h: number }[] }[], top: number, bottom: number): number | null {
  if (!samples.length) return null;
  const hit = samples.filter((s) => s.faces.some((f) => f.y + f.h / 2 >= top && f.y + f.h / 2 < bottom)).length;
  return Math.round((hit / samples.length) * 100) / 100;
}

/**
 * Pure: should this split become blur-fit? Only when the camera band has no face: then the "facecam" was
 * something else and blur-fit is honest. Black that is in the source (a phone video's sides) is in
 * blur-fit too, so it is reported for the reviewer, not "fixed" by a layout that shows it as well.
 */
export const needsBlurFallback = (c: Pick<LayoutCheck, 'mode' | 'faceInCam'>) => c.mode === 'split' && c.faceInCam !== null && c.faceInCam < FACE_MIN;

/** Pure: what the numbers mean. */
export function layoutIssues(c: Pick<LayoutCheck, 'mode' | 'dead' | 'faceInCam'>): string[] {
  const out: string[] = [];
  if (c.dead > DEAD_MAX) out.push(`${Math.round(c.dead * 100)}% of the picture is black for the whole clip`);
  if (c.mode === 'split' && c.faceInCam !== null && c.faceInCam < FACE_MIN)
    out.push(`a face is in the camera band in only ${Math.round(c.faceInCam * 100)}% of the clip`);
  return out;
}

/** One grey sample a second, shrunk; `area` scaling keeps a bar's black and averages noise away. */
function greyFrames(file: string): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vf', `fps=1,scale=${GRID_W}:${GRID_H}:flags=area,format=gray`, '-f', 'rawvideo', '-']);
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (b: Buffer) => chunks.push(b));
    child.stderr.on('data', (b: Buffer) => (err += b.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not sample ${file}: ${err.trim().split('\n').pop()}`));
      const buf = Buffer.concat(chunks);
      const size = GRID_W * GRID_H;
      const out: Uint8Array[] = [];
      for (let i = 0; i + size <= buf.length; i += size) out.push(new Uint8Array(buf.subarray(i, i + size)));
      resolve(out);
    });
  });
}

/**
 * Check a framed 1080×1920 video. `splitSpans` are the seconds of the file that are split (all of it
 * when the whole clip is split); the face is looked for only there.
 */
export async function checkLayout(file: string, framing: Framing, opts: { durationMs: number; splitSpans: [number, number][] }): Promise<LayoutCheck> {
  const frames = await greyFrames(file);
  const dead = deadShare(frames);
  let faceInCam: number | null = null;
  if (framing.mode === 'split' || opts.splitSpans.length) {
    const g = splitGeometry(framing.split);
    try {
      const share = (r: { samples: { ms: number; faces: { x: number; y: number; w: number; h: number }[] }[] }) =>
        faceShareIn(r.samples.filter((s) => opts.splitSpans.some(([a, z]) => s.ms / 1000 >= a && s.ms / 1000 < z)), g.cam.top / CANVAS_H, g.seam);
      // Vision is fast and usually enough. It misses a face under a cap or looking down (59% on a clip
      // where the face is there 88% of the time), so a miss is confirmed with the hybrid, which fills
      // those frames with InsightFace (and is Vision alone when the sidecar is missing).
      const { detectFaces } = await import('../reframe/faces');
      faceInCam = share(await detectFaces(file, 0, opts.durationMs, 1));
      if (faceInCam !== null && faceInCam < FACE_MIN) {
        const { detectFacesHybrid } = await import('../reframe/hybrid');
        faceInCam = share(await detectFacesHybrid(file, 0, opts.durationMs, 1));
      }
    } catch {
      faceInCam = null; // no face detector here (not macOS): the black-area check still ran
    }
  }
  const mode = framing.mode;
  const issues = layoutIssues({ mode: opts.splitSpans.length ? 'split' : mode, dead, faceInCam });
  return { mode, samples: frames.length, dead, faceInCam, issues, ok: !issues.length };
}
