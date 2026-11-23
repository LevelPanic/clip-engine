// clip studio: a local web app for reviewing candidates and editing clips.
// One port: JSON API + media (with Range) + the Vite-served React app + live updates over SSE.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { paths, listDirs, readJsonIf, writeJson } from '../core/paths';
import { ProjectSchema, type Project, type VideoMeta, type SignalsFile, type Transcript } from '../core/schemas';
import { loadProject, saveProject, listClips, listPresets, presetFromProject, presetFile, loadPreset, applyPreset, suggestedPost } from '../core/project';
import { loadCandidates, makeClip, setCandidateStatus, duplicateClip, deleteClip } from '../candidates';
import { resolveMedia, footageSummary, missingRanges, SECTION_MARGIN_MS } from '../ingest/media';
import { enqueue, listJobs, latestJob, activeJobsFor, type Job } from '../jobs/queue';
import { ensureWorker } from '../jobs/worker';
import { generateMarkerIndex } from '../markers/registry-node';
import { loadScan } from '../scan';

type Handler = (req: express.Request, res: express.Response) => unknown;
const h =
  (fn: Handler): express.RequestHandler =>
  async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      const err = e as Error & { code?: string };
      res.status(err.code === 'CONFLICT' ? 409 : 400).json({ error: err.message });
    }
  };

// ---------- live updates ----------

const clients = new Set<express.Response>();
function broadcast(event: Record<string, unknown>) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.write(data);
}

function watch(dir: string, onFile: (rel: string) => void) {
  fs.mkdirSync(dir, { recursive: true });
  const timers = new Map<string, NodeJS.Timeout>();
  fs.watch(dir, { recursive: true }, (_e, name) => {
    if (!name) return;
    const rel = name.toString();
    clearTimeout(timers.get(rel));
    // the entry goes once it fires: scans write thousands of distinct files (stills, chunks), and a
    // map that kept every path ever written grew for as long as the Studio ran
    timers.set(
      rel,
      setTimeout(() => {
        timers.delete(rel);
        onFile(rel);
      }, 120),
    );
  });
}

// ---------- jobs ----------

const slim = (j: Job) => ({ id: j.id, kind: j.kind, state: j.state, progress: j.progress, error: j.error, videoId: j.videoId, clipId: j.clipId, result: j.result, batchId: j.batchId, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt });

/** Queue the footage for a range if it isn't on disk. Returns the job, or null when nothing is missing. */
function fetchFootage(videoId: string, fromMs: number, toMs: number, durationMs: number) {
  const ranges = [{ startMs: fromMs - SECTION_MARGIN_MS, endMs: toMs + SECTION_MARGIN_MS }];
  if (!missingRanges(videoId, ranges, durationMs).length) return null;
  const j = enqueue('sections', { videoId, dedupe: true, payload: { ranges }, priority: 8 });
  ensureWorker();
  return j;
}

const mediaJson = (videoId: string, fromMs: number, toMs: number) => {
  const m = resolveMedia(videoId, fromMs, toMs);
  return m ? { url: m.urlPath, offsetMs: m.offsetMs, startMs: m.startMs, endMs: m.endMs, width: m.width, height: m.height, fps: m.fps, kind: m.kind } : null;
};

// ---------- waveform ----------

const waveCache = new Map<string, { fromMs: number; stepMs: number; peaks: number[] }>();
async function waveform(videoId: string, fromMs: number, toMs: number) {
  const key = `${videoId}:${fromMs}:${toMs}`;
  if (waveCache.has(key)) return waveCache.get(key)!;
  const audio = paths.videoFile(videoId, 'audio.m4a');
  const media = fs.existsSync(audio) ? { file: audio, offsetMs: 0 } : resolveMedia(videoId, fromMs, toMs);
  if (!media) return null;
  const src = media.file;
  const rate = 4000;
  const stepMs = 10;
  const per = (rate * stepMs) / 1000;
  const r = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, fromMs - media.offsetMs) / 1000), '-t', String((toMs - fromMs) / 1000), '-i', src, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-']);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks)));
  });
  const samples = new Int16Array(r.buffer, r.byteOffset, Math.floor(r.length / 2));
  const peaks: number[] = [];
  for (let i = 0; i < samples.length; i += per) {
    let m = 0;
    for (let j = i; j < Math.min(samples.length, i + per); j++) m = Math.max(m, Math.abs(samples[j]));
    peaks.push(Math.round((m / 32768) * 100));
  }
  const out = { fromMs, stepMs, peaks };
  waveCache.set(key, out);
  if (waveCache.size > 50) waveCache.delete(waveCache.keys().next().value!);
  return out;
}

