#!/usr/bin/env tsx
// The channel watchlist daemon. Twitch: it registers every creator's broadcast (channels.json) and a
// few trending topic streams (topics.json) in the tracker (library/tracking.sqlite, src/track/db.ts),
// ranks each one's moments from viewer clips and chat laughter (`clip moments`, src/scan/moments.ts),
// and works one moment per job: scan its few minutes, then the full pipeline (queue-check with the
// three experts -> extractor -> curator -> edit) with one clip at most. Each stream's best moment goes
// before any stream's second. YouTube creators: new uploads go through the quick one-judge /clip pass.
// It never approves or uploads; the review page and the upload cron do.
//
//   npx tsx tools/watchlist.ts --dry-run          # show what it would check/queue
//   npx tsx tools/watchlist.ts --once             # check once, queue jobs
//   npx tsx tools/watchlist.ts --worker --max 2   # process up to two queued jobs
//   npx tsx tools/watchlist.ts --daemon           # check, work, sleep, repeat
//
// State: library/watchlist-state.json. Jobs: the `watch_jobs` table in library/tracking.sqlite (src/track/jobs.ts).
// Page: library/watchlist-status.html (creators, live status, seen, queue, review/upload counts).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { paths, readJson, readJsonIf, writeJson } from '../src/core/paths';
import { loadCreators, type Creator } from '../src/core/creators';
import { fmtTime } from '../src/core/time';
import { YTDLP } from '../src/core/proc';
import { twitchApi } from '../src/ingest/twitch';
import { cli, reviseClip, runFullPipeline } from '../src/pipeline/full';
import { youtubeLive } from '../src/ingest/media';
import { revisionKey, revisionsToQueue } from '../src/track/revise';
import { isSubscriberOnly, unreadable } from '../src/track/rank';
import { runningObserver } from '../src/track/observer';
import { armCounts, claimNext, dropQueued, finishJob, insertJob, listJobs, renewLease, requeueStale, saveStage, workerAlive, workerId, type WatchJob } from '../src/track/jobs';
import { paint } from '../src/track/coverage';
import { listReviews } from '../src/review/db';
import { loadTopics, topicPicks, TOPIC_TOP, type TopicCandidate } from '../src/scan/topics';
import { loadChannel, optedOut } from '../src/core/channel';
import { getStream, listMoments, listStreams, nextArm, nextMoments, setMomentStatus, setStreamStatus, tierOf, TIER_NAMES, trialOn, TRIAL_ARMS, updateCoverage, upsertStream, wrongStream, type TrialArm } from '../src/track/db';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const opt = (f: string, d: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const CHECK_MIN = Number(process.env.CHECK_MIN ?? 15);
/** TOPICS=0 turns the topics off. */
const TOPICS = process.env.TOPICS !== '0';
/** One stream gives at most this many moments to the pipeline. */
const MOMENTS_PER_STREAM = Number(process.env.MOMENTS_PER_STREAM ?? 4);
const MIN_YT_MIN = Number(process.env.MIN_YT_MIN ?? 15);
const MAX_YT_STREAM_MIN = Number(process.env.MAX_YT_STREAM_MIN ?? 720);
const AUTO_EDITED = process.env.AUTO_EDITED === '1';
const AUTO_CLIPS = Number(process.env.AUTO_CLIPS ?? 3);
const NO_CLIPS = has('--no-clips');
const DRY = has('--dry-run');
const MAX_JOBS = Number(process.env.MAX_JOBS ?? opt('--max', '2'));
const log = (s: string) => console.log(`${new Date().toISOString()}  ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Seen = {
  kind: 'vod' | 'video';
  title?: string;
  at: string;
  scanned: [number, number][];
  status: 'queued' | 'scanned' | 'checked' | 'failed';
  note?: string;
};
type Live = { isLive: boolean; vodId?: string; title?: string; checkedAt: string };
type TopicState = {
  category: string;
  lastCheckedAt?: string;
  error?: string;
  /** English streams at or over the topic's minimum, and the biggest three, at the last check. */
  live?: number;
  top?: string[];
  /** Streams this topic took, by video id (with the streamer's login). */
  seen: Record<string, Seen & { login?: string }>;
};
type State = {
  updatedAt: string;
  creators: Record<string, { platform: string; handle: string; source?: string; content?: string; live?: Live; seen: Record<string, Seen>; baseline?: string[]; lastCheckedAt?: string; error?: string }>;
  topics?: Record<string, TopicState>;
  /** What the last check passed over, for the status page. */
  topicSkips?: { topic: string; login: string; viewers: number; why: string }[];
  /** The worker alternates: after a creator job, a waiting topic job goes next. */
  lastSource?: 'creator' | 'topic';
};
type Job = WatchJob;

const creators = loadCreators((why) => log(why));
const stateFile = path.join(paths.library, 'watchlist-state.json');
const state: State = readJsonIf<State>(stateFile) ?? { updatedAt: new Date().toISOString(), creators: {} };
const saveState = () => {
  state.updatedAt = new Date().toISOString();
  if (!DRY) writeJson(stateFile, state);
};
/** This daemon, as a worker on the job table; its pid lets a later daemon see it is gone. */
const WORKER = workerId('watchlist');
const LEASE_MS = 10 * 60_000;
const activeJobs = () => listJobs({ states: ['queued', 'running'] });
/** The job running now (a stop puts it back in line). */
let current: Job | undefined;
const entry = (c: Creator) => (state.creators[c.name] ??= { platform: c.platform, handle: c.handle, seen: {} });
/** A write to the tracker (library/tracking.sqlite); a dry run only reads. */
const track = (fn: () => void) => {
  if (!DRY) fn();
};
function enqueue(c: Pick<Creator, 'name'>, kind: Job['kind'], videoId: string, o: { url?: string; fromMs?: number; toMs?: number; topic?: string } = {}): boolean {
  const active = activeJobs();
  if (active.some((j) => j.videoId === videoId && j.kind === kind)) return true;
  // One active job per creator: each check can find the next unseen video, but the worker must not
  // fall behind a queue that grows by one job per creator every check.
  if (active.some((j) => j.creator === c.name)) return false;
  if (DRY) return true;
  const id = `${c.name}-${videoId}-${Date.now()}`;
  insertJob({ id, kind, creator: c.name, topic: o.topic, tier: 1, videoId, url: o.url, fromMs: o.fromMs, toMs: o.toMs });
  log(`queued ${kind} ${o.topic ? `[${o.topic}] ` : ''}${c.name} ${videoId}`);
  return true;
}

/** How far back a creator check looks: every broadcast live at any time in this window is tracked. */
const RECENT_HOURS = Number(process.env.RECENT_HOURS ?? 48);

async function checkTwitch(c: Creator) {
  const e = entry(c);
  e.platform = 'twitch';
  e.handle = c.handle;
  try {
    // every broadcast of the last RECENT_HOURS, not only the newest: a creator who streams twice in a
    // day has two, and the first must not depend on a check having seen it before the second began
    const { videos, liveWithoutVod } = await twitchApi().recentBroadcasts(c.handle, Date.now() - RECENT_HOURS * 3_600_000);
    e.lastCheckedAt = new Date().toISOString();
    const live = videos.find((v) => v.live);
    e.live = live ? { isLive: true, vodId: live.id, title: live.title, checkedAt: e.lastCheckedAt } : { isLive: liveWithoutVod, title: liveWithoutVod ? 'live, no VOD recorded: nothing to scan' : undefined, checkedAt: e.lastCheckedAt };
    for (const v of videos) {
      const id = `tw-${v.id}`;
      // the broadcast goes into the tracker; what gets clipped is decided by its moments (the observer ranks them)
      track(() => {
        const before = getStream(id);
        if (before?.status === 'done') return; // finished and closed: nothing to refresh
        upsertStream({ videoId: id, platform: 'twitch', creator: c.name, login: c.handle, title: v.title, game: v.game ?? null, source: `creator:${c.name}`, live: v.live, startedAt: v.createdAt, durationMs: v.lengthMs });
        const wrong = wrongStream({ title: v.title, durationMs: v.lengthMs, live: v.live, login: c.handle });
        if (wrong && before?.status !== 'skipped') {
          setStreamStatus(id, 'skipped', wrong);
          log(`skip ${c.name} ${id}: ${wrong}`);
        }
        if (!before) log(`tracking ${c.name} ${id}${v.live ? ' (live)' : ''}: ${v.title.slice(0, 70)}`);
      });
    }
  } catch (err) {
    e.error = (err as Error).message.split('\n')[0];
    log(`twitch ${c.handle}: ${e.error}`);
  }
}

function ytList(c: Creator, tab: 'videos' | 'streams'): { id: string; title: string; durationS?: number; liveStatus?: string }[] {
  const handle = c.handle.startsWith('@') ? c.handle : `@${c.handle}`;
  const [cmd, base] = YTDLP;
  const r = spawnSync(cmd, [...base, '--flat-playlist', '--playlist-end', '30', '--print', '%(id)s\t%(duration)s\t%(live_status)s\t%(title)s', `https://www.youtube.com/${handle}/${tab}`], { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error((r.stderr ?? '').split('\n').find(Boolean) ?? `yt-dlp exit ${r.status}`);
  return (r.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, dur, status, ...t] = line.split('\t');
      return { id, durationS: Number(dur) || undefined, liveStatus: status && status !== 'NA' ? status : undefined, title: t.join('\t') };
    })
    .filter((x) => /^[\w-]{11}$/.test(x.id));
}

