// The never-post list and the two gates in front of it (reports/censorship-review-2026-11-22.md):
// A1 nudity, a slur said, a minor and a sexual title are never uploaded (src/qa/unsafe.ts); A2 a moment
// flagged sexual, slur or minor is dropped at curation, not handed to the editor (src/curate,
// src/pipeline/full.ts); A3 the ranker skips moments the community marked as sexual (src/scan/rank.ts).
import { DATA } from './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../src/core/schemas';

const { unsafeReasons, saidSlurs, checkUnsafe, neverPost } = await import('../src/qa/unsafe');
const { sexualTitleWords, sureNudity, sexualMoment } = await import('../src/qa/adult');
const { unsafeFlags, expertFlags } = await import('../src/scan/review');
const { checkDecision, riskyCandidates, CurationInputSchema } = await import('../src/curate');
const { pickForEdit } = await import('../src/pipeline/full');
const { skipSexual } = await import('../src/scan/rank');
const { planMoments, momentWindow } = await import('../src/scan/moments');
const { defaultCaptions, defaultFraming } = await import('../src/core/schemas');
const { saveProject, loadProject } = await import('../src/core/project');
const { writeJson, paths } = await import('../src/core/paths');

test('titles: sexual words are caught as words, not inside other words', () => {
  assert.deepEqual(sexualTitleWords("ohnePixel's GTA 6 Strip Club Trip: 'Where's My Wife?'"), ['strip club']);
  assert.deepEqual(sexualTitleWords('NickMercs scrubs Lucia in GTA’s nude shower minigame'), ['nude']);
  assert.deepEqual(sexualTitleWords("xQc's GTA 6 phone gallery is 32/32 full of gooner pics"), ['gooner']);
  assert.deepEqual(sexualTitleWords('sexyyy red in gta iv'), [], 'a rapper’s name is not the word');
  assert.deepEqual(sexualTitleWords('Sussex derby gets heated, Essex SCREAMS'), []);
});

test('said slurs: heard words, the verb "sped" is not one, and the reason masks the word', () => {
  const w = (raw: string, s: number) => ({ raw, atMs: s * 1000 });
  assert.deepEqual(saidSlurs([w('he', 1), w('sped', 2), w('past', 3), w('retarded.', 4)]).map((x) => x.word), ['retarded']);
  const r = unsafeReasons({ slurs: saidSlurs([w('retarded', 4)]), minor: [], titleWords: [] });
  assert.equal(r[0].kind, 'slur');
  assert.match(r[0].why, /^a slur is said: "r\*+" at 0:04\. Hiding it in the captions does not mute it/);
  assert.ok(!r[0].why.includes('retarded'), 'the word itself is not printed');
});

test('nudity: what the 18+ check is sure of (two stills, or one at 0.7), from the stored record or an older reason', () => {
  const base = { reasons: [] as string[] };
  assert.match(sureNudity({ ...base, nudity: { stills: 2, of: 19, best: 0.63, firstMs: 7000, labels: ['exposed buttocks'] } })!, /^nudity \(exposed buttocks\) in 2 of 19 stills, first at 0:07/);
  assert.ok(sureNudity({ ...base, nudity: { stills: 1, of: 12, best: 0.71, firstMs: 7000, labels: ['exposed breasts'] } }));
  assert.equal(sureNudity({ ...base, nudity: { stills: 1, of: 12, best: 0.52, firstMs: 21_000, labels: ['exposed buttocks'] } }), undefined, 'one still just over the bar is a lead, not a refusal');
  assert.match(sureNudity({ reasons: ['frames: nudity (exposed breasts) in 2 of 15 stills, first at 0:09 (NudeNet 0.64)'] })!, /^nudity \(exposed breasts\)/);
  assert.equal(sureNudity({ reasons: ['frames: possible nudity (exposed buttocks) in 1 of 12 stills, at 0:21 (NudeNet 0.52): look at it'] }), undefined);
});

test('the flags that keep a moment off the channel: sexual from two experts, any slur, any minor', () => {
  assert.deepEqual(unsafeFlags(new Map([['sexual', ['meme']], ['profanity', ['meme', 'viral']]])), [], 'one expert’s sexual flag is often a gag');
  assert.deepEqual(unsafeFlags(new Map([['sexual', ['meme', 'viral']], ['minor', ['story']]])), ['sexual (meme, viral)', 'minor (story)']);
  assert.deepEqual(unsafeFlags(new Map([['slur', ['viral']]])), ['slur (viral)']);
  assert.deepEqual(unsafeFlags(null), []);
});

