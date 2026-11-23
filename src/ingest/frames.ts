// Stills for the judge: the transcript is blind to what's on screen (a disconnect, a kill feed, a
// facial reaction), so the judge can look at a few frames. Taken from local footage when we have it,
// otherwise straight from the source's stream, without downloading the video.
//
// A still is evidence: an expert confirms a moment because of what a frame shows. So a still must be
// the second it is named for. Stills are cached by time and width, with three guards:
//   - local footage is exact and instant, so it replaces any still made before that footage was on
//     disk (those came from a remote slice, which can be seconds off on a broadcast still being written);
//   - two stills for different seconds that come back byte-identical mean the source did not seek:
//     they are fetched again once, and reported if they are still the same;
//   - the width is part of the cache key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJsonIf } from '../core/paths';
import { runOrThrow, YTDLP } from '../core/proc';
import { fmtTime } from '../core/time';
import { resolveMedia, liveFromStart } from './media';
import { sourceOf } from './source';

const watchUrl = (id: string) => sourceOf(id).url;

// Which bars of a seven-segment digit are lit: a top, b upper right, c lower right, d bottom,
// e lower left, f upper left, g middle.
const SEGMENTS: Record<string, string> = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd' };

/**
 * The time, drawn in a black strip under the picture. Pure.
 *
 * Why: an agent reads a batch of stills in one go and gets them back as bare pictures, so it matches
 * each one to its second by position. Measured on a fresh stream, 2 of 11 checked `frame` lines
 * described a still from a different second. With the time in the picture there is nothing to match.
 * It is drawn with boxes, as a seven-segment display, because this ffmpeg has no text filter; it sits
 * under the picture so it covers nothing.
 */
export function stillLabelFilter(label: string, scale = 1): string {
  const k = Math.max(1, Math.round(scale));
  const [W, H, T, GAP, PAD] = [10 * k, 18 * k, 2 * k, 4 * k, 4 * k];
  const half = (H - 3 * T) / 2;
  const strip = H + 2 * PAD;
  const y0 = `ih-${H + PAD}`;
  const box = (x: number, dy: number, w: number, h: number) => `drawbox=x=${x}:y=${y0}+${dy}:w=${w}:h=${h}:color=white:t=fill`;
  const out = [`pad=iw:ih+${strip}:0:0:black`];
  let x = PAD + 2 * k;
  for (const ch of label) {
    if (ch === ':') {
      out.push(box(x, half, T, T), box(x, half + T + half - T, T, T));
      x += T + GAP;
      continue;
    }
    const lit = SEGMENTS[ch];
    if (!lit) continue; // only digits and colons are drawn
    const bars: Record<string, [number, number, number, number]> = {
      a: [x + T, 0, W - 2 * T, T],
      b: [x + W - T, T, T, half],
      c: [x + W - T, 2 * T + half, T, half],
      d: [x + T, H - T, W - 2 * T, T],
      e: [x, 2 * T + half, T, half],
      f: [x, T, T, half],
      g: [x + T, T + half, W - 2 * T, T],
    };
    for (const seg of lit) out.push(box(...bars[seg]));
    x += W + GAP;
  }
  return out.join(',');
}

