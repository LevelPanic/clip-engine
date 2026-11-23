#!/usr/bin/env node
// The `clip` command. Everything the Studio can do is also here, so the agent can do it too.
import { Command } from 'commander';
import { fmtTime, parseTime } from '../core/time';

// Piping into `head` closes stdout early; that's fine.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

const program = new Command();
program.name('clip').description('YouTube link → clip candidates → edited 9:16 short').showHelpAfterError();

const fail = (e: unknown) => {
  console.error(`✖ ${(e as Error).message}`);
  process.exit(1);
};
const action =
  <A extends unknown[]>(fn: (...args: A) => Promise<void> | void) =>
  (...args: A) =>
    Promise.resolve(fn(...args)).catch(fail);

// ---------- ingest ----------

program
  .command('ingest <url>')
  .description('Fetch metadata, captions, comments, heatmap, chapters and SponsorBlock; queue the audio download')
  .option('--no-audio', "don't download the audio track")
  .option('--full', 'also download the whole video (default: only the sections around candidates)')
  .option('--wait', 'wait for the queued downloads to finish')
  .option('--refresh', 'fetch metadata again even if it is already in the library')
  .action(
    action(async (url: string, o: { audio: boolean; full?: boolean; wait?: boolean; refresh?: boolean }) => {
      const { ingest } = await import('../ingest/ingest');
      await ingest(url, { audio: o.audio, full: !!o.full, wait: !!o.wait, refresh: !!o.refresh });
    }),
  );

program
  .command('status [videoId]')
  .description('Show library videos: candidates, footage on disk and active jobs')
  .action(
    action(async (videoId?: string) => {
      const { listDirs, paths, readJsonIf } = await import('../core/paths');
      const { footageSummary } = await import('../ingest/media');
      const { activeJobsFor } = await import('../jobs/queue');
      const ids = videoId ? [videoId] : listDirs(paths.library);
      if (!ids.length) console.log('Library is empty. Run `clip ingest <url>`.');
      for (const id of ids) {
        const meta = readJsonIf<{ title: string; durationMs: number }>(paths.videoFile(id, 'meta.json'));
        if (!meta) continue;
        const c = readJsonIf<{ candidates: unknown[] }>(paths.videoFile(id, 'candidates.json'));
        const f = footageSummary(id);
        const footage = f.full ? 'full video' : f.sections.length ? `${f.sections.length} sections (${Math.round(f.sectionBytes / 1e6)} MB)` : 'no video';
        const jobs = activeJobsFor(id).map((j) => `${j.kind} ${j.state === 'running' ? (j.progress ?? 'running') : 'queued'}`);
        console.log(
          `${id}  ${fmtTime(meta.durationMs, 0).padStart(8)}  ${String(c?.candidates.length ?? 0).padStart(2)} candidates  ${footage}${f.audio ? ' + audio' : ''}${jobs.length ? `  [${jobs.join(', ')}]` : ''}  ${meta.title}`,
        );
      }
    }),
  );

program
  .command('download <videoId>')
  .description('Queue footage downloads: the whole video, the audio, or a time range')
  .option('--full', 'the whole video')
  .option('--audio', 'the audio track')
  .option('--from <time>', 'start of a section')
  .option('--to <time>', 'end of a section')
  .option('--wait', 'wait for it to finish')
  .action(
    action(async (id: string, o: { full?: boolean; audio?: boolean; from?: string; to?: string; wait?: boolean }) => {
      const { enqueue, waitForJobs } = await import('../jobs/queue');
      const { ensureWorker } = await import('../jobs/worker');
      const jobs = [];
      if (o.full) jobs.push(enqueue('full', { videoId: id, dedupe: true }));
      if (o.audio) jobs.push(enqueue('audio', { videoId: id, dedupe: true }));
      if (o.from && o.to) jobs.push(enqueue('sections', { videoId: id, dedupe: true, payload: { ranges: [{ startMs: parseTime(o.from), endMs: parseTime(o.to) }] } }));
      if (!jobs.length) throw new Error('Say what to download: --full, --audio, or --from/--to');
      ensureWorker();
      console.log(jobs.map((j) => `queued ${j.kind} #${j.id}`).join('\n'));
      if (o.wait) await waitForJobs(jobs.map((j) => j.id));
    }),
  );

// ---------- jobs ----------

program
  .command('worker')
  .description('Run queued jobs (downloads, renders, batches). Starts automatically when something is queued.')
  .option('--exit-when-idle', 'stop once the queue is empty')
  .action(
    action(async (o: { exitWhenIdle?: boolean }) => {
      const { runWorker } = await import('../jobs/worker');
      const { handlers } = await import('../jobs/handlers');
      await runWorker(handlers, { exitWhenIdle: !!o.exitWhenIdle });
    }),
  );

