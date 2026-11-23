// Batches: run the whole pipeline over links unattended, continue one, and show progress.
import type { Command } from 'commander';
import { type Action } from './shared';

export function register(program: Command, action: Action) {
  // ---------- batch ----------

  program
    .command('batch <inputs...>')
    .description('Links, a file of links, or a channel/playlist URL → judged, edited, rendered, QA\'d clips in the review queue')
    .option('--lens <name>', 'judging lens', 'podcast-general')
    .option('--per-video <n>', 'clips to make per video', '5')
    .option('--judge <how>', 'claude (headless Claude Code) or none (stop after discovery)', 'claude')
    .option('--no-autoedit', 'skip the automatic first-pass edit')
    .option('--reframe', 'track faces and crop to the speaker')
    .option('--style <style>', 'edit style for the first pass: clean, punch, hype or story (`clip styles`)', 'punch')
    .option('--no-render', "don't render")
    .option('--limit <n>', 'videos to take from a channel or playlist', '5')
    .action(
      action(
        async (
          inputs: string[],
          o: { lens: string; perVideo: string; judge: string; autoedit: boolean; reframe?: boolean; style: string; render: boolean; limit: string },
        ) => {
          const { startBatch } = await import('../pipeline/startBatch');
          const { STYLES } = await import('../edit/styles');
          if (!STYLES.some((st) => st.key === o.style)) throw new Error(`no style "${o.style}"; try ${STYLES.map((st) => st.key).join(', ')}`);
          const batch = { lens: o.lens, perVideo: Number(o.perVideo), judge: o.judge as 'claude' | 'none', autoedit: o.autoedit, reframe: !!o.reframe, style: o.style, render: o.render };
          const { batchId, videos } = await startBatch(inputs, batch, Number(o.limit));
          console.log(`batch ${batchId}: ${videos.length} video${videos.length > 1 ? 's' : ''} queued (${o.perVideo} clips each, lens ${o.lens}, judge ${o.judge})`);
          console.log(`follow it: ./clip batch-status ${batchId}   ·   review: http://localhost:4400/#/review`);
        },
      ),
    );

  program
    .command('batch-continue [batchId]')
    .description('After judging by hand (/clip in a session), carry a batch on: make the top clips, then edit, render and QA them')
    .action(
      action(async (batchId?: string) => {
        const { jobsDb, listJobs } = await import('../jobs/queue');
        const { afterJudge } = await import('../pipeline/batch');
        const { ensureWorker } = await import('../jobs/worker');
        const { loadCandidates } = await import('../candidates');
        const id = batchId ?? (jobsDb().prepare('SELECT id FROM batches ORDER BY createdAt DESC LIMIT 1').get() as { id: string } | undefined)?.id;
        if (!id) throw new Error('no batches');
        const jobs = listJobs({ batchId: id, limit: 2000 });
        for (const ingest of jobs.filter((j) => j.kind === 'ingest' && j.state === 'done')) {
          const v = ingest.videoId!;
          if (jobs.some((j) => j.videoId === v && j.clipId)) continue; // already carried on
          if (!loadCandidates(v).candidates.some((c) => c.status === 'new')) {
            console.log(`${v}: no candidates yet; judge it with /clip ${v}`);
            continue;
          }
          const made = await afterJudge({ ...ingest, videoId: v });
          console.log(`${v}: made ${made.length} clips → ${made.join(', ')}`);
        }
        ensureWorker();
      }),
    );

  program
    .command('batch-status [batchId]')
    .description('Where a batch is: per video and per clip, with time per clip')
    .action(
      action(async (batchId?: string) => {
        const { jobsDb, listJobs } = await import('../jobs/queue');
        const id = batchId ?? (jobsDb().prepare('SELECT id FROM batches ORDER BY createdAt DESC LIMIT 1').get() as { id: string } | undefined)?.id;
        if (!id) return console.log('no batches yet');
        const jobs = listJobs({ batchId: id, limit: 2000 }).reverse();
        const secs = (j: { startedAt: string | null; finishedAt: string | null }) => (j.startedAt && j.finishedAt ? (Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000 : 0);
        const videos = [...new Set(jobs.map((j) => j.videoId).filter(Boolean))] as string[];
        console.log(`batch ${id}`);
        for (const v of videos) {
          const vj = jobs.filter((j) => j.videoId === v);
          const stage = (k: string) => {
            const j = vj.filter((x) => x.kind === k).pop();
            return j ? `${k} ${j.state}${j.state === 'running' && j.progress ? ` (${j.progress.slice(0, 40)})` : ''}` : null;
          };
          console.log(`\n${v}: ${['ingest', 'discover', 'judge'].map(stage).filter(Boolean).join(' → ')}`);
          const clips = [...new Set(vj.map((j) => j.clipId).filter(Boolean))] as string[];
          for (const c of clips) {
            const cj = vj.filter((j) => j.clipId === c);
            const last = cj[cj.length - 1];
            const t = cj.reduce((a, j) => a + secs(j), 0);
            const qa = cj.find((j) => j.kind === 'qa' && j.state === 'done')?.result as { passed?: boolean; issues?: number } | null;
            console.log(`  ${c.padEnd(18)} ${last.kind} ${last.state}${last.state === 'failed' ? `: ${last.error?.split('\n')[0]}` : ''}  ${t.toFixed(0)} s${qa ? `  QA ${qa.passed ? 'passed' : 'FAILED'} (${qa.issues} notes)` : ''}`);
          }
        }
        const done = jobs.filter((j) => j.kind === 'qa' && j.state === 'done').length;
        const start = jobs.find((j) => j.startedAt)?.startedAt;
        const end = [...jobs].reverse().find((j) => j.finishedAt)?.finishedAt;
        const wall = start && end ? (Date.parse(end) - Date.parse(start)) / 1000 : 0;
        const perVideo = videos.map((v) => jobs.filter((j) => j.videoId === v && !j.clipId).reduce((a, j) => a + secs(j), 0));
        const perClip = jobs.filter((j) => j.clipId).reduce((a, j) => a + secs(j), 0) / Math.max(1, new Set(jobs.map((j) => j.clipId).filter(Boolean)).size);
        console.log(`\n${done} clips ready for review · wall clock ${(wall / 60).toFixed(1)} min · per video (ingest+judge) ${(perVideo.reduce((a, b) => a + b, 0) / Math.max(1, perVideo.length) / 60).toFixed(1)} min · per clip (edit+render+QA) ${perClip.toFixed(0)} s`);
        const failed = jobs.filter((j) => j.state === 'failed');
        if (failed.length) console.log(`${failed.length} failed jobs: ./clip jobs --retry <id>`);
      }),
    );
}
