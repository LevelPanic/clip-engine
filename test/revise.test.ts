// Change requests become revise jobs once each (src/track/revise.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisionKey, revisionsToQueue } from '../src/track/revise';

const row = (clipId: string, note: string | null, decisionAt = '2026-11-20T11:21:00Z', videoId = 'tw-1', status = 'changes') => ({ clipId, videoId, status: status as 'changes', note, decisionAt });

test('a clip sent back with a note is revised once per request; a new request on it runs again', () => {
  const ducks = row('tw-1-c01', 'cant see where the ducks are getting hurt');
  assert.deepEqual(revisionsToQueue([ducks], new Set(), () => false).map((r) => r.clipId), ['tw-1-c01']);
  assert.deepEqual(revisionsToQueue([ducks], new Set([revisionKey(ducks)]), () => false), [], 'asked already (done or failed)');
  const again = row('tw-1-c01', 'still unclear', '2026-11-20T15:00:00Z');
  assert.deepEqual(revisionsToQueue([again], new Set([revisionKey(ducks)]), () => false).length, 1);
});

test('no note, decided again since, or footage editing cannot fix: not queued', () => {
  assert.deepEqual(revisionsToQueue([row('a', '  ')], new Set(), () => false), []);
  assert.deepEqual(revisionsToQueue([row('b', 'fix it', undefined, 'tw-1', 'approved')], new Set(), () => false), []);
  assert.deepEqual(revisionsToQueue([row('hwSg39yIBGU-c01', 'same video?', undefined, 'hwSg39yIBGU')], new Set(), (v) => v === 'hwSg39yIBGU'), []);
});
