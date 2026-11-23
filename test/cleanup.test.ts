// What the hourly cleanup may delete (src/pipeline/cleanup.ts). It deletes for good, so the rules are pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHeavyMedia, rejectedToDelete, sourceMayGo, videosInUse, type ReviewFacts } from '../src/pipeline/cleanup';

const H = 3_600_000;
const now = Date.parse('2026-11-23T12:00:00Z');
const row = (o: Partial<ReviewFacts>): ReviewFacts => ({ clipId: 'c', videoId: 'v', status: 'review', uploadStatus: null, decisionAt: new Date(now).toISOString(), ...o });

test('a rejected clip is deleted only after its grace period', () => {
  const fresh = row({ clipId: 'fresh', status: 'rejected', decisionAt: new Date(now - 30 * 60_000).toISOString() });
  const old = row({ clipId: 'old', status: 'rejected', decisionAt: new Date(now - 61 * 60_000).toISOString() });
  const approved = row({ clipId: 'ok', status: 'approved', decisionAt: new Date(now - 5 * H).toISOString() });
  assert.deepEqual(rejectedToDelete([fresh, old, approved], now, 60).map((r) => r.clipId), ['old']);
});

test('footage stays while a clip of it waits for a decision, changes or an upload, or a job needs it', () => {
  const inUse = videosInUse(
    [
      row({ videoId: 'in-review', status: 'review' }),
      row({ videoId: 'changes', status: 'changes' }),
      row({ videoId: 'approved-waiting', status: 'approved', uploadStatus: 'pending' }),
      row({ videoId: 'approved-held', status: 'approved', uploadStatus: 'held' }),
      row({ videoId: 'uploaded', status: 'approved', uploadStatus: 'uploaded' }),
      row({ videoId: 'rejected', status: 'rejected' }),
    ],
    ['queued-job', undefined, null],
  );
  assert.deepEqual([...inUse].sort(), ['approved-held', 'approved-waiting', 'changes', 'in-review', 'queued-job']);
});

test('a source goes only when it is not in use, was analysed, and has been quiet for the grace period', () => {
  const base = { videoId: 'v', inUse: new Set<string>(), analysed: true, lastActivityMs: now - 25 * H, now, graceHours: 24 };
  assert.equal(sourceMayGo(base), true);
  assert.equal(sourceMayGo({ ...base, inUse: new Set(['v']) }), false, 'in use');
  assert.equal(sourceMayGo({ ...base, analysed: false }), false, 'never analysed: nothing was learned from it yet');
  assert.equal(sourceMayGo({ ...base, lastActivityMs: now - 23 * H }), false, 'touched within the grace period');
  assert.equal(sourceMayGo({ ...base, lastActivityMs: 0 }), false, 'no activity found');
});

test('only footage and audio count as heavy; metadata, transcript, chat and candidates stay', () => {
  for (const f of ['audio', 'sections', 'audio.tmp-123', 'sections.tmp-9', 'video.mp4', 'vod.mkv', 'a.webm', 'chunk.m4a', 'x.ts', 'y.flv']) assert.ok(isHeavyMedia(f), f);
  for (const f of ['meta.json', 'transcript.json', 'chat.json', 'candidates.json', 'signals.json', 'scan.json', 'frames', 'viewer-clips.json']) assert.ok(!isHeavyMedia(f), f);
});
