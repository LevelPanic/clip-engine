// Transcripts that grow window by window. Twitch has no captions and a broadcast runs 6–12 hours, so
// Whisper transcribes only where it matters (around a scan's seeds, or a range someone reads), and
// each window is merged into transcript.json. `covered` records what's been transcribed.
import fs from 'node:fs';
import { withVideoLock } from '../core/lock';
import { paths, readJsonIf, writeJson } from '../core/paths';
import { mergeRanges, subtractRanges, type Range } from '../core/ranges';
import { fmtTime } from '../core/time';
import type { Transcript, Word } from '../core/schemas';

/** Put freshly transcribed words for `range` into a transcript (replacing what was there). Pure. */
export function mergeTranscript(videoId: string, old: Transcript | undefined, add: { words: Omit<Word, 'i'>[] | Word[]; tags: Transcript['tags'] }, range: Range): Transcript {
  const inside = (ms: number) => ms >= range.startMs && ms < range.endMs;
  const keepWords = (old?.words ?? []).filter((w) => !inside(w.startMs));
  const newWords = add.words.filter((w) => inside(w.startMs));
  const words = [...keepWords, ...newWords].sort((a, b) => a.startMs - b.startMs).map((w, i) => ({ ...w, i }));
  const tags = [...(old?.tags ?? []).filter((g) => !inside(g.ms)), ...add.tags.filter((g) => inside(g.ms))].sort((a, b) => a.ms - b.ms);
  return {
    videoId,
    source: old?.source ?? 'whisper',
    lang: old?.lang ?? 'en',
    words,
    tags,
    covered: mergeRanges([...(old?.covered ?? []), range]),
  };
}

/** A gap shorter than this next to what is already transcribed is not worth a Whisper run (and Whisper invents words on a second of audio). */
export const MIN_TRANSCRIBE_MS = 3_000;

/**
 * What still needs transcribing in these ranges (nothing for videos with full captions). Slivers at
 * the edge of what is already covered are left alone: reading "the region plus 20 s" must not start a
 * download and a Whisper run for the last half second.
 */
export function untranscribed(t: Transcript | undefined, ranges: Range[]): Range[] {
  if (t && !t.covered) return [];
  const gaps = mergeRanges(subtractRanges(ranges, t?.covered ?? []), 5_000);
  return t?.covered?.length ? gaps.filter((r) => r.endMs - r.startMs >= MIN_TRANSCRIBE_MS) : gaps;
}

export interface TranscribeDeps {
  downloadAudio: (videoId: string, ranges: Range[], log: (s: string) => void) => Promise<unknown>;
  whisper: (videoId: string, r: Range, log: (s: string) => void) => Promise<Pick<Transcript, 'words' | 'tags'>>;
}

const defaultDeps = async (): Promise<TranscribeDeps> => {
  const { downloadAudioRanges } = await import('../jobs/downloads');
  const { whisperTranscript } = await import('./whisper');
  return {
    downloadAudio: (id, ranges, log) => downloadAudioRanges(id, ranges, log),
    // CLIP_WHISPER_MODEL=small for non-English streams; the default small.en hallucinates on German.
    whisper: (id, r, log) =>
      whisperTranscript(id, { fromMs: r.startMs, toMs: r.endMs, model: process.env.CLIP_WHISPER_MODEL, onProgress: log }),
  };
};

/**
 * Make sure these ranges are transcribed: downloads their audio if needed, runs Whisper on what's
 * missing and merges it in. Caption fixes on existing clips follow their words to the new numbers.
 */
export async function ensureTranscribed(videoId: string, ranges: Range[], log: (s: string) => void = () => {}, deps?: TranscribeDeps) {
  const file = paths.videoFile(videoId, 'transcript.json');
  const none = { transcribed: [] as Range[], failed: [] as { range: Range; error: string }[], seconds: 0 };
  if (!untranscribed(readJsonIf<Transcript>(file), ranges).length) return none;
  // one transcriber at a time per video; whoever waited usually finds the window already done
  return withVideoLock(videoId, 'transcript', () => transcribeMissing(videoId, ranges, log, deps));
}

async function transcribeMissing(videoId: string, ranges: Range[], log: (s: string) => void, deps?: TranscribeDeps) {
  const file = paths.videoFile(videoId, 'transcript.json');
  const todo = untranscribed(readJsonIf<Transcript>(file), ranges);
  if (!todo.length) return { transcribed: [] as Range[], failed: [] as { range: Range; error: string }[], seconds: 0 };
  const d = deps ?? (await defaultDeps());
  const t0 = Date.now();
  await d.downloadAudio(videoId, todo, log);
  const done: Range[] = [];
  const failed: { range: Range; error: string }[] = [];
  for (const r of todo) {
    log(`transcribing ${fmtTime(r.startMs, 0)}–${fmtTime(r.endMs, 0)}`);
    try {
      const got = await d.whisper(videoId, r, log);
      const old = readJsonIf<Transcript>(file);
      const next = mergeTranscript(videoId, old, got, r);
      const { remapCaptionFixes } = await import('./ingest');
      remapCaptionFixes(videoId, old, next, log);
      writeJson(file, next);
      done.push(r);
    } catch (e) {
      // one bad window (no audio, Whisper crash) shouldn't cost the others
      failed.push({ range: r, error: (e as Error).message.split('\n')[0] });
    }
  }
  if (done.length) await writeTranscriptMd(videoId);
  if (!done.length && failed.length) throw new Error(failed[0].error);
  return { transcribed: done, failed, seconds: Math.round((Date.now() - t0) / 1000) };
}

export async function writeTranscriptMd(videoId: string) {
  const t = readJsonIf<Transcript>(paths.videoFile(videoId, 'transcript.json'));
  if (!t) return;
  const { loadMeta, loadSponsors } = await import('./ingest');
  const { renderTranscriptMd } = await import('./transcript');
  fs.writeFileSync(paths.videoFile(videoId, 'transcript.md'), renderTranscriptMd(t, loadMeta(videoId), loadSponsors(videoId)));
}
