// Where a video's footage lives: the full download, or sections downloaded for just the ranges
// we need (a 2 h video is 2–4 GB; its candidate sections are a few hundred MB).
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJsonIf, writeJson } from '../core/paths';
import { ffprobe } from '../core/proc';
import type { MediaInfo } from '../core/schemas';
import { subtractRanges, mergeRanges, type Range } from '../core/ranges';

export const SECTION_MARGIN_MS = 30_000; // context kept around a candidate so trimming has room

/**
 * A live broadcast is served from a VOD that is still being written. Its HLS playlist only reaches
 * back a couple of hours, so a section older than that comes back as a single frame unless yt-dlp is
 * told to read the stream from its start. Harmless once the broadcast has ended.
 */
export function liveFromStart(videoId: string): string[] {
  const live = youtubeLive(videoId);
  if (live) throw new Error(liveYouTubeError(videoId, live));
  const meta = readJsonIf<{ live?: boolean }>(paths.videoFile(videoId, 'meta.json'));
  return meta?.live ? ['--live-from-start'] : [];
}

/**
 * A YouTube stream that was still live when it was ingested has no stable timeline: yt-dlp reads a
 * DVR window that moves, and a section asked for at any time comes back as whatever is live. Three
 * iShowSpeed clips cut at 0:26, 1:31 and 1:45 were all the same minute (2026-11-19). Every download
 * goes through liveFromStart, so this refuses them all until the video is ingested again after it ends.
 */
export function youtubeLive(videoId: string): string | undefined {
  if (videoId.startsWith('tw-')) return undefined;
  const s = readJsonIf<{ live_status?: string }>(paths.videoFile(videoId, 'info.json'))?.live_status;
  return s === 'is_live' || s === 'is_upcoming' || s === 'post_live' ? s : undefined;
}

export const liveYouTubeError = (videoId: string, status: string) =>
  `${videoId} is a YouTube stream that was ${status === 'is_upcoming' ? 'not started' : status === 'post_live' ? 'still processing' : 'still live'} when it was read: its times do not match the finished video. Wait until it has ended, then \`./clip ingest ${videoId} --refresh\``;

/** Fraction of a file where the picture doesn't change (freezedetect). Audio podcasts uploaded over a
 *  still image come out near 1.0, and their shorts would be a static picture with captions. */
