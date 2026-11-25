// A persistent job queue in SQLite (Node's built-in node:sqlite). The CLI, the Studio and the
// worker all share it, so downloads, renders and batch runs survive restarts and show progress.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from '../core/paths';
import { openDatabase } from '../core/sqlite';

export type JobKind =
  | 'ingest' // metadata, captions, comments (+ queues audio)
  | 'audio' // audio-only download (signals, Whisper, waveform)
  | 'audio-events' // SoundAnalysis laughter/cheering detection
  | 'whisper' // transcript fallback
  | 'discover'
  | 'scan' // one scan pass over a range of a stream (chat, clips, audio, windowed transcript, seeds)
  | 'judge' // unattended judge (claude -p)
  | 'sections' // download only the ranges we need
  | 'full' // whole video
  | 'autoedit'
  | 'reframe'
  | 'split' // find the facecam and switch to the split facecam/gameplay layout
  | 'render'
  | 'qa'
  | 'post-text'; // a new title or description for a clip, in the reviewer's direction (src/pipeline/postText.ts)

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: number;
  kind: JobKind;
  videoId: string | null;
  clipId: string | null;
  batchId: string | null;
  payload: Record<string, unknown>;
  state: JobState;
  progress: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  priority: number;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

let db: DatabaseSync | undefined;

export function jobsDb(): DatabaseSync {
  if (db) return db;
  db = openDatabase(path.join(paths.library, 'jobs.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      videoId TEXT,
      clipId TEXT,
      batchId TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'queued',
      progress TEXT,
      error TEXT,
      result TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      startedAt TEXT,
      finishedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, priority, id);
    CREATE INDEX IF NOT EXISTS jobs_video ON jobs(videoId);
    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL,
      note TEXT
    );
  `);
  return db;
}

type Row = Record<string, unknown>;
const toJob = (r: Row): Job => ({
  ...(r as unknown as Job),
  payload: JSON.parse((r.payload as string) || '{}'),
  result: r.result ? JSON.parse(r.result as string) : null,
});
const now = () => new Date().toISOString();

export interface EnqueueOpts {
  videoId?: string;
  clipId?: string;
  batchId?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  /** Reuse a queued/running job of the same kind for the same video/clip instead of adding another. */
  dedupe?: boolean;
}

export function enqueue(kind: JobKind, o: EnqueueOpts = {}): Job {
  const d = jobsDb();
  if (o.dedupe) {
    const existing = d
      .prepare(`SELECT * FROM jobs WHERE kind = ? AND videoId IS ? AND clipId IS ? AND state IN ('queued','running') ORDER BY id DESC LIMIT 1`)
      .get(kind, o.videoId ?? null, o.clipId ?? null) as Row | undefined;
    if (existing) {
      const job = toJob(existing);
      // sections: fold the new ranges into a job that hasn't started yet
      if (kind === 'sections' && job.state === 'queued' && Array.isArray(o.payload?.ranges)) {
        const ranges = [...((job.payload.ranges as unknown[]) ?? []), ...(o.payload!.ranges as unknown[])];
        d.prepare(`UPDATE jobs SET payload = ? WHERE id = ?`).run(JSON.stringify({ ...job.payload, ranges }), job.id);
        return getJob(job.id)!;
      }
      if (kind !== 'sections') return job;
    }
  }
  const r = d
    .prepare(`INSERT INTO jobs (kind, videoId, clipId, batchId, payload, priority, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(kind, o.videoId ?? null, o.clipId ?? null, o.batchId ?? null, JSON.stringify(o.payload ?? {}), o.priority ?? 0, now());
  return getJob(Number(r.lastInsertRowid))!;
}

export function getJob(id: number): Job | undefined {
  const r = jobsDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as Row | undefined;
  return r ? toJob(r) : undefined;
}

/** Atomically take the next runnable job, respecting per-kind concurrency limits. */
export function claimNext(limits: Partial<Record<JobKind, number>>, skip: Set<number> = new Set()): Job | undefined {
  const d = jobsDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const running = d.prepare(`SELECT kind, COUNT(*) AS n FROM jobs WHERE state = 'running' GROUP BY kind`).all() as { kind: JobKind; n: number }[];
    const busy = new Map(running.map((r) => [r.kind, r.n]));
    const queued = d.prepare(`SELECT * FROM jobs WHERE state = 'queued' ORDER BY priority DESC, id ASC LIMIT 200`).all() as Row[];
    for (const row of queued) {
      const kind = row.kind as JobKind;
      if (skip.has(row.id as number)) continue;
      if ((busy.get(kind) ?? 0) >= (limits[kind] ?? 1)) continue;
      d.prepare(`UPDATE jobs SET state = 'running', startedAt = ?, attempts = attempts + 1, progress = NULL, error = NULL WHERE id = ?`).run(now(), row.id as number);
      d.exec('COMMIT');
      return getJob(row.id as number);
    }
    d.exec('COMMIT');
    return undefined;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function setProgress(id: number, progress: string) {
  jobsDb().prepare(`UPDATE jobs SET progress = ? WHERE id = ?`).run(progress, id);
}

export function finishJob(id: number, result: Record<string, unknown> = {}) {
  jobsDb().prepare(`UPDATE jobs SET state = 'done', finishedAt = ?, result = ?, progress = '100%' WHERE id = ?`).run(now(), JSON.stringify(result), id);
}

export function failJob(id: number, error: string) {
  jobsDb().prepare(`UPDATE jobs SET state = 'failed', finishedAt = ?, error = ? WHERE id = ?`).run(now(), error.slice(0, 4000), id);
}

export function cancelJob(id: number) {
  jobsDb().prepare(`UPDATE jobs SET state = 'cancelled', finishedAt = ? WHERE id = ? AND state IN ('queued','running')`).run(now(), id);
}

/** Requeue a failed/cancelled job (or, with fromRunning, a running one that hit a transient error). */
export function retryJob(id: number, fromRunning = false) {
  const states = fromRunning ? "('failed','cancelled','running')" : "('failed','cancelled')";
  jobsDb().prepare(`UPDATE jobs SET state = 'queued', error = NULL, finishedAt = NULL WHERE id = ? AND state IN ${states}`).run(id);
}

/** Jobs left 'running' by a worker that died go back to the queue (up to 3 attempts). */
export function requeueOrphans() {
  const d = jobsDb();
  d.prepare(`UPDATE jobs SET state = 'queued', progress = 'restarted' WHERE state = 'running' AND attempts < 3`).run();
  d.prepare(`UPDATE jobs SET state = 'failed', error = COALESCE(error, 'worker died 3 times'), finishedAt = ? WHERE state = 'running'`).run(now());
}

export function listJobs(f: { videoId?: string; clipId?: string; batchId?: string; states?: JobState[]; kinds?: JobKind[]; limit?: number } = {}): Job[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.videoId) (where.push('videoId = ?'), args.push(f.videoId));
  if (f.clipId) (where.push('clipId = ?'), args.push(f.clipId));
  if (f.batchId) (where.push('batchId = ?'), args.push(f.batchId));
  if (f.states?.length) (where.push(`state IN (${f.states.map(() => '?').join(',')})`), args.push(...f.states));
  if (f.kinds?.length) (where.push(`kind IN (${f.kinds.map(() => '?').join(',')})`), args.push(...f.kinds));
  const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${f.limit ?? 200}`;
  return (jobsDb().prepare(sql).all(...args) as Row[]).map(toJob);
}

export function pendingCount(): number {
  return (jobsDb().prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running')`).get() as { n: number }).n;
}