function checkYouTube(c: Creator) {
  const e = entry(c);
  e.platform = 'youtube';
  e.handle = c.handle;
  try {
    // YouTube separates past broadcasts from uploads: /streams is the reliable stream tab, while
    // /videos is edited content (podcasts, films, vlogs). No duration guess can match that.
    const tab: 'videos' | 'streams' = c.source === 'streams' ? 'streams' : 'videos';
    const videos = ytList(c, tab);
    e.lastCheckedAt = new Date().toISOString();
    e.live = { isLive: false, checkedAt: e.lastCheckedAt };
    e.error = undefined;
    if (!videos.length) return;
    const now = new Date().toISOString();
    if (!e.baseline) {
      // First sight: keep the newest video as the starting point and baseline the back catalogue.
      // Without this, each check would queue the next-oldest unseen video and backfill the channel.
      e.baseline = videos.slice(1).map((v) => v.id);
      for (const v of videos.slice(1)) {
        e.seen[v.id] ??= { kind: 'video', title: v.title, at: now, scanned: [], status: 'checked', note: 'pre-existing upload' };
      }
    }
    for (const v of videos) {
      if (e.seen[v.id]) continue;
      if (e.baseline.includes(v.id)) {
        e.seen[v.id] = { kind: 'video', title: v.title, at: now, scanned: [], status: 'checked', note: 'pre-existing upload' };
        continue;
      }
      if (v.liveStatus === 'is_upcoming') {
        // Leave it unseen: the next check must see it again when it goes live.
        continue;
      }
      if (v.liveStatus === 'is_live' || v.liveStatus === 'post_live') {
        // Not while it is live: a live YouTube stream has no stable timeline, and every clip cut from
        // it came out as the same live minute (youtubeLive, src/ingest/media.ts). Leave it unseen; the
        // check after it ends takes the finished VOD.
        e.live = { isLive: true, vodId: v.id, title: v.title, checkedAt: e.lastCheckedAt };
        continue;
      }
      if (c.source !== 'streams' && v.durationS !== undefined && v.durationS < (c.minMinutes ?? MIN_YT_MIN) * 60) {
        e.seen[v.id] = { kind: 'video', title: v.title, at: now, scanned: [], status: 'checked', note: `short upload (${Math.round(v.durationS / 60)} min), skipped` };
        continue;
      }
      if (c.source === 'streams' && v.durationS !== undefined && v.durationS > MAX_YT_STREAM_MIN * 60) {
        e.seen[v.id] = { kind: 'vod', title: v.title, at: now, scanned: [], status: 'checked', note: `long stream VOD (${(v.durationS / 3600).toFixed(1)} h), skipped` };
        log(`youtube ${c.handle}: skipped ${v.id}, ${(v.durationS / 3600).toFixed(1)} h stream VOD is too long to auto-ingest`);
        continue;
      }
      // A genuinely new upload: queue one per check, newest first. Only record it as queued when
      // the queue actually accepted it; otherwise the per-creator cap would hide it forever.
      if (!enqueue(c, 'youtube-check', v.id, { url: `https://www.youtube.com/watch?v=${v.id}` })) return;
      e.seen[v.id] = { kind: tab === 'streams' ? 'vod' : 'video', title: v.title, at: now, scanned: [], status: 'queued' };
      return;
    }
  } catch (err) {
    e.error = (err as Error).message.split('\n')[0];
    log(`youtube ${c.handle}: ${e.error}`);
  }
}

