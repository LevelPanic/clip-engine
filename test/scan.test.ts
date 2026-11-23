// Range scans and repeat passes against a simulated live stream: the broadcast grows between passes,
// chat has known spikes, and only the network and Whisper are faked. Everything else (planning,
// chat merging, spike detection, seed picking, windowed transcripts, scan.json) is the real code.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { planPass, runPass, loadScan, OVERLAP_MS, LIVE_MARGIN_MS } = await import('../src/scan');
const { loadChat, fetchChat } = await import('../src/ingest/chat');
const { ensureTranscribed, mergeTranscript } = await import('../src/ingest/windowed');
const { paths, writeJson, readJsonIf } = await import('../src/core/paths');
const { saveProject, loadProject } = await import('../src/core/project');
const { defaultCaptions, defaultFraming } = await import('../src/core/schemas');
const { discover } = await import('../src/discover');
type ChatMessage = [number, string, string];
type Range = { startMs: number; endMs: number };

const MIN = 60_000;

// ---------- planPass ----------

test('plan: first pass from a start time to 3 min short of live', () => {
  const p = planPass({ durationMs: 60 * MIN, live: true, scanned: [], fromMs: 20 * MIN, cont: false });
  assert.deepEqual(p, { fromMs: 20 * MIN, toMs: 60 * MIN - LIVE_MARGIN_MS, newMs: 37 * MIN });
});

test('plan: continue starts 2 min before the last pass ended', () => {
  const p = planPass({ durationMs: 80 * MIN, live: true, scanned: [{ startMs: 20 * MIN, endMs: 57 * MIN }], cont: true });
  assert.ok(!('upToDate' in p));
  assert.equal(p.fromMs, 57 * MIN - OVERLAP_MS);
  assert.equal(p.toMs, 77 * MIN);
  assert.equal(p.newMs, 20 * MIN);
});

test('plan: a live stream with under a minute new waits', () => {
  const p = planPass({ durationMs: 60.5 * MIN, live: true, scanned: [{ startMs: 0, endMs: 57 * MIN }], cont: true });
  assert.ok('upToDate' in p);
});

test('plan: once the stream ends, the last pass goes to the very end', () => {
  const p = planPass({ durationMs: 60.5 * MIN, live: false, scanned: [{ startMs: 0, endMs: 57 * MIN }], cont: true });
  assert.ok(!('upToDate' in p));
  assert.equal(p.toMs, 60.5 * MIN);
});

test('plan: nothing left after the final pass', () => {
  assert.ok('upToDate' in planPass({ durationMs: 60 * MIN, live: false, scanned: [{ startMs: 0, endMs: 60 * MIN }], cont: true }));
});

test('plan: a start past the end is an error; --to is capped at what exists', () => {
  assert.throws(() => planPass({ durationMs: 30 * MIN, live: false, scanned: [], fromMs: 45 * MIN, cont: false }), /past the end/);
  const p = planPass({ durationMs: 30 * MIN, live: true, scanned: [], fromMs: 10 * MIN, toMs: 90 * MIN, cont: false });
  assert.ok(!('upToDate' in p) && p.toMs === 27 * MIN);
});

test('plan: a stream younger than the live margin waits', () => {
  assert.ok('upToDate' in planPass({ durationMs: 2 * MIN, live: true, scanned: [], cont: false }));
});

test('plan: --continue with nothing scanned yet starts at --from', () => {
  const p = planPass({ durationMs: 30 * MIN, live: false, scanned: [], fromMs: 5 * MIN, cont: true });
  assert.ok(!('upToDate' in p) && p.fromMs === 5 * MIN);
});

// ---------- a simulated live stream ----------

