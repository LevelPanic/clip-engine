// A YouTube stream read while live has no stable timeline: nothing is cut from it (src/ingest/media.ts).
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { liveFromStart, youtubeLive } = await import('../src/ingest/media');
const { paths, writeJson } = await import('../src/core/paths');
const fs = await import('node:fs');

const info = (id: string, live_status: string) => {
  fs.mkdirSync(paths.video(id), { recursive: true });
  writeJson(paths.videoFile(id, 'info.json'), { id, title: 'stream', live_status });
};

test('footage is refused while a YouTube stream is live, processing or not started; a finished one is fine', () => {
  info('ytLive00001', 'is_live');
  info('ytPost00001', 'post_live');
  info('ytDone00001', 'was_live');
  assert.throws(() => liveFromStart('ytLive00001'), /still live.*--refresh/);
  assert.throws(() => liveFromStart('ytPost00001'), /still processing/);
  assert.deepEqual(liveFromStart('ytDone00001'), []);
  assert.equal(youtubeLive('ytDone00001'), undefined);
});

test('Twitch broadcasts are read from their start while live, as before', () => {
  fs.mkdirSync(paths.video('tw-123'), { recursive: true });
  writeJson(paths.videoFile('tw-123', 'meta.json'), { live: true });
  assert.deepEqual(liveFromStart('tw-123'), ['--live-from-start']);
});