/**
 * Topics: read the most-watched English streams in each topic's Twitch category and queue the best
 * one nobody has scanned. Skipped while a topic job is still waiting: one at a time.
 */
async function checkTopics() {
  const topics = TOPICS ? loadTopics() : [];
  const on = topics.filter((t) => t.enabled);
  if (!on.length) return;
  const ts = (state.topics ??= {});
  // every topic, every check: each one's top 3 eligible streams go into the tracker (the spec, 4.2).
  // Already-tracked ones count toward the 3; the tracker keys streams by broadcast, so taking one again
  // only adds this topic to its sources. Tracked streams are followed to their end even after they
  // leave the top 3. The tracker's order (by hand, listed creators, topics) keeps topics behind the list.
  const api = twitchApi();
  const found: TopicCandidate[] = [];
  for (const t of on) {
    const e = (ts[t.name] ??= { category: t.twitch, seen: {} });
    e.category = t.twitch;
    try {
      const streams = await api.categoryStreams(t.twitch, { limit: 20 });
      found.push(...streams.map((x) => ({ ...x, topic: t.name })));
      e.lastCheckedAt = new Date().toISOString();
      e.error = undefined;
      e.live = streams.filter((x) => x.viewers >= t.minViewers).length;
      e.top = streams.slice(0, 3).map((x) => `${x.name} ${x.viewers.toLocaleString('en-US')}`);
    } catch (err) {
      e.error = (err as Error).message.split('\n')[0];
      log(`topic ${t.name}: ${e.error}`);
    }
  }
  const watched = new Set(creators.filter((c) => c.platform === 'twitch').map((c) => c.handle.toLowerCase()));
  const channel = loadChannel();
  const unusable = new Map(listStreams({ status: 'skipped' }).map((x) => [x.videoId, x.skipReason ?? 'skipped']));
  const { picks, skipped } = topicPicks(topics, found, { watched, optedOut: (login) => !!optedOut({ login }, channel), unusable });
  state.topicSkips = skipped.slice(0, 80);
  const added: string[] = [];
  for (const p of picks) {
    const id = `tw-${p.vodId}`;
    const known = getStream(id);
    const wrong = known ? undefined : wrongStream({ title: p.title, durationMs: p.vodLengthMs ?? 0, live: true, login: p.login });
    track(() => {
      upsertStream({ videoId: id, platform: 'twitch', creator: p.name, login: p.login, title: p.title, game: topics.find((t) => t.name === p.topic)?.twitch ?? null, source: `topic:${p.topic}`, live: true, startedAt: known?.startedAt ?? null, durationMs: p.vodLengthMs ?? 0 });
      if (wrong) setStreamStatus(id, 'skipped', wrong);
    });
    ts[p.topic].seen[id] ??= { kind: 'vod', title: p.title, at: new Date().toISOString(), scanned: [], status: 'checked', login: p.login, note: `${p.viewers.toLocaleString('en-US')} viewers` };
    if (!known) added.push(`${p.topic}: ${p.name} (${p.viewers.toLocaleString('en-US')})${wrong ? ` skipped, ${wrong}` : ''}`);
  }
  log(`topics: ${picks.length} in the top ${TOPIC_TOP}s of ${on.length} topics${added.length ? `; new: ${added.join(' · ')}` : '; nothing new'}`);
}

/**
 * Reading and ranking the tracked streams is the observer's (tools/observer.ts): it reads every minute's
 * chat and ranks each stream every RANK_EVERY_MIN, apart from this process, so a 20-minute clip job never
 * holds up ranking. The watchlist makes sure one is running.
 */
