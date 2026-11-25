// The 18+ check (src/qa/adult.ts): sexual content in what is said, what chat typed, what the queue
// experts flagged and what NudeNet saw add up to points, and the review decision carries 18+ to the
// upload (src/review, src/publish/youtube.ts).
import { DATA } from './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../src/core/schemas';

const { adultScore, sexualWords, lewdChat, checkAdult, ADULT_POINTS } = await import('../src/qa/adult');
const { defaultCaptions, defaultFraming } = await import('../src/core/schemas');
const { saveProject } = await import('../src/project');
const { writeJson, paths } = await import('../src/core/paths');

const none = { explicit: [], suggestive: [], experts: [], lewdChatters: 0, stills: 12, exposed: [], revealing: 0 };

test('words: sexual on their own, sexual in some uses, and two-word phrases', () => {
  const at = (s: string) => s.split(' ').map((text, k) => ({ text, atMs: k * 500 }));
  const r = sexualWords(at('we are going to the strip club in Essex and she is naked, what a dick'));
  assert.deepEqual(r.explicit.map((w) => w.word), ['strip club', 'naked']);
  assert.deepEqual(r.suggestive.map((w) => w.word), ['dick']);
  assert.deepEqual(sexualWords(at('the comic strip about sextants')).explicit, [], 'whole words only');
  assert.deepEqual(sexualWords(at('Cool sex, so we are gonna do sex')).suggestive.map((w) => w.word), ['sex', 'sex']);
});

test('chat: one lewd chatter counts once, only inside the window', () => {
  const m: [number, string, string][] = [
    [1000, 'a', 'GYATT'],
    [2000, 'a', 'gyat again'],
    [3000, 'b', '🥵🥵'],
    [4000, 'c', 'LUL'],
    [9000, 'd', 'nsfw'],
  ];
  assert.deepEqual(lewdChat(m, 0, 8000), { chatters: 3, lewd: 2, samples: ['gyatt', '🥵'] });
});

test('the points: one word or one expert alone is a lead; together, or nudity, tick the check', () => {
  assert.deepEqual(adultScore(none), { points: 0, detected: false, reasons: [] });
  // the "testing penis" mic-check gag: one expert's flag and one word that is sexual in some uses
  const gag = adultScore({ ...none, experts: ['meme'], suggestive: [{ word: 'penis', atMs: 2000 }] });
  assert.equal(gag.points, 3);
  assert.equal(gag.detected, false);
  // GTA 6's strip club, flagged by two experts and named
  const club = adultScore({ ...none, experts: ['meme', 'viral'], explicit: [{ word: 'strip club', atMs: 4000 }] });
  assert.equal(club.points, 5);
  assert.ok(club.detected);
  assert.match(club.reasons[0], /^the queue experts flagged it sexual \(meme, viral\)$/);
  // nudity the model is sure of, or in two stills, is enough on its own
  const nude = adultScore({ ...none, exposed: [{ atMs: 7000, label: 'BUTTOCKS_EXPOSED', score: 0.71 }] });
  assert.equal(nude.points, 6);
  assert.match(nude.reasons[0], /^frames: nudity \(exposed buttocks\) in 1 of 12 stills, first at 0:07 \(NudeNet 0\.71\)$/);
  assert.equal(adultScore({ ...none, exposed: [{ atMs: 5000, label: 'BUTTOCKS_EXPOSED', score: 0.63 }, { atMs: 7000, label: 'BUTTOCKS_EXPOSED', score: 0.55 }] }).points, 6);
  // one still just over the bar is a lead (a tank top at 0.52 and a shoulder at 0.56 were bare skin)
  const skin = adultScore({ ...none, exposed: [{ atMs: 21_000, label: 'BUTTOCKS_EXPOSED', score: 0.52 }] });
  assert.equal(skin.points, 2);
  assert.match(skin.reasons[0], /^frames: possible nudity \(exposed buttocks\) in 1 of 12 stills, at 0:21 \(NudeNet 0\.52\): look at it$/);
  assert.equal(adultScore({ ...none, explicit: [{ word: 'porn', atMs: 0 }] }).detected, false, 'one explicit word is a lead');
  assert.equal(adultScore({ ...none, explicit: [{ word: 'porn', atMs: 0 }, { word: 'nude', atMs: 900 }] }).points, ADULT_POINTS);
  // revealing clothing all through, and chat reacting to it
  assert.ok(adultScore({ ...none, revealing: 6, lewdChatters: 7 }).detected);
  assert.equal(adultScore({ ...none, revealing: 4 }).points, 0, 'under 40% of the stills is not a lead');
  assert.equal(adultScore({ ...none, lewdChatters: 12 }).points, 3);
});

