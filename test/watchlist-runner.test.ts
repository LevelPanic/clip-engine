// What a failed watchlist job becomes (src/track/runner.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobEnding, retryable } from '../src/track/runner';

const job = { kind: 'twitch-moment', attempts: 0, interrupted: 0 };

test('a timeout or a network error is retried once, from the last checkpoint', () => {
  assert.deepEqual(jobEnding(job, 'queue-check: timed out after 40 min', 1), { kind: 'retry', error: 'attempt 1 failed: queue-check: timed out after 40 min' });
  assert.equal(jobEnding({ ...job, attempts: 1 }, 'ECONNRESET', 1).kind, 'fail', 'one retry only');
  assert.equal(retryable('HTTP Error 503'), true);
  assert.equal(retryable('the curator found nothing to keep'), false);
});

test('a restart puts the job back in line, three times at most', () => {
  assert.equal(jobEnding(job, 'interrupted', 1).kind, 'requeue-interrupted');
  assert.equal(jobEnding({ ...job, interrupted: 3 }, 'interrupted', 1).kind, 'fail');
});

test('anything else fails the job', () => {
  assert.equal(jobEnding(job, 'extract: no confirmed moments', 1).kind, 'fail');
});