async function grab(input: string, atSec: number, out: string, width: number, label: string) {
  await runOrThrow('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', atSec.toFixed(3), '-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2,${stillLabelFilter(label, width / 640)}`, '-q:v', '4', out]);
}

/**
 * `<ms>_<width>.jpg`. Stills made before the time was drawn under the picture are plain `<ms>.jpg`;
 * they are left on disk (old verdicts cite them) and never handed out again.
 */
const stillPath = (dir: string, ms: number, width: number) => path.join(dir, `${Math.round(ms)}_${width}.jpg`);

/**
 * Which stills cannot be trusted: indexes that share their content with a still for a different
 * second. Two seconds of real video never encode to the same bytes. Pure.
 */
export function identicalStills(hashes: (string | undefined)[], timesMs: number[]): number[] {
  const out: number[] = [];
  for (let a = 0; a < hashes.length; a++) {
    if (!hashes[a]) continue;
    if (hashes.some((h, b) => b !== a && h === hashes[a] && Math.abs(timesMs[b] - timesMs[a]) >= 1000)) out.push(a);
  }
  return out;
}

const hashOf = (file: string) => (fs.existsSync(file) ? crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex') : undefined);

/** Fetch stills the source's own way: a 1 s video-only slice at each time, then its first frame. */
async function fetchRemote(videoId: string, timesMs: number[], out: string[], width: number, dir: string) {
  // YouTube's stream URLs refuse plain ffmpeg requests (403), so let yt-dlp fetch a 1 s, 480p,
  // video-only slice at each time in one call, then take each slice's first frame.
  const tmp = path.join(dir, `tmp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const [cmd, base] = YTDLP;
    await runOrThrow(cmd, [
      ...base,
      ...liveFromStart(videoId),
      // 480p is enough for a 640 px still; a wider one is asked for to read text on screen
      '-f', width > 854 ? 'bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080]/bv*' : 'bv*[height<=480][vcodec^=avc1]/bv*[height<=480]/bv*',
      ...timesMs.flatMap((t) => ['--download-sections', `*${(t / 1000).toFixed(3)}-${(t / 1000 + 1).toFixed(3)}`]),
      '-o', `${tmp}/%(section_start)s.%(ext)s`,
      watchUrl(videoId),
    ]);
    const got = fs.readdirSync(tmp);
    for (let k = 0; k < timesMs.length; k++) {
      const f = got.find((x) => Math.abs(parseFloat(x) - timesMs[k] / 1000) < 0.01);
      if (f) await grab(path.join(tmp, f), 0, out[k], width, fmtTime(timesMs[k], 0));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function grabFrames(videoId: string, timesMs: number[], width = 640, warn: (line: string) => void = () => {}): Promise<string[]> {
  const dir = paths.videoFile(videoId, 'frames');
  fs.mkdirSync(dir, { recursive: true });
  const out = timesMs.map((t) => stillPath(dir, t, width));
  const local = timesMs.map((t) => resolveMedia(videoId, t, t + 100));
  const remote: number[] = [];
  for (let k = 0; k < timesMs.length; k++) {
    const m = local[k];
    if (m) {
      // exact; also replaces a still made before this footage existed
      const stale = fs.existsSync(out[k]) && fs.statSync(out[k]).mtimeMs < fs.statSync(m.file).mtimeMs;
      if (!fs.existsSync(out[k]) || stale) await grab(m.file, (timesMs[k] - m.offsetMs) / 1000, out[k], width, fmtTime(timesMs[k], 0));
    } else if (!fs.existsSync(out[k])) remote.push(k);
  }
  if (remote.length) await fetchRemote(videoId, remote.map((k) => timesMs[k]), remote.map((k) => out[k]), width, dir);

  // the same picture for different seconds: the source did not seek, or an old still is wrong
  const suspects = () => identicalStills(out.map(hashOf), timesMs).filter((k) => !local[k]);
  let same = suspects();
  if (same.length) {
    for (const k of same) fs.rmSync(out[k], { force: true });
    await fetchRemote(videoId, same.map((k) => timesMs[k]), same.map((k) => out[k]), width, dir);
    same = suspects();
    if (same.length) {
      warn(
        `the stills for ${same.map((k) => fmtTime(timesMs[k], 0)).join(', ')} came back identical: the source did not seek to them (a broadcast still being written?), so they do not show those seconds. Download the footage and ask again: \`clip download ${videoId} --from ${fmtTime(Math.max(0, Math.min(...same.map((k) => timesMs[k])) - 10_000), 0)} --to ${fmtTime(Math.max(...same.map((k) => timesMs[k])) + 10_000, 0)} --wait\``,
      );
      for (const k of same) fs.rmSync(out[k], { force: true }); // never leave a wrong still to be reused
    }
  }
  for (let k = 0; k < out.length; k++) if (!fs.existsSync(out[k])) warn(`no still for ${fmtTime(timesMs[k], 0)}: it could not be fetched`);
  return out;
}