const VID = 'tw-adult';
const project = (id: string, over: Partial<Project> = {}): Project => ({ version: 1, rev: 0, id, videoId: VID, title: 'T', sourceDurationMs: 600_000, fps: 30, segments: [{ startMs: 100_000, endMs: 120_000 }], markers: [], captions: { ...defaultCaptions(), enabled: false }, framing: defaultFraming(), createdAt: '', updatedAt: '', ...over });

test('a clip: words that play (not the ones cut), chat while it plays, the experts near it', async () => {
  const words = ['so', 'she', 'went', 'to', 'the', 'strip', 'club', 'and', 'got', 'naked', 'lol'].map((text, i) => ({ i, text, startMs: 101_000 + i * 1000, endMs: 101_000 + i * 1000 + 800 }));
  writeJson(paths.videoFile(VID, 'transcript.json'), { videoId: VID, source: 'whisper', lang: 'en', words, tags: [] });
  writeJson(paths.videoFile(VID, 'chat.json'), { videoId: VID, fetched: [{ startMs: 0, endMs: 600_000 }], messages: [[105_000, 'a', 'gyat'], [106_000, 'b', 'nice'], [200_000, 'c', 'gyat']] });
  writeJson(paths.videoFile(VID, 'queue-review.json'), { videoId: VID, verdicts: [{ queueId: 'viral@1:46', kind: 'viral', verdict: 'confirm', risks: ['sexual'], momentMs: 106_000 }, { queueId: 'meme@9:00', kind: 'meme', verdict: 'confirm', risks: ['sexual'], momentMs: 540_000 }] });
  saveProject(project('ad1'));
  const a = await checkAdult('ad1', { frames: false });
  assert.equal(a.looked.words, 11);
  assert.deepEqual(a.looked, { words: 11, chatters: 2, stills: null, experts: true });
  // strip club + naked (4) and one expert (2); the meme flag at 9:00 is another moment
  assert.equal(a.points, 6);
  assert.ok(a.detected);
  assert.ok(a.reasons.some((r) => r === 'said: "strip club" at 0:06, "naked" at 0:10'), a.reasons.join(' | '));
  assert.ok(a.missing.some((m) => m.startsWith('frames not checked')));
  // cut the words out: only the expert's flag is left
  saveProject(project('ad2', { markers: [{ id: 'c1', type: 'cut', startMs: 105_500, endMs: 110_500, params: { transition: 'none' } }] }));
  const b = await checkAdult('ad2', { frames: false });
  assert.equal(b.points, 2);
  assert.equal(b.detected, false);
});

