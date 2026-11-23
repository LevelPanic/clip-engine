// The review ledger as a database, for the automation: every clip the review page sees, every
// approve/reject, and whether the upload cron has already picked it. The JSON project keeps the
// review state the Studio uses; this table is the operational queue between review and upload.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from '../core/paths';
import { addColumns, openDatabase } from '../core/sqlite';

export type ReviewStatus = 'review' | 'approved' | 'rejected' | 'changes' | 'editing';

export interface ReviewRow {
  clipId: string;
  videoId: string;
  title: string;
  status: ReviewStatus;
  note: string | null;
  decisionAt: string;
  picked: number;
  pickedAt: string | null;
  /**
   * `held`: the scheduler's current clip, refused by a YouTube limit or a passing error; it is tried again until it uploads.
   * `deferred`: held for the careful period (channel.json → careful); it goes back in line when the period ends.
   */
  uploadStatus: 'pending' | 'uploading' | 'held' | 'uploaded' | 'failed' | 'blocked-title' | 'blocked-auth' | 'deferred' | null;
  /** Upload tries the scheduler made for this approval, the last one's time, and what YouTube said if it was refused. */
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  youtubeUrl: string | null;
  publishAt: string | null;
  /** 18+ (age-restricted on YouTube), as the reviewer decided; null for decisions made before the check. */
  adult: boolean | null;
  createdAt: string;
  updatedAt: string;
}

let db: DatabaseSync | undefined;