program
  .command('jobs')
  .description('List recent jobs')
  .option('--active', 'only queued and running')
  .option('--retry <id>', 'retry a failed job')
  .option('--cancel <id>', 'cancel a queued or running job')
  .action(
    action(async (o: { active?: boolean; retry?: string; cancel?: string }) => {
      const q = await import('../jobs/queue');
      const { ensureWorker } = await import('../jobs/worker');
      if (o.retry) (q.retryJob(Number(o.retry)), ensureWorker(), console.log(`requeued #${o.retry}`));
      if (o.cancel) (q.cancelJob(Number(o.cancel)), console.log(`cancelled #${o.cancel}`));
      for (const j of q.listJobs({ states: o.active ? ['queued', 'running'] : undefined, limit: 40 })) {
        const took = j.startedAt && j.finishedAt ? ` ${((Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000).toFixed(1)} s` : '';
        console.log(`#${String(j.id).padEnd(4)} ${j.kind.padEnd(12)} ${j.state.padEnd(9)} ${(j.clipId ?? j.videoId ?? '').padEnd(18)}${took}  ${j.state === 'failed' ? (j.error ?? '').split('\n')[0] : (j.progress ?? '')}`);
      }
    }),
  );

program
  .command('whisper <videoId>')
  .description('Transcribe with Whisper (small.en by default) instead of YouTube captions; re-runs discovery')
  .option('--model <name>', 'base.en (2× faster) | small.en | medium.en')
  .option('--force', 'replace the transcript even if the video already has clips')
  .action(
    action(async (id: string, o: { model?: string; force?: boolean }) => {
      const { downloadAudio } = await import('../jobs/downloads');
      await downloadAudio(id, (s) => process.stdout.write(`\r${s}   `));
      const { useWhisper } = await import('../ingest/whisperJob');
      const r = await useWhisper(id, { model: o.model, force: !!o.force, log: (s) => process.stdout.write(`\r${s}   `) });
      console.log(`\n${r.words} words, ${r.tags} tags, ${r.seeds} seeds in ${r.seconds} s (YouTube's transcript kept as transcript.youtube.json)`);
    }),
  );

program
  .command('search <videoId> <query...>')
  .description('Find where things are said: "every time they talk about money" → clip search <id> money cash rich')
  .option('--window <s>', 'window size in seconds', '30')
  .option('--top <n>', 'how many windows', '12')
  .action(
    action(async (id: string, query: string[], o: { window: string; top: string }) => {
      const { loadTranscript } = await import('../ingest/ingest');
      const t = loadTranscript(id);
      // crude stemming so "money" also finds "moneys", "rich" finds "richer", "talk" finds "talking"
      const stem = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '').replace(/(ing|ers|er|es|ed|s|'s)$/, '');
      const terms = new Set(query.flatMap((q) => q.split(/\s+/)).map(stem).filter((x) => x.length >= 2));
      const hits = t.words.filter((w) => terms.has(stem(w.text)));
      if (!hits.length) return console.log('no matches');
      const win = Number(o.window) * 1000;
      const windows: { startMs: number; n: number; words: string[] }[] = [];
      for (const h of hits) {
        const last = windows[windows.length - 1];
        if (last && h.startMs - last.startMs < win) (last.n++, last.words.push(h.text));
        else windows.push({ startMs: h.startMs, n: 1, words: [h.text] });
      }
      const { renderTranscriptMd } = await import('../ingest/transcript');
      const { loadMeta, loadSponsors } = await import('../ingest/ingest');
      const meta = loadMeta(id);
      console.log(`${hits.length} mentions in ${windows.length} places; top ${o.top}:`);
      for (const w of windows.sort((a, b) => b.n - a.n).slice(0, Number(o.top)).sort((a, b) => a.startMs - b.startMs)) {
        console.log(`\n── ${fmtTime(w.startMs, 0)}  ${w.n}× (${[...new Set(w.words.map((x) => x.toLowerCase()))].slice(0, 6).join(', ')})`);
        process.stdout.write(renderTranscriptMd(t, meta, loadSponsors(id), { fromMs: w.startMs - 5000, toMs: w.startMs + 15000 }));
      }
    }),
  );

program
  .command('transcript <videoId>')
  .description('Print the transcript (or a time window of it) in the compact form the judge reads. Streams: transcribes the window first if it isn\'t yet')
  .option('--from <time>', 'start, e.g. 13:30')
  .option('--to <time>', 'end, e.g. 16:00')
  .action(
    action(async (id: string, o: { from?: string; to?: string }) => {
      const { loadMeta, loadTranscript, loadSponsors } = await import('../ingest/ingest');
      const { renderTranscriptMd } = await import('../ingest/transcript');
      const meta = loadMeta(id);
      const range = o.from || o.to ? { fromMs: o.from ? parseTime(o.from) : 0, toMs: o.to ? parseTime(o.to) : meta.durationMs } : undefined;
      if (range && meta.platform === 'twitch') {
        // a window of a stream nobody has read yet: transcribe it now (about 20 s for 3 minutes)
        if (range.toMs - range.fromMs > 20 * 60_000) throw new Error('Read a stream at most 20 minutes at a time (it is transcribed as you read).');
        const { ensureTranscribed } = await import('../ingest/windowed');
        await ensureTranscribed(id, [{ startMs: range.fromMs, endMs: range.toMs }], (s) => process.stderr.write(`${s}\n`));
      }
      process.stdout.write(renderTranscriptMd(loadTranscript(id), meta, loadSponsors(id), range));
    }),
  );

export { program };

const { registerMore } = await import('./more');
registerMore(program, action);
const { registerStream } = await import('./stream');
registerStream(program, action);
await program.parseAsync(process.argv);
