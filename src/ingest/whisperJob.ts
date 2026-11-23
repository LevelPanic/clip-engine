// Replace a video's transcript with a Whisper one: keeps YouTube's as transcript.youtube.json,
// rewrites transcript.md and re-runs discovery. Word numbers change, so caption fixes on existing clips
// would point at the wrong words: refuse when the video already has clips unless forced.
import fs from 'node:fs';
import { paths, writeJson } from '../core/paths';
import { listClips, loadProject } from '../core/project';
import { loadMeta, loadSponsors } from './ingest';
import { renderTranscriptMd } from './transcript';
import { whisperTranscript } from './whisper';

export async function useWhisper(videoId: string, opts: { model?: string; force?: boolean; log?: (s: string) => void } = {}) {
  const clips = listClips().filter((c) => loadProject(c).videoId === videoId);
  if (clips.length && !opts.force) throw new Error(`${videoId} already has clips (${clips.join(', ')}); their caption fixes would point at the wrong words. Pass --force to replace the transcript anyway.`);
  const t0 = Date.now();
  const t = await whisperTranscript(videoId, { model: opts.model, onProgress: opts.log });
  const cur = paths.videoFile(videoId, 'transcript.json');
  const yt = paths.videoFile(videoId, 'transcript.youtube.json');
  if (fs.existsSync(cur) && !fs.existsSync(yt)) fs.renameSync(cur, yt);
  writeJson(cur, t);
  const meta = loadMeta(videoId);
  meta.captions = 'youtube-auto';
  fs.writeFileSync(paths.videoFile(videoId, 'transcript.md'), renderTranscriptMd(t, meta, loadSponsors(videoId)));
  const { discover } = await import('../discover');
  const f = discover(videoId);
  return { words: t.words.length, tags: t.tags.length, seeds: f.seeds.length, seconds: Math.round((Date.now() - t0) / 1000) };
}
