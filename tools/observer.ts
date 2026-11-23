#!/usr/bin/env tsx
// The observer (reports/stream-pipeline-spec-2026-11-19.md, section 6.1): the cheap pass over every
// minute of every tracked Twitch stream, apart from the expensive clip pass so it never waits behind a
// 20-minute clip job. For each stream it reads chat range by range up to the live edge, keeps the viewer
// clips fresh, and ranks the stream's moments into the tracker (`tools/watchlist.ts` then clips the best
// ones). What has been read is the stream's `observe` ledger in library/tracking.sqlite
// (src/track/coverage.ts): queued, claimed by this observer, done, failed (with why).
//
//   npx tsx tools/observer.ts --daemon     # started by the watchlist daemon when it is not running
//   npx tsx tools/observer.ts --once       # one ranking pass and one chunk of reading
import { fmtTime } from '../src/core/time';
import { twitchApi } from '../src/ingest/twitch';
import { fetchChat, loadChat } from '../src/ingest/chat';
import { claim, complete, fail, markDone, readUpTo, recover, summary, unqueueFrom, want, type Span } from '../src/track/coverage';
import { listMoments, listStreams, saveCoverage, setStreamStatus, tierOf, updateCoverage, type StreamRow } from '../src/track/db';
import { rankAndStore, unreadable } from '../src/scan/rank';
import { runningObserver, writeHeartbeat } from '../src/track/observer';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
/** How much chat one step reads (about a minute for a busy stream's hour). */
const CHUNK_MIN = Number(process.env.OBSERVE_CHUNK_MIN ?? 60);
const RANK_EVERY_MIN = Number(process.env.RANK_EVERY_MIN ?? 20);
const TRACK_ENDED_HOURS = Number(process.env.TRACK_ENDED_HOURS ?? 48);
const IDLE_S = Number(process.env.OBSERVE_IDLE_S ?? 60);
/** A live stream's new minutes are read once this many have built up (the time between goes to older footage). */
const LIVE_BATCH_MIN = Number(process.env.OBSERVE_LIVE_BATCH_MIN ?? 10);

