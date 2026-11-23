// Download jobs: audio only, sections (just the ranges we need) and the full video.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { paths, writeJson } from '../core/paths';
import { runOrThrow, YTDLP, ffprobe } from '../core/proc';
import { loadMeta } from './ingest';
import { missingRanges, registerSection, missingAudio, audioChunkPath, listAudioChunks, liveFromStart } from './media';
import { ALIGN, sectionStartFromAudio } from './align';
import { fmtTime } from '../core/time';
import { sourceOf } from './source';

const watchUrl = (id: string) => sourceOf(id).url;
const YT_VIDEO_FORMAT = 'bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]/bv*[height<=1080]+ba/b';
// Twitch serves muxed HLS renditions (1080p60, 720p60…) plus Audio_Only
const videoFormat = (id: string) => (sourceOf(id).platform === 'twitch' ? 'b[height<=1080]/b' : YT_VIDEO_FORMAT);
const audioFormat = (id: string) => (sourceOf(id).platform === 'twitch' ? 'Audio_Only/ba/b' : 'ba[ext=m4a]/ba');

type Progress = (s: string) => void;

function ytdlpProgress(progress: Progress, label: string) {
  let last = 0;
  let part = 0;
  return (line: string) => {
    if (/Destination:/.test(line)) part++;
    const m = /\[download\]\s+([\d.]+)%/.exec(line);
    if (m && Date.now() - last > 1000) {
      last = Date.now();
      progress(`${label}${part > 1 ? ` (part ${part})` : ''} ${m[1]}%`);
    }
  };
}

/** Audio only (~1 MB a minute): feeds audio signals, Whisper and the waveform without the video. */
export async function downloadAudio(videoId: string, progress: Progress) {
  const out = paths.videoFile(videoId, 'audio.m4a');
  if (fs.existsSync(out)) return { file: out, skipped: true };
  fs.mkdirSync(paths.video(videoId), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(paths.video(videoId), 'audio.tmp-'));
  const [cmd, base] = YTDLP;
  await runOrThrow(cmd, [...base, ...liveFromStart(videoId), '-f', audioFormat(videoId), '--newline', '-o', `${tmp}/audio.%(ext)s`, watchUrl(videoId)], {
    onLine: ytdlpProgress(progress, 'audio'),
  });
  const got = fs.readdirSync(tmp).find((f) => f.startsWith('audio.') && !f.endsWith('.part'));
  if (!got) throw new Error('yt-dlp produced no audio file');
  if (got.endsWith('.m4a')) fs.renameSync(path.join(tmp, got), out);
  else await runOrThrow('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(tmp, got), '-vn', '-c:a', 'aac', '-b:a', '128k', out]);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { file: out };
}

/** Download only the requested source ranges (merged, minus what's on disk). Frame-accurate: tested
 *  against a full download, a section's first frame and audio sample land exactly on its start time.
 *  yt-dlp fetches sections through ffmpeg at roughly real-time speed, so ranges download in parallel
 *  and each one is usable as soon as it lands. */
export async function downloadSections(videoId: string, ranges: { startMs: number; endMs: number }[], progress: Progress, parallel = 6) {
  const meta = loadMeta(videoId);
  const todo = missingRanges(videoId, ranges, meta.durationMs);
  if (!todo.length) return { downloaded: 0 };
  const [cmd, base] = YTDLP;
  const pct = new Map<number, string>();
  let done = 0;
  const report = () => progress(`${done}/${todo.length} sections${pct.size ? ` · ${[...pct.values()].join(' ')}` : ''}`);
  const one = async (r: { startMs: number; endMs: number }) => {
    // Unique per download: sections and split jobs can ask for the same range in parallel, and a
    // shared temp dir lets one job delete the other's file mid-write (ffmpeg "No such file").
    fs.mkdirSync(paths.video(videoId), { recursive: true });
    const tmp = fs.mkdtempSync(path.join(paths.video(videoId), 'sections.tmp-'));
    // Twitch cuts land up to a segment early or a keyframe late, so ask with room on both sides: the
    // measured file then always covers the range (else it would look missing and download again)
    const twitch = sourceOf(videoId).platform === 'twitch';
    const req = twitch ? { startMs: Math.max(0, r.startMs - 10_000), endMs: Math.min(meta.durationMs, r.endMs + 2_000) } : r;
    try {
      await runOrThrow(
        cmd,
        [
          ...base,
          ...liveFromStart(videoId),
          '-f', videoFormat(videoId),
          '--merge-output-format', 'mp4',
          '--newline',
          '--download-sections', `*${(req.startMs / 1000).toFixed(3)}-${(req.endMs / 1000).toFixed(3)}`,
          '-o', `${tmp}/section.%(ext)s`,
          watchUrl(videoId),
        ],
        {
          onLine: (line) => {
            const m = /\[download\]\s+([\d.]+)%/.exec(line);
            if (m) (pct.set(r.startMs, `${Math.round(Number(m[1]))}%`), report());
          },
        },
      );
      const f = fs.readdirSync(tmp).find((x) => x.endsWith('.mp4'));
      if (!f) throw new Error(`section ${r.startMs} ms: yt-dlp produced no file`);
      // Twitch sections start at the HLS segment before the asked time: measure where it really is
      let start = req.startMs;
      if (twitch) {
        const a = await measureSectionStart(videoId, path.join(tmp, f), req.startMs);
        if (a) start = a.startMs;
        else progress(`section ${fmtTime(req.startMs, 0)}: couldn't confirm where it starts (quiet audio); assuming the asked time`);
      }
      const dur = (await ffprobe(path.join(tmp, f))).durationMs;
      await registerSection(videoId, path.join(tmp, f), start, start + dur);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      pct.delete(r.startMs);
      done++;
      report();
    }
  };
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: Math.min(parallel, queue.length) }, async () => {
      for (let r = queue.shift(); r; r = queue.shift()) await one(r);
    }),
  );
  return { downloaded: todo.length, ranges: todo };
}

