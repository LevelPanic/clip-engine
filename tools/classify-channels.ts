#!/usr/bin/env tsx
// Classify each creator's source from the platform itself, not from video length guesses:
//   Twitch              -> stream (live + VODs)
//   YouTube /streams    -> stream (live and past broadcasts; yt-dlp reports is_live / was_live)
//   YouTube /videos     -> uploads; long episode channels are podcasts, short ones are edited
//   no /streams tab     -> not a YouTube streamer
//
//   npx tsx tools/classify-channels.ts
//   npx tsx tools/classify-channels.ts --json
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { twitchApi } from '../src/ingest/twitch';
import { YTDLP } from '../src/core/proc';
import { loadCreators } from '../src/core/creators';

type Entry = { id: string; title: string; durationS?: number; liveStatus?: string };

const creators = loadCreators((why) => console.error(why));
const asJson = process.argv.includes('--json');

function ytTab(handle: string, tab: 'videos' | 'streams'): { ok: boolean; entries: Entry[]; note?: string } {
  const h = handle.startsWith('@') ? handle : `@${handle}`;
  const [cmd, base] = YTDLP;
  const r = spawnSync(cmd, [...base, '--flat-playlist', '--playlist-end', '3', '--print', '%(id)s\t%(duration)s\t%(live_status)s\t%(title)s', `https://www.youtube.com/${h}/${tab}`], { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) return { ok: false, entries: [], note: (r.stderr ?? '').split('\n').find(Boolean)?.slice(0, 140) ?? `exit ${r.status}` };
  const entries = (r.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, dur, status, ...t] = line.split('\t');
      return { id, durationS: Number(dur) || undefined, liveStatus: status && status !== 'NA' ? status : undefined, title: t.join('\t') };
    })
    .filter((x) => /^[\w-]{11}$/.test(x.id));
  return { ok: true, entries };
}

const rows: Record<string, unknown>[] = [];
for (const c of creators) {
  if (c.platform === 'twitch') {
    let live = false;
    let latest = '';
    let error: string | undefined;
    try {
      const b = await twitchApi().latestBroadcast(c.handle);
      live = !!b?.live;
      latest = b ? `${b.title} (${b.vodId})` : 'no broadcast';
    } catch (e) {
      error = (e as Error).message.split('\n')[0];
    }
    rows.push({ name: c.name, platform: 'twitch', handle: c.handle, source: 'stream', content: 'stream', live, latest, error, configured: `${c.platform}/${c.content ?? '?'}` });
    continue;
  }
  const streams = ytTab(c.handle, 'streams');
  const videos = ytTab(c.handle, 'videos');
  const live = streams.entries.find((v) => v.liveStatus === 'is_live');
  const vods = streams.entries.filter((v) => v.liveStatus === 'was_live');
  const longUpload = videos.entries.filter((v) => (v.durationS ?? 0) >= 30 * 60);
  const source = live || vods.length ? 'streams' : 'videos';
  const content = live || vods.length ? 'stream' : longUpload.length >= 2 ? 'podcast' : 'edited';
  rows.push({
    name: c.name,
    platform: 'youtube',
    handle: c.handle,
    source,
    content,
    live: !!live,
    liveTitle: live?.title,
    streams: streams.ok ? streams.entries.map((v) => `${v.liveStatus ?? 'upload'} ${v.durationS ? (v.durationS / 60).toFixed(0) + 'm' : '?'}`) : streams.note,
    videos: videos.ok ? videos.entries.map((v) => `${(v.durationS ?? 0) / 60 ? ((v.durationS ?? 0) / 60).toFixed(0) + 'm' : '?'}`) : videos.note,
    configured: `${c.platform}/${c.source ?? '-'}/${c.content ?? '?'}`,
  });
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const r of rows) {
    const bits = [
      String(r.name).padEnd(22),
      String(r.platform).padEnd(7),
      String(r.content).padEnd(7),
      r.live ? 'LIVE' : 'offline',
      r.platform === 'twitch' ? String(r.latest ?? '') : `/streams: ${Array.isArray(r.streams) ? r.streams.join(', ') || 'none' : r.streams} | /videos: ${Array.isArray(r.videos) ? r.videos.join(', ') : r.videos}`,
      r.error ? `! ${r.error}` : '',
    ];
    console.log(bits.filter(Boolean).join('  '));
  }
}