const VID = 'tw-unsafe';
const project = (id: string, over: Partial<Project> = {}): Project => ({ version: 1, rev: 0, id, videoId: VID, title: 'T', sourceDurationMs: 600_000, fps: 30, segments: [{ startMs: 100_000, endMs: 120_000 }], markers: [], captions: { ...defaultCaptions(), enabled: false }, framing: defaultFraming(), createdAt: '', updatedAt: '', post: { title: 'Emily laughs at the GTA 6 trailer' }, ...over });
const ledger = (verdicts: { queueId: string; kind: string; risks: string[]; momentMs: number }[]) => writeJson(paths.videoFile(VID, 'queue-review.json'), { videoId: VID, updatedAt: '', verdicts: verdicts.map((v) => ({ ...v, verdict: 'confirm' })) });

test('a clip: a slur said in it, a minor flagged near it, a sexual title; a cut clears the slur only with a new render', async () => {
  const words = ['you', 'are', 'so', 'retarded', 'bro', 'lol'].map((text, i) => ({ i, text, startMs: 101_000 + i * 1000, endMs: 101_000 + i * 1000 + 800 }));
  writeJson(paths.videoFile(VID, 'transcript.json'), { videoId: VID, source: 'whisper', lang: 'en', words, tags: [] });
  ledger([{ queueId: 'viral@1:46', kind: 'viral', risks: ['minor'], momentMs: 106_000 }, { queueId: 'meme@9:00', kind: 'meme', risks: ['minor'], momentMs: 540_000 }]);
  // the captions hide the word: it is still said
  saveProject(project('un1', { captions: { ...defaultCaptions(), enabled: true, fixes: { '3': '[__]' } } }));
  const a = await checkUnsafe('un1');
  assert.deepEqual(a.reasons.map((r) => r.kind), ['slur', 'minor']);
  assert.match(a.reasons[1].why, /\(viral\)$/, 'the flag at 9:00 is another moment');

  saveProject(project('un2', { post: { title: "Emily's GTA 6 strip club trip 😳" } }));
  ledger([]);
  assert.deepEqual((await checkUnsafe('un2')).reasons.map((r) => [r.kind, r.why]), [
    ['slur', (await checkUnsafe('un2')).reasons[0].why],
    ['title', 'the title sells it on sex (strip club): say what happened instead, and it uploads by itself'],
  ]);

  // rendered with the slur: QA stored it. Cutting it in the project without a render does not clear it
  fs.mkdirSync(path.join(DATA, 'exports'), { recursive: true });
  const rendered = await checkUnsafe('un2');
  writeJson(path.join(paths.exports, 'un2.qa.json'), { clipId: 'un2', passed: false, issues: [], loudnessLufs: -14, durationS: 20, checkedAt: '', unsafe: rendered });
  const p = loadProject('un2');
  saveProject({ ...p, markers: [{ id: 'c1', type: 'cut', startMs: 103_500, endMs: 104_500, params: { transition: 'none' } }], post: { title: 'Emily laughs at a GTA 6 cutscene' } });
  assert.equal((await checkUnsafe('un2')).reasons.length, 0, 'the project as it is now is clean');
  assert.deepEqual((await neverPost('un2')).map((r) => r.kind), ['slur'], 'the export still says it; the title is read as it is now');
});

test('the publisher refuses a never-post clip, --force or not', async () => {
  const { publishYoutube } = await import('../src/publish/youtube');
  writeJson(path.join(paths.exports, 'un2.json'), { credit: true });
  await assert.rejects(publishYoutube('un2', { force: true }), /un2 is never posted \(src\/qa\/unsafe\.ts\): a slur is said/);
});

