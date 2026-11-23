// Range scans and repeat passes over a long or still-live stream.
//
//   clip scan <link> --from 1:00:00     scan 1:00:00 up to now
//   clip scan <id> --continue           scan from where the last pass stopped
//   clip watch <channel>                pass after pass until the stream ends
//
// A pass: re-read the broadcast's length (it grows while live), fetch chat and viewer clips, download
// and analyse the audio, pick seeds inside the range, transcribe around the best seeds, pick again.
// Each pass starts 2 min before the last one ended (a moment on the boundary is still seen whole; the
// candidate validator drops repeats) and stops 3 min short of the live edge (chat reacts late and the
// payoff may not have happened yet). library/<id>/scan.json records the passes.
import fs from 'node:fs';
import { paths, readJsonIf, writeJson } from '../core/paths';
import { mergeRanges, type Range } from '../core/ranges';
import { fmtTime } from '../core/time';
import { doNotClipError, optedOut } from '../core/channel';
import type { SignalsFile, VideoMeta } from '../core/schemas';
import { discover } from '../discover';

export const OVERLAP_MS = 2 * 60_000;
export const LIVE_MARGIN_MS = 3 * 60_000;
export const CHAT_LOOKBACK_MS = 6 * 60_000; // chat before the range, so "normal" is known from the start
export const MIN_NEW_LIVE_MS = 60_000; // a live pass waits until at least this much is new
export const SEED_PAD = { before: 30_000, after: 20_000 }; // transcribed around each seed
export const MAX_TRANSCRIBED_SEEDS = 25;

export interface Pass {
  n: number;
  fromMs: number;
  toMs: number;
  at: string;
  live: boolean;
  durationMs: number;
  seeds: number;
  chatMessages: number;
  viewerClips: number;
  transcribedMs: number;
  seconds: number;
  notes: string[];
}

export interface WatchState {
  pid: number;
  everyMs: number;
  nextAt?: string;
  state: 'scanning' | 'judging' | 'waiting' | 'offline' | 'ended';
  login?: string;
  note?: string;
}

export interface ScanFile {
  videoId: string;
  passes: Pass[];
  watch?: WatchState;
}

export const loadScan = (videoId: string): ScanFile => readJsonIf<ScanFile>(paths.videoFile(videoId, 'scan.json')) ?? { videoId, passes: [] };
export const scannedRanges = (s: ScanFile): Range[] => mergeRanges(s.passes.map((p) => ({ startMs: p.fromMs, endMs: p.toMs })));

export function saveScan(s: ScanFile) {
  writeJson(paths.videoFile(s.videoId, 'scan.json'), s);
}

export type PassPlan = { fromMs: number; toMs: number; newMs: number } | { upToDate: true; reason: string };

/** Which range the next pass covers. Pure (test/scan.test.ts). */
export function planPass(o: { durationMs: number; live: boolean; scanned: Range[]; fromMs?: number; toMs?: number; cont: boolean }): PassPlan {
  const available = o.live ? o.durationMs - LIVE_MARGIN_MS : o.durationMs;
  if (available <= 0) return { upToDate: true, reason: `the stream is only ${fmtTime(o.durationMs, 0)} old; the first pass waits until it's past ${fmtTime(LIVE_MARGIN_MS, 0)}` };
  const lastEnd = o.scanned.length ? Math.max(...o.scanned.map((r) => r.endMs)) : undefined;
  let fromMs: number;
  if (o.cont && lastEnd !== undefined) fromMs = Math.max(0, lastEnd - OVERLAP_MS);
  else fromMs = Math.max(0, o.fromMs ?? 0);
  const toMs = Math.min(o.toMs ?? available, available);
  if (fromMs >= available) {
    if (o.cont && lastEnd !== undefined && fromMs >= available) return { upToDate: true, reason: `scanned up to ${fmtTime(lastEnd, 0)}; nothing new yet` };
    throw new Error(`${fmtTime(fromMs, 0)} is past the end of the broadcast (${fmtTime(o.durationMs, 0)}${o.live ? ' so far, live' : ''})`);
  }
  if (toMs <= fromMs) throw new Error(`the range ${fmtTime(fromMs, 0)}–${fmtTime(toMs, 0)} is empty`);
  // what this pass adds beyond what's been scanned
  const newMs = toMs - Math.max(fromMs, Math.min(toMs, lastEnd !== undefined && o.cont ? lastEnd : fromMs));
  if (o.cont && lastEnd !== undefined && newMs < (o.live ? MIN_NEW_LIVE_MS : 1000))
    return { upToDate: true, reason: `scanned up to ${fmtTime(lastEnd, 0)}; only ${Math.round(newMs / 1000)} s new so far` };
  return { fromMs, toMs, newMs };
}

