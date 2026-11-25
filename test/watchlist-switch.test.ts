// The Studio's switch for the watchlist (src/track/watchlist.ts): the pause flag and the heartbeat.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { discoveryPause, setDiscoveryPaused, claimableKinds, runningWatchlist, writeWatchlistHeartbeat, watchlistHeartbeatFile, pauseFile } = await import('../src/track/watchlist');

test('no pause file means finding clips runs; pausing records when, and pressing it twice keeps the first time', () => {
  fs.rmSync(pauseFile(), { force: true });
  assert.deepEqual(discoveryPause(), { paused: false });
  const first = setDiscoveryPaused(true);
  assert.equal(first.paused, true);
  assert.ok(first.at);
  assert.deepEqual(setDiscoveryPaused(true), first);
  assert.equal(discoveryPause().paused, true);
  assert.equal(setDiscoveryPaused(false).paused, false);
  assert.equal(discoveryPause().paused, false);
});

test('an unreadable pause file is not a pause', () => {
  fs.writeFileSync(pauseFile(), '{ half');
  assert.equal(discoveryPause().paused, false);
  fs.rmSync(pauseFile(), { force: true });
});

test('paused, the watchlist takes change requests only', () => {
  assert.deepEqual(claimableKinds(true), ['revise']);
  assert.equal(claimableKinds(false), undefined);
});

test('the heartbeat says the watchlist runs only while its pid lives and it beat in the last 3 minutes', () => {
  writeWatchlistHeartbeat({ job: { kind: 'revise', creator: 'x', videoId: 'tw-x' }, queued: 2 });
  assert.equal(runningWatchlist()?.pid, process.pid);
  assert.equal(runningWatchlist()?.job?.kind, 'revise');
  fs.writeFileSync(watchlistHeartbeatFile(), JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 5 * 60_000).toISOString() }));
  assert.equal(runningWatchlist(), undefined);
  fs.writeFileSync(watchlistHeartbeatFile(), JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
  assert.equal(runningWatchlist(), undefined);
});
