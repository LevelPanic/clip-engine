// Links → library ids, and the Twitch client's paging and failure handling against a fake API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, parseSource, sourceOf, parseLinkTime } from '../src/ingest/source';
import { mergeRanges, subtractRanges, covers } from '../src/core/ranges';
import { twitchApi, clipsForBroadcast, estimateClipOffset, type Fetch } from '../src/ingest/twitch';

test('YouTube links keep their plain 11-character ids', () => {
  for (const u of ['https://www.youtube.com/watch?v=2v99_8xJoqA', 'youtu.be/2v99_8xJoqA', 'https://youtube.com/shorts/2v99_8xJoqA', '2v99_8xJoqA', 'https://m.youtube.com/watch?v=2v99_8xJoqA&t=754'])
    assert.equal(parseSource(u).id, '2v99_8xJoqA', u);
  assert.equal(parseSource('https://www.youtube.com/watch?v=2v99_8xJoqA&t=754').atMs, 754_000);
});

test('Twitch broadcast links become tw-<vod>', () => {
  for (const u of ['https://www.twitch.tv/videos/2921546465', 'twitch.tv/videos/2921546465?t=1h2m3s', 'https://m.twitch.tv/videos/2921546465', 'https://www.twitch.tv/xqc/v/2921546465', 'v2921546465', 'tw-2921546465'])
    assert.equal(parseSource(u).id, 'tw-2921546465', u);
  assert.equal(parseSource('https://www.twitch.tv/videos/2921546465?t=1h2m3s').atMs, 3_723_000);
  assert.equal(sourceOf('tw-2921546465').url, 'https://www.twitch.tv/videos/2921546465');
  assert.equal(sourceOf('2v99_8xJoqA').platform, 'youtube');
});