export function reviewsDb(): DatabaseSync {
  if (db) return db;
  db = openDatabase(path.join(paths.library, 'reviews.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      clip_id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      decision_at TEXT NOT NULL,
      picked INTEGER NOT NULL DEFAULT 0,
      picked_at TEXT,
      upload_status TEXT,
      youtube_url TEXT,
      publish_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reviews_queue ON reviews(status, picked, decision_at);
  `);
  addColumns(db, 'reviews', { attempts: 'INTEGER NOT NULL DEFAULT 0', last_attempt_at: 'TEXT', last_error: 'TEXT', adult: 'INTEGER' });
  return db;
}

/** Insert or update the review row. An approval resets `picked` so the upload cron can take it. */
export function recordReview(o: { clipId: string; videoId: string; title: string; status: ReviewStatus; note?: string; at?: string; adult?: boolean }) {
  const at = o.at ?? new Date().toISOString();
  const d = reviewsDb();
  const approved = o.status === 'approved';
  d.prepare(
    `INSERT INTO reviews (clip_id, video_id, title, status, note, decision_at, picked, upload_status, adult, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?)
     ON CONFLICT(clip_id) DO UPDATE SET
       video_id = excluded.video_id,
       title = excluded.title,
       status = excluded.status,
       note = excluded.note,
       decision_at = excluded.decision_at,
       adult = excluded.adult,
       picked = CASE WHEN excluded.status = 'approved' THEN 0 ELSE reviews.picked END,
       upload_status = CASE WHEN excluded.status = 'approved' THEN 'pending' ELSE reviews.upload_status END,
       updated_at = excluded.updated_at`,
  ).run(o.clipId, o.videoId, o.title, o.status, o.note ?? null, at, o.adult === undefined ? null : o.adult ? 1 : 0, at, at);
  return approved;
}

export function listReviews(status?: ReviewStatus): ReviewRow[] {
  const d = reviewsDb();
  const rows = status
    ? (d.prepare('SELECT * FROM reviews WHERE status = ? ORDER BY decision_at DESC').all(status) as Record<string, unknown>[])
    : (d.prepare('SELECT * FROM reviews ORDER BY decision_at DESC').all() as Record<string, unknown>[]);
  return rows.map((r) => ({
    clipId: String(r.clip_id),
    videoId: String(r.video_id),
    title: String(r.title),
    status: String(r.status) as ReviewStatus,
    note: r.note ? String(r.note) : null,
    decisionAt: String(r.decision_at),
    picked: Number(r.picked),
    pickedAt: r.picked_at ? String(r.picked_at) : null,
    uploadStatus: r.upload_status ? (String(r.upload_status) as ReviewRow['uploadStatus']) : null,
    youtubeUrl: r.youtube_url ? String(r.youtube_url) : null,
    publishAt: r.publish_at ? String(r.publish_at) : null,
    adult: r.adult === null || r.adult === undefined ? null : Number(r.adult) === 1,
    attempts: Number(r.attempts ?? 0),
    lastAttemptAt: r.last_attempt_at ? String(r.last_attempt_at) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

/**
 * The clip the upload scheduler is on: the one it already holds (picked, still uploading or held by a
 * YouTube limit) until it uploads; otherwise the oldest approval it has not picked, marked picked. A
 * clip taken back out of `approved` (rejected, sent for changes) stops being the current one.
 */
export function pickApproved(): ReviewRow | null {
  const d = reviewsDb();
  const current = d
    .prepare("SELECT clip_id FROM reviews WHERE status = 'approved' AND picked = 1 AND upload_status IN ('uploading', 'held') ORDER BY picked_at LIMIT 1")
    .get() as { clip_id: string } | undefined;
  if (current) return listReviews().find((r) => r.clipId === current.clip_id) ?? null;
  const row = d.prepare("SELECT * FROM reviews WHERE status = 'approved' AND picked = 0 ORDER BY decision_at LIMIT 1").get() as Record<string, unknown> | undefined;
  if (!row) return null;
  const at = new Date().toISOString();
  d.prepare("UPDATE reviews SET picked = 1, picked_at = ?, upload_status = 'uploading', updated_at = ? WHERE clip_id = ?").run(at, at, String(row.clip_id));
  return listReviews().find((r) => r.clipId === String(row.clip_id)) ?? null;
}

/** Hold an approved clip for its title (the auto-generated placeholder, or a sexual word); fixing the title requeues it. */
export function blockTitle(clipId: string, why = 'placeholder title; edit the title and it uploads automatically') {
  const d = reviewsDb();
  const at = new Date().toISOString();
  d.prepare(
    "UPDATE reviews SET picked = 1, picked_at = COALESCE(picked_at, ?), upload_status = 'blocked-title', note = COALESCE(note, '') || ?, updated_at = ? WHERE clip_id = ?",
  ).run(at, `\n[gate] ${why}`, at, clipId);
}

/** Hold an approval because the YouTube login expired: not the clip's fault, so not a failure. The cron releases it once the login works. */
export function blockAuth(clipId: string) {
  const d = reviewsDb();
  const at = new Date().toISOString();
  d.prepare(
    "UPDATE reviews SET picked = 1, picked_at = COALESCE(picked_at, ?), upload_status = 'blocked-auth', note = COALESCE(note, '') || ?, updated_at = ? WHERE clip_id = ?",
  ).run(at, '\n[gate] the YouTube login expired: run ./clip auth youtube, and uploads resume by themselves', at, clipId);
}

/** Hold an approval for the careful period: not a failure, and not the line's current clip; it goes back in line when the period ends. */
export function deferPick(clipId: string, why: string) {
  const d = reviewsDb();
  const at = new Date().toISOString();
  d.prepare(
    "UPDATE reviews SET picked = 1, picked_at = COALESCE(picked_at, ?), upload_status = 'deferred', note = COALESCE(note, '') || ?, updated_at = ? WHERE clip_id = ?",
  ).run(at, `\n[gate] ${why}`, at, clipId);
}

/** One upload try is starting: counted, with its time. Returns the try number. */
export function noteAttempt(clipId: string): number {
  const d = reviewsDb();
  const at = new Date().toISOString();
  d.prepare("UPDATE reviews SET attempts = attempts + 1, last_attempt_at = ?, upload_status = 'uploading', updated_at = ? WHERE clip_id = ?").run(at, at, clipId);
  return Number((d.prepare('SELECT attempts FROM reviews WHERE clip_id = ?').get(clipId) as { attempts: number } | undefined)?.attempts ?? 0);
}

/** The try was refused by a YouTube limit or a passing error: the clip stays the scheduler's current one. */
export function holdPick(clipId: string, error: string) {
  const d = reviewsDb();
  const at = new Date().toISOString();
  d.prepare("UPDATE reviews SET upload_status = 'held', last_error = ?, updated_at = ? WHERE clip_id = ?").run(error, at, clipId);
}

/** Put a picked approval back in the queue without calling it a failure (Retry upload, a fixed title, the login back). */
export function releasePick(clipId: string) {
  const d = reviewsDb();
  const at = new Date().toISOString();
  d.prepare("UPDATE reviews SET picked = 0, picked_at = NULL, upload_status = 'pending', updated_at = ? WHERE clip_id = ?").run(at, clipId);
}

export function markUploaded(clipId: string, o: { youtubeUrl: string; publishAt: string }) {
  const d = reviewsDb();
  const at = new Date().toISOString();
  d.prepare("UPDATE reviews SET upload_status = 'uploaded', youtube_url = ?, publish_at = ?, last_error = NULL, updated_at = ? WHERE clip_id = ?").run(o.youtubeUrl, o.publishAt, at, clipId);
}

export function markFailed(clipId: string, note: string) {
  const d = reviewsDb();
  const at = new Date().toISOString();
  d.prepare("UPDATE reviews SET upload_status = 'failed', last_error = ?, note = COALESCE(note, '') || ? , updated_at = ? WHERE clip_id = ?").run(note.slice(0, 500), `\n[upload] ${note}`, at, clipId);
}

/** Remove a clip from the operational queue (the feedback log keeps the rejection history). */
export function deleteReview(clipId: string) {
  reviewsDb().prepare('DELETE FROM reviews WHERE clip_id = ?').run(clipId);
}
