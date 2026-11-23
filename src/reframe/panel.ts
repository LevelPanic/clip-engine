// Snap an estimated facecam box to the real panel borders.
//
// Sampled frames minutes apart: the webcam picture (a room) changes less than the game/desktop
// around it, so the panel border is where the per-pixel temporal variance steps. This is the
// temporal-variance border refinement used by kiy0ni/auto-video-editor (MIT), ported to Node.
import { spawn } from 'node:child_process';
import type { FaceBox, FaceResult } from './faces';
import type { FramingBox } from '../core/schemas';
import { clamp } from '../core/time';

const SAMPLE_WIDTH = 240;
const SAMPLE_COUNT = 24;

const median = (a: Float32Array) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function sampleGray(file: string, startMs: number, endMs: number, width: number, height: number): Promise<Buffer[]> {
  const duration = (endMs - startMs) / 1000;
  const fps = SAMPLE_COUNT / Math.max(0.1, duration);
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', (startMs / 1000).toFixed(3),
    '-t', duration.toFixed(3),
    '-i', file,
    '-an',
    '-vf', `fps=${fps.toFixed(4)},scale=${width}:${height},format=gray`,
    '-f', 'rawvideo', '-',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (b: Buffer) => chunks.push(b));
    child.stderr.on('data', (b: Buffer) => (err += b.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`panel sampling failed: ${err.trim().split('\n').slice(-3).join(' ')}`));
      const frameSize = width * height;
      const all = Buffer.concat(chunks);
      const out: Buffer[] = [];
      for (let i = 0; i + frameSize <= all.length; i += frameSize) out.push(all.subarray(i, i + frameSize));
      resolve(out);
    });
  });
}

function faceSeed(result: FaceResult, cam: FramingBox): FaceBox {
  const inside = result.samples.flatMap((s) => s.faces).filter((f) => {
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    return cx >= cam.x && cx <= cam.x + cam.w && cy >= cam.y && cy <= cam.y + cam.h;
  });
  if (inside.length) {
    return {
      x: median(new Float32Array(inside.map((f) => f.x))),
      y: median(new Float32Array(inside.map((f) => f.y))),
      w: median(new Float32Array(inside.map((f) => f.w))),
      h: median(new Float32Array(inside.map((f) => f.h))),
      confidence: 1,
    };
  }
  return { x: cam.x + cam.w * 0.25, y: cam.y + cam.h * 0.2, w: cam.w * 0.5, h: cam.h * 0.6, confidence: 0.5 };
}

function border(profile: Float32Array, start: number, stop: number, outward: 1 | -1, k: number): number | null {
  const a = clamp(Math.floor(Math.min(start, stop)), k, profile.length - k - 1);
  const b = clamp(Math.ceil(Math.max(start, stop)), k, profile.length - k - 1);
  const threshold = Math.max(6, 0.25 * median(profile));
  let best: number | null = null;
  let bestStep = threshold;
  for (let i = a; i <= b; i++) {
    const before = profile.subarray(i - k, i).reduce((s, v) => s + v, 0) / k;
    const after = profile.subarray(i, i + k).reduce((s, v) => s + v, 0) / k;
    const step = outward > 0 ? after - before : before - after;
    if (step > bestStep) {
      best = i;
      bestStep = step;
    }
  }
  return best;
}

/** Returns the snapped panel bounds, or null when the border is not clear enough. */
export async function refinePanel(
  result: FaceResult,
  file: string,
  startMs: number,
  endMs: number,
  camSeed: FramingBox,
): Promise<FramingBox | null> {
  if (!(endMs > startMs) || result.width <= 0 || result.height <= 0) return null;
  const height = Math.max(2, Math.round((SAMPLE_WIDTH * result.height) / result.width / 2) * 2);
  const frames = await sampleGray(file, startMs, endMs, SAMPLE_WIDTH, height);
  if (frames.length < 6) return null;

  const n = frames.length;
  const sum = new Float64Array(SAMPLE_WIDTH * height);
  const sum2 = new Float64Array(SAMPLE_WIDTH * height);
  for (const f of frames) {
    for (let i = 0; i < f.length; i++) {
      sum[i] += f[i];
      sum2[i] += f[i] * f[i];
    }
  }
  const std = new Float32Array(SAMPLE_WIDTH * height);
  for (let i = 0; i < std.length; i++) {
    const mean = sum[i] / n;
    std[i] = Math.sqrt(Math.max(0, sum2[i] / n - mean * mean));
  }

  const face = faceSeed(result, camSeed);
  const fx = face.x * SAMPLE_WIDTH;
  const fy = face.y * height;
  const fw = face.w * SAMPLE_WIDTH;
  const fh = face.h * height;

  const rowsA = clamp(Math.floor(fy - fh), 0, height - 1);
  const rowsB = clamp(Math.ceil(fy + 2 * fh), 1, height);
  const colsA = clamp(Math.floor(fx - fw), 0, SAMPLE_WIDTH - 1);
  const colsB = clamp(Math.ceil(fx + 2 * fw), 1, SAMPLE_WIDTH);
  const columnProfile = new Float32Array(SAMPLE_WIDTH);
  for (let x = 0; x < SAMPLE_WIDTH; x++) {
    let s = 0;
    for (let y = rowsA; y < rowsB; y++) s += std[y * SAMPLE_WIDTH + x];
    columnProfile[x] = s / Math.max(1, rowsB - rowsA);
  }
  const rowProfile = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let s = 0;
    for (let x = colsA; x < colsB; x++) s += std[y * SAMPLE_WIDTH + x];
    rowProfile[y] = s / Math.max(1, colsB - colsA);
  }

  const k = Math.max(2, Math.round(SAMPLE_WIDTH / 240));
  const right = border(columnProfile, fx + 1.3 * fw, fx + 5 * fw, 1, k);
  const left = border(columnProfile, fx - 4 * fw, fx - 0.3 * fw, -1, k);
  const bottom = border(rowProfile, fy + 1.3 * fh, fy + 5.5 * fh, 1, k);
  const top = border(rowProfile, fy - 3 * fh, fy - 0.3 * fh, -1, k);
  if (left === null && right === null && top === null && bottom === null) return null;

  let x0 = left === null ? camSeed.x : left / SAMPLE_WIDTH;
  let x1 = right === null ? camSeed.x + camSeed.w : right / SAMPLE_WIDTH;
  let y0 = top === null ? camSeed.y : top / height;
  let y1 = bottom === null ? camSeed.y + camSeed.h : bottom / height;
  if (x0 < 0.02) x0 = 0;
  if (y0 < 0.02) y0 = 0;
  if (x1 > 0.98) x1 = 1;
  if (y1 > 0.98) y1 = 1;

  const w = x1 - x0;
  const h = y1 - y0;
  const inside = x0 <= face.x && y0 <= face.y && face.x + face.w <= x1 && face.y + face.h <= y1;
  if (!inside || w < face.w * 1.5 || h < face.h * 1.5 || w > 0.6 || h > 0.7) return null;
  return { x: Math.round(x0 * 1000) / 1000, y: Math.round(y0 * 1000) / 1000, w: Math.round(w * 1000) / 1000, h: Math.round(h * 1000) / 1000 };
}