/** The newest job of a kind for a video/clip, if any. */
export function latestJob(kind: JobKind, key: { videoId?: string; clipId?: string }): Job | undefined {
  const r = jobsDb()
    .prepare(`SELECT * FROM jobs WHERE kind = ? AND (videoId IS ? OR ? IS NULL) AND (clipId IS ? OR ? IS NULL) ORDER BY id DESC LIMIT 1`)
    .get(kind, key.videoId ?? null, key.videoId ?? null, key.clipId ?? null, key.clipId ?? null) as Row | undefined;
  return r ? toJob(r) : undefined;
}

export function createBatch(note?: string): string {
  const id = `b${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}${Math.random().toString(36).slice(2, 5)}`;
  jobsDb().prepare(`INSERT INTO batches (id, createdAt, note) VALUES (?, ?, ?)`).run(id, now(), note ?? null);
  return id;
}

/** Block until these jobs finish (the CLI's --wait). Throws if one fails. */
export async function waitForJobs(ids: number[], log: (s: string) => void = console.log) {
  const last = new Map<number, string>();
  for (;;) {
    const jobs = ids.map((id) => getJob(id)!).filter(Boolean);
    for (const j of jobs) {
      const line = `${j.kind} #${j.id}: ${j.state}${j.progress ? ` ${j.progress}` : ''}`;
      if (last.get(j.id) !== line && j.state !== 'queued') (log(`  ${line}`), last.set(j.id, line));
      if (j.state === 'failed') throw new Error(`${j.kind} #${j.id} failed: ${j.error}`);
    }
    if (jobs.every((j) => j.state === 'done' || j.state === 'cancelled')) return jobs;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** One line per video for UIs: what footage is on disk and what's downloading. */
export function activeJobsFor(videoId: string): Job[] {
  return listJobs({ videoId, states: ['queued', 'running'] });
}