// ---------- server ----------

export async function startStudio(port: number) {
  generateMarkerIndex();
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', h(() => ({ ok: true })));

  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: {"type":"hello"}\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  // videos
  app.get(
    '/api/videos',
    h(() =>
      listDirs(paths.library)
        .map((id) => {
          const meta = readJsonIf<VideoMeta>(paths.videoFile(id, 'meta.json'));
          if (!meta) return null;
          const c = loadCandidates(id).candidates;
          return {
            id,
            title: meta.title,
            channel: meta.channel,
            durationMs: meta.durationMs,
            candidates: c.length,
            made: c.filter((x) => x.status === 'made').length,
            footage: footageSummary(id),
            jobs: activeJobsFor(id).map(slim),
            ingestedAt: meta.ingestedAt,
          };
        })
        .filter(Boolean)
        .sort((a, b) => (b!.ingestedAt > a!.ingestedAt ? 1 : -1)),
    ),
  );

  app.get(
    '/api/videos/:id',
    h((req) => {
      const id = String(req.params.id);
      const meta = readJsonIf<VideoMeta>(paths.videoFile(id, 'meta.json'));
      if (!meta) throw new Error(`No video ${id}`);
      const signals = readJsonIf<SignalsFile>(paths.videoFile(id, 'signals.json'));
      const scan = loadScan(id);
      let watchAlive = false;
      if (scan.watch) {
        try {
          process.kill(scan.watch.pid, 0);
          watchAlive = true;
        } catch {}
      }
      return {
        meta,
        signals,
        scan: {
          passes: scan.passes,
          watch: scan.watch ?? null,
          watchAlive,
          // a judge that failed after the last pass (e.g. the claude CLI isn't logged in)
          judgeError: (() => {
            const j = latestJob('judge', { videoId: id });
            const last = scan.passes.at(-1);
            return j?.state === 'failed' && last && j.finishedAt && j.finishedAt >= last.at ? (j.error ?? 'judge failed') : null;
          })(),
        },
        candidates: loadCandidates(id).candidates,
        footage: footageSummary(id),
        jobs: activeJobsFor(id).map(slim),
        // per made candidate: its clip, export and review state
        clips: Object.fromEntries(
          loadCandidates(id)
            .candidates.filter((c) => c.clipId && fs.existsSync(paths.project(c.clipId)))
            .map((c) => {
              const p = loadProject(c.clipId!);
              const exp = readJsonIf<{ renderedAt: string }>(path.join(paths.exports, `${c.clipId}.json`));
              // the newest step of its export chain (autoedit → render → qa)
              const job = (['autoedit', 'render', 'qa'] as const)
                .map((k) => latestJob(k, { clipId: c.clipId! }))
                .filter((j): j is NonNullable<typeof j> => !!j)
                .sort((a, b) => b.id - a.id)[0];
              return [c.id, { clipId: c.clipId, review: p.review?.status ?? null, exportedAt: exp?.renderedAt ?? null, render: job ? slim(job) : null }];
            }),
        ),
      };
    }),
  );

  // footage for a range; ?fetch=1 queues a section download when it's missing
  app.get(
    '/api/videos/:id/media',
    h((req) => {
      const id = String(req.params.id);
      const from = Number(req.query.from);
      const to = Number(req.query.to);
      const media = mediaJson(id, from, to);
      if (media) return { media };
      const meta = readJsonIf<VideoMeta>(paths.videoFile(id, 'meta.json'));
      const job = req.query.fetch && meta ? fetchFootage(id, from, to, meta.durationMs) : null;
      return { media: null, job: job ? slim(job) : null };
    }),
  );

  app.get(
    '/api/videos/:id/words',
    h((req) => {
      const t = readJsonIf<Transcript>(paths.videoFile(String(req.params.id), 'transcript.json'));
      const from = Number(req.query.from ?? 0);
      const to = Number(req.query.to ?? Infinity);
      return (t?.words ?? []).filter((w) => w.endMs >= from && w.startMs <= to);
    }),
  );

  app.post(
    '/api/videos/:id/candidates/:cid/make',
    h(async (req) => ({ clipId: await makeClip(String(req.params.id), String(req.params.cid)) })),
  );

  // export candidates straight away: as they are, or with an edit style; QA'd and queued for review
  app.post(
    '/api/videos/:id/candidates/export',
    h(async (req) => {
      const id = String(req.params.id);
      const ids = (req.body.ids as string[]) ?? [];
      const style = String(req.body.style ?? 'none');
      const { DEFAULT_BATCH } = await import('../jobs/pipeline');
      const batch = { ...DEFAULT_BATCH, render: true, autoedit: style !== 'none', style: style === 'none' ? undefined : style };
      const out = [];
      for (const cid of ids) {
        const clipId = await makeClip(id, cid);
        const j =
          style === 'none'
            ? enqueue('render', { videoId: id, clipId, payload: { batch }, priority: 7 })
            : enqueue('autoedit', { videoId: id, clipId, payload: { batch, accept: true, style }, priority: 7 });
        out.push({ candidateId: cid, clipId, job: slim(j) });
      }
      ensureWorker();
      return out;
    }),
  );

  // one scan pass over a range of a stream (or the new part since the last pass), then judge it
  app.post(
    '/api/videos/:id/scan',
    h((req) => {
      const id = String(req.params.id);
      const b = req.body ?? {};
      const payload = {
        ...(typeof b.fromMs === 'number' ? { fromMs: b.fromMs } : {}),
        ...(typeof b.toMs === 'number' ? { toMs: b.toMs } : {}),
        cont: !!b.cont,
        judge: b.judge !== false,
        lens: b.lens ?? 'stream-moments',
      };
      const j = enqueue('scan', { videoId: id, dedupe: true, payload, priority: 8 });
      ensureWorker();
      return slim(j);
    }),
  );

  app.post(
    '/api/videos/:id/candidates/:cid/status',
    h((req) => setCandidateStatus(String(req.params.id), String(req.params.cid), req.body.status)),
  );

  // clips
  app.get(
    '/api/clips',
    h(() =>
      listClips().map((id) => {
        const p = loadProject(id);
        return {
          id,
          title: p.title,
          videoId: p.videoId,
          segment: p.segments[0],
          markers: p.markers.length,
          updatedAt: p.updatedAt,
          exported: readJsonIf(path.join(paths.exports, `${id}.json`)) ?? null,
        };
      }),
    ),
  );

  app.get(
    '/api/clips/:id',
    h((req) => {
      const id = String(req.params.id);
      const project = loadProject(id);
      const meta = readJsonIf<VideoMeta>(paths.videoFile(project.videoId, 'meta.json'));
      const seg = project.segments[0];
      // footage for the editor's view (clip ± 8 s), falling back to just the clip
      const view = { startMs: Math.max(0, seg.startMs - 8000), endMs: Math.min(project.sourceDurationMs, seg.endMs + 8000) };
      const media = mediaJson(project.videoId, view.startMs, view.endMs) ?? mediaJson(project.videoId, seg.startMs, seg.endMs);
      const fetching = media ? null : fetchFootage(project.videoId, view.startMs, view.endMs, project.sourceDurationMs);
      const t = readJsonIf<Transcript>(paths.videoFile(project.videoId, 'transcript.json'));
      return {
        project,
        tags: (t?.tags ?? []).filter((g) => g.ms >= seg.startMs - 120_000 && g.ms <= seg.endMs + 120_000),
        meta: meta ? { title: meta.title, channel: meta.channel, durationMs: meta.durationMs, width: meta.width, height: meta.height } : null,
        media,
        footageJob: fetching ? slim(fetching) : (activeJobsFor(project.videoId).find((j) => j.kind === 'sections' || j.kind === 'full') ?? null),
        export: readJsonIf(path.join(paths.exports, `${id}.json`)) ?? null,
        qa: readJsonIf(path.join(paths.exports, `${id}.qa.json`)) ?? null,
        postSuggestion: suggestedPost(project),
        job: (() => {
          const j = latestJob('render', { clipId: id });
          return j ? slim(j) : null;
        })(),
        // the other clips from this video, for prev/next
        // in the candidate list's order (best score first), so next/prev walks the list
        siblings: (() => {
          const score = new Map(loadCandidates(project.videoId).candidates.map((c) => [c.id, c.score]));
          return listClips()
            .map((c) => ({ id: c, p: loadProject(c) }))
            .filter((c) => c.p.videoId === project.videoId)
            .sort((a, b) => (score.get(b.p.candidateId ?? '') ?? 0) - (score.get(a.p.candidateId ?? '') ?? 0) || a.id.localeCompare(b.id))
            .map((c) => ({ id: c.id, title: c.p.title }));
        })(),
      };
    }),
  );

  app.put(
    '/api/clips/:id',
    h((req) => {
      const project = ProjectSchema.parse(req.body.project) as Project;
      if (project.id !== req.params.id) throw new Error('id mismatch');
      return { project: saveProject(project, req.body.baseRev) };
    }),
  );

  app.get(
    '/api/clips/:id/waveform',
    h(async (req) => {
      const p = loadProject(String(req.params.id));
      const from = Math.max(0, Number(req.query.from));
      const to = Math.min(p.sourceDurationMs, Number(req.query.to));
      return (await waveform(p.videoId, from, to)) ?? { fromMs: from, stepMs: 10, peaks: [] };
    }),
  );

  app.post(
    '/api/clips/:id/render',
    h((req) => {
      const clipId = String(req.params.id);
      const j = enqueue('render', { clipId, videoId: loadProject(clipId).videoId, dedupe: true, priority: 10, payload: { qa: true } });
      ensureWorker();
      return slim(j);
    }),
  );
  app.post('/api/clips/:id/duplicate', h((req) => ({ clipId: duplicateClip(String(req.params.id)) })));
  app.post('/api/clips/:id/delete', h((req) => deleteClip(String(req.params.id))));
  app.get(
    '/api/clips/:id/render',
    h((req) => {
      const j = latestJob('render', { clipId: String(req.params.id) });
      return j ? slim(j) : null;
    }),
  );
  app.get('/api/jobs', h((req) => listJobs({ limit: Number(req.query.limit ?? 100) }).map(slim)));
  app.post(
    '/api/batch',
    h(async (req) => {
      const { startBatch } = await import('../jobs/batch');
      const { DEFAULT_BATCH } = await import('../jobs/pipeline');
      const b = req.body ?? {};
      return startBatch([String(b.inputs ?? '')], { ...DEFAULT_BATCH, ...b.options }, Number(b.limit ?? 5));
    }),
  );
  app.get('/api/lenses', h(() => fs.readdirSync(paths.lenses).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => f.replace(/\.md$/, ''))));

  // engine actions on a clip (run by the worker; the editor reloads when the project changes)
  app.post(
    '/api/clips/:id/action',
    h(async (req) => {
      const clipId = String(req.params.id);
      const p = loadProject(clipId);
      const kind = String(req.body.kind);
      if (kind === 'suggest-cuts') {
        const { suggestSilenceCuts } = await import('../edit/suggest');
        const cuts = await suggestSilenceCuts(p, {});
        p.markers = [...p.markers, ...cuts].sort((a, b) => a.startMs - b.startMs);
        saveProject(p);
        return { proposed: cuts.length };
      }
      if (kind === 'split') {
        const j = enqueue('split', { clipId, videoId: p.videoId, payload: { auto: false }, priority: 9 });
        ensureWorker();
        return slim(j);
      }
      if (kind !== 'autoedit' && kind !== 'reframe') throw new Error(`unknown action ${kind}`);
      const j = enqueue(kind, { clipId, videoId: p.videoId, payload: { accept: false, reframe: false, range: req.body.range, style: req.body.style }, priority: 9 });
      ensureWorker();
      return slim(j);
    }),
  );

  // review
  app.get(
    '/api/review',
    h(async () => {
      const { reviewQueue } = await import('../review');
      // what the upload scheduler did with each approval (refusals live only in the review DB)
      const { listReviews } = await import('../review/db');
      const rows = new Map(listReviews().map((r) => [r.clipId, r]));
      return Promise.all(reviewQueue().map(async (q) => {
        const p = loadProject(q.id);
        const cand = loadCandidates(p.videoId).candidates.find((c) => c.id === p.candidateId) ?? null;
        const { loadQa } = await import('../qa');
        const exp = readJsonIf<{ durationS: number }>(path.join(paths.exports, `${q.id}.json`));
        const { postFor } = await import('../core/post');
        return {
          ...q,
          durationMs: exp ? Math.round(exp.durationS * 1000) : p.segments[0].endMs - p.segments[0].startMs,
          candidate: cand,
          markers: p.markers.length,
          proposed: p.markers.filter((m) => m.proposed).length,
          qa: loadQa(q.id) ?? null,
          published: readJsonIf<Record<string, unknown>>(path.join(paths.exports, `${q.id}.publish.json`)) ?? null,
          post: postFor(p.post, suggestedPost(p)),
          upload: (() => {
            const r = rows.get(q.id);
            if (!r) return null;
            // the last thing the scheduler said about it ([upload] … or [gate] …)
            const said = (r.note ?? '').split('\n').filter((l) => /^\[(upload|gate)\]/.test(l)).pop()?.replace(/^\[(upload|gate)\]\s*/, '');
            return {
              status: r.uploadStatus,
              pickedAt: r.pickedAt,
              reason: r.uploadStatus === 'failed' || r.uploadStatus === 'blocked-title' || r.uploadStatus === 'blocked-auth' || r.uploadStatus === 'deferred' ? said ?? null : null,
              attempts: r.attempts,
              lastAttemptAt: r.lastAttemptAt,
              lastError: r.lastError,
            };
          })(),
        };
      }));
    }),
  );
  app.post(
    '/api/clips/:id/review',
    h(async (req) => {
      const { setReview, parseReasons } = await import('../review');
      // `adult`: the review page's 18+ check (only the To review tab sends a ticked/unticked choice)
      const adult = typeof req.body.adult === 'boolean' ? req.body.adult : undefined;
      const p = setReview(String(req.params.id), req.body.status, req.body.note || undefined, parseReasons(req.body.reasons), adult);
      return { review: p.review };
    }),
  );
  app.get(
    '/api/upload-status',
    h(async () => {
      // what the upload scheduler is doing (uploading, or held by YouTube and why), how many went up today,
      // its pace (in the status) and the careful period, if one is on (channel.json)
      const { readUploadLog, readUploadStatus, recentUploads } = await import('../publish/uploadStatus');
      const { carefulUntil, loadChannel } = await import('../core/channel');
      const recent = recentUploads();
      const ch = loadChannel();
      const until = carefulUntil(ch);
      return {
        status: readUploadStatus(),
        uploads24h: recent.length,
        firstIn24h: recent[0] ?? null,
        lastUpload: recent.at(-1) ?? null,
        log: readUploadLog(30),
        careful: until ? { until, why: ch.careful?.why ?? null } : null,
      };
    }),
  );
  app.post(
    '/api/clips/:id/retry-upload',
    h(async (req) => {
      // put a refused approval back in the scheduler's line; it is checked again from the start
      const { releasePick } = await import('../review/db');
      releasePick(String(req.params.id));
      return { ok: true };
    }),
  );
  app.post(
    '/api/clips/:id/publish',
    h(async (req) => {
      const { publishYoutube } = await import('../publish/youtube');
      const publishAt = typeof req.body.publishAt === 'string' ? req.body.publishAt : undefined;
      return publishYoutube(String(req.params.id), { publishAt, force: !!req.body.force });
    }),
  );
  app.get('/api/stats', h(async () => (await import('../review')).stats()));

  // presets & assets
  app.get('/api/presets', h(() => listPresets()));
  app.post(
    '/api/presets',
    h((req) => {
      const pr = presetFromProject(loadProject(String(req.body.clipId)), String(req.body.name));
      writeJson(presetFile(pr.name), pr);
      return pr;
    }),
  );
  app.post(
    '/api/clips/:id/apply-preset',
    h(async (req) => {
      const p = await applyPreset(loadProject(String(req.params.id)), loadPreset(String(req.body.name)), req.body.mode ?? 'replace');
      return { project: saveProject(p) };
    }),
  );
  app.get(
    '/api/sfx',
    h(() => (fs.existsSync(paths.sfx) ? fs.readdirSync(paths.sfx).filter((f) => /\.(wav|mp3|m4a|ogg)$/i.test(f)).sort() : [])),
  );

  // media (express.static handles Range requests, so the 2 h source streams fine)
  app.use('/media/library', express.static(paths.library, { fallthrough: false }));
  app.use('/media/assets', express.static(paths.assets, { fallthrough: false }));
  app.use('/media/exports', express.static(paths.exports, { fallthrough: false }));

  // the React app
  const server = http.createServer(app);
  const { createServer: createVite } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const vite = await createVite({
    configFile: false,
    root: path.join(paths.root, 'src', 'studio', 'web'),
    appType: 'spa',
    plugins: [react()],
    server: { middlewareMode: true, hmr: { server }, fs: { allow: [paths.root] } },
    logLevel: 'warn',
  });
  app.use(vite.middlewares);

  // watch files so CLI/agent edits show up live
  watch(paths.clips, (rel) => {
    const m = /^([^/]+)\/project\.json$/.exec(rel);
    if (!m || !fs.existsSync(paths.project(m[1]))) return;
    try {
      broadcast({ type: 'project', clipId: m[1], rev: loadProject(m[1]).rev });
    } catch {}
  });
  watch(paths.library, (rel) => {
    if (rel === 'upload-status.json' || rel === 'upload-log.jsonl') return broadcast({ type: 'upload-status' });
    const m = /^([^/]+)\/(candidates|signals|media|download|meta|scan)\.json$/.exec(rel);
    if (m) broadcast({ type: 'video', videoId: m[1], file: m[2] });
  });
  watch(paths.exports, (rel) => {
    const m = /^(.+?)(\.qa)?\.json$/.exec(rel);
    if (m) broadcast({ type: 'export', clipId: m[1] });
  });
  watch(paths.markers, (rel) => {
    if (!rel.includes('index.generated')) generateMarkerIndex();
  });

  // the worker runs in its own process; poll the queue and push job changes to the browser
  const seen = new Map<number, string>();
  setInterval(() => {
    try {
      for (const j of listJobs({ limit: 60 })) {
        const sig = `${j.state}|${j.progress}`;
        if (seen.get(j.id) !== sig) {
          if (seen.has(j.id) || j.state === 'running' || j.state === 'queued') broadcast({ type: 'job', job: slim(j) });
          seen.set(j.id, sig);
        }
      }
    } catch {}
  }, 1000);
  ensureWorker(); // pick up anything left in the queue

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  console.log(`Studio running at http://localhost:${port}`);
}