// ---------- a pass ----------

export interface PassDeps {
  refreshMeta: (videoId: string) => Promise<VideoMeta>;
  fetchChat: (videoId: string, ranges: Range[], log: (s: string) => void) => Promise<{ added: number; disabled: boolean }>;
  fetchViewerClips: (videoId: string, meta: VideoMeta) => Promise<number>;
  /** Download (if needed) and analyse the audio for these ranges. */
  audio: (videoId: string, ranges: Range[], log: (s: string) => void) => Promise<void>;
  transcribe: (videoId: string, ranges: Range[], log: (s: string) => void) => Promise<{ transcribed: Range[]; failed?: { range: Range; error: string }[] }>;
  discover: (videoId: string, range: Range) => SignalsFile;
}

export interface PassOptions {
  fromMs?: number;
  toMs?: number;
  cont?: boolean;
  log?: (s: string) => void;
}

export type PassResult = { pass: Pass; signals: SignalsFile } | { upToDate: true; reason: string; meta: VideoMeta };

/** One scan pass. Takes a lock so a watcher and a Studio scan can't write the same files at once. */
export async function runPass(videoId: string, opts: PassOptions = {}, deps?: PassDeps): Promise<PassResult> {
  const d = deps ?? (await defaultDeps());
  const log = opts.log ?? (() => {});
  const release = lock(videoId);
  try {
    const t0 = Date.now();
    const meta = await d.refreshMeta(videoId);
    const out = optedOut(meta);
    if (out) throw doNotClipError(out);
    const scan = loadScan(videoId);
    const plan = planPass({ durationMs: meta.durationMs, live: !!meta.live, scanned: scannedRanges(scan), fromMs: opts.fromMs, toMs: opts.toMs, cont: !!opts.cont });
    if ('upToDate' in plan) return { upToDate: true, reason: plan.reason, meta };
    const range = { startMs: plan.fromMs, endMs: plan.toMs };
    const notes: string[] = [];
    log(`pass ${scan.passes.length + 1}: ${fmtTime(range.startMs, 0)}–${fmtTime(range.endMs, 0)}${meta.live ? ` (live; broadcast is ${fmtTime(meta.durationMs, 0)} so far)` : ''}`);

    let chatMessages = 0;
    let viewerClips = 0;
    if (meta.platform === 'twitch') {
      try {
        const c = await d.fetchChat(videoId, [{ startMs: Math.max(0, range.startMs - CHAT_LOOKBACK_MS), endMs: range.endMs }], log);
        chatMessages = c.added;
        if (c.disabled) notes.push('chat replay is turned off for this broadcast');
      } catch (e) {
        notes.push(`chat unavailable: ${(e as Error).message}`); // a pass still works on clips, audio and transcript
      }
      try {
        viewerClips = await d.fetchViewerClips(videoId, meta);
      } catch (e) {
        notes.push(`viewer clips unavailable: ${(e as Error).message}`);
      }
    }
    try {
      // include the padding a seed window may reach before the range, so it's one download
      await d.audio(videoId, [{ startMs: Math.max(0, range.startMs - SEED_PAD.before), endMs: range.endMs }], log);
    } catch (e) {
      notes.push(`audio analysis failed: ${(e as Error).message.split('\n')[0]}`);
    }

    // seeds from chat, clips and audio first; then transcribe around the best ones and pick again,
    // so transcript signals (speech, title words, laughter tags) count too
    let signals = d.discover(videoId, range);
    const windows = signals.seeds.slice(0, MAX_TRANSCRIBED_SEEDS).map((s) => ({ startMs: Math.max(0, s.startMs - SEED_PAD.before), endMs: Math.min(meta.durationMs, s.endMs + SEED_PAD.after) }));
    let transcribedMs = 0;
    if (windows.length) {
      try {
        const t = await d.transcribe(videoId, windows, log);
        transcribedMs = t.transcribed.reduce((a, r) => a + r.endMs - r.startMs, 0);
        if (t.failed?.length) notes.push(`${t.failed.length} window${t.failed.length > 1 ? 's' : ''} not transcribed: ${t.failed[0].error}`);
      } catch (e) {
        notes.push(`transcription failed: ${(e as Error).message.split('\n')[0]}`);
      }
      signals = d.discover(videoId, range);
    } else notes.push('no seeds: nothing stood out in chat, viewer clips or audio');

    const pass: Pass = {
      n: scan.passes.length + 1,
      fromMs: range.startMs,
      toMs: range.endMs,
      at: new Date().toISOString(),
      live: !!meta.live,
      durationMs: meta.durationMs,
      seeds: signals.seeds.length,
      chatMessages,
      viewerClips,
      transcribedMs,
      seconds: Math.round((Date.now() - t0) / 1000),
      notes,
    };
    const fresh = loadScan(videoId); // a watcher may have updated its status meanwhile
    fresh.passes.push(pass);
    saveScan(fresh);
    return { pass, signals };
  } finally {
    release();
  }
}

