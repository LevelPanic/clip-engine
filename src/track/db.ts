// What we know about every stream and every moment in it, in one place (library/tracking.sqlite):
// whose stream it is, when it ran, whether it is live; the moments the community picked out of it
// (src/scan/moments.ts) and what became of each one. The watchlist works from this: the next job is
// the next moment, not the next 20 minutes of somebody's stream. `clip streams` and the status page
// read it.
//
// Wrong content is recorded, not just avoided: a test stream, a rerun, a subscriber-only broadcast or
// a gambling chapter gets `skipped` with the reason, so nothing runs on it and anyone can see why.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from '../core/paths';
import { duplicatesOf, planMoments, type KnownMoment, type RankedMoment } from '../scan/moments';
import { normalize, type Span } from './coverage';

export type StreamStatus = 'tracking' | 'done' | 'skipped';
export type MomentStatus = 'pending' | 'queued' | 'working' | 'clipped' | 'no-clip' | 'skipped' | 'failed' | 'covered';

export interface StreamRow {
  videoId: string;
  platform: 'twitch' | 'youtube';
  creator: string;
  login: string | null;
  title: string;
  game: string | null;
  /** Where we found it, the one that sets its tier: by hand, else a listed creator, else a topic. */
  source: string;
  /** Every list that found it (a creator check and two topics are one stream with three sources). */
  sources: string[];
  live: boolean;
  startedAt: string | null;
  durationMs: number;
  status: StreamStatus;
  skipReason: string | null;
  viewerClips: number;
  rankedAt: string | null;
  updatedAt: string;
}

export interface MomentRow {
  videoId: string;
  momentId: string;
  peakMs: number;
  fromMs: number;
  toMs: number;
  windowFromMs: number;
  windowToMs: number;
  score: number;
  views: number;
  clippers: number;
  laughers: number;
  titles: string[];
  why: string[];
  status: MomentStatus;
  note: string | null;
  clipIds: string[];
  /** `covered`: the moment that already has these seconds (the same moment, or its window). */
  coveredBy: string | null;
  /** Position in its stream under the current ranking (combined score) and the shadow one (alternating). */
  rank: number | null;
  altRank: number | null;
  updatedAt: string;
}

let db: DatabaseSync | undefined;

