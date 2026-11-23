// The worker: takes jobs off the queue and runs them with per-kind concurrency limits.
// It starts on demand (ensureWorker) and can exit when the queue is empty.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths } from '../core/paths';
import { claimNext, finishJob, failJob, setProgress, requeueOrphans, pendingCount, getJob, retryJob, type Job, type JobKind } from './queue';

const RETRYABLE = new Set<JobKind>(['ingest', 'audio', 'sections', 'full', 'judge']);
const TRANSIENT = /HTTP Error (403|429|5\d\d)|timed out|Connection reset|Read timed out|Temporary failure|Unable to download (webpage|video data|API page)|no video stream/i;

export type Handler = (job: Job, progress: (s: string) => void) => Promise<Record<string, unknown> | void>;

/** How many of each kind run at once. Renders and Whisper saturate the M1, so one at a time. */
export const LIMITS: Record<JobKind, number> = {
  ingest: 2,
  audio: 2,
  'audio-events': 1,
  whisper: 1,
  discover: 2,
  scan: 1, // Whisper inside a pass saturates the M1, like the whisper job
  judge: 1,
  sections: 2,
  full: 1,
  autoedit: 2,
  reframe: 1,
  split: 1,
  render: 1,
  qa: 2,
};

const LOCK = () => path.join(paths.cache, 'worker.json');

async function rendersWaitingForFootage(): Promise<Set<number>> {
  const { listJobs } = await import('./queue');
  const { resolveMedia } = await import('../ingest/media');
  const { loadProject } = await import('../core/project');
  const skip = new Set<number>();
  const queued = listJobs({ kinds: ['render', 'reframe'], states: ['queued'], limit: 100 });
  if (!queued.length) return skip;
  const downloading = new Set(listJobs({ kinds: ['sections', 'full'], states: ['queued', 'running'], limit: 100 }).map((j) => j.videoId));
  for (const j of queued) {
    if (!j.clipId || !downloading.has(j.videoId)) continue;
    try {
      const seg = loadProject(j.clipId).segments[0];
      if (!resolveMedia(j.videoId!, seg.startMs - 1000, seg.endMs + 1000)) skip.add(j.id);
    } catch {}
  }
  return skip;
}

interface Lock {
  pid: number;
  heartbeat: number;
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function workerAlive(): boolean {
  try {
    const l = JSON.parse(fs.readFileSync(LOCK(), 'utf8')) as Lock;
    return pidAlive(l.pid) && Date.now() - l.heartbeat < 15_000;
  } catch {
    return false;
  }
}

/** Start a background worker if none is running. Called whenever something is queued. */
export function ensureWorker(): boolean {
  if (workerAlive()) return false;
  fs.mkdirSync(paths.cache, { recursive: true });
  const log = fs.openSync(path.join(paths.cache, 'worker.log'), 'a');
  const child = spawn(path.join(paths.root, 'clip'), ['worker', '--exit-when-idle'], {
    cwd: paths.root,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  return true;
}

export async function runWorker(handlers: Partial<Record<JobKind, Handler>>, opts: { exitWhenIdle?: boolean; log?: (s: string) => void } = {}) {
  const log = opts.log ?? ((s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`));
  if (workerAlive()) {
    log('another worker is already running');
    return;
  }
  fs.mkdirSync(paths.cache, { recursive: true });
  const beat = () => fs.writeFileSync(LOCK(), JSON.stringify({ pid: process.pid, heartbeat: Date.now() } satisfies Lock));
  beat();
  requeueOrphans();
  log(`worker ${process.pid} started`);

  const running = new Map<number, Promise<void>>();
  let idleSince = Date.now();
  let stop = false;
  process.on('SIGINT', () => (stop = true));
  process.on('SIGTERM', () => (stop = true));

  while (!stop) {
    beat();
    // only claim kinds we have handlers for
    const limits = Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, handlers[k as JobKind] ? v : 0]));
    // a render whose footage is still downloading would sit in the only render slot; skip it for now
    const notReady = await rendersWaitingForFootage();
    let job: Job | undefined;
    while ((job = claimNext(limits, notReady))) {
      const j = job;
      const handler = handlers[j.kind]!;
      log(`▶ #${j.id} ${j.kind} ${j.videoId ?? ''} ${j.clipId ?? ''}`);
      let lastWrite = 0;
      const progress = (s: string) => {
        if (Date.now() - lastWrite < 500) return;
        lastWrite = Date.now();
        // a cancelled job keeps running to completion but stops reporting
        if (getJob(j.id)?.state === 'running') setProgress(j.id, s);
      };
      const p = handler(j, progress)
        .then((result) => {
          if (getJob(j.id)?.state === 'running') finishJob(j.id, result ?? {});
          log(`✔ #${j.id} ${j.kind}`);
        })
        .catch(async (e: Error) => {
          // YouTube throws intermittent 403/429/5xx on downloads; those usually succeed a bit later
          if (RETRYABLE.has(j.kind) && TRANSIENT.test(e.message) && j.attempts < 3) {
            const wait = 15_000 * j.attempts;
            log(`↻ #${j.id} ${j.kind}: transient error, retrying in ${wait / 1000} s`);
            setProgress(j.id, `retrying after: ${e.message.split('\n').find((l) => TRANSIENT.test(l))?.slice(0, 80) ?? 'network error'}`);
            await new Promise((r) => setTimeout(r, wait));
            retryJob(j.id, true);
            return;
          }
          failJob(j.id, e.message);
          log(`✖ #${j.id} ${j.kind}: ${e.message.split('\n')[0]}`);
        })
        .finally(() => running.delete(j.id));
      running.set(j.id, p);
    }
    if (running.size || pendingCount()) idleSince = Date.now();
    else if (opts.exitWhenIdle && Date.now() - idleSince > 8000) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  await Promise.allSettled(running.values());
  fs.rmSync(LOCK(), { force: true });
  log('worker stopped');
}
