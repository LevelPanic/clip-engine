// clip ingest <url>: metadata, captions, comments, heatmap, chapters, SponsorBlock → library/<id>/,
// then the video downloads in the background.
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJson, readJsonIf, writeJson } from '../core/paths';
import { run, YTDLP } from '../core/proc';
import type { VideoMeta, Transcript, SponsorSegment } from '../core/schemas';
import { transcriptFromJson3, renderTranscriptMd } from './transcript';
import { vocabulary, applyVocabulary } from './vocab';
import { listClips, loadProject, saveProject } from '../project';
import { fetchSponsorBlock } from './sponsorblock';
import { fmtTime } from '../core/time';
import { parseSource, sourceOf, type SourceRef } from './source';
import { liveYouTubeError, youtubeLive } from './media';

/** The library id for a link or id (YouTube video or Twitch past broadcast). */
export function parseVideoId(input: string): string {
  return parseSource(input).id;
}

const watchUrl = (id: string) => sourceOf(id).url;

interface InfoJson {
  id: string;
  title: string;
  description?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  upload_date?: string;
  view_count?: number;
  width?: number;
  height?: number;
  heatmap?: { start_time: number; end_time: number; value: number }[];
  chapters?: { start_time: number; end_time: number; title: string }[];
  comments?: { text?: string; like_count?: number; parent?: string }[];
}

export function loadMeta(id: string): VideoMeta {
  const m = readJsonIf<VideoMeta>(paths.videoFile(id, 'meta.json'));
  if (!m) throw new Error(`Video ${id} isn't in the library. Run \`clip ingest <url>\` first.`);
  return m;
}

export function loadTranscript(id: string): Transcript {
  const t = readJsonIf<Transcript>(paths.videoFile(id, 'transcript.json'));
  if (!t) throw new Error(`No transcript for ${id}`);
  return t;
}

export function loadSponsors(id: string): SponsorSegment[] {
  return readJsonIf<SponsorSegment[]>(paths.videoFile(id, 'sponsor.json')) ?? [];
}

export function loadInfo(id: string): InfoJson {
  return readJson<InfoJson>(paths.videoFile(id, 'info.json'));
}