test('channels and clips are recognised, and refused where one video is needed', () => {
  assert.deepEqual(parseInput('https://www.twitch.tv/xQc'), { kind: 'twitch-channel', login: 'xqc' });
  assert.deepEqual(parseInput('xqc'), { kind: 'twitch-channel', login: 'xqc' });
  assert.deepEqual(parseInput('@KaiCenat'), { kind: 'twitch-channel', login: 'kaicenat' });
  assert.equal(parseInput('@kaicenat123').kind, 'twitch-channel'); // 11 characters: the @ makes it a channel
  assert.deepEqual(parseInput('https://www.twitch.tv/xqc/clip/MissileSlug-abc'), { kind: 'twitch-clip', slug: 'MissileSlug-abc' });
  assert.deepEqual(parseInput('https://clips.twitch.tv/MissileSlug-abc'), { kind: 'twitch-clip', slug: 'MissileSlug-abc' });
  assert.throws(() => parseSource('https://www.twitch.tv/xqc'), /clip watch xqc/);
  assert.throws(() => parseSource('https://www.twitch.tv/directory/game/Chess'), /Can't find a Twitch broadcast/);
  assert.throws(() => parseSource('https://vimeo.com/123'), /not a YouTube or Twitch link/);
  assert.throws(() => parseSource('hello world'), /not a YouTube or Twitch link/);
});

test('link times', () => {
  assert.equal(parseLinkTime('1h2m3s'), 3_723_000);
  assert.equal(parseLinkTime('45m'), 2_700_000);
  assert.equal(parseLinkTime('754'), 754_000);
  assert.equal(parseLinkTime('soon'), undefined);
});

test('ranges merge, subtract and cover', () => {
  assert.deepEqual(mergeRanges([{ startMs: 10, endMs: 20 }, { startMs: 0, endMs: 5 }, { startMs: 18, endMs: 30 }, { startMs: 40, endMs: 40 }]), [{ startMs: 0, endMs: 5 }, { startMs: 10, endMs: 30 }]);
  assert.deepEqual(subtractRanges([{ startMs: 0, endMs: 100 }], [{ startMs: 20, endMs: 30 }, { startMs: 50, endMs: 120 }]), [{ startMs: 0, endMs: 20 }, { startMs: 30, endMs: 50 }]);
  assert.ok(covers([{ startMs: 0, endMs: 50 }, { startMs: 50, endMs: 100 }], { startMs: 10, endMs: 90 }));
  assert.ok(!covers([{ startMs: 0, endMs: 50 }], { startMs: 10, endMs: 90 }));
});

// ---------- the Twitch client against a fake API ----------

type Msg = { id: string; contentOffsetSeconds: number; commenter: { login: string }; message: { fragments: { text: string }[] } };
/** A fake gql.twitch.tv: chat pages of `pageSize` from an offset (starting a few seconds early, like Twitch). */
function fakeTwitch(chat: Msg[], o: { pageSize?: number; integrity?: boolean; disabled?: boolean; missing?: boolean } = {}) {
  const requests: unknown[] = [];
  const f: Fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (Array.isArray(body) && body[0].operationName === 'VideoCommentsByOffsetOrCursor') {
      const v = body[0].variables;
      if (o.missing) return json([{ data: { video: null } }]);
      if (v.cursor || o.integrity) return json([{ errors: [{ message: 'failed integrity check' }], data: { video: { id: '1', comments: null } } }]);
      if (o.disabled) return json([{ data: { video: { id: '1', comments: null } } }]);
      const page = chat.filter((m) => m.contentOffsetSeconds >= v.contentOffsetSeconds - 3).slice(0, o.pageSize ?? 50);
      return json([{ data: { video: { id: '1', comments: { edges: page.map((node) => ({ cursor: 'c', node })) } } } }]);
    }
    return json({ data: {} });
  };
  return { api: twitchApi(f), requests };
}
const msgs = (n: number, perSec: number, startSec = 0): Msg[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}`, contentOffsetSeconds: startSec + Math.floor(i / perSec), commenter: { login: `u${i % 97}` }, message: { fragments: [{ text: `msg ${i}` }] } }));

test('chat pages by offset, never by cursor, and returns each message once, in order', async () => {
  const { api, requests } = fakeTwitch(msgs(3000, 4)); // 4 per second, 750 s
  const r = await api.chat('1', 100_000, 400_000);
  assert.equal(r.messages.length, 1200); // 300 s × 4
  assert.equal(new Set(r.messages.map((m) => m[2])).size, 1200);
  assert.ok(r.messages.every((m, i) => i === 0 || m[0] >= r.messages[i - 1][0]));
  assert.ok(r.messages.every((m) => m[0] >= 100_000 && m[0] < 400_000));
  assert.ok(requests.every((b) => !(b as { variables: { cursor?: string } }[])[0].variables.cursor), 'no cursor requests');
});

test('a second with more messages than a page holds does not stall paging', async () => {
  const dense = msgs(500, 200, 10); // 200 a second for 2.5 s, page of 50
  const { api, requests } = fakeTwitch([...dense, ...msgs(40, 1, 20).map((m) => ({ ...m, id: `late${m.id}` }))], { pageSize: 50 });
  const r = await api.chat('1', 0, 60_000);
  assert.ok(requests.length < 200, `${requests.length} requests`);
  assert.ok(r.messages.some((m) => m[0] >= 20_000), 'reaches the messages after the dense part');
});

test('a refused chat replay is an error, chat turned off is "disabled", a missing broadcast is an error', async () => {
  await assert.rejects(fakeTwitch(msgs(10, 1), { integrity: true }).api.chat('1', 0, 10_000), /refused the chat replay/);
  assert.equal((await fakeTwitch([], { disabled: true }).api.chat('1', 0, 10_000)).disabled, true);
  await assert.rejects(fakeTwitch([], { missing: true }).api.chat('1', 0, 10_000), /no broadcast/);
});

test('viewer clips: exact offsets kept, missing ones estimated, other broadcasts dropped', () => {
  const vod = { id: '42', createdAt: '2026-11-09T10:00:00Z', lengthMs: 4 * 3_600_000 };
  const clips = [
    { slug: 'a', title: 'exact', views: 100, durationMs: 30_000, createdAt: '2026-11-09T11:00:30Z', offsetMs: 3_600_000, exact: true, vodId: '42' },
    { slug: 'b', title: 'other stream', views: 900, durationMs: 30_000, createdAt: '2026-11-08T11:00:00Z', offsetMs: 100, exact: true, vodId: '41' },
    { slug: 'c', title: 'no vod link', views: 5, durationMs: 20_000, createdAt: '2026-11-09T12:00:20Z', offsetMs: 0, exact: false },
    { slug: 'd', title: 'before the stream', views: 5, durationMs: 20_000, createdAt: '2026-11-09T09:00:00Z', offsetMs: 0, exact: false },
  ];
  const got = clipsForBroadcast(clips, vod);
  assert.deepEqual(got.map((c) => c.slug), ['a', 'c']);
  assert.equal(got[1].offsetMs, 2 * 3_600_000); // created 2:00:20 in, minus 20 s
  assert.equal(estimateClipOffset({ createdAt: '2026-11-09T10:00:10Z', durationMs: 30_000 }, vod.createdAt), 0); // never negative
});

test('bot clips are dropped: tell-tale titles and accounts that clip constantly for nobody', () => {
  const vod = { id: '42', createdAt: '2026-11-09T10:00:00Z', lengthMs: 4 * 3_600_000 };
  const c = (slug: string, title: string, views: number, curator: string) => ({ slug, title, views, durationMs: 30_000, createdAt: '2026-11-09T11:00:00Z', offsetMs: 3_600_000, exact: true, vodId: '42', curator });
  const clips = [
    c('person', 'he actually did it', 40, 'fan1'),
    c('bot1', 'xQc: Viewer signal: +696 viewers (+3.5%) | Chat burst 1.4x b', 1, 'clipper'),
    ...Array.from({ length: 9 }, (_, k) => c(`spam${k}`, `moment ${k}`, 1, 'autoclipper')),
    c('named', 'insane play', 2, 'highlightbot'),
  ];
  assert.deepEqual(clipsForBroadcast(clips, vod).map((x) => x.slug), ['person']);
});

// ---------- section alignment ----------
import { envelope, bestLag, sectionStartFromAudio, ALIGN } from '../src/ingest/align';

/** Speech-like test audio: bursts of noise with random gaps, deterministic. */
function fakeAudio(ms: number, seed = 7): Int16Array {
  const out = new Int16Array((ms / 1000) * ALIGN.rate);
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let i = 0;
  while (i < out.length) {
    const len = Math.floor((0.1 + rnd() * 0.6) * ALIGN.rate);
    const loud = rnd() < 0.6 ? 2000 + rnd() * 8000 : 50;
    for (let j = 0; j < len && i < out.length; j++, i++) out[i] = Math.round((rnd() * 2 - 1) * loud);
  }
  return out;
}

test('a section that starts 6.63 s early is measured back to its real start', () => {
  const stream = fakeAudio(60_000); // source audio 0–60 s
  const asked = 30_000;
  const realStart = asked - 6_630; // what Twitch actually handed back
  const probe = stream.slice((realStart / 1000) * ALIGN.rate, ((realStart + ALIGN.probeMs) / 1000) * ALIGN.rate);
  const refFrom = asked - ALIGN.searchMs;
  const ref = stream.slice((refFrom / 1000) * ALIGN.rate, ((asked + ALIGN.probeMs + 5_000) / 1000) * ALIGN.rate);
  const got = sectionStartFromAudio(probe, ref, refFrom);
  assert.ok(got, 'matched');
  assert.ok(Math.abs(got!.startMs - realStart) <= ALIGN.stepMs, `measured ${got!.startMs}, real ${realStart}`);
});

test('silence gives no confident match (the caller keeps the asked time and says so)', () => {
  const quiet = new Int16Array(25 * ALIGN.rate);
  assert.equal(sectionStartFromAudio(quiet.slice(0, 20 * ALIGN.rate), quiet, 0), null);
});

test('bestLag finds an exact shift', () => {
  const a = envelope(fakeAudio(30_000, 3), ALIGN.rate);
  assert.equal(bestLag(a.slice(700, 1700), a).lag, 700);
});
