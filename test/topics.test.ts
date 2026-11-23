// Topics (src/scan/topics.ts): every topic's top 3 eligible streams, every check; listed creators never take a place.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTopics, topicPicks, TopicSchema, type TopicCandidate } from '../src/scan/topics';

const MIN = 60_000;
const topics = [
  TopicSchema.parse({ name: 'GTA 6', twitch: 'Grand Theft Auto VI', minViewers: 10_000, priority: 1.5 }),
  TopicSchema.parse({ name: 'Fortnite', twitch: 'Fortnite', minViewers: 2000, skip: ['fncs'] }),
  TopicSchema.parse({ name: 'League of Legends', twitch: 'League of Legends', minViewers: 3000 }),
];
const stream = (o: Partial<TopicCandidate> & { login: string; viewers: number }): TopicCandidate => ({
  topic: 'GTA 6',
  name: o.login,
  title: 'GTA 6 LAUNCH',
  type: 'live',
  vodId: `${o.login.length}${o.viewers}`,
  vodLengthMs: 120 * MIN,
  recording: true,
  ...o,
});
const ctx = (o: Partial<Parameters<typeof topicPicks>[2]> = {}): Parameters<typeof topicPicks>[2] => ({ watched: new Set(), optedOut: () => false, ...o });
const names = (r: { picks: TopicCandidate[] }, topic?: string) => r.picks.filter((p) => !topic || p.topic === topic).map((p) => p.login);

test('every topic gets its own top 3, so the biggest topic cannot take every place', () => {
  const found = [
    ...['ohnepixel', 'joe', 'jynxzi', 'stable', 'hutch'].map((l, i) => stream({ login: l, viewers: 60_000 - i * 5000 })),
    stream({ login: 'mrsavage', viewers: 2640, topic: 'Fortnite' }),
    ...['tyler1', 'natty', 'drututt', 'small'].map((l, i) => stream({ login: l, viewers: [8383, 4213, 3077, 900][i], topic: 'League of Legends' })),
  ];
  const r = topicPicks(topics, found, ctx());
  assert.deepEqual(names(r, 'GTA 6'), ['ohnepixel', 'joe', 'jynxzi']);
  assert.deepEqual(names(r, 'Fortnite'), ['mrsavage']);
  assert.deepEqual(names(r, 'League of Legends'), ['tyler1', 'natty', 'drututt']);
  assert.match(r.skipped.find((s) => s.login === 'stable')!.why, /not in GTA 6's top 3/);
});

test("a listed creator never takes a topic's place: the next stream does", () => {
  const r = topicPicks(topics, [stream({ login: 'xQc', viewers: 65_000 }), ...['a1', 'b22', 'c333', 'd4444'].map((l, i) => stream({ login: l, viewers: 40_000 - i * 1000 }))], ctx({ watched: new Set(['xqc']) }));
  assert.deepEqual(names(r), ['a1', 'b22', 'c333']);
  assert.match(r.skipped.find((s) => s.login === 'xQc')!.why, /listed creator/);
});

test('a stream already tracked still counts toward its 3 (taking it again is a no-op); one skipped before gives its place', () => {
  const a = stream({ login: 'ohnepixel', viewers: 73_000, vodId: '111' });
  const b = stream({ login: 'typicalgamer', viewers: 50_000, vodId: '222' });
  const rest = ['c1', 'd22', 'e333'].map((l, i) => stream({ login: l, viewers: 30_000 - i * 1000 }));
  const r = topicPicks(topics, [a, b, ...rest], ctx({ unusable: new Map([['tw-222', 'subscriber-only']]) }));
  assert.deepEqual(names(r), ['ohnepixel', 'c1', 'd22']);
  assert.match(r.skipped.find((s) => s.login === 'typicalgamer')!.why, /skipped before: subscriber-only/);
});

test('one channel listed under two topics is one candidate', () => {
  const twoTopics = [...topics, TopicSchema.parse({ name: 'GTA (all)', twitch: 'Grand Theft Auto VI', minViewers: 1000 })];
  const s = stream({ login: 'lacy', viewers: 19_000 });
  const r = topicPicks(twoTopics, [s, { ...s, topic: 'GTA (all)' }], ctx());
  assert.equal(r.picks.filter((p) => p.login === 'lacy').length, 1);
  assert.equal(r.skipped.filter((x) => x.login === 'lacy' && /another topic/.test(x.why)).length, 1);
});

test('reruns, VOD channels, streams with no VOD, small streams, skip lists and opted-out creators are passed over', () => {
  const found = [
    stream({ login: 'happyhappygal_vod', viewers: 30_000 }),
    stream({ login: 'oldshow', viewers: 30_000, type: 'rerun' }),
    stream({ login: 'ishowspeed', viewers: 26_000, vodId: undefined }),
    stream({ login: 'smallgta', viewers: 4000 }),
    stream({ login: 'fncs', viewers: 50_000, topic: 'Fortnite' }),
    stream({ login: 'shy', viewers: 20_000 }),
  ];
  const { picks, skipped } = topicPicks(topics, found, ctx({ optedOut: (l) => l === 'shy' }));
  assert.deepEqual(picks, []);
  const why = Object.fromEntries(skipped.map((s) => [s.login, s.why]));
  assert.match(why.happyhappygal_vod, /rerun or replay/);
  assert.match(why.oldshow, /rerun or replay/);
  assert.match(why.ishowspeed, /no VOD/);
  assert.match(why.smallgta, /under 10000/);
  assert.match(why.fncs, /skip list/);
  assert.match(why.shy, /doNotClip/);
  // a 24/7 marathon is a live stream, not a rerun
  assert.deepEqual(names(topicPicks(topics, [stream({ login: 'lacy', viewers: 19_000, title: 'GTA 6 24/7 MARATHON' })], ctx())), ['lacy']);
});

test('a disabled topic is not read, and topics.json is checked when it loads', () => {
  const off = [TopicSchema.parse({ name: 'GTA 6', twitch: 'Grand Theft Auto VI', enabled: false })];
  assert.deepEqual(topicPicks(off, [stream({ login: 'kaicenat', viewers: 92_000 })], ctx()).picks, []);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'topics-')), 'topics.json');
  fs.writeFileSync(file, JSON.stringify([{ name: 'Fortnite', twitch: 'Fortnite' }]));
  assert.deepEqual(loadTopics(file).map((t) => [t.name, t.minViewers, t.priority, t.enabled]), [['Fortnite', 2000, 1, true]]);
  fs.writeFileSync(file, JSON.stringify([{ name: 'No category' }]));
  assert.throws(() => loadTopics(file));
  assert.deepEqual(loadTopics(path.join(path.dirname(file), 'missing.json')), []);
});

test('the topics.json in the project parses', () => {
  const real = loadTopics(path.join(import.meta.dirname, '..', 'topics.json'));
  assert.ok(real.length >= 3);
  assert.ok(real.some((t) => t.twitch === 'Grand Theft Auto VI'));
});
