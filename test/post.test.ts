// Post text: title options, context-first description and a small relevant hashtag set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postFor, suggestPost, suggestTitles } from '../src/core/post';
import { outcomeScore } from '../src/publish/analytics';

test('viral titles: short name, action, one emphasized word, reaction emoji', () => {
  const t = suggestTitles({
    title: "The undercover cop's name is just Dallas",
    quote: 'His undercover name is Dallas',
    reason: 'The crew tries to unmask an undercover cop, and his secret double-account name is literally Dallas.',
    channel: 'TheBurntPeanut',
  });
  assert.equal(t[0], 'His name is LITERALLY Dallas 💀');
  assert.ok(t.some((x) => x.includes('"His undercover name is Dallas"')));
  assert.ok(t.some((x) => /^No way/.test(x)));
  assert.ok(!t[0].includes(':'));
});

test('a named streamer gets the community nickname and the action in past tense', () => {
  const t = suggestTitles({
    title: "xQc's chef career ends over a car key",
    quote: 'You do not have the keys to this vehicle.',
    reason: 'A key error, chat spamming o7 FIRED, and xQc raging at the armory.',
    channel: 'xQc',
  });
  assert.equal(t[0], "xQc's chef career ENDED over a car key 💀");
  assert.ok(t.some((x) => x.includes('Chat declared xQc FIRED')));
});

test('the chat-aware title is used when the chat is the story', () => {
  const t = suggestTitles({
    title: 'Cloakzy hates firefighters?',
    quote: 'he hates all veterans',
    reason: 'A Veterans Day bit snowballs into the whole chat typing 1 to prove they served.',
    channel: 'TheBurntPeanut',
  });
  assert.equal(t[0], 'Cloakzy HATES firefighters? 💀');
  assert.ok(t.some((x) => x.startsWith('The chat had to prove they served')));
});

test('a Name: phrase title becomes “Name says …”, never a colon', () => {
  const t = suggestTitles({
    title: 'Hasan: Elon Musk doesn\'t really do shit',
    reason: 'A sharp contrast about Musk and Nvidia.',
    channel: 'HasanAbi',
  });
  assert.ok(t[0].startsWith('Hasan says '), t[0]);
  assert.ok(!t[0].includes(':'));
  assert.ok(t[0].endsWith('💀'));
});

test('a number-led title keeps the context instead of forcing a name prefix', () => {
  const t = suggestTitles({ title: '12K watching a 45-year-old Nick play Mario', channel: 'NICKMERCS' });
  assert.ok(t[0].startsWith('12K WATCHING'), t[0]);
  assert.ok(!t[0].startsWith("Nick's"));
});

test('description starts with context and credit; hashtags are 3–5 and relevant', () => {
  const p = suggestPost({
    title: 'Hasan: GPU prices only go up',
    hook: 'Does this mean the 50-series goes down in price?',
    reason: 'A clean deadpan answer to the Nvidia panic.',
    lens: 'hot-takes',
    channel: 'HasanAbi',
    game: 'Just Chatting',
  });
  assert.match(p.caption, /^A clean deadpan answer/);
  assert.match(p.caption, /🎥 HasanAbi/);
  const tags = p.hashtags.split(' ');
  assert.ok(tags.length >= 3 && tags.length <= 5);
  assert.ok(tags.includes('#shorts'));
  assert.ok(tags.includes('#HasanAbi'));
});

test('a manual title override wins but keeps the title options', () => {
  const s = suggestPost({ title: 'Original', hook: 'A line', channel: 'Chan' });
  const p = postFor({ title: 'My title' }, s);
  assert.equal(p.title, 'My title');
  assert.deepEqual(p.titles, s.titles);
});

test('a possessive name in the title becomes one clean hashtag', () => {
  const p = suggestPost({ title: "Eintracht Spandau's entrance of the year", lens: 'stream-moments', channel: 'eliasn97' });
  assert.ok(p.hashtags.includes('#EintrachtSpandau'), p.hashtags);
  assert.ok(!p.hashtags.includes('#EintrachtSpandaus'), p.hashtags);
});

test('outcome: engaged views and average view % carry most of the score', () => {
  assert.equal(outcomeScore({ views: 1000, engagedViews: 600, avgViewPct: 50, shares: 10, subscribersGained: 2 }), 53);
  assert.equal(outcomeScore({ views: 0, engagedViews: 0, avgViewPct: 0, shares: 0, subscribersGained: 0 }), 0);
});