function ensureObserver() {
  if (DRY || runningObserver()) return;
  const out = fs.openSync(path.join(paths.cache, 'observer.log'), 'a');
  const child = spawn('npx', ['tsx', 'tools/observer.ts', '--daemon'], { cwd: paths.root, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  log(`started the observer (pid ${child.pid}): it reads and ranks every tracked stream`);
}

/**
 * Keep one moment job waiting: the next moment across every tracked stream (nextMoments decides:
 * by hand, then listed creators, then topics). A waiting job from a lower tier gives its place to a
 * higher one that came up since (a stream added with `clip track`), so "do this one" is the next job.
 */
/**
 * Clips you sent back with a note (C in the review page) go first: one `revise` job per request (its
 * key is the clip and the time you sent it back, so a new request on the same clip runs again, and a
 * request that failed is not retried by itself). A clip whose footage was cut from a YouTube stream
 * while it was live cannot be fixed by editing (the footage is the wrong minute): it is left alone.
 */
function enqueueRevisions(): number {
  if (DRY) return 0;
  const asked = new Set(listJobs({ kind: 'revise' }).map((j) => j.momentId ?? ''));
  let n = 0;
  for (const r of revisionsToQueue(listReviews('changes'), asked, (v) => !!youtubeLive(v))) {
    const key = revisionKey(r);
    const creator = getStream(r.videoId)?.creator ?? r.videoId;
    if (insertJob({ id: `revise-${r.clipId}-${Date.now()}`, kind: 'revise', creator, tier: 0, videoId: r.videoId, momentId: key })) {
      log(`queued revise ${r.clipId} (you asked: "${(r.note ?? '').split('\n')[0].slice(0, 90)}")`);
      n++;
    }
  }
  return n;
}

/**
 * The next moment, and in the blind ranker trial (on unless RANKER_TRIAL=0) which arm picked it: the
 * arms take turns (the one with the fewest jobs goes next) among the moments of the best tier waiting,
 * so a stream added by hand still goes first. A moment outside both rankings' top 4 (a stream whose
 * top moments are done) is picked as before, with no arm.
 */
function pickMoment(busy: Set<string>): { m: ReturnType<typeof nextMoments>[number]; arm?: TrialArm } | undefined {
  const free = (arm?: TrialArm) => nextMoments(8, MOMENTS_PER_STREAM, arm).find((m) => !busy.has(`${m.videoId}|${m.momentId}`));
  const plain = free();
  if (!trialOn()) return plain && { m: plain };
  const tierOfMoment = (m: { videoId: string }) => tierOf(getStream(m.videoId)?.source ?? '');
  const offers = TRIAL_ARMS.map((arm) => ({ arm, m: free(arm) })).filter((x): x is { arm: TrialArm; m: NonNullable<typeof plain> } => !!x.m);
  const best = Math.min(...[...offers.map((x) => tierOfMoment(x.m)), ...(plain ? [tierOfMoment(plain)] : [])]);
  const armed = offers.filter((x) => tierOfMoment(x.m) === best);
  const arm = nextArm(armCounts(), armed.map((x) => x.arm));
  const pick = armed.find((x) => x.arm === arm);
  if (pick) return { m: pick.m, arm: pick.arm };
  return plain && { m: plain };
}

function enqueueMoment(): boolean {
  if (DRY) return false;
  const live = listJobs({ states: ['queued', 'running'], kind: 'twitch-moment' });
  const busy = new Set(live.map((j) => `${j.videoId}|${j.momentId}`));
  const picked = pickMoment(busy);
  if (!picked) return false;
  const { m: next, arm } = picked;
  const st = getStream(next.videoId)!;
  const tier = tierOf(st.source);
  const waiting = live.find((j) => j.state === 'queued');
  if (waiting) {
    // a retry or an interrupted job keeps its place; otherwise only a higher tier takes it
    if (waiting.attempts || waiting.interrupted || waiting.tier <= tier) return false;
    if (!dropQueued(waiting.id)) return false;
    track(() => setMomentStatus(waiting.videoId, waiting.momentId!, 'pending'));
    log(`moved ${waiting.creator} ${waiting.momentId} back: a ${TIER_NAMES[tier]} stream goes first`);
  }
  const topic = st.source.startsWith('topic:') ? st.source.slice('topic:'.length) : undefined;
  const ok = insertJob({
    id: `${st.creator}-${next.videoId}-${next.momentId}-${Date.now()}`,
    creator: st.creator,
    kind: 'twitch-moment',
    topic,
    tier,
    videoId: next.videoId,
    momentId: next.momentId,
    fromMs: next.windowFromMs,
    toMs: next.windowToMs,
    arm,
  });
  if (!ok) return false;
  setMomentStatus(next.videoId, next.momentId, 'queued');
  log(`queued moment (${TIER_NAMES[tier]}${arm ? `, trial: ${arm}` : ''}) ${topic ? `[${topic}] ` : ''}${st.creator} ${next.videoId} ${next.momentId} (${next.why[0]}) scan ${fmtTime(next.windowFromMs, 0)}–${fmtTime(next.windowToMs, 0)}`);
  return true;
}

async function checkAll() {
  log(`checking ${creators.length} creators${DRY ? ' (dry)' : ''}`);
  for (const c of creators) {
    const e = entry(c);
    const source = c.platform === 'youtube' ? (c.source ?? 'videos') : undefined;
    // A channel that changes platform or starts using the /streams tab has a different catalogue;
    // keep only the entries that belong to the new platform (Twitch ids start with tw-).
    if (e.platform !== c.platform) {
      e.seen = Object.fromEntries(Object.entries(e.seen).filter(([id]) => id.startsWith('tw-')));
      e.baseline = undefined;
    }
    if (source === 'streams' && e.source !== 'streams') {
      e.seen = {};
      e.baseline = undefined;
    }
    if (c.platform === 'twitch') {
      // Old YouTube ids on a channel that moved to Twitch are a different catalogue.
      for (const id of Object.keys(e.seen)) if (!id.startsWith('tw-')) delete e.seen[id];
      if (Object.keys(e.seen).length === 0) e.baseline = undefined;
    }
    e.platform = c.platform;
    e.handle = c.handle;
    e.source = source;
    e.content = c.content ?? (c.platform === 'twitch' ? 'stream' : '');
    if (c.content === 'edited' && !AUTO_EDITED) {
      e.lastCheckedAt = new Date().toISOString();
      e.error = 'edited channel: skipped';
      continue;
    }
    if (c.platform === 'twitch') await checkTwitch(c);
    else checkYouTube(c);
  }
  // after the creators, so a stream a creator check just registered is not taken again by a topic
  try {
    await checkTopics();
  } catch (err) {
    log(`topics: ${(err as Error).message.split('\n')[0]}`);
  }
  try {
    ensureObserver();
    enqueueRevisions();
    enqueueMoment();
  } catch (err) {
    log(`moments: ${(err as Error).message.split('\n')[0]}`);
  }
  saveState();
  writePage();
  log(`queue: ${activeJobs().filter((j) => j.state === 'queued').length} queued, ${activeJobs().filter((j) => j.state === 'running').length} running`);
}

/** Run the CLI without blocking (the job's lease is renewed every minute meanwhile); a restart's signal is "interrupted". */
async function run(args: string[], timeout = 30 * 60_000): Promise<{ ok: boolean; out: string }> {
  const r = await cli(args, timeout);
  return { ok: r.ok, out: r.out.slice(-4000) };
}

/** What a quick pass came to: a failed stage is a failed job, not a finished one. */
type QuickOutcome =
  | { outcome: 'off' | 'nothing-qualified'; clips: []; note: string }
  | { outcome: 'stage-failed'; clips: string[]; note: string }
  | { outcome: 'submitted'; clips: string[]; note: string };

/** The lens for a source: a stream is judged as a stream, a podcast as talk (the format sets the gates). */
export const lensFor = (videoId: string, content?: Creator['content']) =>
  videoId.startsWith('tw-') || content === 'stream' ? 'stream-moments' : 'podcast-general';

async function quickClips(videoId: string, fromMs: number, toMs: number, creator: string, lens: string): Promise<QuickOutcome> {
  if (NO_CLIPS) return { outcome: 'off', clips: [], note: 'auto-clips off' };
  // Keep the existing judge/pipeline order. OpenCode (DeepSeek) follows the same clip skill and
  // additionally sees the measured chat explosions; it is never the only reason to accept a clip.
  const rangeArgs = videoId.startsWith('tw-') ? ['--from', fmtTime(fromMs, 0), '--to', fmtTime(toMs, 0)] : [];
  const j = await run(['judge', videoId, '--provider', 'opencode', '--lens', lens, '--want', String(Math.max(AUTO_CLIPS, 2)), ...rangeArgs], 45 * 60_000);
  if (!j.ok) return { outcome: 'stage-failed', clips: [], note: `judge failed: ${j.out.slice(-300)}` };
  const cands = readJsonIf<{ candidates: { id: string; startMs?: number; endMs?: number; score?: number; rankScore?: number; title?: string; verdict?: string; status?: string }[] }>(paths.videoFile(videoId, 'candidates.json'))?.candidates ?? [];
  const inRange = cands.filter(
    (c) =>
      c.status !== 'made' &&
      c.startMs !== undefined &&
      c.endMs !== undefined &&
      c.startMs >= fromMs &&
      c.startMs <= toMs &&
      // the upload scheduler's rule: 5–60 s (15 s is the editing target, not an upload rule)
      c.endMs - c.startMs >= 5_000 &&
      c.endMs - c.startMs <= 60_000,
  );
  if (!inRange.length) return { outcome: 'nothing-qualified', clips: [], note: `the judge found nothing postable (${cands.length} candidates, none new and 5–60 s)` };
  // The engine's rank already puts post before recut before skip; do not re-order it.
  const chosen = inRange.sort((a, b) => (b.rankScore ?? b.score ?? 0) - (a.rankScore ?? a.score ?? 0)).slice(0, AUTO_CLIPS);
  const made: string[] = [];
  const failed: string[] = [];
  for (const c of chosen) {
    const clip = `${videoId}-${c.id}`;
    const mk = await run(['make', videoId, c.id], 10 * 60_000);
    if (!mk.ok) {
      failed.push(`make ${clip}: ${mk.out.slice(-160)}`);
      continue;
    }
    // The judge wrote a real title and hook from the moment; keep them. The reviewer can still edit.
    if (c.title) await run(['set', clip, `title=${c.title}`], 60_000);
    const r = await run(['render', clip], 20 * 60_000);
    if (!r.ok) {
      failed.push(`render ${clip}: ${r.out.slice(-160)}`);
      continue;
    }
    const sub = await run(['review', clip, 'submit', '--note', `Auto-generated by watchlist for ${creator} (OpenCode judge + measured chat evidence). Verify before approving.`], 60_000);
    if (!sub.ok) {
      failed.push(`submit ${clip}: ${sub.out.slice(-160)}`);
      continue;
    }
    made.push(clip);
    log(`  review clip ${clip} — ${c.title ?? ''}`);
  }
  for (const f of failed) log(`  ${f}`);
  if (!made.length) return { outcome: 'stage-failed', clips: [], note: `no clip reached review: ${failed.join(' | ')}` };
  return { outcome: 'submitted', clips: made, note: `${made.length} clip${made.length === 1 ? '' : 's'} in review: ${made.join(', ')}${failed.length ? ` (${failed.length} failed)` : ''}` };
}

/** Worth retrying: a stage timed out, or the network or an API hiccuped. Not: a broadcast nobody may read. */
const TRANSIENT = /timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|HTTP Error 5\d\d|\b5\d\d\b|rate limit|429|Temporary failure/i;
const MAX_RETRIES = Number(process.env.WATCHLIST_RETRIES ?? 1);
export const retryable = (msg: string) => TRANSIENT.test(msg) && !isSubscriberOnly(msg);

/** Paint a moment job's window on the stream's `clip` ledger (src/track/coverage.ts). */
const clipLedger = (job: Job, state: 'claimed' | 'done' | 'queued' | 'failed', reason?: string) => {
  if (job.kind !== 'twitch-moment' || job.fromMs === undefined || job.toMs === undefined) return;
  track(() => updateCoverage(job.videoId, 'clip', (s) => paint(s, [{ startMs: job.fromMs!, endMs: job.toMs! }], { state, jobId: job.id, ...(reason ? { reason } : {}) })));
};

type End = Parameters<typeof finishJob>[2];

async function runJob(job: Job): Promise<End> {
  if (job.kind === 'twitch-moment') {
    // one moment the community picked out: scan its few minutes, then the full pipeline on them
    const from = fmtTime(job.fromMs!, 0);
    const to = fmtTime(job.toMs!, 0);
    track(() => setMomentStatus(job.videoId, job.momentId!, 'working'));
    clipLedger(job, 'claimed');
    if (!job.stage) {
      const a = await run(['scan', job.videoId, '--from', from, '--to', to], 30 * 60_000);
      const why = unreadable(a.out);
      if (why) {
        track(() => (setStreamStatus(job.videoId, 'skipped', why), setMomentStatus(job.videoId, job.momentId!, 'skipped', { note: why })));
        clipLedger(job, 'failed', why);
        return { state: 'done', result: `${why}; skipped` };
      }
      if (!a.ok && !/Up to date/i.test(a.out)) throw new Error(a.out.slice(-800));
      const q = await run(['queues', job.videoId, '--from', from, '--to', to, '--limit', '20', '--transcribe', 'range'], 30 * 60_000);
      if (!q.ok) throw new Error(q.out.slice(-800));
      saveStage(job.id, WORKER, 'scanned', {});
    }
    const m = listMoments({ videoId: job.videoId }).find((x) => x.momentId === job.momentId);
    const moment = m ? { peakMs: m.peakMs, fromMs: m.fromMs, toMs: m.toMs, why: m.why, titles: m.titles } : undefined;
    const r = await runFullPipeline({
      videoId: job.videoId,
      fromMs: job.fromMs!,
      toMs: job.toMs!,
      creator: job.creator,
      maxKeep: 1,
      moment,
      resume: job.stage && job.stage !== 'scanned' ? { stage: job.stage, data: job.stageData } : undefined,
      onStage: (stage, data) => {
        if (!saveStage(job.id, WORKER, stage, data)) log(`  ${job.id}: the claim was lost after ${stage}`);
      },
      log: (x) => log(`  ${x}`),
    });
    track(() => setMomentStatus(job.videoId, job.momentId!, r.clips.length ? 'clipped' : 'no-clip', { note: r.note, clipIds: r.clips }));
    clipLedger(job, 'done');
    return { state: 'done', result: r.note, clipIds: r.clips };
  }
  if (job.kind === 'twitch-scan') return { state: 'done', result: 'replaced by moment tracking (not run)' };
  if (job.kind === 'revise') {
    // a clip you sent back: the editor does what your note asks, renders and submits it again
    const clipId = job.momentId!.split('@')[0];
    const before = listReviews().find((r) => r.clipId === clipId);
    if (!before || before.status !== 'changes') return { state: 'done', result: 'no longer waiting for changes (decided again since)' };
    const reply = await reviseClip({ clipId, note: before.note ?? '', creator: job.creator, log: (x) => log(`  ${x}`) });
    const after = listReviews().find((r) => r.clipId === clipId);
    if (after?.status !== 'review') throw new Error(`revise ${clipId}: the clip was not submitted to review again · ${reply.slice(0, 300)}`);
    return { state: 'done', result: `revised and back in review: ${reply.slice(0, 400)}`, clipIds: [clipId] };
  }
  // youtube-check
  const a = await run(['ingest', job.url!], 20 * 60_000);
  if (!a.ok) throw new Error(a.out.slice(-800));
  const d = await run(['discover', job.videoId], 5 * 60_000);
  if (!d.ok) throw new Error(d.out.slice(-800));
  const s = state.creators[job.creator]?.seen[job.videoId];
  if (s) s.status = 'checked';
  const content = creators.find((c) => c.name === job.creator)?.content;
  const q = await quickClips(job.videoId, 0, Number.MAX_SAFE_INTEGER, job.creator, lensFor(job.videoId, content));
  // a stage that failed is a failed job (retried once if it was the network), never "done"
  if (q.outcome === 'stage-failed') throw new Error(q.note);
  return { state: 'done', result: `${q.outcome}: ${q.note}`, clipIds: q.clips };
}

/** What a failed run comes to: skipped (unreadable), back in line (interrupted, or a retry), or failed. */
function afterError(job: Job, msg: string): End {
  const gone = unreadable(msg);
  if (gone && job.kind === 'twitch-moment') {
    // a later step (the audio for the transcript) found the broadcast unreadable: the stream is
    // skipped once, instead of every one of its moments failing in turn
    track(() => (setStreamStatus(job.videoId, 'skipped', gone), setMomentStatus(job.videoId, job.momentId!, 'skipped', { note: gone })));
    clipLedger(job, 'failed', gone);
    log(`skip ${job.creator} ${job.videoId}: ${gone}`);
    return { state: 'done', result: `${gone}; skipped` };
  }
  if (/\binterrupted\b/.test(msg) && job.interrupted < 3) {
    // a restart stopped it: back in line at its checkpoint
    if (job.momentId) track(() => setMomentStatus(job.videoId, job.momentId!, 'queued', { note: 'interrupted by a restart; back in line' }));
    clipLedger(job, 'queued');
    log(`job ${job.id} was interrupted; back in line${job.stage ? ` (resumes after ${job.stage})` : ''}`);
    return { state: 'queued', interrupted: job.interrupted + 1 };
  }
  if (retryable(msg) && job.attempts < MAX_RETRIES) {
    // a stage that timed out or a network error is worth one more go, from the last checkpoint
    const error = `attempt ${job.attempts + 1} failed: ${msg.split('\n')[0]}`;
    if (job.momentId) track(() => setMomentStatus(job.videoId, job.momentId!, 'queued', { note: error }));
    clipLedger(job, 'queued');
    log(`job ${job.id} will be retried (${job.attempts + 1}/${MAX_RETRIES}): ${msg.split('\n')[0]}`);
    return { state: 'queued', attempts: job.attempts + 1, error };
  }
  if (job.momentId) track(() => setMomentStatus(job.videoId, job.momentId!, 'failed', { note: msg.split('\n')[0].slice(0, 300) }));
  clipLedger(job, 'failed', msg.split('\n')[0].slice(0, 200));
  log(`job failed ${job.id}: ${msg.split('\n')[0]}`);
  return { state: 'failed', error: msg };
}

async function worker(max = MAX_JOBS): Promise<number> {
  let n = 0;
  while (n < max && !DRY) {
    requeueStale(workerAlive);
    const job = claimNext(WORKER, LEASE_MS);
    if (!job) break;
    current = job;
    log(`job ${job.kind} ${job.topic ? `[${job.topic}] ` : ''}${job.creator} ${job.videoId}${job.momentId ? ` ${job.momentId}` : ''}${job.stage ? ` (resuming after ${job.stage})` : ''}`);
    // keep the claim alive while the stages run (each is a child process; this loop stays free)
    const renew = setInterval(() => {
      if (!renewLease(job.id, WORKER, LEASE_MS)) log(`  lost the claim on ${job.id}: another worker has it; this run's result will not be written`);
    }, 60_000);
    let end: End;
    try {
      end = await runJob(job);
    } catch (err) {
      end = afterError(job, (err as Error).message.slice(-1200));
    } finally {
      clearInterval(renew);
    }
    if (!finishJob(job.id, WORKER, end)) log(`job ${job.id}: the claim was lost, so its result was not written`);
    current = undefined;
    saveState();
    n++;
    // the next moment goes in as soon as one is done, not at the next check
    if (job.kind === 'twitch-moment') enqueueMoment();
  }
  writePage();
  return n;
}

function writePage() {
  if (DRY) return;
  const rows = Object.entries(state.creators)
    .map(([name, e]) => {
      const seen = Object.entries(e.seen);
      const live = e.live?.isLive ? `<b style="color:#38d996">LIVE</b>` : 'offline';
      const latest = seen.sort((a, b) => b[1].at.localeCompare(a[1].at))[0];
      return `<tr><td>${name}</td><td>${e.platform}</td><td>${e.content ?? ''}</td><td>${live}</td><td>${e.lastCheckedAt ?? ''}</td><td>${seen.length}</td><td>${latest ? `${latest[0]} · ${latest[1].status}` : ''}</td><td>${e.error ?? ''}</td></tr>`;
    })
    .join('');
  const q = activeJobs();
  const topicRows = Object.entries(state.topics ?? {})
    .map(([name, t]) => {
      const last = Object.entries(t.seen).sort((a, b) => b[1].at.localeCompare(a[1].at))[0];
      return `<tr><td>${name}</td><td>${t.category}</td><td>${t.lastCheckedAt ?? ''}</td><td>${t.live ?? ''}</td><td>${(t.top ?? []).join(' · ')}</td><td>${last ? `${last[1].login ?? ''} ${last[0]} · ${last[1].status}` : ''}</td><td>${t.error ?? ''}</td></tr>`;
    })
    .join('');
  // the tracker: every stream we follow, what of it is done, and what is next
  const tracked = listStreams().filter((x) => x.status === 'tracking' || Date.parse(x.updatedAt) >= Date.now() - 24 * 3_600_000);
  const tally = (id: string) => {
    const c: Record<string, number> = {};
    for (const m of listMoments({ videoId: id })) c[m.status] = (c[m.status] ?? 0) + 1;
    return ['clipped', 'no-clip', 'pending', 'queued', 'working', 'skipped', 'failed'].filter((k) => c[k]).map((k) => `${c[k]} ${k}`).join(' · ');
  };
  const streamRows = tracked
    .sort((a, b) => Number(b.live) - Number(a.live) || (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    .map((x) => `<tr><td>${x.creator}</td><td>${x.live ? '<b style="color:#38d996">LIVE</b>' : x.status}</td><td>${x.source.startsWith('topic:') ? x.source.slice(6) : 'creator'}</td><td>${fmtTime(x.durationMs, 0)}</td><td>${x.status === 'skipped' ? `skipped: ${x.skipReason ?? ''}` : tally(x.videoId) || 'not ranked yet'}</td><td>${x.title.replace(/</g, '&lt;').slice(0, 60)}</td></tr>`)
    .join('');
  const nextRows = nextMoments(8)
    .map((m) => `<tr><td>${tracked.find((x) => x.videoId === m.videoId)?.creator ?? m.videoId}</td><td>${m.momentId}</td><td>${Math.round(m.score).toLocaleString('en-US')}</td><td>${(m.why[0] ?? '').replace(/</g, '&lt;')}</td><td>${(m.titles[0] ?? '').replace(/</g, '&lt;').slice(0, 60)}</td></tr>`)
    .join('');
  const reviews = listReviews();
  const count = (s: string) => reviews.filter((r) => r.status === s).length;
  const approvedUnpicked = reviews.filter((r) => r.status === 'approved' && r.picked === 0).length;
  const html = `<!doctype html><meta charset="utf-8"><title>Watchlist</title>
<style>body{background:#0b0c10;color:#f4f4f7;font-family:Inter,system-ui,sans-serif;padding:28px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:9px;border-bottom:1px solid #282d3a}th{color:#9aa1b5;font-size:11px;text-transform:uppercase}.box{display:inline-block;margin:0 18px 12px 0;padding:10px 14px;border:1px solid #282d3a;border-radius:10px;background:#151821}code{color:#25f4ee}</style>
<h1>Watchlist</h1><p style="color:#9aa1b5">Updated ${state.updatedAt}. Review at <code>http://localhost:4400/#/review</code>.</p>
<div><span class="box">Review <b>${count('review')}</b></span><span class="box">Approved, not picked <b>${approvedUnpicked}</b></span><span class="box">Rejected <b>${count('rejected')}</b></span><span class="box">Queue <b>${q.length}</b></span></div>
<table><thead><tr><th>Creator</th><th>Platform</th><th>Content</th><th>Live</th><th>Last check</th><th>Seen</th><th>Latest</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>
<h2 style="margin-top:26px">Streams</h2><table><thead><tr><th>Creator</th><th>State</th><th>From</th><th>Length</th><th>Moments</th><th>Title</th></tr></thead><tbody>${streamRows}</tbody></table>
<h2 style="margin-top:26px">Next moments</h2><table><thead><tr><th>Creator</th><th>Moment</th><th>Score</th><th>Why</th><th>Viewer clip</th></tr></thead><tbody>${nextRows}</tbody></table>
<h2 style="margin-top:26px">Topics</h2><table><thead><tr><th>Topic</th><th>Twitch category</th><th>Last check</th><th>Big English streams</th><th>Top now</th><th>Last taken</th><th>Error</th></tr></thead><tbody>${topicRows}</tbody></table>
<h2 style="margin-top:26px">Queue</h2><table><thead><tr><th>Job</th><th>Creator</th><th>Video</th><th>Status</th><th>Result</th></tr></thead><tbody>${q.map((j) => `<tr><td>${j.kind}${j.topic ? ` · ${j.topic}` : ''}</td><td>${j.creator}</td><td>${j.videoId}</td><td>${j.state}</td><td>${(j.result ?? j.error ?? '').slice(0, 300)}</td></tr>`).join('')}</tbody></table>`;
  fs.writeFileSync(path.join(paths.library, 'watchlist-status.html'), html);
}

if (has('--daemon') && !DRY) {
  // a job a stopped or crashed daemon left running goes back in line at its checkpoint (its worker's
  // pid is gone, or its lease ran out)
  for (const j of requeueStale(workerAlive)) log(`requeued ${j.kind} ${j.topic ? `[${j.topic}] ` : ''}${j.creator} ${j.videoId}${j.stage ? ` (resumes after ${j.stage})` : ''}: its worker stopped`);
  // range scans (the newest 20–30 minutes, blind) are replaced by moments the community picked out
  const old = listJobs({ states: ['queued'], kind: 'twitch-scan' });
  for (const j of old) dropQueued(j.id);
  if (old.length) log(`retired ${old.length} queued range scan${old.length === 1 ? '' : 's'}: the watchlist now works moment by moment`);
  // a moment marked queued or working with no job behind it goes back to waiting
  const inQueue = new Set(listJobs({ states: ['queued', 'running'], kind: 'twitch-moment' }).map((x) => `${x.videoId}|${x.momentId}`));
  for (const st of ['queued', 'working'] as const) for (const m of listMoments({ status: st })) if (!inQueue.has(`${m.videoId}|${m.momentId}`)) setMomentStatus(m.videoId, m.momentId, 'pending');
  // YouTube streams the old path ingested while live (every clip of one came out as the same live
  // minute): forget them, so the check after they end takes the finished VOD
  for (const [name, e] of Object.entries(state.creators))
    for (const [id, v] of Object.entries(e.seen))
      if (e.platform === 'youtube' && v.note === 'live') {
        delete e.seen[id];
        log(`youtube ${name}: ${id} was read while live; it is taken again once it has ended`);
      }
  saveState();
  // A stop (a restart) puts the running job back in line instead of leaving it failed or running.
  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    const j = current;
    if (j && finishJob(j.id, WORKER, { state: 'queued', interrupted: j.interrupted + 1 })) {
      if (j.momentId) track(() => setMomentStatus(j.videoId, j.momentId!, 'queued', { note: 'interrupted by a restart; back in line' }));
      clipLedger(j, 'queued');
    }
    log(`stopping (${sig}): the running job goes back in line${j?.stage ? ` (resumes after ${j.stage})` : ''}`);
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (has('--once') || has('--dry-run') || has('--daemon')) {
  await checkAll();
  if (!has('--once') && !has('--dry-run')) {
    // Discovery has its own timer: creators and topics are checked every CHECK_MIN whatever the worker
    // is doing (a clip job runs a median 26 minutes; its stages are child processes, so this process
    // stays free). The worker runs back to back while anything waits, and when idle looks each minute
    // for a stream added by hand (`clip track` ranks it at once).
    let checking = false;
    setInterval(async () => {
      if (checking) return; // the last check is still running
      checking = true;
      try {
        await checkAll();
      } catch (err) {
        log(`check failed: ${(err as Error).message.split('\n')[0]}`);
      } finally {
        checking = false;
      }
    }, CHECK_MIN * 60_000);
    for (;;) {
      enqueueRevisions();
      enqueueMoment();
      const ran = await worker(1);
      if (!ran) await sleep(60_000);
    }
  }
} else if (has('--worker')) {
  await worker(MAX_JOBS);
} else if (has('--page')) {
  writePage();
} else {
  console.log('usage: watchlist.ts --dry-run | --once | --worker [--max N] | --page | --daemon');
  process.exit(2);
}
