// The watchlist's job queue (src/track/jobs.ts): dedupe, order, leases, fencing, checkpoints.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { insertJob, claimNext, finishJob, saveStage, renewLease, requeueStale, getJob, listJobs, dropQueued } = await import('../src/track/jobs');

const moment = (id: string, momentId: string, tier: number, createdAt = new Date().toISOString()) => ({ id, kind: 'twitch-moment' as const, creator: id, videoId: `tw-${id}`, momentId, tier, createdAt });

test('the same moment cannot be queued twice, even by a race; a finished one can be queued again', () => {
  assert.equal(insertJob(moment('a', 'moment@1:00:00', 1)), true);
  assert.equal(insertJob({ ...moment('a', 'moment@1:00:00', 1), id: 'a-again' }), false);
  const j = claimNext('w:1', 600_000)!;
  finishJob(j.id, 'w:1', { state: 'done', result: 'ok' });
  assert.equal(insertJob({ ...moment('a', 'moment@1:00:00', 1), id: 'a-later' }), true);
  dropQueued('a-later');
});

test('jobs are taken by hand first, then listed creators, then topics, oldest first within each', () => {
  const t = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  insertJob(moment('topic1', 'm1', 2, t(300)));
  insertJob(moment('creator1', 'm1', 1, t(100)));
  insertJob(moment('creator0', 'm1', 1, t(200)));
  insertJob(moment('hand', 'm1', 0, t(10)));
  const order = [claimNext('w:1', 600_000)!, claimNext('w:1', 600_000)!, claimNext('w:1', 600_000)!, claimNext('w:1', 600_000)!].map((j) => j.creator);
  assert.deepEqual(order, ['hand', 'creator0', 'creator1', 'topic1']);
  for (const j of listJobs({ states: ['running'] })) finishJob(j.id, 'w:1', { state: 'done' });
});

test('killed mid-job: the job goes back in line with its checkpoint, the dead worker cannot finish it, and it runs once more', () => {
  insertJob(moment('kai', 'moment@2:53:25', 1));
  const first = claimNext('watchlist:111', 600_000)!;
  // the experts and the extractor finished before the kill
  assert.equal(saveStage(first.id, 'watchlist:111', 'extract', { extracted: ['c04'] }), true);
  // worker 111 is dead: its claim is put back, checkpoint and all
  const back = requeueStale((w) => w !== 'watchlist:111');
  assert.deepEqual(back.map((j) => j.id), [first.id]);
  const queued = getJob(first.id)!;
  assert.equal(queued.state, 'queued');
  assert.equal(queued.stage, 'extract');
  assert.deepEqual(queued.stageData, { extracted: ['c04'] });
  assert.equal(queued.interrupted, 1);
  // a new worker takes it; the dead one's late writes are refused (fencing): nothing is done twice
  const again = claimNext('watchlist:222', 600_000)!;
  assert.equal(again.id, first.id);
  assert.equal(saveStage(first.id, 'watchlist:111', 'edit', { clips: ['tw-kai-c99'] }), false);
  assert.equal(finishJob(first.id, 'watchlist:111', { state: 'done', clipIds: ['tw-kai-c99'] }), false);
  assert.equal(renewLease(first.id, 'watchlist:111', 600_000), false);
  assert.equal(finishJob(first.id, 'watchlist:222', { state: 'done', clipIds: ['tw-kai-c04'], result: 'one clip' }), true);
  const done = getJob(first.id)!;
  assert.deepEqual(done.clipIds, ['tw-kai-c04']);
  assert.equal(done.state, 'done');
});

test('a lease that runs out puts the job back even if the worker id looks alive', () => {
  insertJob(moment('slow', 'm', 1));
  const j = claimNext('w:alive', -1)!; // a lease already expired
  assert.deepEqual(requeueStale(() => true).map((x) => x.id), [j.id]);
  const back = claimNext('w:alive', 600_000)!;
  finishJob(back.id, 'w:alive', { state: 'done' });
});

test('a retry goes back in line keeping its checkpoint; failed and done keep their result', () => {
  insertJob(moment('net', 'm', 1));
  const j = claimNext('w:1', 600_000)!;
  saveStage(j.id, 'w:1', 'queue-check', {});
  assert.equal(finishJob(j.id, 'w:1', { state: 'queued', attempts: 1, error: 'attempt 1 failed: timed out' }), true);
  const q = getJob(j.id)!;
  assert.equal(q.state, 'queued');
  assert.equal(q.stage, 'queue-check');
  assert.equal(q.startedAt, undefined);
  const k = claimNext('w:1', 600_000)!;
  finishJob(k.id, 'w:1', { state: 'failed', error: 'gave up' });
  assert.equal(getJob(j.id)!.error, 'gave up');
  assert.ok(getJob(j.id)!.finishedAt);
});

test('paused in the Studio: only change requests are taken, and a waiting moment keeps its place for the resume', async () => {
  const { claimableKinds } = await import('../src/track/watchlist');
  insertJob(moment('waits', 'moment@0:10:00', 0)); // by hand: first in line when running
  insertJob({ id: 'revise-tw-x-c01-1', kind: 'revise', creator: 'x', tier: 0, videoId: 'tw-x', momentId: 'tw-x-c01@2026-11-24T13:00:00Z' });
  assert.equal(claimNext('w:1', 600_000, claimableKinds(true))?.kind, 'revise');
  assert.equal(claimNext('w:1', 600_000, claimableKinds(true)), undefined); // the moment waits
  assert.equal(getJob(listJobs({ kind: 'twitch-moment', states: ['queued'] })[0].id)!.creator, 'waits');
  const resumed = claimNext('w:1', 600_000, claimableKinds(false))!;
  assert.equal(resumed.creator, 'waits');
  for (const j of listJobs({ states: ['running'] })) finishJob(j.id, 'w:1', { state: 'done' });
});
