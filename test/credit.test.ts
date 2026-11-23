// The channel posts other people's streams, so every clip says whose it is: a line on screen for the
// whole clip, and a credit under the post with the creator's channel, the source at the second the
// clip starts, and what this channel is.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate, VideoMeta } from '../src/core/schemas';

const { writeJson, paths } = await import('../src/core/paths');
const { creditBlock, creditLine, linkTime, sourceLink, suggestPost, suggestTitles, postFor, postBody } = await import('../src/core/post');
const { loadChannel, channelFile, optedOut, uncredited, ChannelSchema } = await import('../src/core/channel');
const { projectFromCandidate, saveProject, suggestedPost, setCredit, loadProject, CREDIT } = await import('../src/core/project');
const fs = await import('node:fs');

const twitch = { platform: 'twitch' as const, videoId: 'tw-2927311587', url: 'https://www.twitch.tv/videos/2927311587', channel: 'caseoh_', login: 'caseoh_', title: '🟨LOSING MY MIND🟨', game: 'Just Chatting' };
const youtube = { platform: 'youtube' as const, videoId: 'Hn0cZBN1JfA', url: 'https://www.youtube.com/watch?v=Hn0cZBN1JfA', channel: 'Some Podcast', title: 'Episode 12' };
const me = { name: 'Clip Engine', disclosure: '🤖 {name} is automated. Not affiliated with {creator}.', removal: 'Creators: message this channel.' };

test('a start time is written the way the platform reads it', () => {
  assert.equal(linkTime(0), '0s');
  assert.equal(linkTime(72_000), '1m12s');
  assert.equal(linkTime(3_852_900), '1h4m12s');
  assert.equal(sourceLink(twitch, 3_852_900), 'https://www.twitch.tv/videos/2927311587?t=1h4m12s');
  assert.equal(sourceLink(youtube, 3_852_900), 'https://www.youtube.com/watch?v=Hn0cZBN1JfA&t=3852s');
  assert.equal(sourceLink(twitch), 'https://www.twitch.tv/videos/2927311587');
});

test('the credit says who, where the whole thing is, what it is from and what this channel is', () => {
  const lines = creditBlock(twitch, me, 3_852_900).split('\n');
  assert.deepEqual(lines, [
    '▶ Watch the full stream from this moment: https://www.twitch.tv/videos/2927311587?t=1h4m12s',
    '🎥 caseoh_ on Twitch: https://www.twitch.tv/caseoh_',
    'From "🟨LOSING MY MIND🟨" · Just Chatting',
    '🤖 Clip Engine is automated. Not affiliated with caseoh_.',
    'Creators: message this channel.',
  ]);
  const yt = creditBlock(youtube, me, 61_000);
  assert.match(yt, /^▶ Full episode from this moment: https:\/\/www\.youtube\.com\/watch\?v=Hn0cZBN1JfA&t=61s\n🎥 Some Podcast on YouTube: https:\/\/www\.youtube\.com\/@SomePodcast\nFrom "Episode 12"\n/);
  assert.equal(creditLine(twitch), 'twitch.tv/caseoh_');
  assert.equal(creditLine(youtube), 'youtube.com/@SomePodcast');
});