test('the decision carries 18+: the reviewer’s check, else the 18+ check; a clip sent for review is decided again', async () => {
  const { setReview } = await import('../src/review');
  const { listReviews } = await import('../src/review/db');
  saveProject(project('ad3'));
  fs.mkdirSync(path.join(DATA, 'exports'), { recursive: true });
  writeJson(path.join(paths.exports, 'ad3.qa.json'), { clipId: 'ad3', passed: true, issues: [], loudnessLufs: -14, durationS: 20, checkedAt: '', adult: { detected: true, points: 6, reasons: [], looked: { words: 0, chatters: null, stills: null, experts: false }, missing: [], checkedAt: '' } });
  assert.equal(setReview('ad3', 'approved').review?.adult, true, 'no check sent: what the 18+ check found');
  assert.equal(listReviews().find((r) => r.clipId === 'ad3')?.adult, true);
  assert.equal(setReview('ad3', 'approved', undefined, undefined, false).review?.adult, false, 'the reviewer unticked it');
  assert.equal(listReviews().find((r) => r.clipId === 'ad3')?.adult, false);
  assert.equal(setReview('ad3', 'rejected').review?.adult, false, 'a later decision keeps the last 18+');
  assert.equal(setReview('ad3', 'review').review?.adult, undefined, 'sent for review: decided again');
  assert.equal(listReviews().find((r) => r.clipId === 'ad3')?.adult, null);
  const feedback = fs.readFileSync(path.join(DATA, 'library', 'feedback.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(feedback.filter((f) => f.clipId === 'ad3').map((f) => [f.adult, f.adultDetected]), [[true, true], [false, true], [false, true]]);
});

test('a decision never takes the hand-over the clip came in with as the reviewer’s note', async () => {
  const { setReview } = await import('../src/review');
  saveProject(project('hn1'));
  const handOver = 'For review: the prompt is the real channel, frozen 1.4 s at the open';
  setReview('hn1', 'review', handOver);
  assert.equal(setReview('hn1', 'changes', handOver).review?.note, undefined, 'the hand-over sent back unchanged is no request');
  setReview('hn1', 'review', handOver);
  assert.equal(setReview('hn1', 'changes', 'bad crop').review?.note, 'bad crop', 'a note the reviewer wrote stays');
  assert.equal(setReview('hn1', 'review', 'bad crop').review?.note, 'bad crop', 'sent back to review: the note is kept');
});

test('an 18+ upload asks YouTube for the age rating; others do not', async () => {
  const { youtubeMetadata } = await import('../src/publish/youtube');
  const base = { title: 'T', description: 'd', tags: [], privacy: 'private' as const, categoryId: '20', madeForKids: false, notifySubscribers: false };
  const adult = youtubeMetadata({ ...base, ageRestricted: true });
  assert.deepEqual((adult.body as { contentDetails?: unknown }).contentDetails, { contentRating: { ytRating: 'ytAgeRestricted' } });
  assert.match(adult.query, /part=snippet%2Cstatus%2CcontentDetails/);
  const plain = youtubeMetadata(base);
  assert.equal((plain.body as { contentDetails?: unknown }).contentDetails, undefined);
  assert.match(plain.query, /part=snippet%2Cstatus&/);
});

test('Upload anyway: only on an approval; it puts the clip back in the upload line, and a new decision clears it', async () => {
  const { setReview, uploadAnyway } = await import('../src/review');
  const { deferPick, listReviews } = await import('../src/review/db');
  const { loadProject } = await import('../src/project');
  saveProject(project('ua1'));
  setReview('ua1', 'review');
  assert.throws(() => uploadAnyway('ua1'), /not approved/);
  setReview('ua1', 'approved');
  deferPick('ua1', 'careful period until 2026-12-06 (channel.json): it is 18+');
  assert.equal(listReviews('approved').find((r) => r.clipId === 'ua1')?.uploadStatus, 'deferred');
  const r = uploadAnyway('ua1');
  assert.ok(r.uploadAnyway);
  const row = listReviews('approved').find((x) => x.clipId === 'ua1')!;
  assert.equal(row.uploadStatus, 'pending');
  assert.equal(row.picked, 0);
  assert.ok(loadProject('ua1').review?.uploadAnyway);
  setReview('ua1', 'review');
  setReview('ua1', 'approved');
  assert.equal(loadProject('ua1').review?.uploadAnyway, undefined, 'a new decision is checked again');
});
