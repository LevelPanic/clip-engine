// Audio events: laughs, applause, cheers and shouts heard in the soundtrack itself, so reaction
// moments are found even when the captions have no [laughter] tags. Uses Apple's built-in
// SoundAnalysis classifier through a small Swift tool (tools/audio-events), so macOS only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths, writeJson, readJsonIf } from '../core/paths';
import { mergeRanges } from '../core/ranges';
import { runOrThrow } from '../core/proc';

export interface AudioEventsFile {
  durationMs: number;
  /** Length of each analysis window; `ms` below is a window's start. */
  windowMs: number;
  hopMs: number;
  /** Watched labels above the tool's floor (0.3); the signal picks the real threshold. */
  events: { ms: number; label: string; confidence: number }[];
  /** Ranges analysed so far (Twitch: only scanned ranges). Absent = the whole video. */
  covered?: { startMs: number; endMs: number }[];
}

const SOURCE = path.join(paths.root, 'tools', 'audio-events', 'main.swift');
const BINARY = path.join(paths.cache, 'bin', 'audio-events');

/** Compiles the Swift tool on first use, and again whenever main.swift changes. */
async function audioEventsBinary(): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('Audio events need macOS (Apple SoundAnalysis).');
  if (fs.existsSync(BINARY) && fs.statSync(BINARY).mtimeMs >= fs.statSync(SOURCE).mtimeMs) return BINARY;
  fs.mkdirSync(path.dirname(BINARY), { recursive: true });
  // Build next to the target and rename, so a concurrent run never executes half a binary.
  const tmp = `${BINARY}.${process.pid}.tmp`;
  await runOrThrow('swiftc', ['-O', SOURCE, '-o', tmp]);
  fs.renameSync(tmp, BINARY);
  return BINARY;
}

/** Classifies the video's audio and writes library/<id>/audio-events.json. `seconds` is how long it took. */
export async function analyzeAudioEvents(
  videoId: string,
  log: (line: string) => void = () => {},
): Promise<{ file: string; events: number; seconds: number }> {
  const audio = paths.videoFile(videoId, 'audio.m4a');
  const video = paths.videoFile(videoId, 'source.mp4');
  const input = fs.existsSync(audio) ? audio : fs.existsSync(video) ? video : undefined;
  if (!input) throw new Error(`No audio for ${videoId}: library/${videoId}/source.mp4 isn't downloaded yet.`);
  const started = Date.now();
  const data = await classify(input, log);
  const file = paths.videoFile(videoId, 'audio-events.json');
  writeJson(file, data);
  return { file, events: data.events.length, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

/**
 * Classify one audio chunk (a scanned range of a stream) and merge its events into
 * audio-events.json, replacing whatever was there for that range.
 */
export async function analyzeAudioChunk(videoId: string, chunk: { file: string; startMs: number; endMs: number }, log: (line: string) => void = () => {}) {
  const started = Date.now();
  const data = await classify(chunk.file, log);
  const file = paths.videoFile(videoId, 'audio-events.json');
  const prev = readJsonIf<AudioEventsFile>(file);
  const shifted = data.events.map((e) => ({ ...e, ms: e.ms + chunk.startMs }));
  const kept = (prev?.events ?? []).filter((e) => e.ms < chunk.startMs || e.ms >= chunk.endMs);
  const merged: AudioEventsFile = {
    durationMs: Math.max(prev?.durationMs ?? 0, chunk.endMs),
    windowMs: data.windowMs,
    hopMs: data.hopMs,
    events: [...kept, ...shifted].sort((a, b) => a.ms - b.ms),
    covered: mergeRanges([...(prev?.covered ?? []), { startMs: chunk.startMs, endMs: chunk.endMs }]),
  };
  writeJson(file, merged);
  return { events: shifted.length, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

async function classify(input: string, log: (line: string) => void): Promise<AudioEventsFile> {
  const bin = await audioEventsBinary();
  // Always decode to a mono 16 kHz WAV first (the rate the classifier states its window limits in):
  // Core Audio stops early on some yt-dlp mp4s (a 2 h livestream read as 1:46) and may not read
  // every codec yt-dlp can merge (e.g. Opus). The ~5 s per 2 h is won back by analysing plain PCM.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-events-'));
  const wav = path.join(dir, 'audio.wav');
  let stdout: string;
  try {
    log(`audio-events: extracting the audio of ${path.basename(input)}`);
    await runOrThrow('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    ({ stdout } = await runOrThrow(bin, [wav], { onLine: (line) => line.startsWith('audio-events:') && log(line) }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return JSON.parse(stdout) as AudioEventsFile;
}