const VID = 'tw-1000000001';
// the moments: chat explodes just after each (funny at 25:00, hype at 66:30 near a pass edge, shock at 78:00)
const MOMENTS = [
  { at: 25 * MIN, text: 'KEKW KEKW' },
  { at: 66.5 * MIN, text: 'POGGERS' },
  { at: 78 * MIN, text: '???' },
];
function worldChat(from: number, to: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let t = Math.ceil(from / 10_000) * 10_000; t < to; t += 10_000) for (let k = 0; k < 3; k++) out.push([t + k * 3000, `viewer${(t / 10_000 + k) % 40}`, 'chatting']);
  for (const m of MOMENTS) for (let k = 0; k < 30; k++) {
    const ms = m.at + 6_000 + k * 300; // chat reacts ~6 s after the moment
    if (ms >= from && ms < to) out.push([ms, `fan${k}`, m.text]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

const stream = { lengthMs: 0, live: true };
const calls = { chat: [] as Range[], transcribe: [] as Range[] };

const deps = {
  refreshMeta: async (id: string) => {
    const meta = {
      id, url: 'https://www.twitch.tv/videos/1000000001', platform: 'twitch' as const, title: 'Test stream', channel: 'Tester', login: 'tester',
      live: stream.live, startedAt: '2026-11-09T10:00:00Z', durationMs: stream.lengthMs, hasHeatmap: false, chapters: [], heatmap: [], captions: 'none' as const, commentCount: 0, ingestedAt: '2026-11-09T10:00:00Z',
    };
    writeJson(paths.videoFile(id, 'meta.json'), meta);
    if (!fs.existsSync(paths.videoFile(id, 'info.json'))) writeJson(paths.videoFile(id, 'info.json'), { id, title: 'Test stream' });
    if (!fs.existsSync(paths.videoFile(id, 'sponsor.json'))) writeJson(paths.videoFile(id, 'sponsor.json'), []);
    return meta;
  },
  // the real fetchChat (which skips what's on disk) over a fake Twitch API that serves worldChat
  fetchChat: (id: string, ranges: Range[]) =>
    fetchChat(id, ranges, {
      chat: async (_vod: string, fromMs: number, toMs: number) => {
        calls.chat.push({ startMs: fromMs, endMs: toMs });
        return { messages: worldChat(fromMs, Math.min(toMs, stream.lengthMs)), disabled: false };
      },
    } as never),
  fetchViewerClips: async () => 0,
  audio: async () => {},
  transcribe: (id: string, ranges: Range[]) =>
    ensureTranscribed(id, ranges, () => {}, {
      downloadAudio: async () => {},
      whisper: async (_id, r) => {
        calls.transcribe.push(r);
        const words = [];
        for (let t = r.startMs; t < r.endMs; t += 1000) words.push({ i: 0, startMs: t, endMs: t + 400, text: t % 10_000 === 0 ? 'okay.' : 'word' });
        return { words, tags: [] };
      },
    }),
  discover: (id: string, range: Range) => discover(id, { range }),
};

test('repeat passes over a live stream find every moment once and never re-fetch chat', async () => {
  // pass 1 at 40:00 of stream time, from 20:00
  stream.lengthMs = 40 * MIN;
  const p1 = await runPass(VID, { fromMs: 20 * MIN }, deps);
  assert.ok('pass' in p1);
  assert.equal(p1.pass.fromMs, 20 * MIN);
  assert.equal(p1.pass.toMs, 37 * MIN);
  assert.ok(p1.signals.seeds.some((s) => s.peakMs <= 25 * MIN + 10_000 && s.endMs >= 25 * MIN), 'the 25:00 moment is a seed');
  assert.ok(p1.signals.seeds.every((s) => s.peakMs >= 20 * MIN && s.peakMs <= 37 * MIN), 'seeds stay inside the range');

  // 30 s later: not enough new yet
  stream.lengthMs = 40.5 * MIN;
  const early = await runPass(VID, { cont: true }, deps);
  assert.ok('upToDate' in early);

  // pass 2 at 68:00: the 66:30 moment's chat (66:36–66:45) is past the 65:00 edge, so it isn't seen yet
  stream.lengthMs = 68 * MIN;
  const p2 = await runPass(VID, { cont: true }, deps);
  assert.ok('pass' in p2);
  assert.equal(p2.pass.fromMs, 37 * MIN - OVERLAP_MS);
  assert.equal(p2.pass.toMs, 65 * MIN);

  // the stream ends at 80:00: the last pass covers 63:00 → 80:00 and catches both late moments
  stream.lengthMs = 80 * MIN;
  stream.live = false;
  const p3 = await runPass(VID, { cont: true }, deps);
  assert.ok('pass' in p3);
  assert.equal(p3.pass.toMs, 80 * MIN);
  for (const at of [66.5 * MIN, 78 * MIN]) assert.ok(p3.signals.seeds.some((s) => s.startMs <= at && s.endMs >= at), `moment at ${at / MIN} min is a seed`);

  const done = await runPass(VID, { cont: true }, deps);
  assert.ok('upToDate' in done);

  // chat: fetched once per stretch, contiguous from 6 min before the first pass to the end
  const chat = loadChat(VID)!;
  assert.deepEqual(chat.fetched, [{ startMs: 14 * MIN, endMs: 80 * MIN }]);
  const overlaps = calls.chat.some((a, i) => calls.chat.some((b, j) => i < j && Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs) > 0));
  assert.ok(!overlaps, 'no chat range fetched twice');

  // transcript: only windows around seeds, words in order with consecutive numbers
  const t = readJsonIf<{ words: { i: number; startMs: number }[]; covered: Range[] }>(paths.videoFile(VID, 'transcript.json'))!;
  assert.ok(t.covered.length >= 2);
  t.words.forEach((w, i) => assert.equal(w.i, i));
  for (let i = 1; i < t.words.length; i++) assert.ok(t.words[i].startMs >= t.words[i - 1].startMs);
  const coveredMs = t.covered.reduce((a, r) => a + r.endMs - r.startMs, 0);
  assert.ok(coveredMs < 0.5 * 80 * MIN, 'far less than the whole stream is transcribed');

  assert.equal(loadScan(VID).passes.length, 3);
  assert.ok(!fs.existsSync(paths.videoFile(VID, 'scan.lock')), 'lock released');
});

test('a second scan of the same video while one runs is refused', async () => {
  const id = 'tw-1000000002';
  fs.mkdirSync(paths.video(id), { recursive: true });
  fs.writeFileSync(paths.videoFile(id, 'scan.lock'), String(process.ppid)); // a live process that isn't us
  await assert.rejects(runPass(id, {}, deps), /already running/);
  fs.rmSync(paths.videoFile(id, 'scan.lock'));
});

test('a stale lock from a dead process is ignored', async () => {
  const id = 'tw-1000000003';
  fs.mkdirSync(paths.video(id), { recursive: true });
  fs.writeFileSync(paths.videoFile(id, 'scan.lock'), '999999');
  stream.lengthMs = 10 * MIN;
  stream.live = false;
  const r = await runPass(id, {}, deps);
  assert.ok('pass' in r);
});

test('caption fixes follow their words when a new window is transcribed before them', async () => {
  const id = 'tw-1000000004';
  const w = (startMs: number, text: string) => ({ i: 0, startMs, endMs: startMs + 400, text });
  const first = mergeTranscript(id, undefined, { words: [w(600_000, 'hello'), w(601_000, 'wrold'), w(602_000, 'again')], tags: [] }, { startMs: 600_000, endMs: 610_000 });
  writeJson(paths.videoFile(id, 'transcript.json'), first);
  const now = new Date().toISOString();
  saveProject({ version: 1, rev: 0, id: `${id}-c01`, videoId: id, title: 't', sourceDurationMs: 3_600_000, fps: 30, segments: [{ startMs: 600_000, endMs: 620_000 }], markers: [], captions: { ...defaultCaptions(), fixes: { '1': 'world' } }, framing: defaultFraming(), createdAt: now, updatedAt: now });
  // a window earlier in the stream adds 5 words before them, so "wrold" goes from word 1 to word 6
  const { remapCaptionFixes } = await import('../src/ingest/ingest');
  const next = mergeTranscript(id, first, { words: [100_000, 101_000, 102_000, 103_000, 104_000].map((t) => w(t, 'x')), tags: [] }, { startMs: 100_000, endMs: 110_000 });
  remapCaptionFixes(id, first, next);
  assert.equal(next.words[6].text, 'wrold');
  assert.deepEqual(loadProject(`${id}-c01`).captions.fixes, { '6': 'world' });
});
