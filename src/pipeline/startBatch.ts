// Start a batch: links, a file of links, or channel/playlist URLs → queued ingest jobs that chain
// through the pipeline (see pipeline.ts). Used by `clip batch` and the Studio.
import fs from 'node:fs';
import { parseVideoId } from '../ingest/ingest';
import { createBatch, enqueue } from '../jobs/queue';
import { ensureWorker } from '../jobs/worker';
import { runOrThrow, YTDLP } from '../core/proc';
import type { BatchOptions } from './batch';

export async function expandInputs(inputs: string[], limit = 5): Promise<string[]> {
  const urls: string[] = [];
  for (const inp of inputs.flatMap((i) => i.split(/\s+/)).filter(Boolean)) {
    if (fs.existsSync(inp) && fs.statSync(inp).isFile()) urls.push(...fs.readFileSync(inp, 'utf8').split(/\s+/).filter((l) => l && !l.startsWith('#')));
    else if (/\/(@|channel\/|c\/|user\/|playlist)/.test(inp)) {
      const [cmd, base] = YTDLP;
      const r = await runOrThrow(cmd, [...base, '--flat-playlist', '-I', `1:${limit}`, '--print', 'id', inp]);
      urls.push(...r.stdout.trim().split('\n').filter(Boolean));
    } else if (/twitch\.tv\/[\w]+\/?$/.test(inp) || /twitch\.tv\/[\w]+\/videos/.test(inp)) {
      // a Twitch channel: its newest past broadcasts (each is 6–12 h, so keep the limit low)
      const login = /twitch\.tv\/(\w+)/.exec(inp)![1];
      const [cmd, base] = YTDLP;
      const r = await runOrThrow(cmd, [...base, '--flat-playlist', '-I', `1:${limit}`, '--print', 'id', `https://www.twitch.tv/${login}/videos?filter=archives&sort=time`]);
      urls.push(...r.stdout.trim().split('\n').filter(Boolean).map((v) => `tw-${v.replace(/^v/, '')}`));
    } else urls.push(inp);
  }
  return [...new Set(urls.map((u) => parseVideoId(u)))];
}

export async function startBatch(inputs: string[], batch: BatchOptions, limit = 5) {
  const ids = await expandInputs(inputs, limit);
  if (!ids.length) throw new Error('no videos found');
  const batchId = createBatch(JSON.stringify(batch));
  for (const id of ids) enqueue('ingest', { videoId: id, batchId, payload: { url: id, batch } });
  ensureWorker();
  return { batchId, videos: ids };
}
