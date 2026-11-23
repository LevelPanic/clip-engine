// Upload scheduling: first clip +5 minutes, each next one +5 minutes after that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPublishSlot } from '../src/publish/youtube';

const MIN = 60_000;
const at = (now: number, minutes: number) => new Date(now + minutes * MIN).toISOString();

test('an empty queue schedules the first upload five minutes out', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.equal(nextPublishSlot([], now), at(now, 5));
});

test('the next upload takes the next five-minute slot', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  const queued = [at(now, 5), at(now, 10)];
  assert.equal(nextPublishSlot(queued, now), at(now, 15));
});

test('old schedules do not push a new batch', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.equal(nextPublishSlot([at(now, -30), at(now, -5)], now), at(now, 5));
});

test('a schedule far in the future is treated as a different batch', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.equal(nextPublishSlot([at(now, 60 * 5)], now), at(now, 5));
});
