#!/usr/bin/env tsx
// Hourly cleanup:
//   1. Rejected clips past the grace period: delete the clip project, its exports, and the review
//      row. The feedback log keeps the rejection for learning.
//   2. Source streams that are fully analysed and no longer referenced by an active review, queue
//      job, or render job: delete the heavy media (audio/sections/video) and keep the small metadata,
//      transcript, chat and candidate files. SOURCE_DELETE=all removes the whole source directory.
//
//   npx tsx tools/cleanup.ts --once
//   npx tsx tools/cleanup.ts --daemon
//   npx tsx tools/cleanup.ts --dry-run
//
// Env: CLEANUP_MIN=60, REJECTED_GRACE_MIN=60, SOURCE_GRACE_HOURS=24, SOURCE_DELETE=media|all.
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJsonIf } from '../src/core/paths';
import { listReviews, deleteReview } from '../src/review/db';
import { listJobs } from '../src/jobs/queue';
import { listJobs as listWatchJobs } from '../src/track/jobs';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const ONCE = has('--once');
const DRY = has('--dry-run');
const DAEMON = has('--daemon');
const CLEANUP_MIN = Number(process.env.CLEANUP_MIN ?? 60);
const REJECTED_GRACE_MIN = Number(process.env.REJECTED_GRACE_MIN ?? 60);
const SOURCE_GRACE_HOURS = Number(process.env.SOURCE_GRACE_HOURS ?? 24);
const SOURCE_DELETE = process.env.SOURCE_DELETE === 'all' ? 'all' : 'media';
const log = (s: string) => console.log(`${new Date().toISOString()}  ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function audit(entry: Record<string, unknown>) {
  fs.mkdirSync(paths.library, { recursive: true });
  fs.appendFileSync(path.join(paths.library, 'cleanup.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

function deleteClipFiles(id: string) {
  const project = path.join(paths.clips, id);
  if (fs.existsSync(project)) fs.rmSync(project, { recursive: true, force: true });
  if (!fs.existsSync(paths.exports)) return;
  for (const f of fs.readdirSync(paths.exports)) {
    if (f === id || f.startsWith(`${id}.`)) fs.rmSync(path.join(paths.exports, f), { force: true });
  }
}

function sweepRejected(): number {
  const cutoff = Date.now() - REJECTED_GRACE_MIN * 60_000;
  const rejected = listReviews('rejected');
  const live = new Set(rejected.map((r) => r.clipId));
  let n = 0;
  for (const r of rejected) {
    if (Date.parse(r.decisionAt) > cutoff) continue;
    if (!live.has(r.clipId)) continue;
    if (DRY) {
      log(`[dry] would delete rejected ${r.clipId} — ${r.title}`);
      n++;
      continue;
    }
    deleteClipFiles(r.clipId);
    deleteReview(r.clipId);
    audit({ action: 'rejected-clip', clipId: r.clipId, videoId: r.videoId, title: r.title });
    log(`deleted rejected ${r.clipId} — ${r.title}`);
    n++;
  }
  return n;
}

const ANALYSIS_FILES = ['scan.json', 'candidates.json', 'transcript.json'];
const ACTIVITY_FILES = ['meta.json', 'scan.json', 'candidates.json', 'transcript.json', 'signals.json', 'chat.json', 'info.json', 'audio', 'sections'];

function hasAnalysis(dir: string) {
  return ANALYSIS_FILES.some((f) => fs.existsSync(path.join(dir, f)));
}

function newestActivity(dir: string): number {
  let max = 0;
  for (const f of ACTIVITY_FILES) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    try {
      max = Math.max(max, fs.statSync(p).mtimeMs);
    } catch {
      // A file can disappear between exists and stat; ignore it.
    }
  }
  return max;
}

function removeMedia(dir: string): boolean {
  let removed = false;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const ext = path.extname(f).toLowerCase();
    const heavy =
      f === 'audio' ||
      f === 'sections' ||
      f.startsWith('audio.tmp-') ||
      f.startsWith('sections.tmp-') ||
      f.startsWith('audio.') ||
      f.startsWith('sections.') ||
      ['.mp4', '.mkv', '.webm', '.m4a', '.ts', '.flv'].includes(ext);
    if (!heavy) continue;
    if (DRY) {
      log(`[dry] would remove ${p}`);
      removed = true;
      continue;
    }
    fs.rmSync(p, { recursive: true, force: true });
    removed = true;
  }
  return removed;
}

function sweepSources(): number {
  if (!fs.existsSync(paths.library)) return 0;
  // a clip waiting for a decision or an upload needs its footage (a change means a re-render); one that is
  // already on YouTube does not. Counting uploaded approvals as active kept every posted stream's
  // gigabytes forever (17.9 GB of footage with the disk at 97%, 2026-11-18).
  const activeReviews = new Set(
    listReviews()
      .filter((r) => r.status === 'review' || r.status === 'changes' || (r.status === 'approved' && r.uploadStatus !== 'uploaded'))
      .map((r) => r.videoId),
  );
  const activeJobs = new Set(listJobs({ states: ['queued', 'running'] }).map((j) => j.videoId).filter((v): v is string => !!v));
  // the watchlist's jobs (the tracker's job table): a video with a moment queued or running keeps its footage
  for (const j of listWatchJobs({ states: ['queued', 'running'] })) activeJobs.add(j.videoId);

  const cutoff = Date.now() - SOURCE_GRACE_HOURS * 3600_000;
  let n = 0;
  for (const name of fs.readdirSync(paths.library)) {
    const dir = path.join(paths.library, name);
    if (!fs.statSync(dir).isDirectory() || name.startsWith('.')) continue;
    if (activeReviews.has(name) || activeJobs.has(name)) continue;
    if (!hasAnalysis(dir)) continue;
    const last = newestActivity(dir);
    if (!last || last > cutoff) continue;
    if (!removeMedia(dir)) continue;
    if (DRY) {
      log(`[dry] would clean source ${name} (${SOURCE_DELETE})`);
      n++;
      continue;
    }
    if (SOURCE_DELETE === 'all') fs.rmSync(dir, { recursive: true, force: true });
    audit({ action: SOURCE_DELETE === 'all' ? 'source-all' : 'source-media', videoId: name });
    log(`cleaned source ${name} (${SOURCE_DELETE})`);
    n++;
  }
  return n;
}

async function runOnce() {
  const rejected = sweepRejected();
  const sources = sweepSources();
  log(`sweep complete: ${rejected} rejected clip${rejected === 1 ? '' : 's'}, ${sources} source${sources === 1 ? '' : 's'}`);
}

if (ONCE || DRY) {
  await runOnce();
} else if (DAEMON) {
  log(`cleanup: rejected clips and safe sources every ${CLEANUP_MIN}m${DRY ? ' (dry)' : ''}`);
  for (;;) {
    await runOnce();
    await sleep(CLEANUP_MIN * 60_000);
  }
} else {
  console.log('usage: cleanup.ts --once | --daemon | --dry-run');
  process.exit(2);
}