export async function stillFraction(file: string, maxSec = 60): Promise<number> {
  const { run } = await import('../core/proc');
  const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-t', String(maxSec), '-i', file, '-an', '-vf', 'freezedetect=n=-55dB:d=2', '-f', 'null', '-']);
  const dur = Number(/Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr)?.slice(1).reduce((a, x, k) => a + Number(x) * [3600, 60, 1][k], 0) ?? maxSec);
  const total = Math.min(maxSec, dur || maxSec);
  const frozen = [...r.stderr.matchAll(/freeze_duration: ([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
  // a freeze still running at the end of the file has a start but no duration yet
  const open = [...r.stderr.matchAll(/freeze_start: ([\d.]+)/g)].length > [...r.stderr.matchAll(/freeze_end: /g)].length;
  const lastStart = Number([...r.stderr.matchAll(/freeze_start: ([\d.]+)/g)].pop()?.[1] ?? total);
  return Math.min(1, (frozen + (open ? total - lastStart : 0)) / total);
}

export interface Section extends MediaInfo {
  startMs: number;
  endMs: number;
  file: string; // absolute path
  name: string; // file name in sections/
}

export interface ResolvedMedia extends MediaInfo {
  file: string;
  /** URL path the Studio serves it at. */
  urlPath: string;
  /** Source time of the file's first frame. */
  offsetMs: number;
  /** Source range the file covers. */
  startMs: number;
  endMs: number;
  kind: 'full' | 'section';
}

const sectionsDir = (id: string) => paths.videoFile(id, 'sections');

export function listSections(videoId: string): Section[] {
  const dir = sectionsDir(videoId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => /^(\d+)_(\d+)\.mp4$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => {
      const info = readJsonIf<MediaInfo>(path.join(dir, `${m[1]}_${m[2]}.json`));
      if (!info || !info.width || !info.height) return null; // audio-only or unprobed: not footage
      return { ...info, startMs: Number(m[1]), endMs: Number(m[2]), file: path.join(dir, m[0]), name: m[0] };
    })
    .filter((s): s is Section => !!s)
    .sort((a, b) => a.startMs - b.startMs);
}

export function hasFull(videoId: string): boolean {
  return fs.existsSync(paths.videoFile(videoId, 'source.mp4')) && fs.existsSync(paths.videoFile(videoId, 'media.json'));
}

/** A local file that covers [fromMs, toMs], or null if we'd have to download it. */
export function resolveMedia(videoId: string, fromMs: number, toMs: number): ResolvedMedia | null {
  if (hasFull(videoId)) {
    const m = readJsonIf<MediaInfo>(paths.videoFile(videoId, 'media.json'))!;
    return { ...m, file: paths.videoFile(videoId, 'source.mp4'), urlPath: `/media/library/${videoId}/source.mp4`, offsetMs: 0, startMs: 0, endMs: m.durationMs, kind: 'full' };
  }
  const s = listSections(videoId)
    .filter((x) => x.startMs <= fromMs + 50 && x.endMs >= toMs - 50)
    .sort((a, b) => a.endMs - a.startMs - (b.endMs - b.startMs))[0];
  if (!s) return null;
  return { width: s.width, height: s.height, fps: s.fps, durationMs: s.durationMs, file: s.file, urlPath: `/media/library/${videoId}/sections/${s.name}`, offsetMs: s.startMs, startMs: s.startMs, endMs: s.endMs, kind: 'section' };
}

/** Merge overlapping/nearby ranges and drop what's already on disk. */
export function missingRanges(videoId: string, ranges: { startMs: number; endMs: number }[], durationMs: number) {
  if (hasFull(videoId)) return [];
  const have = listSections(videoId);
  const want = ranges
    .map((r) => ({ startMs: Math.max(0, Math.round(r.startMs)), endMs: Math.min(durationMs, Math.round(r.endMs)) }))
    .filter((r) => r.endMs > r.startMs && !have.some((s) => s.startMs <= r.startMs && s.endMs >= r.endMs))
    .sort((a, b) => a.startMs - b.startMs);
  const merged: { startMs: number; endMs: number }[] = [];
  for (const r of want) {
    const last = merged[merged.length - 1];
    if (last && r.startMs <= last.endMs + 20_000) last.endMs = Math.max(last.endMs, r.endMs);
    else merged.push({ ...r });
  }
  return merged;
}

/** Record a finished section download (probe + index file next to it). */
export async function registerSection(videoId: string, tmpFile: string, startMs: number, endMs: number): Promise<Section> {
  const dir = sectionsDir(videoId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${startMs}_${endMs}.mp4`;
  const file = path.join(dir, name);
  const probe = await ffprobe(tmpFile);
  // after HTTP 403s yt-dlp can hand back only the audio; that's not usable footage
  if (!probe.width || !probe.height) {
    fs.rmSync(tmpFile, { force: true });
    throw new Error(`section ${startMs}–${endMs} ms came back with no video stream (YouTube served audio only)`);
  }
  fs.renameSync(tmpFile, file);
  const info = probe;
  const still = await stillFraction(file);
  writeJson(path.join(dir, `${startMs}_${endMs}.json`), { ...info, still: Math.round(still * 100) / 100 });
  return { ...info, startMs, endMs, file, name };
}

/** True when the footage we have is (almost) a still image: an audio podcast uploaded with cover art. */
export function isStillImage(videoId: string): boolean {
  const fr = listSections(videoId).map((s) => (s as Section & { still?: number }).still).filter((x): x is number => typeof x === 'number');
  return fr.length > 0 && fr.reduce((a, b) => a + b, 0) / fr.length > 0.9;
}

export function footageSummary(videoId: string) {
  const sections = listSections(videoId);
  const bytes = sections.reduce((a, s) => a + fs.statSync(s.file).size, 0);
  return {
    full: hasFull(videoId),
    audio: fs.existsSync(paths.videoFile(videoId, 'audio.m4a')),
    sections: sections.map((s) => ({ startMs: s.startMs, endMs: s.endMs })),
    sectionBytes: bytes,
    stillImage: isStillImage(videoId),
  };
}

// ---------- audio ----------
// YouTube videos get the whole audio track (audio.m4a, ~1 MB a minute). Twitch broadcasts are 6–12 h
// and may still be growing, so their audio comes in chunks for the ranges being scanned:
// library/<id>/audio/<startMs>_<endMs>.m4a.

const audioDir = (id: string) => paths.videoFile(id, 'audio');

export interface AudioChunk extends Range {
  file: string;
}

export function listAudioChunks(videoId: string): AudioChunk[] {
  const dir = audioDir(videoId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => /^(\d+)_(\d+)\.m4a$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ startMs: Number(m[1]), endMs: Number(m[2]), file: path.join(dir, m[0]) }))
    .sort((a, b) => a.startMs - b.startMs);
}

export const audioChunkPath = (videoId: string, r: Range) => path.join(audioDir(videoId), `${r.startMs}_${r.endMs}.m4a`);

/** A local file with sound for [fromMs, toMs]: the whole audio, an audio chunk, the full video or a section. */
export function resolveAudio(videoId: string, fromMs: number, toMs: number): { file: string; offsetMs: number } | null {
  const whole = paths.videoFile(videoId, 'audio.m4a');
  if (fs.existsSync(whole)) return { file: whole, offsetMs: 0 };
  const chunk = listAudioChunks(videoId).find((c) => c.startMs <= fromMs + 50 && c.endMs >= toMs - 50);
  if (chunk) return { file: chunk.file, offsetMs: chunk.startMs };
  const m = resolveMedia(videoId, fromMs, toMs);
  return m ? { file: m.file, offsetMs: m.offsetMs } : null;
}

/** The parts of `ranges` with no audio on disk yet (nearby gaps joined, so downloads stay few). */
export function missingAudio(videoId: string, ranges: Range[], durationMs: number): Range[] {
  if (fs.existsSync(paths.videoFile(videoId, 'audio.m4a')) || hasFull(videoId)) return [];
  const clamp = ranges.map((r) => ({ startMs: Math.max(0, Math.round(r.startMs)), endMs: Math.min(durationMs, Math.round(r.endMs)) }));
  return mergeRanges(subtractRanges(clamp, listAudioChunks(videoId)), 20_000);
}

/**
 * Files that together cover [fromMs, toMs] with sound, in order: one piece when a single file covers
 * it, several when the range spans audio chunks (e.g. a seed window that starts before a pass).
 * Null when part of the range has no audio on disk.
 */
export function audioPieces(videoId: string, fromMs: number, toMs: number): { file: string; offsetMs: number; startMs: number; endMs: number }[] | null {
  const one = resolveAudio(videoId, fromMs, toMs);
  if (one) return [{ ...one, startMs: fromMs, endMs: toMs }];
  const have = [
    ...listAudioChunks(videoId).map((c) => ({ file: c.file, offsetMs: c.startMs, startMs: c.startMs, endMs: c.endMs })),
    ...listSections(videoId).map((c) => ({ file: c.file, offsetMs: c.startMs, startMs: c.startMs, endMs: c.endMs })),
  ];
  const out: { file: string; offsetMs: number; startMs: number; endMs: number }[] = [];
  let cur = fromMs;
  while (cur < toMs - 50) {
    const next = have.filter((h) => h.startMs <= cur + 50 && h.endMs > cur + 50).sort((a, b) => b.endMs - a.endMs)[0];
    if (!next) return null;
    const end = Math.min(next.endMs, toMs);
    out.push({ file: next.file, offsetMs: next.offsetMs, startMs: cur, endMs: end });
    cur = end;
  }
  return out;
}