/**
 * Audio for just these ranges (Twitch broadcasts are too long to fetch whole): one m4a chunk per
 * missing stretch in library/<id>/audio/. Returns the chunks it added.
 */
export async function downloadAudioRanges(videoId: string, ranges: { startMs: number; endMs: number }[], progress: Progress) {
  const meta = loadMeta(videoId);
  // ≤ 30 min per chunk: quick to seek in, and a pass on a live stream adds small pieces
  const todo = missingAudio(videoId, ranges, meta.durationMs).flatMap((r) => {
    const out: { startMs: number; endMs: number }[] = [];
    for (let a = r.startMs; a < r.endMs; a += 30 * 60_000) out.push({ startMs: a, endMs: Math.min(r.endMs, a + 30 * 60_000) });
    return out;
  });
  const added: { startMs: number; endMs: number }[] = [];
  const [cmd, base] = YTDLP;
  for (const r of todo) {
    fs.mkdirSync(paths.video(videoId), { recursive: true });
    const tmp = fs.mkdtempSync(path.join(paths.video(videoId), 'audio.tmp-'));
    try {
      progress(`audio ${fmtTime(r.startMs, 0)}–${fmtTime(r.endMs, 0)}`);
      await runOrThrow(cmd, [
        ...base, ...liveFromStart(videoId), '-f', audioFormat(videoId), '--newline',
        '--download-sections', `*${(r.startMs / 1000).toFixed(3)}-${(r.endMs / 1000).toFixed(3)}`,
        '-o', `${tmp}/audio.%(ext)s`, watchUrl(videoId),
      ]);
      const got = fs.readdirSync(tmp).find((f) => f.startsWith('audio.') && !f.endsWith('.part'));
      if (!got) throw new Error(`audio ${r.startMs}–${r.endMs} ms: yt-dlp produced no file`);
      const out = audioChunkPath(videoId, r);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      // keep only the sound in an m4a: copy the AAC stream as is, re-encode only if that fails
      const input = path.join(tmp, got);
      try {
        await runOrThrow('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-c:a', 'copy', `${out}.tmp.m4a`]);
      } catch {
        await runOrThrow('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-c:a', 'aac', '-b:a', '128k', `${out}.tmp.m4a`]);
      }
      fs.renameSync(`${out}.tmp.m4a`, out);
      added.push(r);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return { added };
}

/** Exact audio for a range: the whole track or an audio chunk (not a section, which may be off). */
function exactAudio(videoId: string, fromMs: number, toMs: number): { file: string; offsetMs: number } | null {
  const whole = paths.videoFile(videoId, 'audio.m4a');
  if (fs.existsSync(whole)) return { file: whole, offsetMs: 0 };
  const c = listAudioChunks(videoId).find((x) => x.startMs <= fromMs && x.endMs >= toMs);
  return c ? { file: c.file, offsetMs: c.startMs } : null;
}

/** Mono 16-bit PCM at ALIGN.rate from ffmpeg (binary stdout, so not through run(), which decodes text). */
function pcm(args: string[]): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args, '-vn', '-ac', '1', '-ar', String(ALIGN.rate), '-f', 's16le', '-']);
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with ${code}: ${err.trim().split('\n').pop()}`));
      const b = Buffer.concat(chunks);
      resolve(new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2)));
    });
  });
}

/**
 * Measure a section file's real start (source ms) by matching its first 20 s of audio against exact
 * audio around the asked start: a local audio chunk, else the stream's audio decoded from a precise
 * seek (decoding audio is sample-accurate; copying video is not). Null if the match is too weak.
 */
export async function measureSectionStart(videoId: string, file: string, askedMs: number) {
  const refFrom = Math.max(0, askedMs - ALIGN.searchMs);
  const refTo = askedMs + ALIGN.probeMs + 5_000;
  const probe = await pcm(['-t', String(ALIGN.probeMs / 1000), '-i', file]);
  const local = exactAudio(videoId, refFrom, refTo);
  let ref: Int16Array;
  if (local) ref = await pcm(['-ss', ((refFrom - local.offsetMs) / 1000).toFixed(3), '-t', ((refTo - refFrom) / 1000).toFixed(3), '-i', local.file]);
  else {
    const [cmd, base] = YTDLP;
    const { stdout } = await runOrThrow(cmd, [...base, '-q', '-f', audioFormat(videoId), '-g', watchUrl(videoId)]);
    const url = String(stdout).trim().split('\n')[0];
    ref = await pcm(['-ss', (refFrom / 1000).toFixed(3), '-i', url, '-t', ((refTo - refFrom) / 1000).toFixed(3)]);
  }
  return sectionStartFromAudio(probe, ref, refFrom);
}

export async function downloadFull(videoId: string, progress: Progress) {
  const [cmd, base] = YTDLP;
  await runOrThrow(
    cmd,
    [...base, ...liveFromStart(videoId), '-f', videoFormat(videoId), '--merge-output-format', 'mp4', '-N', '4', '--newline', '-o', `${paths.video(videoId)}/source.%(ext)s`, watchUrl(videoId)],
    {
      onLine: (line) => {
        ytdlpProgress(progress, 'video')(line);
        if (/\[Merger\]/.test(line)) progress('merging');
      },
    },
  );
  const media = await ffprobe(paths.videoFile(videoId, 'source.mp4'));
  writeJson(paths.videoFile(videoId, 'media.json'), media);
  return { ...media };
}