export function trackingDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(paths.library, { recursive: true });
  db = new DatabaseSync(path.join(paths.library, 'tracking.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS streams (
      video_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      creator TEXT NOT NULL,
      login TEXT,
      title TEXT NOT NULL,
      game TEXT,
      source TEXT NOT NULL,
      live INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'tracking',
      skip_reason TEXT,
      viewer_clips INTEGER NOT NULL DEFAULT 0,
      ranked_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS moments (
      video_id TEXT NOT NULL,
      moment_id TEXT NOT NULL,
      peak_ms INTEGER NOT NULL,
      from_ms INTEGER NOT NULL,
      to_ms INTEGER NOT NULL,
      window_from_ms INTEGER NOT NULL,
      window_to_ms INTEGER NOT NULL,
      score REAL NOT NULL,
      views INTEGER NOT NULL DEFAULT 0,
      clippers INTEGER NOT NULL DEFAULT 0,
      laughers INTEGER NOT NULL DEFAULT 0,
      titles TEXT NOT NULL DEFAULT '[]',
      why TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      clip_ids TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (video_id, moment_id)
    );
    CREATE INDEX IF NOT EXISTS moments_status ON moments(status, score);
  `);
  // added 2026-11-19: every source that found a stream, not just the one that sets its tier
  const cols = (db.prepare('PRAGMA table_info(streams)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('sources')) {
    db.exec(`ALTER TABLE streams ADD COLUMN sources TEXT NOT NULL DEFAULT '[]'`);
    db.exec(`UPDATE streams SET sources = json_array(source)`);
  }
  // added 2026-11-19: moment identity (covered_by) and the shadow ranker (rank, alt_rank)
  const mcols = (db.prepare('PRAGMA table_info(moments)').all() as { name: string }[]).map((c) => c.name);
  if (!mcols.includes('covered_by')) db.exec('ALTER TABLE moments ADD COLUMN covered_by TEXT');
  if (!mcols.includes('rank')) db.exec('ALTER TABLE moments ADD COLUMN rank INTEGER');
  if (!mcols.includes('alt_rank')) db.exec('ALTER TABLE moments ADD COLUMN alt_rank INTEGER');
  // added 2026-11-19: the coverage ledger (src/track/coverage.ts), per stream and layer
  db.exec(`
    CREATE TABLE IF NOT EXISTS coverage (
      video_id TEXT NOT NULL,
      layer TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      state TEXT NOT NULL,
      job_id TEXT,
      reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS coverage_stream ON coverage(video_id, layer);
  `);
  return db;
}

const now = () => new Date().toISOString();

const toStream = (r: Record<string, unknown>): StreamRow => ({
  videoId: String(r.video_id),
  platform: String(r.platform) as StreamRow['platform'],
  creator: String(r.creator),
  login: r.login ? String(r.login) : null,
  title: String(r.title),
  game: r.game ? String(r.game) : null,
  source: String(r.source),
  sources: JSON.parse(String(r.sources ?? '[]')),
  live: !!r.live,
  startedAt: r.started_at ? String(r.started_at) : null,
  durationMs: Number(r.duration_ms),
  status: String(r.status) as StreamStatus,
  skipReason: r.skip_reason ? String(r.skip_reason) : null,
  viewerClips: Number(r.viewer_clips),
  rankedAt: r.ranked_at ? String(r.ranked_at) : null,
  updatedAt: String(r.updated_at),
});

const toMoment = (r: Record<string, unknown>): MomentRow => ({
  videoId: String(r.video_id),
  momentId: String(r.moment_id),
  peakMs: Number(r.peak_ms),
  fromMs: Number(r.from_ms),
  toMs: Number(r.to_ms),
  windowFromMs: Number(r.window_from_ms),
  windowToMs: Number(r.window_to_ms),
  score: Number(r.score),
  views: Number(r.views),
  clippers: Number(r.clippers),
  laughers: Number(r.laughers),
  titles: JSON.parse(String(r.titles)),
  why: JSON.parse(String(r.why)),
  status: String(r.status) as MomentStatus,
  note: r.note ? String(r.note) : null,
  clipIds: JSON.parse(String(r.clip_ids)),
  coveredBy: r.covered_by ? String(r.covered_by) : null,
  rank: r.rank == null ? null : Number(r.rank),
  altRank: r.alt_rank == null ? null : Number(r.alt_rank),
  updatedAt: String(r.updated_at),
});

/** Insert or refresh a stream. Its status and skip reason are kept unless given. */
export function upsertStream(s: Omit<StreamRow, 'updatedAt' | 'status' | 'skipReason' | 'rankedAt' | 'viewerClips' | 'sources'> & Partial<Pick<StreamRow, 'status' | 'skipReason' | 'viewerClips'>>) {
  const d = trackingDb();
  const at = now();
  // one stream, however many lists found it: its sources add up, and the best one sets its tier
  const old = d.prepare('SELECT source, sources FROM streams WHERE video_id = ?').get(s.videoId) as { source: string; sources: string } | undefined;
  const sources = [...new Set([...(old ? (JSON.parse(old.sources) as string[]) : []), ...(old ? [old.source] : []), s.source])];
  const source = sources.reduce((best, x) => (tierOf(x) < tierOf(best) ? x : best), s.source);
  d.prepare(
    `INSERT INTO streams (video_id, platform, creator, login, title, game, source, sources, live, started_at, duration_ms, status, skip_reason, viewer_clips, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET
       creator = excluded.creator, login = excluded.login, title = excluded.title, game = excluded.game,
       live = excluded.live, started_at = COALESCE(excluded.started_at, streams.started_at),
       duration_ms = MAX(excluded.duration_ms, streams.duration_ms),
       source = excluded.source, sources = excluded.sources,
       status = COALESCE(?, streams.status), skip_reason = CASE WHEN ? IS NULL THEN streams.skip_reason ELSE ? END,
       viewer_clips = COALESCE(?, streams.viewer_clips),
       updated_at = excluded.updated_at`,
  ).run(
    s.videoId, s.platform, s.creator, s.login, s.title, s.game, source, JSON.stringify(sources), s.live ? 1 : 0, s.startedAt, s.durationMs,
    s.status ?? 'tracking', s.skipReason ?? null, s.viewerClips ?? 0, at,
    s.status ?? null, s.status ?? null, s.skipReason ?? null, s.viewerClips ?? null,
  );
}

export function setStreamStatus(videoId: string, status: StreamStatus, reason?: string) {
  trackingDb().prepare('UPDATE streams SET status = ?, skip_reason = ?, updated_at = ? WHERE video_id = ?').run(status, reason ?? null, now(), videoId);
}

export function getStream(videoId: string): StreamRow | undefined {
  const r = trackingDb().prepare('SELECT * FROM streams WHERE video_id = ?').get(videoId) as Record<string, unknown> | undefined;
  return r ? toStream(r) : undefined;
}

export function listStreams(o: { status?: StreamStatus; sinceMs?: number } = {}): StreamRow[] {
  const rows = (o.status ? trackingDb().prepare('SELECT * FROM streams WHERE status = ? ORDER BY started_at DESC').all(o.status) : trackingDb().prepare('SELECT * FROM streams ORDER BY started_at DESC').all()) as Record<string, unknown>[];
  return rows.map(toStream).filter((s) => !o.sinceMs || !s.startedAt || Date.parse(s.startedAt) >= o.sinceMs);
}

/**
 * Record the ranked moments of a stream. A new moment comes in `pending`; one we know keeps its status
 * (a clipped moment is not reopened because its views went up). `skip` marks a moment that must not
 * run (a gambling chapter), with the reason.
 */
export function upsertMoments(videoId: string, ms: RankedMoment[], viewerClips?: number) {
  const d = trackingDb();
  const at = now();
  const known = () => (d.prepare('SELECT * FROM moments WHERE video_id = ?').all(videoId) as Record<string, unknown>[]).map(toMoment) as (MomentRow & KnownMoment)[];
  const plan = planMoments(known(), ms);
  const ins = d.prepare(
    `INSERT INTO moments (video_id, moment_id, peak_ms, from_ms, to_ms, window_from_ms, window_to_ms, score, views, clippers, laughers, titles, why, status, note, covered_by, rank, alt_rank, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(video_id, moment_id) DO NOTHING`,
  );
  const numbers = d.prepare(
    'UPDATE moments SET score = ?, views = ?, clippers = ?, laughers = ?, titles = ?, why = ?, rank = ?, alt_rank = ?, updated_at = ? WHERE video_id = ? AND moment_id = ?',
  );
  const bounds = d.prepare('UPDATE moments SET peak_ms = ?, from_ms = ?, to_ms = ?, window_from_ms = ?, window_to_ms = ? WHERE video_id = ? AND moment_id = ?');
  const status = d.prepare('UPDATE moments SET status = ?, note = ? WHERE video_id = ? AND moment_id = ?');
  const cover = d.prepare("UPDATE moments SET status = 'covered', covered_by = ?, note = ?, updated_at = ? WHERE video_id = ? AND moment_id = ?");
  d.exec('BEGIN');
  try {
    for (const u of plan.update) {
      const m = u.m;
      numbers.run(m.score, m.views, m.clippers, m.laughers, JSON.stringify(m.titles), JSON.stringify(m.why), m.rank ?? null, m.altRank ?? null, at, videoId, u.momentId);
      if (u.bounds) bounds.run(m.peakMs, m.fromMs, m.toMs, m.window.startMs, m.window.endMs, videoId, u.momentId);
      if (u.status) status.run(u.status, u.note ?? null, videoId, u.momentId);
    }
    for (const x of plan.insert) {
      const m = x.m;
      ins.run(videoId, m.id, m.peakMs, m.fromMs, m.toMs, m.window.startMs, m.window.endMs, m.score, m.views, m.clippers, m.laughers, JSON.stringify(m.titles), JSON.stringify(m.why), x.status, x.note, x.coveredBy ?? null, m.rank ?? null, m.altRank ?? null, at);
    }
    // rows that were already duplicates (before matching existed) are folded in the same way
    for (const dup of duplicatesOf(known())) cover.run(dup.by, dup.why, at, videoId, dup.momentId);
    d.prepare('UPDATE streams SET ranked_at = ?, viewer_clips = COALESCE(?, viewer_clips), updated_at = ? WHERE video_id = ?').run(at, viewerClips ?? null, at, videoId);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function setMomentStatus(videoId: string, momentId: string, status: MomentStatus, o: { note?: string; clipIds?: string[] } = {}) {
  const d = trackingDb();
  d.prepare('UPDATE moments SET status = ?, note = COALESCE(?, note), clip_ids = COALESCE(?, clip_ids), updated_at = ? WHERE video_id = ? AND moment_id = ?').run(
    status, o.note ?? null, o.clipIds ? JSON.stringify(o.clipIds) : null, now(), videoId, momentId,
  );
}

export function listMoments(o: { videoId?: string; status?: MomentStatus } = {}): MomentRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (o.videoId) (where.push('video_id = ?'), args.push(o.videoId));
  if (o.status) (where.push('status = ?'), args.push(o.status));
  const rows = trackingDb().prepare(`SELECT * FROM moments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY score DESC`).all(...args) as Record<string, unknown>[];
  return rows.map(toMoment);
}

/** Moments a stream may still give (waiting or in progress), to cap how many one stream takes. */
const takenFrom = (videoId: string) =>
  Number((trackingDb().prepare("SELECT COUNT(*) AS n FROM moments WHERE video_id = ? AND status IN ('queued','working','clipped','no-clip','failed')").get(videoId) as { n: number }).n);

/**
 * The next moments to work on, across every stream we track. Each stream's best waiting moment comes
 * before any stream's second (so one huge streamer does not take every slot), biggest first within a
 * round; a stream gives at most `perStream` moments; skipped and done streams give none. Pure over the db.
 */
/** Which ranking orders a stream's own moments: `score` (the combined score, default) or `alternate` (the shadow one). */
export const momentRanker = () => (process.env.MOMENT_RANKER === 'alternate' ? 'alternate' : 'score');

/**
 * The blind ranker trial (2026-11-19): which moments a trial arm may pick. `score`: in a stream's top
 * `TRIAL_TOP` by the combined score but not by the shadow ranking; `alternate`: the reverse; `both`: in
 * both top lists (likely the best, kept in the rotation so the trial does not starve the channel). Each
 * arm's job costs the same (one moment, the same pipeline, one clip at most) and the review page never
 * says which arm picked a clip, so approvals per arm compare the rankings on new streams. Pure.
 */
export type TrialArm = 'score' | 'alternate' | 'both';
export const TRIAL_ARMS: TrialArm[] = ['score', 'alternate', 'both'];
export const TRIAL_TOP = Number(process.env.TRIAL_TOP ?? 4);
export const trialOn = () => process.env.RANKER_TRIAL !== '0';
export function inArm(m: Pick<MomentRow, 'rank' | 'altRank'>, arm: TrialArm, top = TRIAL_TOP): boolean {
  const s = (m.rank ?? 1e9) <= top;
  const a = (m.altRank ?? 1e9) <= top;
  return arm === 'score' ? s && !a : arm === 'alternate' ? a && !s : s && a;
}
/** The arm with the fewest jobs so far (ties in order: score, alternate, both), so the arms stay even. Pure. */
export function nextArm(counts: Partial<Record<TrialArm, number>>, available: TrialArm[] = TRIAL_ARMS): TrialArm | undefined {
  return [...available].sort((a, b) => (counts[a] ?? 0) - (counts[b] ?? 0) || TRIAL_ARMS.indexOf(a) - TRIAL_ARMS.indexOf(b))[0];
}

export function nextMoments(limit = 1, perStream = 4, arm?: TrialArm): MomentRow[] {
  const streams = new Map(listStreams({ status: 'tracking' }).map((s) => [s.videoId, s]));
  let pending = listMoments({ status: 'pending' }).filter((m) => streams.has(m.videoId));
  // an arm picks only its own moments, in its own ranking's order
  if (arm) pending = pending.filter((m) => inArm(m, arm));
  if (arm === 'alternate' || (!arm && momentRanker() === 'alternate')) pending.sort((a, b) => (a.altRank ?? 1e9) - (b.altRank ?? 1e9) || b.score - a.score);
  const rank = new Map<string, number>();
  const ordered = pending
    .map((m) => {
      const r = (rank.get(m.videoId) ?? takenFrom(m.videoId)) + 1;
      rank.set(m.videoId, r);
      return { m, r, t: tierOf(streams.get(m.videoId)!.source) };
    })
    .filter((x) => x.r <= perStream)
    .sort((a, b) => a.t - b.t || a.r - b.r || b.m.score - a.m.score);
  return ordered.slice(0, limit).map((x) => x.m);
}

/**
 * Whose moments go first: a stream added by hand (`clip track`: "do this one"), then the creators the
 * user listed (channels.json), then the topics, which fill the time the creators leave. Within a tier,
 * each stream's best before anyone's second.
 */
export const tierOf = (source: string): number => (source === 'manual' ? 0 : source.startsWith('topic:') ? 2 : 1);
export const TIER_NAMES = ['by hand', 'listed creator', 'topic'] as const;

/** Wrong content, by what a stream says about itself. Pure. */
export function wrongStream(s: { title: string; durationMs: number; live: boolean; login?: string | null }): string | undefined {
  if (/\btest stream\b|don'?t tune in|\btesting\b.*\bstream\b/i.test(s.title)) return 'a test stream';
  if (/\b(rerun|re-run|replay|vod(s)?)\b/i.test(s.title) && !/\blive\b/i.test(s.title)) return 'a rerun or a VOD replay';
  if (s.login && /(^|_)(vods?|reruns?|replays?|clips)$/i.test(s.login)) return 'a VOD or clip channel, not the creator';
  if (!s.live && s.durationMs < 20 * 60_000) return 'ended under 20 minutes';
  return undefined;
}

/** Categories we never clip, wherever the moment is. */
export const NEVER_CLIP = new Set(['slots', 'virtual casino', 'poker', 'blackjack', 'roulette'].map((s) => s.toLowerCase()));

/** Marks the moments in a chapter we never clip as skipped, with why. `categoryOf` gives a time's chapter. */
export function skipNeverClip<T extends { peakMs: number; skip?: string }>(moments: T[], categoryOf: (ms: number) => string | null | undefined): T[] {
  return moments.map((m) => {
    const cat = categoryOf(m.peakMs);
    return cat && NEVER_CLIP.has(cat.toLowerCase()) ? { ...m, skip: `a ${cat} chapter: never clipped` } : m;
  });
}

/** Coverage layers: `observe` (chat and viewer clips read), later `clip` (the expensive pass). */
export type CoverageLayer = 'observe' | 'clip';

export function loadCoverage(videoId: string, layer: CoverageLayer): Span[] {
  const rows = trackingDb().prepare('SELECT * FROM coverage WHERE video_id = ? AND layer = ? ORDER BY start_ms').all(videoId, layer) as Record<string, unknown>[];
  return rows.map((r) => ({
    startMs: Number(r.start_ms),
    endMs: Number(r.end_ms),
    state: String(r.state) as Span['state'],
    ...(r.job_id ? { jobId: String(r.job_id) } : {}),
    ...(r.reason ? { reason: String(r.reason) } : {}),
  }));
}

/** Replace a stream's ledger for a layer, in one transaction (readers never see half of it). */
export function saveCoverage(videoId: string, layer: CoverageLayer, spans: Span[]) {
  const d = trackingDb();
  const at = now();
  const ins = d.prepare('INSERT INTO coverage (video_id, layer, start_ms, end_ms, state, job_id, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM coverage WHERE video_id = ? AND layer = ?').run(videoId, layer);
    for (const s of normalize(spans)) ins.run(videoId, layer, s.startMs, s.endMs, s.state, s.jobId ?? null, s.reason ?? null, at);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** Read, change and save a ledger in one go. */
export function updateCoverage(videoId: string, layer: CoverageLayer, fn: (spans: Span[]) => Span[]): Span[] {
  const next = fn(loadCoverage(videoId, layer));
  saveCoverage(videoId, layer, next);
  return next;
}
