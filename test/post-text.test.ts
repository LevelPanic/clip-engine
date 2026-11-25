// Regenerate title / description (src/pipeline/postText.ts): what the model is told, and which of its
// options the reviewer is shown.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { postTextPrompt, checkOptions, POST_TEXT } = await import('../src/pipeline/postText');

const brief = {
  field: 'title' as const,
  creator: 'Kai Rivers',
  platform: 'YouTube' as const,
  game: 'Kart Racer',
  durationS: 20.8,
  context: 'Kai ends a 24-hour stream by finally winning a race.',
  hook: 'One more race, chat.',
  words: "one more race chat let's go we won",
  title: 'Kai FINALLY wins after 24 hours 😭',
  caption: 'He ends the 24-hour stream with his first win.',
};

test("the prompt carries the clip, the house rules, the reviewer's direction and where to write", () => {
  const p = postTextPrompt({ ...brief, note: 'lead with how tired he is' }, '.cache/post-text/x.json');
  for (const s of ['Kai Rivers on YouTube, Kart Racer, 21 s', 'Kai ends a 24-hour stream', "one more race chat let's go we won", 'Kai FINALLY wins after 24 hours', 'No colon', 'never "he"', 'sexual word', "The reviewer's direction: lead with how tired he is", 'Write 3 different options', '.cache/post-text/x.json'])
    assert.ok(p.includes(s), `missing: ${s}`);
  assert.ok(!p.includes('\n\n\n'), 'no runs of blank lines where a part is missing');
});

test('with no direction, it asks for better ones in the house style; a description asks for 2 and keeps off the credit', () => {
  assert.ok(postTextPrompt(brief, 'f.json').includes('none given: write better ones in the house style'));
  const d = postTextPrompt({ ...brief, field: 'caption' }, 'f.json');
  assert.ok(d.includes('Write 2 different options'));
  assert.ok(d.includes('No hashtags, links or credit line'));
  assert.ok(!d.includes('No colon'));
});

test('options: quotes and stray spaces trimmed, duplicates and non-text dropped, sexual titles and long ones left out with why', () => {
  const r = checkOptions('title', { options: ['  "Kai WINS on no sleep 😭"  ', 'Kai WINS on no sleep 😭', 42, '', 'Streamer shows a SEXY dance 😳', 'x'.repeat(POST_TEXT.title.max + 1)] });
  assert.deepEqual(r.options, ['Kai WINS on no sleep 😭']);
  assert.equal(r.dropped.length, 2);
  assert.match(r.dropped[0], /refuses a title with sexy/);
  assert.match(r.dropped[1], /over 100 characters/);
});

test('a description keeps its line breaks and may say what a title may not; a broken file gives nothing', () => {
  const r = checkOptions('caption', { options: ['Line one.\nLine   two.'] });
  assert.deepEqual(r.options, ['Line one.\nLine two.']);
  assert.deepEqual(checkOptions('title', { titles: ['wrong key'] }), { options: [], dropped: [] });
  assert.deepEqual(checkOptions('title', null), { options: [], dropped: [] });
});
