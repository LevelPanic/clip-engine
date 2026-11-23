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
import { isHeavyMedia, rejectedToDelete, sourceMayGo, videosInUse } from '../src/pipeline/cleanup';
import { setting } from '../src/core/config';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const ONCE = has('--once');
const DRY = has('--dry-run');
const DAEMON = has('--daemon');
const CLEANUP_MIN = setting('CLEANUP_MIN');
const REJECTED_GRACE_MIN = setting('REJECTED_GRACE_MIN');
const SOURCE_GRACE_HOURS = setting('SOURCE_GRACE_HOURS');
const SOURCE_DELETE = setting('SOURCE_DELETE');
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
  let n = 0;
  for (const r of rejectedToDelete(listReviews('rejected'), Date.now(), REJECTED_GRACE_MIN)) {
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
    if (!isHeavyMedia(f)) continue;
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
  // the rules are src/pipeline/cleanup.ts: a clip waiting for a decision, changes or an upload, or a job
  // queued or running (the Studio's or the watchlist's), keeps its source's footage
  const inUse = videosInUse(listReviews(), [
    ...listJobs({ states: ['queued', 'running'] }).map((j) => j.videoId),
    ...listWatchJobs({ states: ['queued', 'running'] }).map((j) => j.videoId),
  ]);
  const now = Date.now();
  let n = 0;
  for (const name of fs.readdirSync(paths.library)) {
    const dir = path.join(paths.library, name);
    if (!fs.statSync(dir).isDirectory() || name.startsWith('.')) continue;
    if (!sourceMayGo({ videoId: name, inUse, analysed: hasAnalysis(dir), lastActivityMs: newestActivity(dir), now, graceHours: SOURCE_GRACE_HOURS })) continue;
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
