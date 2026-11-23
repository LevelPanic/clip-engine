// clip render <clipId>: cut the source range, render the composition, write exports/<clipId>.mp4.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { paths, writeJson } from '../core/paths';
import { CREDIT, captionPositionFor, loadProject, saveProject, suggestedPost } from '../project';
import { postFor, postFile } from '../core/post';
import { runOrThrow } from '../core/proc';
import { loadTranscript } from '../ingest/ingest';
import { resolveMedia, SECTION_MARGIN_MS } from '../ingest/media';
import { downloadSections } from '../ingest/downloads';
import { generateMarkerIndex } from '../markers/registry-node';
import { serveFiles } from './fileServer';
import type { ClipProps } from '../composition/props';
import { buildTimeMap } from '../core/timeline';
import { timeMarkers, framingKeys } from '../markers/define';
import { loadMarkerSchemas } from '../markers/registry-node';
import { fmtTime } from '../core/time';
import { framingFilter, splitSpans } from './framing';
import { setting } from '../core/config';

export { framingFilter } from './framing';

const ENTRY = path.join(paths.root, 'src', 'composition', 'index.ts');

function sourceHash(): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(paths.root, 'src', 'composition'));
  walk(paths.markers);
  files.push(
    path.join(paths.root, 'src', 'markers', 'define.ts'),
    path.join(paths.root, 'src', 'core', 'schemas.ts'),
    path.join(paths.root, 'src', 'core', 'time.ts'),
    path.join(paths.root, 'package.json'),
  );
  const h = crypto.createHash('sha1');
  for (const f of files.sort()) h.update(f).update(fs.readFileSync(f));
  return h.digest('hex').slice(0, 12);
}

/** Bundle the composition once and reuse it until composition or marker code changes. */
export async function getBundle(log: (s: string) => void): Promise<string> {
  generateMarkerIndex();
  const dir = path.join(paths.cache, `bundle-${sourceHash()}`);
  if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  for (const old of fs.existsSync(paths.cache) ? fs.readdirSync(paths.cache) : [])
    if (old.startsWith('bundle-')) fs.rmSync(path.join(paths.cache, old), { recursive: true, force: true });
  log('bundling composition (first render after a code change)…');
  const { bundle } = await import('@remotion/bundler');
  const emptyPublic = path.join(paths.cache, 'empty-public');
  fs.mkdirSync(emptyPublic, { recursive: true });
  await bundle({ entryPoint: ENTRY, outDir: dir, publicDir: emptyPublic });
  return dir;
}

