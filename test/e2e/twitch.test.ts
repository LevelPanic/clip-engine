// End to end against real Twitch: network, yt-dlp, ffmpeg, the audio classifier and Whisper. Slow
// (a few minutes) and opt-in: `npm run test:e2e`. Runs in a throwaway data folder, so the real
// library is never touched. Twitch past broadcasts expire, so it finds a recent ended one by itself
// (or set E2E_TWITCH_VOD=<number>).
import '../helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const skip = !process.env.E2E && 'set E2E=1 (npm run test:e2e)';
const { twitchApi } = await import('../../src/ingest/twitch');
const api = twitchApi();
const MIN = 60_000;

async function endedBroadcast(): Promise<string> {
  if (process.env.E2E_TWITCH_VOD) return process.env.E2E_TWITCH_VOD;
  for (const login of ['tarik', 'caseoh_', 'xqc', 'zackrawrr', 'kaicenat', 'jynxzi']) {
    const b = await api.latestBroadcast(login).catch(() => null);
    if (b && !b.live) return b.vodId;
  }
  throw new Error('no ended broadcast found; set E2E_TWITCH_VOD');
}

test('the Twitch web API answers every query the tool uses', { skip }, async () => {
  const vod = await endedBroadcast();
  const v = await api.video(vod);
  assert.ok(v && v.lengthMs > 10 * MIN && v.login, 'broadcast details');
  assert.ok(Array.isArray(await api.mutedSegments(vod)));
  const chat = await api.chat(vod, 5 * MIN, 7 * MIN);
  assert.ok(chat.disabled || chat.messages.length > 0, 'chat replay');
  assert.ok(chat.messages.every((m) => m[0] >= 5 * MIN && m[0] < 7 * MIN));
  const clips = await api.clips(v!.login, 'LAST_MONTH');
  assert.ok(Array.isArray(clips));
  if (clips[0]) assert.equal((await api.clip(clips[0].slug))?.slug, clips[0].slug);
});

test('a real scan pass: chat, viewer clips, audio, seeds and transcript windows', { skip, timeout: 15 * MIN }, async () => {
  const vod = await endedBroadcast();
  const id = `tw-${vod}`;
  const { ingest } = await import('../../src/ingest/ingest');
  const { runPass, loadScan } = await import('../../src/scan');
  const { paths, readJsonIf } = await import('../../src/core/paths');
  await ingest(id, { audio: true, full: false, refresh: false, wait: false, log: () => {} });
  const meta = readJsonIf<{ durationMs: number; live: boolean }>(paths.videoFile(id, 'meta.json'))!;
  const from = Math.min(30 * MIN, meta.durationMs - 12 * MIN);
  const r = await runPass(id, { fromMs: from, toMs: from + 8 * MIN });
  assert.ok('pass' in r, 'a pass ran');
  assert.deepEqual([r.pass.fromMs, r.pass.toMs], [from, from + 8 * MIN]);
  assert.ok(r.signals.seeds.every((s) => s.peakMs >= from && s.peakMs <= from + 8 * MIN), 'seeds inside the range');
  const chat = readJsonIf<{ fetched: { startMs: number; endMs: number }[] }>(paths.videoFile(id, 'chat.json'));
  assert.ok(chat?.fetched.some((f) => f.startMs <= from && f.endMs >= from + 8 * MIN), 'chat fetched for the range');
  assert.ok(fs.existsSync(paths.videoFile(id, 'audio')), 'audio chunk downloaded');
  const events = readJsonIf<{ covered: { startMs: number; endMs: number }[] }>(paths.videoFile(id, 'audio-events.json'));
  assert.ok(events?.covered.some((c) => c.startMs <= from && c.endMs >= from + 8 * MIN), 'audio analysed for the range');
  if (r.signals.seeds.length) {
    const t = readJsonIf<{ words: unknown[]; covered: unknown[] }>(paths.videoFile(id, 'transcript.json'));
    assert.ok(t && t.covered.length > 0 && t.words.length > 0, 'windows around seeds transcribed');
  }
  // a second --continue on an ended broadcast scans the rest; nothing is fetched twice
  const again = await runPass(id, { fromMs: from, toMs: from + 8 * MIN });
  assert.ok('pass' in again && again.pass.chatMessages === 0, 'chat for a scanned range is not fetched again');
  assert.equal(loadScan(id).passes.length, 2);
});

test('a Twitch video section is recorded at its real start (to the frame)', { skip, timeout: 5 * MIN }, async () => {
  const vod = await endedBroadcast();
  const id = `tw-${vod}`;
  const { ingest } = await import('../../src/ingest/ingest');
  const { downloadSections, downloadAudioRanges, measureSectionStart } = await import('../../src/jobs/downloads');
  const { listSections } = await import('../../src/ingest/media');
  await ingest(id, { audio: true, full: false, refresh: false, wait: false, log: () => {} });
  const asked = { startMs: 20 * MIN + 1_234, endMs: 20 * MIN + 31_234 };
  await downloadAudioRanges(id, [{ startMs: asked.startMs - 60_000, endMs: asked.endMs + 30_000 }], () => {});
  await downloadSections(id, [asked], () => {});
  const s = listSections(id).find((x) => x.startMs <= asked.startMs && x.endMs >= asked.endMs - 1000);
  assert.ok(s, `a section covers the asked range; have ${JSON.stringify(listSections(id).map((x) => [x.startMs, x.endMs, x.durationMs]))}`);
  // measured again against the exact audio chunk, the recorded start must hold to within a frame
  const again = await measureSectionStart(id, s!.file, s!.startMs);
  assert.ok(again && Math.abs(again.startMs - s!.startMs) <= 40, `recorded ${s!.startMs}, measured ${again?.startMs}`);
});