test('the credit is its own part of the post: an edited caption cannot lose it', () => {
  const sug = suggestPost({ title: 'CaseOh rages at a vending machine', reason: 'He loses two dollars to a vending machine. Chat laughs.', channel: 'caseoh_', game: 'Just Chatting', source: twitch, identity: me, atMs: 3_852_900 });
  assert.equal(sug.caption, 'He loses two dollars to a vending machine.', 'the caption no longer repeats the channel: the credit names it');
  assert.match(sug.credit ?? '', /^▶ Watch the full stream/);
  const edited = postFor({ caption: 'my own caption' }, sug);
  assert.equal(edited.caption, 'my own caption');
  assert.equal(edited.credit, sug.credit);
  const body = postBody(edited).split('\n\n');
  assert.equal(body[0], 'my own caption');
  assert.match(body[1], /^▶ Watch the full stream/);
  assert.match(body[2], /^#/);
  // with no source (an old caller), the caption still names the channel
  assert.match(suggestPost({ title: 'A title', channel: 'caseoh_' }).caption, /🎥 caseoh_/);
});

test('a new clip names the creator on screen, and the post links the second it starts', async () => {
  const VID = 'tw-3000000001';
  const meta = { id: VID, url: 'https://www.twitch.tv/videos/3000000001', platform: 'twitch', login: 'tester', game: 'Just Chatting', title: 'Test stream', channel: 'Tester', durationMs: 3_600_000, hasHeatmap: false, chapters: [], heatmap: [], captions: 'none', commentCount: 0, ingestedAt: new Date(0).toISOString() } as VideoMeta;
  writeJson(paths.videoFile(VID, 'meta.json'), meta);
  const cand = { id: 'c01', startMs: 600_000, endMs: 630_000, title: 'A test moment' } as Candidate;
  // with no channel.json: the name the user gave the channel, the credit on, nobody opted out
  assert.deepEqual([loadChannel().name, loadChannel().creditOnScreen, loadChannel().doNotClip], ['Clip Engine', true, []]);
  const p = saveProject(projectFromCandidate(VID, cand, meta));
  const credit = p.markers.filter((m) => m.type === CREDIT);
  assert.equal(credit.length, 1);
  assert.equal(credit[0].params.text, 'twitch.tv/tester');
  assert.equal(credit[0].params.label, '🎮 Twitch');
  assert.equal(credit[0].proposed, undefined, 'it renders: it is not a proposal');
  const post = suggestedPost(p);
  assert.match(post.credit ?? '', /▶ Watch the full stream from this moment: https:\/\/www\.twitch\.tv\/videos\/3000000001\?t=10m0s\n🎥 Tester on Twitch: https:\/\/www\.twitch\.tv\/tester\nFrom "Test stream" · Just Chatting\n🤖 Clip Engine finds and cuts moments/);
  assert.match(post.credit ?? '', /Not affiliated with Tester\./);
  // changing the text keeps one credit; removing it leaves none; adding it back restores the default
  assert.equal((await setCredit(p.id, { text: 'Tester on Twitch' })).markers.filter((m) => m.type === CREDIT)[0].params.text, 'Tester on Twitch');
  assert.equal(loadProject(p.id).markers.filter((m) => m.type === CREDIT).length, 1);
  assert.equal((await setCredit(p.id, { remove: true })).markers.filter((m) => m.type === CREDIT).length, 0);
  assert.equal((await setCredit(p.id)).markers.filter((m) => m.type === CREDIT)[0].params.text, 'twitch.tv/tester');
  // a channel that turns the on-screen credit off gets clips without it, and its own words under the post
  writeJson(channelFile(), { name: 'Stream Finds', creditOnScreen: false, removal: 'Creators: write to the address on the channel page.' });
  try {
    assert.equal(projectFromCandidate(VID, cand, meta).markers.length, 0);
    assert.match(suggestedPost(p).credit ?? '', /🤖 Stream Finds finds and cuts moments[^\n]*\nCreators: write to the address on the channel page\.$/);
  } finally {
    fs.rmSync(channelFile(), { force: true });
  }
});

test('a creator who asked not to be clipped is not clipped', () => {
  const VID = 'tw-3000000002';
  const meta = { id: VID, url: 'https://www.twitch.tv/videos/3000000002', platform: 'twitch', login: 'quiet_one', title: 'Stream', channel: 'Quiet One', durationMs: 3_600_000, hasHeatmap: false, chapters: [], heatmap: [], captions: 'none', commentCount: 0, ingestedAt: new Date(0).toISOString() } as VideoMeta;
  const cand = { id: 'c01', startMs: 600_000, endMs: 630_000, title: 'A test moment' } as Candidate;
  const list = (doNotClip: string[]) => ChannelSchema.parse({ doNotClip });
  assert.equal(optedOut(meta, list([])), undefined);
  assert.equal(optedOut(meta, list(['someone_else'])), undefined);
  assert.equal(optedOut(meta, list(['@Quiet_One'])), '@Quiet_One', 'by login, however it is written');
  assert.equal(optedOut(meta, list(['quiet one'])), 'quiet one', 'or by channel name');
  assert.equal(projectFromCandidate(VID, cand, meta).videoId, VID);
  writeJson(channelFile(), { doNotClip: ['quiet_one'] });
  try {
    assert.throws(() => projectFromCandidate(VID, cand, meta), /quiet_one asked not to be clipped/);
  } finally {
    fs.rmSync(channelFile(), { force: true });
  }
});

test('a title that does not say who gets the creator\'s name', () => {
  assert.equal(suggestTitles({ title: 'Streamer gets jumpscared in the wardrobe by his game daughter', channel: 'caseoh_' })[0], 'CaseOh got JUMPSCARED in the wardrobe by his game daughter 💀');
  assert.match(suggestTitles({ title: 'He has to share a bed with a talking horse', channel: 'caseoh_' })[0], /^CaseOh has to share a bed with a talking horse/i);
  // a title that already names someone is left alone
  assert.match(suggestTitles({ title: 'Ron lost it over a fake BMW order', channel: 'lacy' })[0], /^Ron /);
});

test('the post says what the stream was at that point, in the words the expert wrote for a cold viewer', () => {
  const VID = 'tw-3000000003';
  const meta = { id: VID, url: 'https://www.twitch.tv/videos/3000000003', platform: 'twitch', login: 'tester', game: 'Just Chatting', title: 'Long stream', channel: 'tester', durationMs: 7_200_000, hasHeatmap: false, chapters: [{ startMs: 0, endMs: 3_000_000, title: 'Just Chatting' }, { startMs: 3_000_000, endMs: 7_200_000, title: 'Scary Game' }], heatmap: [], captions: 'none', commentCount: 0, ingestedAt: new Date(0).toISOString() } as VideoMeta;
  writeJson(paths.videoFile(VID, 'meta.json'), meta);
  const cand = { id: 'c01', startMs: 3_600_000, endMs: 3_625_000, title: 'Tester gets scared by a wardrobe', reason: 'Setup: flashlight build, 2 s of quiet before the scare.', queueId: 'meme@1:00:05' } as Candidate;
  writeJson(paths.videoFile(VID, 'candidates.json'), { videoId: VID, candidates: [cand] });
  writeJson(paths.videoFile(VID, 'queue-review.json'), { videoId: VID, verdicts: [{ queueId: 'meme@1:00:05', context: 'His game daughter said there was a monster in her room' }] });
  const post = suggestedPost(saveProject(projectFromCandidate(VID, cand, meta)));
  assert.equal(post.caption, 'His game daughter said there was a monster in her room', 'not the extractor\'s note about the cut');
  assert.equal(suggestPost({ title: 'A title', channel: 'caseoh_', context: "In this game the streamer has to share the streamer's bed" }).caption.split('\n')[0], "In this game CaseOh has to share CaseOh's bed", 'a viewer is told who');
  assert.match(post.credit ?? '', /From "Long stream" · Scary Game/, 'the chapter the clip is in, not the category the stream started in');
  assert.match(post.hashtags, /#ScaryGame/);
});

test('an export goes out only if it was rendered with the creator\'s name on screen', () => {
  const report = (id: string, body: object) => writeJson(`${paths.exports}/${id}.json`, { clipId: id, ...body });
  report('tw-1-c01', { credit: true });
  report('tw-1-c02', { credit: false });
  report('tw-1-c03', {}); // rendered before the rule existed
  assert.equal(uncredited('tw-1-c01'), undefined);
  assert.match(uncredited('tw-1-c02') ?? '', /rendered without the creator's name on screen/);
  assert.match(uncredited('tw-1-c03') ?? '', /clip credit tw-1-c03/);
  assert.match(uncredited('tw-1-c99') ?? '', /rendered without/, 'no render report at all');
  // a channel that turned the credit off, on purpose, is not held to it
  assert.equal(uncredited('tw-1-c02', ChannelSchema.parse({ creditOnScreen: false })), undefined);
});