/** True when the mp4's moov atom comes before mdat (playback can start before the file finishes loading). */
function isFaststart(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let pos = 0;
    const buf = Buffer.alloc(16);
    while (pos < size) {
      fs.readSync(fd, buf, 0, 16, pos);
      let len = buf.readUInt32BE(0);
      const type = buf.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (len === 1) len = Number(buf.readBigUInt64BE(8));
      if (len < 8) return false;
      pos += len;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** ffmpeg version of FramedVideo.tsx: blur-fit, fill-and-crop or split into 1080×1920 at 30 fps.
 *  Reframe keys can pan the crop and switch the framing part-way through (see ./framing.ts). */

/**
 * Which browser renders. Default: Remotion's Chrome Headless Shell (fast shared-memory frame capture).
 * On macOS it goes through bin/headless-shell, which keeps GPU work in-process (the shell's GPU
 * helper crashes on macOS 26). CLIP_BROWSER=<path to Chrome> and CLIP_GL=<angle|swangle> override.
 */
function browserOptions() {
  const gl = (setting('CLIP_GL') || undefined) as 'swangle' | 'angle' | 'swiftshader' | undefined;
  const chromiumOptions = gl ? { gl } : {};
  if (setting('CLIP_BROWSER')) return { chromiumOptions, browserExecutable: setting('CLIP_BROWSER'), chromeMode: 'chrome-for-testing' as const };
  if (process.platform === 'darwin')
    return { chromiumOptions, browserExecutable: path.join(paths.root, 'bin', 'headless-shell'), chromeMode: 'headless-shell' as const };
  return { chromiumOptions, chromeMode: 'headless-shell' as const };
}

export interface RenderReport {
  clipId: string;
  renderedAt: string;
  output: string;
  durationS: number;
  frames: number;
  timings: { cutMs: number; bundleMs: number; renderMs: number; totalMs: number };
  /** The export names the creator on screen: the credit marker was in the project that was rendered. */
  credit?: boolean;
  /** The framed picture's check (src/qa/layout.ts): black area, the face in a split's camera band. */
  layout?: import('../qa/layout').LayoutCheck;
  realtimeFactor: number;
  concurrency: number;
  machine: string;
  spec: Record<string, unknown>;
}

export async function renderClip(
  clipId: string,
  opts: { wait?: boolean; log?: (s: string) => void; concurrency?: number; keepLayout?: boolean } = {},
): Promise<RenderReport> {
  const log = opts.log ?? console.log;
  const t0 = Date.now();
  let p = loadProject(clipId);
  const seg = p.segments[0];
  const types = await loadMarkerSchemas();
  const typeOfNode = (t: string) => types.get(t);
  // the export never includes proposed markers
  const live = p.markers.filter((m) => !m.proposed);
  const map = buildTimeMap(seg, timeMarkers(live, typeOfNode));
  const durMs = map.durationMs;
  const keys = framingKeys(live, typeOfNode, false);

  // footage: the full download or a section covering the clip (fetched now if missing)
  const need = { startMs: Math.max(0, seg.startMs - 1000), endMs: Math.min(p.sourceDurationMs, seg.endMs + 1000) };
  let media = resolveMedia(p.videoId, need.startMs, need.endMs);
  if (!media) {
    log('downloading the footage for this clip…');
    await downloadSections(p.videoId, [{ startMs: need.startMs - SECTION_MARGIN_MS, endMs: need.endMs + SECTION_MARGIN_MS }], log);
    media = resolveMedia(p.videoId, need.startMs, need.endMs);
    if (!media) throw new Error(`Couldn't get footage for ${fmtTime(need.startMs)}–${fmtTime(need.endMs)}`);
  }
  log(`${clipId}: ${fmtTime(seg.startMs)}–${fmtTime(seg.endMs)} → ${(durMs / 1000).toFixed(1)} s edited, ${live.length} markers${live.length < p.markers.length ? ` (${p.markers.length - live.length} proposed, not rendered)` : ''}`);
  if (durMs > 60_000) log('⚠ over 60 s: YouTube blocks Shorts over 1 min that get a Content ID claim');

  // 1. Cut the clip from the source in its original format first. This is the canonical clip:
  //    facecam detection and the 9:16 framing both run on it, so corrections are per clip.
  const work = path.join(paths.cache, 'render', clipId);
  fs.mkdirSync(work, { recursive: true });
  const original = path.join(work, 'original.mp4');
  const cut = path.join(work, 'cut.mp4');
  const offsetMs = Math.max(media.startMs, seg.startMs - 1000);
  const cutLen = Math.min(media.endMs, seg.endMs + 1000) - offsetMs;
  const tc = Date.now();
  log('cutting the original clip…');
  await runOrThrow('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', ((offsetMs - media.offsetMs) / 1000).toFixed(3),
    '-i', media.file,
    '-t', (cutLen / 1000).toFixed(3),
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
    '-movflags', '+faststart',
    original,
  ]);

  // a new Twitch clip may still be waiting for its automatic split layout. Find it on the
  // original-format clip, not the whole stream, so the boxes belong to this clip.
  if (p.autoSplit) {
    const { detectSplit } = await import('../reframe/split');
    await detectSplit(clipId, { auto: true, log, file: original, fileDurationMs: cutLen });
    p = loadProject(clipId);
  }

  // 2. Frame the original clip to 1080×1920 at 30 fps in ffmpeg, so the renderer's browser draws
  //    one ready-made video instead of blurring and scaling every frame. The filter mirrors
  //    FramedVideo.tsx, which does the same thing live in the Studio.
  const src = { width: media.width || 1920, height: media.height || 1080 };
  const frame = async () => {
    log('framing to 1080×1920…');
    const cutArgs = (codec: string[]) => [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', original,
      '-filter_complex', framingFilter(p.framing, keys, offsetMs, src),
      '-map', '[v]', '-map', '0:a:0?',
      ...codec,
      '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
      cut,
    ];
    try {
      await runOrThrow('ffmpeg', cutArgs(['-c:v', 'h264_videotoolbox', '-b:v', '40M']));
    } catch {
      await runOrThrow('ffmpeg', cutArgs(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14']));
    }
  };
  await frame();

  // 3. Check the framed picture before the expensive render (src/qa/layout.ts): nothing black for the
  //    whole clip, and in a split a face in the camera band. A split with no face in its camera band
  //    becomes blur-fit and is framed again: a fallback is better than a bad vertical. The split boxes
  //    stay in the project, so the Studio can switch back. Black from the source itself is reported
  //    (QA fails `layout`), not switched: blur-fit would show it too. `keepLayout` only reports.
  const { checkLayout, needsBlurFallback } = await import('../qa/layout');
  const checkNow = () => checkLayout(cut, p.framing, { durationMs: cutLen, splitSpans: splitSpans(p.framing, keys, offsetMs) });
  let layout = await checkNow();
  // facecam-only / game-only spans are no reason to keep a split that has no face: they follow it to blur-fit
  // (resolveKeys drops a solo span that is not over a split)
  if (needsBlurFallback(layout) && p.framing.mode === 'split' && !keys.some((k) => !k.solo && !k.restore) && !opts.keepLayout) {
    const why = layout.issues.filter((i) => /face/.test(i)).join('; ');
    log(`⚠ layout: ${why}. Switching this clip to blur-fit.`);
    p = loadProject(clipId);
    // captions that were moved under a whole-frame plate go back to where blur-fit puts them
    const { captionPositionForSplit } = await import('../core/layout');
    if (p.captions.position === captionPositionForSplit(p.framing.split, src.width, src.height)) p.captions = { ...p.captions, position: captionPositionFor(src.width, src.height) };
    p.framing = { ...p.framing, mode: 'blur' };
    saveProject(p);
    await frame();
    layout = { ...(await checkNow()), fellBack: `split → blur-fit: ${why}` };
  }
  if (!layout.ok) log(`⚠ layout: ${layout.issues.join('; ')}`);
  else log(`layout ok: ${layout.mode}${layout.faceInCam !== null ? `, face in the camera band ${Math.round(layout.faceInCam * 100)}% of the clip` : ''}`);
  const cutMs = Date.now() - tc;

  // 4. Serve the cut and assets to the renderer's browser.
  const server = await serveFiles({ '/cut.mp4': cut, '/assets': paths.assets });
  try {
    const tb = Date.now();
    const serveUrl = await getBundle(log);
    const bundleMs = Date.now() - tb;

    const words = loadTranscript(p.videoId).words.filter((w) => w.endMs >= seg.startMs - 2000 && w.startMs <= seg.endMs + 2000);
    const inputProps: ClipProps = {
      project: { ...p, markers: live },
      words,
      media: { src: `${server.base}/cut.mp4`, offsetMs, width: media.width, height: media.height, framed: true },
      assetBase: `${server.base}/assets/`,
    };

    const { ensureBrowser, selectComposition, renderMedia } = await import('@remotion/renderer');
    const browser = browserOptions();
    await ensureBrowser({ chromeMode: 'headless-shell' }); // downloads the shell on first use
    const logLevel = setting('CLIP_LOG') as 'error' | 'verbose' | 'info' | 'warn';
    log('preparing composition…');
    const composition = await selectComposition({ serveUrl, id: 'Clip', inputProps, logLevel, ...browser });
    fs.mkdirSync(paths.exports, { recursive: true });
    const out = path.join(paths.exports, `${clipId}.mp4`);
    const tmp = path.join(work, 'out.mp4');
    const concurrency = opts.concurrency ?? (setting('CLIP_CONCURRENCY') || Math.max(2, os.cpus().length - 2));
    const tr = Date.now();
    let lastPct = -1;
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      outputLocation: tmp,
      inputProps,
      concurrency,
      imageFormat: 'jpeg',
      jpegQuality: 92,
      pixelFormat: 'yuv420p',
      videoBitrate: '11M',
      audioCodec: 'aac',
      audioBitrate: '192k',
      enforceAudioTrack: true,
      // measured on an M1: 4 decode threads + VideoToolbox encoding took a 10 s test from 2.0× to 1.45× clip length
      offthreadVideoThreads: setting('CLIP_OVT') || 4,
      hardwareAcceleration: setting('CLIP_HW') ? 'if-possible' : 'disable',
      logLevel,
      ...browser,
      onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 100);
        if (pct >= lastPct + 5 || pct === 100) {
          lastPct = pct;
          log(`progress ${pct}%`);
        }
      },
    });
    const renderMs = Date.now() - tr;

    // loudness: -14 LUFS like the platforms normalise to, -1 dBTP ceiling (also writes faststart)
    const { normalizeLoudness } = await import('../qa');
    const norm = path.join(work, 'out-norm.mp4');
    const loud = await normalizeLoudness(tmp, norm);
    fs.renameSync(norm, tmp);
    if (loud.before !== null) log(`loudness ${loud.before.toFixed(1)} LUFS → -14 (${loud.gainDb >= 0 ? '+' : ''}${loud.gainDb.toFixed(1)} dB)`);
    if (!isFaststart(tmp)) {
      const fixed = path.join(work, 'out-faststart.mp4');
      await runOrThrow('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-c', 'copy', '-movflags', '+faststart', fixed]);
      fs.renameSync(fixed, tmp);
    }
    fs.renameSync(tmp, out);

    const probe = JSON.parse(
      (
        await runOrThrow('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,profile,width,height,r_frame_rate,sample_rate,bit_rate:format=bit_rate,size,duration', '-of', 'json', out])
      ).stdout,
    );
    const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
    const a = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
    const spec = {
      size: `${v.width}×${v.height}`,
      fps: v.r_frame_rate,
      video: `${v.codec_name} ${v.profile}`,
      audio: a ? `${a.codec_name} ${a.sample_rate} Hz` : 'none',
      mbps: Math.round(Number(probe.format.bit_rate) / 1e5) / 10,
      faststart: isFaststart(out),
      bytes: Number(probe.format.size),
    };
    const totalMs = Date.now() - t0;
    const report: RenderReport = {
      clipId,
      renderedAt: new Date().toISOString(),
      output: path.relative(paths.root, out),
      durationS: Math.round(durMs) / 1000,
      frames: composition.durationInFrames,
      timings: { cutMs, bundleMs, renderMs, totalMs },
      credit: p.markers.some((m) => m.type === CREDIT && !m.proposed),
      layout,
      realtimeFactor: Math.round((renderMs / durMs) * 100) / 100,
      concurrency,
      machine: `${os.cpus()[0]?.model ?? os.arch()} · ${Math.round(os.totalmem() / 2 ** 30)} GB`,
      spec,
    };
    writeJson(path.join(paths.exports, `${clipId}.json`), report);
    // the post text next to the video, ready to paste
    fs.writeFileSync(path.join(paths.exports, `${clipId}.txt`), postFile(postFor(p.post, suggestedPost(p))));
    fs.rmSync(work, { recursive: true, force: true }); // the cut is ~100 MB; keep it only when a render fails
    log(`✔ ${report.output}  ${spec.size} ${spec.video} ${spec.mbps} Mbps, ${spec.audio}, faststart ${spec.faststart ? 'yes' : 'no'}`);
    log(`  took ${(totalMs / 1000).toFixed(1)} s (cut ${(cutMs / 1000).toFixed(1)}, bundle ${(bundleMs / 1000).toFixed(1)}, render ${(renderMs / 1000).toFixed(1)}) = ${report.realtimeFactor}× clip length`);
    return report;
  } finally {
    server.close();
  }
}