function lock(videoId: string): () => void {
  const file = paths.videoFile(videoId, 'scan.lock');
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = pid !== process.pid;
    } catch {}
    if (alive) throw new Error(`a scan of ${videoId} is already running (process ${pid})`);
  }
  fs.mkdirSync(paths.video(videoId), { recursive: true });
  fs.writeFileSync(file, String(process.pid));
  return () => fs.rmSync(file, { force: true });
}

async function defaultDeps(): Promise<PassDeps> {
  const { twitchApi } = await import('../ingest/twitch');
  const api = twitchApi();
  return {
    refreshMeta: async (id) => {
      const { loadMeta, refreshTwitchMeta } = await import('../ingest/ingest');
      return loadMeta(id).platform === 'twitch' ? refreshTwitchMeta(id, api) : loadMeta(id);
    },
    fetchChat: async (id, ranges, log) => {
      const { fetchChat } = await import('../ingest/chat');
      return fetchChat(id, ranges, api, log);
    },
    fetchViewerClips: async (id, meta) => {
      const { fetchViewerClips } = await import('../ingest/chat');
      return (await fetchViewerClips(id, api, { login: meta.login ?? '', startedAt: meta.startedAt ?? new Date().toISOString(), durationMs: meta.durationMs })).length;
    },
    audio: async (id, ranges, log) => {
      const { loadMeta } = await import('../ingest/ingest');
      if (loadMeta(id).platform !== 'twitch') return; // YouTube: the audio job covers the whole video
      const { downloadAudioRanges } = await import('../jobs/downloads');
      const { analyzeAudioChunk } = await import('../ingest/audioEvents');
      const { listAudioChunks } = await import('../ingest/media');
      const { added } = await downloadAudioRanges(id, ranges, log);
      for (const r of added) {
        const chunk = listAudioChunks(id).find((c) => c.startMs === r.startMs && c.endMs === r.endMs);
        if (chunk) {
          log(`listening for laughs and shouts ${fmtTime(r.startMs, 0)}–${fmtTime(r.endMs, 0)}`);
          await analyzeAudioChunk(id, chunk, log);
        }
      }
    },
    transcribe: async (id, ranges, log) => {
      const { ensureTranscribed } = await import('../ingest/windowed');
      return ensureTranscribed(id, ranges, log);
    },
    discover: (id, range) => discover(id, { range }),
  };
}
