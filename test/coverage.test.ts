// The coverage ledger (src/track/coverage.ts), row by row from the spec's hour-by-hour table (section 5.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claim, complete, fail, markDone, recover, summary, want, type Span } from '../src/track/coverage';

const M = 60_000;
const r = (a: number, b: number) => ({ startMs: a * M, endMs: b * M });
const show = (spans: Span[]) => spans.map((s) => `${s.state} ${s.startMs / M}-${s.endMs / M}${s.jobId ? ` ${s.jobId}` : ''}`);

test('check at 0:43: the first 40 minutes are queued as one job', () => {
  const w = want([], [r(0, 40)], 'J1');
  assert.deepEqual(show(w.spans), ['queued 0-40 J1']);
  assert.equal(w.jobId, 'J1');
});

test('check at 1:03 with J1 still queued: the 40 minutes are overwritten by the whole hour, same job', () => {
  const w = want(want([], [r(0, 40)], 'J1').spans, [r(0, 60)], 'J2');
  assert.deepEqual(show(w.spans), ['queued 0-60 J1']);
  assert.deepEqual(w.added, [r(40, 60)]);
});

test('check at 1:03 with J1 running: J1 keeps 0:00–0:40 and a new job counts from 0:40', () => {
  const running = claim(want([], [r(0, 40)], 'J1').spans, 'J1', 60 * M, 'J1b').spans;
  const w = want(running, [r(0, 60)], 'J2');
  assert.deepEqual(show(w.spans), ['claimed 0-40 J1', 'queued 40-60 J2']);
});

test('check at 1:03 with J1 done: only 0:40–1:00 is queued', () => {
  let s = claim(want([], [r(0, 40)], 'J1').spans, 'J1', 60 * M, 'x').spans;
  s = complete(s, 'J1', [r(0, 40)], 'x');
  assert.deepEqual(show(want(s, [r(0, 60)], 'J2').spans), ['done 0-40 J1', 'queued 40-60 J2']);
});

test('check at 2:03 with J2 still queued: J2 grows to 2:00', () => {
  let s = complete(claim(want([], [r(0, 40)], 'J1').spans, 'J1', 60 * M, 'x').spans, 'J1', [r(0, 40)], 'x');
  s = want(s, [r(0, 60)], 'J2').spans;
  assert.deepEqual(show(want(s, [r(0, 120)], 'J3').spans), ['done 0-40 J1', 'queued 40-120 J2']);
});

test('J1 dies at 0:25: what it finished is done, the rest goes back in line', () => {
  const s = claim(want([], [r(0, 40)], 'J1').spans, 'J1', 60 * M, 'x').spans;
  assert.deepEqual(show(recover(s, [r(0, 25)], 'J9')), ['done 0-25 J1', 'queued 25-40 J9']);
  // and if a job was already queued behind it, the unfinished part joins that job
  const behind = want(s, [r(0, 60)], 'J2').spans;
  assert.deepEqual(show(recover(behind, [r(0, 25)], 'J9')), ['done 0-25 J1', 'queued 25-60 J2']);
});

test('a claim takes at most its budget, from the earliest; the rest stays queued under a new job', () => {
  const c = claim(want([], [r(0, 150)], 'J1').spans, 'J1', 60 * M, 'J2');
  assert.deepEqual(c.claimed, [r(0, 60)]);
  assert.deepEqual(show(c.spans), ['claimed 0-60 J1', 'queued 60-150 J2']);
});

test('done from elsewhere (a scan read the chat) is not queued; a running claim is left alone', () => {
  let s = want([], [r(0, 60)], 'J1').spans;
  s = markDone(s, [r(10, 30)], 'scan');
  assert.deepEqual(show(s), ['queued 0-10 J1', 'done 10-30', 'queued 30-60 J1']);
  const running = claim(s, 'J1', 5 * M, 'J2').spans;
  assert.deepEqual(show(markDone(running, [r(0, 60)])).slice(0, 1), ['claimed 0-5 J1']);
});

test('a failed stretch is recorded with why and asked for again by the next check', () => {
  let s = claim(want([], [r(0, 30)], 'J1').spans, 'J1', 60 * M, 'x').spans;
  s = fail(s, 'J1', 'network');
  assert.deepEqual(show(s), ['failed 0-30 J1']);
  assert.deepEqual(show(want(s, [r(0, 30)], 'J2').spans), ['queued 0-30 J2']);
});

test('nothing to do and nothing queued gives no job', () => {
  const s = markDone([], [r(0, 60)]);
  const w = want(s, [r(0, 60)], 'J1');
  assert.equal(w.jobId, null);
  assert.deepEqual(summary(w.spans, 90 * M).byState.done, 60 * M);
});

test('a live stream is read in 10-minute batches; the time between goes to older gaps; an ended one is flushed', async () => {
  const { readUpTo, unqueueFrom } = await import('../src/track/coverage');
  const B = 10 * M;
  // read to 1:00, live edge at 1:00:05: nothing new is worth a read yet
  let s = complete(claim(want([], [r(0, 60)], 'J1').spans, 'J1', 60 * M, 'x').spans, 'J1', [r(0, 60)], 'x');
  assert.equal(readUpTo(s, 60 * M + 5000, true, B), 60 * M);
  // a 5-second tail left queued by an earlier check is taken back
  s = want(s, [{ startMs: 0, endMs: 60 * M + 5000 }], 'J2').spans;
  assert.deepEqual(show(unqueueFrom(s, readUpTo(s, 60 * M + 5000, true, B))), ['done 0-60 J1']);
  // ten minutes later the batch is due
  assert.equal(readUpTo(s, 70 * M, true, B), 70 * M);
  // older gaps are always wanted: a hole at 0:20–0:30 is read while the tail waits
  const holey = markDone([], [r(0, 20), r(30, 60)]);
  const to = readUpTo(holey, 62 * M, true, B);
  assert.deepEqual(show(want(unqueueFrom(holey, to), [{ startMs: 0, endMs: to }], 'J3').spans), ['done 0-20', 'queued 20-30 J3', 'done 30-60']);
  // the stream ended: its last 2 minutes are read
  assert.equal(readUpTo(holey, 62 * M, false, B), 62 * M);
});
