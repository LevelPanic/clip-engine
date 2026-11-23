// The watchlist's job queue (reports/stream-pipeline-spec-2026-11-19.md, sections 7 and 8), in the
// tracker (library/tracking.sqlite) instead of a JSON file with one writer.
//   - Dedupe: a unique index on (kind, video, moment) among queued and running jobs, so a race can
//     never insert a second job for the same thing.
//   - Leases: a worker claims a job in one transaction (`claimed_by`, `lease_until`) and renews the
//     lease every minute. A job whose lease ran out, or whose worker's process is gone, goes back in
//     line (`requeueStale`), keeping its checkpoint.
//   - Fencing: every write a worker makes to a job (`saveStage`, `finishJob`) checks it still holds the
//     claim, so a worker that lost its job cannot complete it twice.
//   - Checkpoints: `stage` + `stage_data` record the last pipeline stage that finished (and what it
//     made: candidate ids, picks, clip ids), so a restart resumes there.
import { trackingDb } from './db';

/** `revise`: a clip the reviewer sent back with a note (its `momentId` is `<clip>@<request time>`, so each request runs once). */
export type JobKind = 'twitch-moment' | 'youtube-check' | 'twitch-scan' | 'revise';
export type JobState = 'queued' | 'running' | 'done' | 'failed';