test('curation: a keep or review on a risky moment needs "the cut avoids it by …"; a drop on unsafe stands', () => {
  const cands = [{ id: 'c01', status: 'new' as const }, { id: 'c02', status: 'new' as const }];
  const risky = new Map([['c01', ['sexual (meme, viral)']]]);
  const dec = (decision: 'keep' | 'review' | 'drop', reason: string, o: object = {}) => CurationInputSchema.parse({ candidateId: 'c01', niche: 'reaction-meme', fit: 70, decision, reason, ...o });
  assert.match(checkDecision(dec('review', 'the shower scene needs a person to sign it off'), cands, risky)[0], /c01's moment is flagged sexual \(meme, viral\): drop it with ground "unsafe"/);
  assert.match(checkDecision(dec('keep', 'Emily reacting to the trailer, a strong cold open'), cands, risky)[0], /the cut avoids it by/);
  assert.deepEqual(checkDecision(dec('keep', 'Emily reacting; the cut avoids it by ending at 1:35:02, before the shower'), cands, risky), []);
  assert.deepEqual(checkDecision(dec('drop', 'the nude shower is the whole moment, nothing to cut around', { ground: 'unsafe', removalWeight: 95 }), cands, risky), []);
  assert.deepEqual(checkDecision({ ...dec('review', 'a borderline joke that needs a look'), candidateId: 'c02' }, cands, risky), [], 'an unflagged candidate is as before');
});

test('the risky candidates come from the experts’ ledger, over the candidate’s own seconds', () => {
  ledger([
    { queueId: 'viral@1:46', kind: 'viral', risks: ['sexual'], momentMs: 106_000 },
    { queueId: 'meme@1:46', kind: 'meme', risks: ['sexual', 'profanity'], momentMs: 107_000 },
    { queueId: 'meme@5:00', kind: 'meme', risks: ['sexual'], momentMs: 300_000 },
  ]);
  assert.deepEqual([...expertFlags(VID, { startMs: 100_000, endMs: 120_000 })!].sort(), [['profanity', ['meme']], ['sexual', ['viral', 'meme']]]);
  const r = riskyCandidates(VID, [{ id: 'c01', startMs: 100_000, endMs: 120_000 }, { id: 'c02', startMs: 290_000, endMs: 310_000 }]);
  assert.deepEqual([...r], [['c01', ['sexual (viral, meme)']]], 'one expert at 5:00 is a lead, not a drop');
});

test('the editor never gets a risky "review" as the fallback, and a risky keep only with how the cut avoids it', () => {
  const d = (candidateId: string, decision: 'keep' | 'review' | 'drop', fit: number, reason = `${candidateId} reason`) => ({ candidateId, decision, fit, reason });
  const risky = new Map([['c01', ['sexual (meme, viral)']], ['c02', ['minor (story)']]]);
  assert.deepEqual(pickForEdit(['c01', 'c03'], [d('c01', 'review', 90, 'needs a sign-off'), d('c03', 'drop', 80)], new Set(), 1, risky), [], 'the shower clip reached the editor this way');
  assert.deepEqual(pickForEdit(['c01', 'c03'], [d('c01', 'keep', 90, 'great'), d('c03', 'review', 50)], new Set(), 1, risky), [{ id: 'c03', concern: 'c03 reason' }]);
  assert.deepEqual(pickForEdit(['c02'], [d('c02', 'keep', 90, 'the cut avoids it by staying on xQc’s camera')], new Set(), 1, risky), [{ id: 'c02' }]);
});

const S = 1000;
const mo = (peakS: number, titles: string[] = []) => ({ id: `moment@${peakS}`, peakMs: peakS * S, fromMs: (peakS - 20) * S, toMs: (peakS + 20) * S, views: 900, clips: 1, clippers: 1, laughers: 0, titles, score: 900, why: [] as string[], skip: undefined as string | undefined });
const chatOf = (lewdPeople: number, others: number, atS: number): [number, string, string][] => [
  ...Array.from({ length: lewdPeople }, (_, k): [number, string, string] => [atS * S + k * 10, `l${k}`, 'GYATT 🥵']),
  ...Array.from({ length: others }, (_, k): [number, string, string] => [atS * S + k * 10, `o${k}`, 'LUL what']),
];

test('the ranker skips a moment titled for sex or with lewd chat (10+ people, 5%+ of chat), and lifts the skip when it no longer holds', () => {
  assert.match(sexualMoment({ titles: ['Emily gets a private dance at the GTA strip club'] })!, /^viewer clips are titled for sex/);
  // GTA 6's nude shower: 16 of 243 chatters; an ordinary moment's 95th percentile is 2%
  assert.match(sexualMoment({ titles: ['Emily watches Jason take a shower in game'] }, { lewd: 16, chatters: 243, samples: ['gyatt', 'naked'] })!, /^chat was lewd over it \(16 of 243 people/);
  assert.equal(sexualMoment({ titles: [] }, { lewd: 9, chatters: 40, samples: [] }), undefined, 'under 10 people is a few chatters');
  assert.equal(sexualMoment({ titles: [] }, { lewd: 20, chatters: 800, samples: [] }), undefined, '2.5% of a big chat');

  const ms = skipSexual([mo(1000, ['Jynxzi catches a tiny fish']), mo(2000, ['G1AY SEX']), mo(3000)], { messages: chatOf(16, 227, 3005) });
  assert.deepEqual(ms.map((m) => m.skip?.replace(/ \(.*$/, '')), [undefined, 'a sexual moment: never clipped', 'a sexual moment: never clipped']);
  assert.deepEqual(skipSexual([{ ...mo(3000), skip: 'a Slots chapter: never clipped' }], { messages: chatOf(16, 227, 3005) })[0].skip, 'a Slots chapter: never clipped', 'an earlier skip stands');
  assert.equal(skipSexual([mo(3000)], { messages: chatOf(16, 227, 3005), disabled: true })[0].skip, undefined, 'chat off: titles only');

  const k = { momentId: 'moment@3000', peakMs: 3000 * S, fromMs: 2980 * S, toMs: 3020 * S, windowFromMs: 2920 * S, windowToMs: 3065 * S, score: 900, status: 'skipped', note: 'a sexual moment: never clipped (chat was lewd over it)' };
  const ranked = { ...mo(3000), window: momentWindow(mo(3000), 10 * 3600 * S) };
  assert.equal(planMoments([k], [ranked]).update[0].status, 'pending', 'chat read since shows it was not');
});
