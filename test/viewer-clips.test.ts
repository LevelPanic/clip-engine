// Viewer clips are evidence that accumulates: a refresh adds and updates, it never erases (src/ingest/chat.ts).
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TwitchApi, ViewerClip } from '../src/ingest/twitch';

const { mergeViewerClips, fetchViewerClips, loadViewerClips } = await import('../src/ingest/chat');

const clip = (slug: string, views: number, offsetMs: number, exact = true): ViewerClip => ({ slug, title: slug, views, durationMs: 30_000, createdAt: '2026-11-19T12:00:00Z', offsetMs, exact, vodId: '555', curator: slug });

test('a clip seen once stays; views only go up; an exact offset beats an estimate', () => {
  const known = [clip('big', 291_583, 21_270_000), clip('est', 50, 1_000_000, false)];
  assert.deepEqual(mergeViewerClips(known, []).map((c) => c.slug), ['big', 'est'], 'an empty refresh erases nothing');
  const m = mergeViewerClips(known, [clip('big', 478_600, 21_270_000), clip('est', 40, 1_200_000, true), clip('new', 900, 5_000_000)]);
  assert.deepEqual(m.map((c) => [c.slug, c.views]), [['big', 478_600], ['new', 900], ['est', 50]]);
  assert.equal(m.find((c) => c.slug === 'est')!.offsetMs, 1_200_000, 'the exact offset replaces the estimate');
  const back = mergeViewerClips([clip('x', 10, 7_000, true)], [clip('x', 12, 9_000, false)]);
  assert.equal(back[0].offsetMs, 7_000, 'an estimate never replaces an exact offset');
});

test('a refresh whose page lost this broadcast keeps the clips and records how much came back', async () => {
  let page: ViewerClip[] = [clip('a', 300, 60_000), clip('b', 120, 600_000)];
  const api = { clips: async () => page } as unknown as TwitchApi;
  const vod = { login: 'someone', startedAt: new Date(Date.now() - 3_600_000).toISOString(), durationMs: 3 * 3_600_000 };
  assert.equal((await fetchViewerClips('tw-555', api, vod)).length, 2);
  page = []; // a newer broadcast's clips filled the channel's page
  assert.equal((await fetchViewerClips('tw-555', api, vod)).length, 2);
  const file = loadViewerClips('tw-555')!;
  assert.deepEqual(file.fetches!.map((f) => f.returned), [2, 0]);
});