export interface WatchJob {
  id: string;
  kind: JobKind;
  creator: string;
  topic?: string;
  /** 0 by hand, 1 a listed creator, 2 a topic. */
  tier: number;
  videoId: string;
  momentId?: string;
  url?: string;
  fromMs?: number;
  toMs?: number;
  state: JobState;
  claimedBy?: string;
  leaseUntil?: string;
  /** The last pipeline stage that finished, and what it made. */
  stage?: string;
  stageData?: Record<string, unknown>;
  attempts: number;
  interrupted: number;
  error?: string;
  result?: string;
  clipIds: string[];
  /** The blind ranker trial: which ranking's pick this moment job is (`score`, `alternate`, `both`). */
  arm?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

let ready = false;
function db() {
  const d = trackingDb();
  if (ready) return d;
  d.exec(`
    CREATE TABLE IF NOT EXISTS watch_jobs (
      job_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      creator TEXT NOT NULL,
      topic TEXT,
      tier INTEGER NOT NULL DEFAULT 1,
      video_id TEXT NOT NULL,
      moment_id TEXT,
      url TEXT,
      from_ms INTEGER,
      to_ms INTEGER,
      state TEXT NOT NULL,
      claimed_by TEXT,
      lease_until TEXT,
      stage TEXT,
      stage_data TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      interrupted INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      result TEXT,
      clip_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS watch_jobs_state ON watch_jobs(state, tier, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS watch_jobs_active ON watch_jobs(kind, video_id, IFNULL(moment_id, '')) WHERE state IN ('queued', 'running');
  `);
  // added 2026-11-19: the blind ranker trial's arm
  if (!(d.prepare('PRAGMA table_info(watch_jobs)').all() as { name: string }[]).some((c) => c.name === 'arm')) d.exec('ALTER TABLE watch_jobs ADD COLUMN arm TEXT');
  ready = true;
  return d;
}

const now = () => new Date().toISOString();

const toJob = (r: Record<string, unknown>): WatchJob => ({
  id: String(r.job_id),
  kind: String(r.kind) as JobKind,
  creator: String(r.creator),
  ...(r.topic ? { topic: String(r.topic) } : {}),
  tier: Number(r.tier),
  videoId: String(r.video_id),
  ...(r.moment_id ? { momentId: String(r.moment_id) } : {}),
  ...(r.url ? { url: String(r.url) } : {}),
  ...(r.from_ms != null ? { fromMs: Number(r.from_ms) } : {}),
  ...(r.to_ms != null ? { toMs: Number(r.to_ms) } : {}),
  state: String(r.state) as JobState,
  ...(r.claimed_by ? { claimedBy: String(r.claimed_by) } : {}),
  ...(r.lease_until ? { leaseUntil: String(r.lease_until) } : {}),
  ...(r.stage ? { stage: String(r.stage) } : {}),
  ...(r.stage_data ? { stageData: JSON.parse(String(r.stage_data)) } : {}),
  attempts: Number(r.attempts),
  interrupted: Number(r.interrupted),
  ...(r.error ? { error: String(r.error) } : {}),
  ...(r.result ? { result: String(r.result) } : {}),
  clipIds: JSON.parse(String(r.clip_ids ?? '[]')),
  ...(r.arm ? { arm: String(r.arm) } : {}),
  createdAt: String(r.created_at),
  ...(r.started_at ? { startedAt: String(r.started_at) } : {}),
  ...(r.finished_at ? { finishedAt: String(r.finished_at) } : {}),
});

/** Add a job. False when the same kind of job for the same video and moment is already queued or running. */
export function insertJob(j: Pick<WatchJob, 'id' | 'kind' | 'creator' | 'videoId'> & Partial<WatchJob>): boolean {
  const r = db()
    .prepare(
      `INSERT OR IGNORE INTO watch_jobs (job_id, kind, creator, topic, tier, video_id, moment_id, url, from_ms, to_ms, state, stage, stage_data, attempts, interrupted, error, result, clip_ids, arm, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      j.id, j.kind, j.creator, j.topic ?? null, j.tier ?? 1, j.videoId, j.momentId ?? null, j.url ?? null, j.fromMs ?? null, j.toMs ?? null,
      j.state ?? 'queued', j.stage ?? null, j.stageData ? JSON.stringify(j.stageData) : null, j.attempts ?? 0, j.interrupted ?? 0,
      j.error ?? null, j.result ?? null, JSON.stringify(j.clipIds ?? []), j.arm ?? null, j.createdAt ?? now(), j.startedAt ?? null, j.finishedAt ?? null,
    );
  return Number(r.changes) === 1;
}

export function getJob(id: string): WatchJob | undefined {
  const r = db().prepare('SELECT * FROM watch_jobs WHERE job_id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toJob(r) : undefined;
}

export function listJobs(o: { states?: JobState[]; kind?: JobKind; limit?: number } = {}): WatchJob[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (o.states?.length) (where.push(`state IN (${o.states.map(() => '?').join(', ')})`), args.push(...o.states));
  if (o.kind) (where.push('kind = ?'), args.push(o.kind));
  const sql = `SELECT * FROM watch_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC ${o.limit ? `LIMIT ${Math.floor(o.limit)}` : ''}`;
  return (db().prepare(sql).all(...args) as Record<string, unknown>[]).map(toJob);
}

/** Remove a job that has not started (a waiting moment giving its place to a higher tier). */
export function dropQueued(id: string): boolean {
  return Number(db().prepare("DELETE FROM watch_jobs WHERE job_id = ? AND state = 'queued'").run(id).changes) === 1;
}

/** Take the next job (by hand, listed creators, topics; oldest first) for `worker`, in one transaction. */
export function claimNext(worker: string, leaseMs: number): WatchJob | undefined {
  const d = db();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = d.prepare("SELECT * FROM watch_jobs WHERE state = 'queued' ORDER BY tier, created_at LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!r) {
      d.exec('COMMIT');
      return undefined;
    }
    const at = now();
    d.prepare("UPDATE watch_jobs SET state = 'running', claimed_by = ?, lease_until = ?, started_at = ? WHERE job_id = ? AND state = 'queued'").run(
      worker, new Date(Date.now() + leaseMs).toISOString(), at, String(r.job_id),
    );
    d.exec('COMMIT');
    return getJob(String(r.job_id));
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** Keep the claim alive. False when the job is no longer this worker's (its lease ran out and it was put back). */
export function renewLease(id: string, worker: string, leaseMs: number): boolean {
  return (
    Number(
      db().prepare("UPDATE watch_jobs SET lease_until = ? WHERE job_id = ? AND claimed_by = ? AND state = 'running'").run(new Date(Date.now() + leaseMs).toISOString(), id, worker).changes,
    ) === 1
  );
}

/** Record that a stage finished, with what it made. Fenced: only the worker holding the claim can. */
export function saveStage(id: string, worker: string, stage: string, data: Record<string, unknown>): boolean {
  const old = getJob(id);
  const merged = { ...(old?.stageData ?? {}), ...data };
  return Number(db().prepare("UPDATE watch_jobs SET stage = ?, stage_data = ? WHERE job_id = ? AND claimed_by = ? AND state = 'running'").run(stage, JSON.stringify(merged), id, worker).changes) === 1;
}

/**
 * End this worker's claim: done or failed with the result, or back in line (`queued`, keeping the
 * checkpoint) for a retry or an interruption. Fenced: false if the claim was lost, and nothing is written.
 */
export function finishJob(
  id: string,
  worker: string,
  o: { state: JobState; result?: string; error?: string; clipIds?: string[]; attempts?: number; interrupted?: number },
): boolean {
  const end = o.state === 'done' || o.state === 'failed';
  return (
    Number(
      db()
        .prepare(
          `UPDATE watch_jobs SET state = ?, result = COALESCE(?, result), error = ?, clip_ids = COALESCE(?, clip_ids), attempts = COALESCE(?, attempts), interrupted = COALESCE(?, interrupted),
             claimed_by = NULL, lease_until = NULL, started_at = CASE WHEN ? THEN started_at ELSE NULL END, finished_at = ?
           WHERE job_id = ? AND claimed_by = ? AND state = 'running'`,
        )
        .run(o.state, o.result ?? null, o.error ?? null, o.clipIds ? JSON.stringify(o.clipIds) : null, o.attempts ?? null, o.interrupted ?? null, end ? 1 : 0, end ? now() : null, id, worker).changes,
    ) === 1
  );
}

/**
 * Running jobs whose worker is gone go back in line, checkpoint kept: the lease ran out, or the
 * worker's process is not alive (`alive`). Returns them.
 */
export function requeueStale(alive: (worker: string) => boolean): WatchJob[] {
  const t = Date.now();
  const stale = listJobs({ states: ['running'] }).filter((j) => !j.claimedBy || !alive(j.claimedBy) || (j.leaseUntil && Date.parse(j.leaseUntil) < t));
  for (const j of stale)
    db()
      .prepare("UPDATE watch_jobs SET state = 'queued', claimed_by = NULL, lease_until = NULL, started_at = NULL, interrupted = interrupted + 1 WHERE job_id = ? AND state = 'running' AND IFNULL(claimed_by, '') = ?")
      .run(j.id, j.claimedBy ?? '');
  return stale;
}

/** A worker id carries its pid, so a dead worker's claims are found at once, not only when the lease runs out. */
export const workerId = (name: string) => `${name}:${process.pid}`;
export function workerAlive(worker: string): boolean {
  const pid = Number(worker.split(':').pop());
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Moment jobs per trial arm (every state but a dropped one): what keeps the arms even. */
export function armCounts(): Record<string, number> {
  const rows = db().prepare("SELECT arm, COUNT(*) AS n FROM watch_jobs WHERE kind = 'twitch-moment' AND arm IS NOT NULL GROUP BY arm").all() as { arm: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.arm, Number(r.n)]));
}