const log = (s: string) => console.log(`${new Date().toISOString()}  ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newJob = () => `obs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
/** Nothing past the live edge: chat trails the moment, and the last minutes are not on the VOD yet. */
const edgeOf = (st: StreamRow) => (st.live ? Math.max(0, st.durationMs - 3 * 60_000) : st.durationMs);
const twitchTracked = () => listStreams({ status: 'tracking' }).filter((s) => s.platform === 'twitch');

const heartbeat = writeHeartbeat;

/**
 * Bring a stream's ledger up to what is on disk and what is wanted: chat already read (by a scan, a
 * moment job, an earlier observer) is done; a stream whose chat is off is done on viewer clips alone;
 * everything else up to the live edge is wanted.
 */
function syncLedger(st: StreamRow): Span[] {
  const chat = loadChat(st.videoId);
  const edge = edgeOf(st);
  return updateCoverage(st.videoId, 'observe', (spans) => {
    let s = markDone(spans, chat?.fetched ?? [], 'chat read');
    if (chat?.disabled) s = markDone(s, [{ startMs: 0, endMs: edge }], 'chat off: viewer clips only');
    // a live stream's tail is read in batches of LIVE_BATCH_MIN; an ended one to its end (the last
    // partial stretch flushed); older gaps are always wanted
    const to = readUpTo(s, edge, st.live, LIVE_BATCH_MIN * 60_000);
    s = unqueueFrom(s, to);
    return want(s, [{ startMs: 0, endMs: to }], newJob()).spans;
  });
}

/** Rank a stream into the tracker; a broadcast nobody may read is skipped, with why. */
async function rank(st: StreamRow) {
  try {
    const r = await rankAndStore(st);
    const best = r.stored.find((m) => !m.skip);
    log(`ranked ${st.creator} ${st.videoId}: ${r.ranked.length} over the bar${best ? `, best ${best.id} (${best.why[0]})` : ''}`);
  } catch (err) {
    const msg = (err as Error).message;
    const gone = unreadable(msg);
    if (gone) {
      setStreamStatus(st.videoId, 'skipped', gone);
      log(`skip ${st.creator} ${st.videoId}: ${gone}`);
    } else log(`rank ${st.creator} ${st.videoId} failed: ${msg.split('\n')[0].slice(0, 200)}`);
  }
}

/** A stream ended over TRACK_ENDED_HOURS ago with nothing waiting is closed: viewer clips have stopped. */
function closeEnded(streams: StreamRow[]) {
  const now = Date.now();
  for (const st of streams) {
    const endedAt = st.startedAt ? Date.parse(st.startedAt) + st.durationMs : now;
    if (st.live || endedAt >= now - TRACK_ENDED_HOURS * 3_600_000) continue;
    if (listMoments({ videoId: st.videoId, status: 'pending' }).length) continue;
    setStreamStatus(st.videoId, 'done');
    log(`done ${st.creator} ${st.videoId}: ended over ${TRACK_ENDED_HOURS} h ago`);
  }
}

/** Read one chunk of the stream that needs it most: by hand first, then listed creators, then topics; live first; least read first. */
async function observeOne(streams: StreamRow[]): Promise<boolean> {
  const work = streams
    .map((st) => ({ st, spans: syncLedger(st) }))
    .filter((x) => x.spans.some((s) => s.state === 'queued'))
    .map((x) => ({ ...x, done: summary(x.spans, edgeOf(x.st)) }))
    .sort((a, b) => tierOf(a.st.source) - tierOf(b.st.source) || Number(b.st.live) - Number(a.st.live) || a.done.doneMs / Math.max(1, a.done.totalMs) - b.done.doneMs / Math.max(1, b.done.totalMs));
  if (!work.length) return false;
  const { st, spans } = work[0];
  const queuedJob = spans.find((s) => s.state === 'queued')!.jobId!;
  const c = claim(spans, queuedJob, CHUNK_MIN * 60_000, newJob());
  saveCoverage(st.videoId, 'observe', c.spans);
  const what = c.claimed.map((r) => `${fmtTime(r.startMs, 0)}–${fmtTime(r.endMs, 0)}`).join(', ');
  try {
    const got = await fetchChat(st.videoId, c.claimed, twitchApi());
    const chat = loadChat(st.videoId);
    updateCoverage(st.videoId, 'observe', (s) => complete(s, queuedJob, chat?.disabled ? c.claimed : (chat?.fetched ?? []), newJob()));
    const left = summary(syncLedger(st), edgeOf(st));
    log(`read ${st.creator} ${st.videoId} ${what}: ${got.added.toLocaleString('en-US')} messages${chat?.disabled ? ' (chat off)' : ''} · ${Math.round((100 * left.doneMs) / Math.max(1, left.totalMs))}% read`);
    await rank(st);
  } catch (err) {
    const msg = (err as Error).message;
    const gone = unreadable(msg);
    updateCoverage(st.videoId, 'observe', (s) => fail(s, queuedJob, (gone ?? msg).split('\n')[0].slice(0, 200)));
    if (gone) setStreamStatus(st.videoId, 'skipped', gone);
    log(`read ${st.creator} ${st.videoId} ${what} failed: ${(gone ?? msg).split('\n')[0].slice(0, 200)}`);
    await sleep(10_000); // a network error: do not spin
  }
  return true;
}

async function rankDue(streams: StreamRow[]) {
  const due = streams.filter((st) => !st.rankedAt || Date.now() - Date.parse(st.rankedAt) >= RANK_EVERY_MIN * 60_000);
  for (const st of due) await rank(st);
}

function backlog(streams: StreamRow[]) {
  let todo = 0;
  let total = 0;
  for (const st of streams) {
    const s = summary(syncLedger(st), edgeOf(st));
    todo += s.totalMs - s.doneMs;
    total += s.totalMs;
  }
  return { streams: streams.length, readH: +((total - todo) / 3_600_000).toFixed(1), toReadH: +(todo / 3_600_000).toFixed(1) };
}

if (has('--daemon') || has('--once')) {
  const other = runningObserver();
  if (other && other.pid !== process.pid && has('--daemon')) {
    console.log(`an observer is already running (pid ${other.pid})`);
    process.exit(0);
  }
  heartbeat();
  // claims a dead observer left open: what it read is done (the chat file says), the rest back in line
  for (const st of twitchTracked()) updateCoverage(st.videoId, 'observe', (s) => recover(s, loadChat(st.videoId)?.fetched ?? [], newJob()));
  const stop = () => {
    // the running read is left claimed; the next observer's start recovers it from the chat file
    log('observer stopping');
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log(`observer: chat in reads of up to ${CHUNK_MIN} min (a live stream's new minutes in batches of ${LIVE_BATCH_MIN}), every stream re-ranked every ${RANK_EVERY_MIN} min`);
  let lastBacklog = 0;
  for (;;) {
    const streams = twitchTracked();
    closeEnded(streams);
    await rankDue(streams);
    const read = await observeOne(twitchTracked());
    if (Date.now() - lastBacklog > 10 * 60_000) {
      const b = backlog(twitchTracked());
      heartbeat(b);
      log(`backlog: ${b.streams} streams, ${b.readH} h read, ${b.toReadH} h to read`);
      lastBacklog = Date.now();
    } else heartbeat();
    if (has('--once')) break;
    if (!read) await sleep(IDLE_S * 1000);
  }
} else {
  console.log('usage: observer.ts --daemon | --once');
}
