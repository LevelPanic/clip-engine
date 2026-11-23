// What each job kind does. Imports are lazy so the worker starts fast and only loads what it runs.
// Jobs that belong to a batch hand off to the next stage (see pipeline.ts).
import type { Handler } from '../jobs/worker';
import type { JobKind } from '../jobs/queue';

export const handlers: Partial<Record<JobKind, Handler>> = {
  ingest: async (j, progress) => {
    const { ingest } = await import('../ingest/ingest');
    const r = await ingest(String(j.payload.url ?? j.videoId), { audio: true, full: false, refresh: false, wait: false, log: progress });
    const { afterIngest } = await import('./batch');
    afterIngest({ ...j, videoId: r.id });
    return { videoId: r.id, words: r.transcript?.words.length ?? 0 };
  },
  // audio download + laughter/cheer/shout detection in one job (~1 min for a 2 h video)
  audio: async (j, progress) => {
    const { downloadAudio } = await import('../ingest/downloads');
    const { analyzeAudioEvents } = await import('../ingest/audioEvents');
    const dl = await downloadAudio(j.videoId!, progress);
    progress('listening for laughs and cheers');
    const ev = await analyzeAudioEvents(j.videoId!, progress);
    return { ...dl, audioEvents: ev.events };
  },
  'audio-events': async (j, progress) => {
    const { analyzeAudioEvents } = await import('../ingest/audioEvents');
    return analyzeAudioEvents(j.videoId!, progress);
  },
  whisper: async (j, progress) => {
    const { downloadAudio } = await import('../ingest/downloads');
    await downloadAudio(j.videoId!, progress);
    const { useWhisper } = await import('./whisperJob');
    return useWhisper(j.videoId!, { log: progress, force: true });
  },
  discover: async (j, progress) => {
    // audio signals make discovery better; give the audio job a moment if it's still running
    const { activeJobsFor } = await import('../jobs/queue');
    for (let i = 0; i < 900 && activeJobsFor(j.videoId!).some((x) => x.kind === 'audio' || x.kind === 'whisper'); i++) {
      progress('waiting for audio analysis / transcription');
      await new Promise((r) => setTimeout(r, 2000));
    }
    const { discover } = await import('../discover');
    const f = discover(j.videoId!);
    const { afterDiscover } = await import('./batch');
    afterDiscover(j);
    return { seeds: f.seeds.length, signals: Object.entries(f.available).filter(([, v]) => v).map(([k]) => k) };
  },
  scan: async (j, progress) => {
    const { runPass } = await import('../scan');
    const p = j.payload as { fromMs?: number; toMs?: number; cont?: boolean; judge?: boolean; lens?: string; batch?: { lens?: string } };
    const r = await runPass(j.videoId!, { fromMs: p.fromMs, toMs: p.toMs, cont: p.cont, log: progress });
    if ('upToDate' in r) return { upToDate: r.reason };
    const range = { startMs: r.pass.fromMs, endMs: r.pass.toMs };
    const { enqueue } = await import('../jobs/queue');
    if (p.batch) {
      const { afterDiscover } = await import('./batch');
      afterDiscover({ ...j, payload: { ...j.payload, range } });
    } else if (p.judge && r.pass.seeds > 0) enqueue('judge', { videoId: j.videoId!, payload: { range, lens: p.lens ?? 'stream-moments' }, priority: 6 });
    return { pass: r.pass.n, from: range.startMs, to: range.endMs, seeds: r.pass.seeds, chat: r.pass.chatMessages, viewerClips: r.pass.viewerClips, notes: r.pass.notes };
  },
  judge: async (j, progress) => {
    const { judgeVideo } = await import('../judge');
    const o = j.payload.batch as { lens?: string; perVideo?: number } | undefined;
    const range = j.payload.range as { startMs: number; endMs: number } | undefined;
    const lens = (j.payload.lens as string | undefined) ?? o?.lens ?? (j.videoId?.startsWith('tw-') ? 'stream-moments' : undefined);
    const r = await judgeVideo(j.videoId!, { lens, range, want: range && !o ? undefined : Math.max(8, (o?.perVideo ?? 5) * 2), log: progress });
    const { afterJudge } = await import('./batch');
    const made = await afterJudge(j);
    return { ...r, made };
  },
  sections: async (j, progress) => {
    const { downloadSections } = await import('../ingest/downloads');
    return downloadSections(j.videoId!, (j.payload.ranges as { startMs: number; endMs: number }[]) ?? [], progress);
  },
  full: async (j, progress) => {
    const { downloadFull } = await import('../ingest/downloads');
    return downloadFull(j.videoId!, progress);
  },
  autoedit: async (j, progress) => {
    const { autoEdit } = await import('../edit/autoedit');
    progress('editing');
    const r = await autoEdit(j.clipId!, { accept: !!j.payload.accept, reframe: !!j.payload.reframe, style: j.payload.style as string | undefined });
    const { afterAutoedit } = await import('./batch');
    afterAutoedit(j);
    return { added: r.added.length, captionFixes: r.captionFixes.length };
  },
  reframe: async (j, progress) => {
    const { autoReframe } = await import('../reframe/apply');
    return autoReframe(j.clipId!, { accept: !!j.payload.accept, range: j.payload.range as { startMs: number; endMs: number } | undefined, log: progress });
  },
  split: async (j, progress) => {
    const { detectSplit } = await import('../reframe/split');
    return (await detectSplit(j.clipId!, { auto: !!j.payload.auto, log: progress })) as unknown as Record<string, unknown>;
  },
  render: async (j, progress) => {
    const { renderClip } = await import('../render');
    // the Studio editor's export (payload.qa, no pipeline) is a layout someone chose by hand: report it, don't replace it
    const studioExport = !!j.payload.qa && !j.payload.batch;
    const r = await renderClip(j.clipId!, { log: progress, keepLayout: studioExport });
    const { afterRender } = await import('./batch');
    afterRender(j);
    return { output: r.output, totalMs: r.timings.totalMs, realtimeFactor: r.realtimeFactor };
  },
  qa: async (j) => {
    const { qaClip } = await import('../qa');
    const r = await qaClip(j.clipId!);
    const { afterQa } = await import('./batch');
    await afterQa(j);
    return { passed: r.passed, issues: r.issues.length, lufs: r.loudnessLufs };
  },
};
