// The worker process: whether one is running, and starting one (ensureWorker) whenever something is
// queued. The loop that runs the jobs is src/pipeline/runner.ts (it needs the handlers, which are above).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths } from '../core/paths';
import type { Job, JobKind } from './queue';
import { pidAlive } from '../core/proc';


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

/** The running worker's pid and heartbeat. */
export const LOCK = () => path.join(paths.cache, 'worker.json');


export interface Lock {
  pid: number;
  heartbeat: number;
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