export async function ingest(url: string, opts: { audio: boolean; full: boolean; refresh: boolean; wait: boolean; log?: (s: string) => void }) {
  const log = opts.log ?? console.log;
  const ref = parseSource(url);
  if (ref.platform === 'twitch') return ingestTwitch(ref, opts, log);
  const id = ref.id;
  const dir = paths.video(id);
  fs.mkdirSync(dir, { recursive: true });
  const infoFile = path.join(dir, 'info.json');
  // what the last read said: a stream read while live has footage from a moving window (below)
  const liveBefore = youtubeLive(id);

  if (!fs.existsSync(infoFile) || opts.refresh) {
    log(`Fetching metadata, captions and top comments for ${id}…`);
    const t0 = Date.now();
    const [cmd, base] = YTDLP;
    const r = await run(cmd, [
      ...base,
      '--skip-download',
      '--no-progress',
      '--ignore-errors', // a caption 429 shouldn't throw away the metadata and comments
      '--write-info-json',
      '--write-auto-subs',
      '--sub-langs', 'en-orig,en',
      '--sub-format', 'json3',
      '--write-comments',
      '--extractor-args', 'youtube:comment_sort=top;max_comments=1000,1000,0,0',
      '-o', `infojson:${dir}/info`,
      '-o', `subtitle:${dir}/captions`,
      '-o', `${dir}/source.%(ext)s`,
      watchUrl(id),
    ]);
    // yt-dlp names it info.info.json; normalise
    const produced = [path.join(dir, 'info.info.json'), infoFile].find((f) => fs.existsSync(f));
    if (!produced) {
      const tail = (r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n');
      throw new Error(`yt-dlp couldn't read ${id}:\n${tail}`);
    }
    if (produced !== infoFile) fs.renameSync(produced, infoFile);
    if (r.code !== 0) log(`  (yt-dlp: ${r.stderr.trim().split('\n').filter((l) => l.startsWith('ERROR')).pop() ?? 'warnings'})`);
    log(`  done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }

  // A stream still live on YouTube has no stable timeline (see youtubeLive in media.ts): read it again
  // once in case it has ended since, and refuse it while it is live. Footage cut while it was live is
  // from a moving window, so it goes.
  {
    const live = youtubeLive(id);
    if (live && !opts.refresh) return ingest(url, { ...opts, refresh: true });
    if (live) throw new Error(liveYouTubeError(id, live));
    if (liveBefore && fs.existsSync(path.join(dir, 'sections'))) {
      fs.rmSync(path.join(dir, 'sections'), { recursive: true, force: true });
      log('  removed footage cut while the stream was live (it came from a moving window)');
    }
  }

  // captions are rate-limited separately (HTTP 429); retry just them with backoff
  const haveCaps = () => ['captions.en-orig.json3', 'captions.en.json3'].some((f) => fs.existsSync(path.join(dir, f)));
  const info0 = loadInfo(id) as InfoJson & { automatic_captions?: Record<string, unknown> };
  const offered = !!info0.automatic_captions && Object.keys(info0.automatic_captions).some((k) => k === 'en' || k === 'en-orig');
  for (let attempt = 1; offered && !haveCaps() && attempt <= 3; attempt++) {
    const wait = [0, 15, 45][attempt - 1];
    if (wait) {
      log(`  captions were rate-limited; retrying in ${wait} s (${attempt}/3)…`);
      await new Promise((res) => setTimeout(res, wait * 1000));
    }
    const [cmd, base] = YTDLP;
    await run(cmd, [...base, '--skip-download', '--no-progress', '--ignore-errors', '--write-auto-subs', '--sub-langs', 'en-orig,en', '--sub-format', 'json3', '-o', `subtitle:${dir}/captions`, '-o', `${dir}/source.%(ext)s`, watchUrl(id)]);
  }

  const info = loadInfo(id);
  const capFile = ['captions.en-orig.json3', 'captions.en.json3'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (capFile?.endsWith('en-orig.json3')) fs.rmSync(path.join(dir, 'captions.en.json3'), { force: true }); // same ASR twice
  const comments = (info.comments ?? []).filter((c) => c.parent === undefined || c.parent === 'root');

  const meta: VideoMeta = {
    id,
    url: watchUrl(id),
    platform: 'youtube',
    title: info.title,
    channel: info.channel ?? info.uploader ?? '',
    durationMs: Math.round((info.duration ?? 0) * 1000),
    uploadDate: info.upload_date,
    viewCount: info.view_count,
    width: info.width,
    height: info.height,
    hasHeatmap: !!info.heatmap?.length,
    heatmap: (info.heatmap ?? []).map((h) => ({
      startMs: Math.round(h.start_time * 1000),
      endMs: Math.round(h.end_time * 1000),
      value: h.value,
    })),
    chapters: (info.chapters ?? []).map((c) => ({
      startMs: Math.round(c.start_time * 1000),
      endMs: Math.round(c.end_time * 1000),
      title: c.title,
    })),
    captions: capFile ? 'youtube-auto' : 'none',
    commentCount: comments.length,
    ingestedAt: new Date().toISOString(),
  };
  writeJson(path.join(dir, 'meta.json'), meta);

  const sponsors = await fetchSponsorBlock(id);
  writeJson(path.join(dir, 'sponsor.json'), sponsors);

  let transcript: Transcript | undefined;
  let nameFixes = 0;
  if (capFile) {
    transcript = transcriptFromJson3(id, readJson(capFile));
    // names the captions mishear, corrected from the title / channel / description
    const terms = vocabulary([
      { text: info.title, strong: true },
      { text: meta.channel, strong: true },
      { text: info.description ?? '', strong: false },
    ]);
    nameFixes = applyVocabulary(transcript, terms).length;
    remapCaptionFixes(id, readJsonIf<Transcript>(path.join(dir, 'transcript.json')), transcript, log);
    writeJson(path.join(dir, 'transcript.json'), transcript);
    fs.writeFileSync(path.join(dir, 'transcript.md'), renderTranscriptMd(transcript, meta, sponsors));
  }

  log('');
  log(`${meta.title}`);
  log(`  ${id} · ${fmtTime(meta.durationMs, 0)} · ${meta.channel}`);
  log(`  captions:      ${transcript ? `${transcript.words.length} words, ${transcript.tags.length} tags${nameFixes ? `, ${nameFixes} misheard names fixed` : ''}` : 'none: Whisper will transcribe it (about 7 min per hour)'}`);
  log(`  most replayed: ${meta.hasHeatmap ? 'yes' : 'no'}`);
  log(`  chapters:      ${meta.chapters.length}`);
  log(`  comments:      ${meta.commentCount}`);
  log(`  sponsorblock:  ${sponsors.length ? sponsors.map((s) => s.category).join(', ') : 'nothing marked'}`);
  log(`  files:         library/${id}/`);

  // Footage: audio now (small; feeds audio signals and Whisper), video only for the ranges we clip
  // (queued when candidates are added) unless the whole file is asked for.
  const { enqueue, waitForJobs } = await import('../jobs/queue');
  const { ensureWorker } = await import('../jobs/worker');
  const queued = [];
  if (opts.audio || !transcript) queued.push(enqueue('audio', { videoId: id, dedupe: true, priority: 5 }));
  // no YouTube captions: transcribe with Whisper (small.en, ~0.12× real time on an M1)
  if (!transcript) queued.push(enqueue('whisper', { videoId: id, dedupe: true, priority: 4 }));
  if (opts.full) queued.push(enqueue('full', { videoId: id, dedupe: true }));
  if (queued.length) {
    ensureWorker();
    log(`  queued:        ${queued.map((j) => `${j.kind} (#${j.id})`).join(', ')}${opts.full ? '' : ' · video sections download when candidates are added'}`);
    if (opts.wait) await waitForJobs(queued.map((j) => j.id), log);
  }
  return { id, meta, transcript };
}


/** Caption fixes are stored by word number. When a transcript is rebuilt (parser or vocabulary
 *  changes), move each clip's fixes to the same word in the new one: same start time, same text. */
export function remapCaptionFixes(videoId: string, old: Transcript | undefined, next: Transcript, log: (s: string) => void = () => {}) {
  if (!old) return;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const byStart = new Map<number, number[]>();
  next.words.forEach((w, i) => byStart.set(w.startMs, [...(byStart.get(w.startMs) ?? []), i]));
  for (const clipId of listClips()) {
    const p = loadProject(clipId);
    if (p.videoId !== videoId || !Object.keys(p.captions.fixes).length) continue;
    const fixes: Record<string, string> = {};
    let lost = 0;
    for (const [k, v] of Object.entries(p.captions.fixes)) {
      const w = old.words[Number(k)];
      const hit = w && (byStart.get(w.startMs) ?? []).find((i) => norm(next.words[i].text) === norm(w.text));
      if (hit !== undefined) fixes[String(hit)] = v;
      else lost++;
    }
    const changed = JSON.stringify(fixes) !== JSON.stringify(p.captions.fixes);
    if (changed) {
      p.captions.fixes = fixes;
      saveProject(p);
      log(`  ${clipId}: moved ${Object.keys(fixes).length} caption fix${Object.keys(fixes).length === 1 ? '' : 'es'} to the new word numbers${lost ? ` (${lost} couldn't be matched)` : ''}`);
    }
  }
}

// ---------- Twitch ----------

/**
 * A Twitch past broadcast: metadata, game chapters and muted stretches. No captions, comments or
 * heatmap exist on Twitch; chat, viewer clips, audio and a Whisper transcript come per scanned range
 * (`clip scan`), because a broadcast is 6–12 hours and may still be growing.
 */
async function ingestTwitch(ref: SourceRef, opts: { refresh: boolean }, log: (s: string) => void) {
  const id = ref.id;
  const dir = paths.video(id);
  fs.mkdirSync(dir, { recursive: true });
  const infoFile = path.join(dir, 'info.json');
  if (!fs.existsSync(infoFile) || opts.refresh) {
    log(`Fetching the broadcast's details for ${id}…`);
    // yt-dlp gives the game chapters and the picture size; the web API gives everything else
    const [cmd, base] = YTDLP;
    const r = await run(cmd, [...base, '--skip-download', '--no-progress', '--ignore-errors', '--write-info-json', '-o', `infojson:${dir}/info`, '-o', `${dir}/source.%(ext)s`, ref.url]);
    const produced = [path.join(dir, 'info.info.json'), infoFile].find((f) => fs.existsSync(f));
    if (produced && produced !== infoFile) fs.renameSync(produced, infoFile);
    if (!produced) {
      log(`  (yt-dlp: ${(r.stderr || r.stdout).trim().split('\n').filter((l) => l.startsWith('ERROR')).pop() ?? 'no details'}; going on without chapters)`);
      writeJson(infoFile, { id: ref.nativeId, title: '' });
    }
  }
  const meta = await refreshTwitchMeta(id);
  log('');
  log(meta.title);
  log(`  ${id} · ${fmtTime(meta.durationMs, 0)}${meta.live ? ' so far (live now)' : ''} · ${meta.channel}${meta.game ? ` · ${meta.game}` : ''}`);
  log(`  chapters:  ${meta.chapters.map((c) => `${fmtTime(c.startMs, 0)} ${c.title}`).join(', ') || 'none'}`);
  const muted = loadSponsors(id);
  log(`  muted:     ${muted.length ? `${muted.length} stretch${muted.length > 1 ? 'es' : ''} (copyrighted music), never clipped` : 'nothing'}`);
  log(`  next:      clip scan ${id} --from <time>   (chat, viewer clips, audio and transcript for that range)`);
  return { id, meta, transcript: readJsonIf<Transcript>(path.join(dir, 'transcript.json')) };
}

/** Re-read a Twitch broadcast's length, live state and muted stretches (it grows while live). */
export async function refreshTwitchMeta(id: string, api?: import('./twitch').TwitchApi): Promise<VideoMeta> {
  const ref = sourceOf(id);
  const { twitchApi } = await import('./twitch');
  const tw = api ?? twitchApi();
  const v = await tw.video(ref.nativeId);
  if (!v) throw new Error(`Twitch has no broadcast ${ref.nativeId}: it was deleted, has expired (past broadcasts last 7–60 days) or is subscriber-only`);
  const info = readJsonIf<InfoJson>(paths.videoFile(id, 'info.json')) ?? { id: ref.nativeId, title: v.title };
  const prev = readJsonIf<VideoMeta>(paths.videoFile(id, 'meta.json'));
  const chapters = (info.chapters ?? []).map((c) => ({ startMs: Math.round(c.start_time * 1000), endMs: Math.round(c.end_time * 1000), title: c.title }));
  if (chapters.length) chapters[chapters.length - 1].endMs = Math.max(chapters[chapters.length - 1].endMs, v.lengthMs);
  const meta: VideoMeta = {
    id,
    url: ref.url,
    platform: 'twitch',
    title: v.title,
    channel: v.channel,
    login: v.login,
    game: v.game,
    live: v.live,
    startedAt: v.createdAt,
    durationMs: Math.max(v.lengthMs, prev?.durationMs ?? 0),
    uploadDate: v.createdAt.slice(0, 10).replace(/-/g, ''),
    viewCount: v.viewCount,
    width: info.width,
    height: info.height,
    hasHeatmap: false,
    heatmap: [],
    chapters,
    captions: 'none',
    commentCount: 0,
    ingestedAt: prev?.ingestedAt ?? new Date().toISOString(),
  };
  writeJson(paths.videoFile(id, 'meta.json'), meta);
  const muted = await tw.mutedSegments(ref.nativeId);
  writeJson(paths.videoFile(id, 'sponsor.json'), muted.map((m) => ({ ...m, category: 'muted' })));
  return meta;
}
