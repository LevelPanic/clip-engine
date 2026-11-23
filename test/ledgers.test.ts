// The two ledgers that hand work from one agent to the next: the queue experts' verdicts and the
// curator's decisions. Both are checked like candidates are: an agent that skips the looking, uses a
// word outside the vocabulary or drops a clip without a ground gets an error, not a silent pass.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AudioDetection, ReactionKind } from '../src/discover/signals/audio';
import type { QueueData } from '../src/scan/queues';
import type { Candidate } from '../src/core/schemas';

const { applyQueueVerdicts, loadQueueReview, confirmedMoments, pendingQueues, orphanedMoments, queueFromVerdict, citedFrames, findSaid, saidParts, stillFiles, stillNear } = await import('../src/scan/review');
const corePaths = (await import('../src/core/paths')).paths;
const { parseTime } = await import('../src/core/time');
const { queuesFrom } = await import('../src/scan/queues');
const { applyCuration, loadCuration, undecidedIn } = await import('../src/curate');
const { saveCandidates, loadCandidates } = await import('../src/candidates');
const { VOCABULARY } = await import('../src/core/vocabulary');

const MIN = 60_000;
const heard = (kind: ReactionKind, startMs: number): AudioDetection => ({ kind, startMs, endMs: startMs + 2250, peak: 0.9, windows: 2 });
const words = Array.from({ length: 200 }, (_, i) => ({ i, startMs: 9 * MIN + 30_000 + i * 300, endMs: 9 * MIN + 30_250 + i * 300, text: i % 9 === 8 ? 'done.' : 'word' }));
const data: QueueData = {
  durationMs: 30 * MIN,
  platform: 'twitch',
  reactions: [heard('laugh', 10 * MIN), heard('shout', 15 * MIN), heard('laugh', 20 * MIN)],
  audioAnalysed: true,
  clips: [],
  clipsFetched: true,
  transcript: { words, tags: [], covered: [{ startMs: 0, endMs: 30 * MIN }] },
  titleHits: [],
  excluded: [],
};
const VID = 'tw-4000000001';
const verdict = (over: Record<string, unknown>) => ({ queueId: 'meme@0:10:00', verdict: 'confirm', archetype: 'fail', seen: ['frame 10:00: he falls off the chair'], confidence: 0.8, reason: 'a clean fall with a laugh right after', ...over });
const refusal = (v: Record<string, unknown>) => applyQueueVerdicts(VID, data, [v]).refused[0]?.errors.join(' | ') ?? '';
/** A still on disk for these times: what `clip frames` leaves behind when an expert looks. */
const still = (id: string, ...times: string[]) => {
  const dir = corePaths.videoFile(id, 'frames');
  fs.mkdirSync(dir, { recursive: true });
  for (const t of times) fs.writeFileSync(path.join(dir, `${parseTime(t)}.jpg`), 'x');
};
still(VID, '10:00', '15:00');

test('a confirm has to name the moment and cite a frame', () => {
  assert.match(refusal(verdict({ seen: ['chat laughed a lot'] })), /cites a frame you looked at/);
  assert.match(refusal(verdict({ archetype: undefined })), /names the moment/);
  assert.match(refusal(verdict({ archetype: 'banger' })), /archetype/, 'a word outside the vocabulary is refused');
  assert.match(refusal(verdict({ queueId: 'meme@0:12:30' })), /no meme queue near 0:12:30/);
  assert.match(refusal(verdict({ queueId: 'the first one' })), /a queue id looks like/);
  assert.match(refusal(verdict({ moment: '14:00' })), /a different moment/);
  assert.match(refusal(verdict({ start: '9:50', end: '11:05' })), /is 75 s; a clip is 15–60 s/);
  assert.match(refusal(verdict({ confidence: 0.3 })), /too low to confirm/);
});

test('a story confirm cites the words, a viral confirm names the trigger', () => {
  assert.match(refusal(verdict({ queueId: 'clip@0:10:00', archetype: 'anecdote' })), /cites the words/);
  assert.equal(refusal(verdict({ queueId: 'clip@0:10:00', archetype: 'anecdote', seen: ['frame 10:00: two people on a couch', 'said: word word done.'] })), '');
  const viral: QueueData = { ...data, clips: [{ offsetMs: 10 * MIN, durationMs: 30_000, views: 400, title: 'he fell', slug: 'a' }] };
  const noTrigger = applyQueueVerdicts(VID, viral, [verdict({ queueId: 'viral@0:10:00' })]).refused[0].errors.join(' ');
  assert.match(noTrigger, /names why a stranger would send it/);
  assert.match(applyQueueVerdicts(VID, viral, [verdict({ queueId: 'viral@0:10:00', trigger: 'none' })]).refused[0].errors.join(' '), /no-reach/);
});

test('a reject names its ground and what was checked; a merge names its target', () => {
  assert.match(refusal({ queueId: 'meme@0:15:00', verdict: 'reject', confidence: 0.9, reason: 'nothing on screen explains it' }), /names its ground/);
  assert.match(refusal({ queueId: 'meme@0:15:00', verdict: 'reject', rejected: 'no-visible-cause', confidence: 0.9, reason: 'nothing on screen explains it' }), /says what was checked/);
  assert.match(refusal({ queueId: 'meme@0:15:00', verdict: 'merge', confidence: 0.9, reason: 'tail of the earlier bit' }), /names the queue it belongs to/);
  assert.match(refusal({ queueId: 'meme@0:15:00', verdict: 'merge', mergeInto: 'meme@0:25:00', confidence: 0.9, reason: 'tail of the earlier bit' }), /is not a queue/);
});

test('verdicts are saved by queue, the latest wins, and what is left is known', () => {
  const r = applyQueueVerdicts(VID, data, [
    verdict({ context: 'He just bragged he never falls', risks: ['profanity'], start: '9:54', end: '10:12' }),
    verdict({ queueId: 'clip@0:10:00', archetype: 'banter', confidence: 0.6, seen: ['frame 10:01: laughing', 'said: word word done.'] }),
    { queueId: 'meme@0:15:00', verdict: 'reject', rejected: 'no-visible-cause', seen: ['frame 15:00: a menu screen'], confidence: 0.9, reason: 'a shout with nothing on screen' },
  ]);
  assert.equal(r.refused.length, 0, JSON.stringify(r.refused));
  const ledger = loadQueueReview(VID);
  assert.equal(ledger.verdicts.length, 3);
  const meme = ledger.verdicts.find((v) => v.queueId === 'meme@0:10:00')!;
  assert.equal(meme.startMs, 9 * MIN + 54_000);
  assert.deepEqual(meme.queue.witnesses, ['reaction'], 'the engine records what the queue was built on');
  // two experts confirmed the same 20 seconds: one moment, the more confident reading first
  const moments = confirmedMoments(ledger);
  assert.equal(moments.length, 1);
  assert.equal(moments[0].primary.queueId, 'meme@0:10:00');
  assert.deepEqual(moments[0].also.map((v) => v.queueId), ['clip@0:10:00']);
  // the 20:00 laugh has no verdict yet (nobody speaks there, so it is a meme queue only)
  const all = (['meme', 'viral', 'clip'] as const).flatMap((kind) => queuesFrom(data, { kind, limit: 50 }));
  assert.deepEqual(pendingQueues(ledger, all).map((q) => q.id), ['meme@0:20:00']);
  // a second look replaces the first verdict instead of adding one
  applyQueueVerdicts(VID, data, [{ queueId: 'meme@0:10:00', verdict: 'reject', rejected: 'lore', seen: ['frame 10:00: an in-joke about a mod'], confidence: 0.7, reason: 'only regulars know who that is' }]);
  assert.equal(loadQueueReview(VID).verdicts.length, 3);
  assert.equal(confirmedMoments(loadQueueReview(VID))[0].primary.queueId, 'clip@0:10:00');
});

// ---------- curation ----------

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({ id, startMs: 0, endMs: 20_000, title: `Clip ${id}`, hook: 'h', reason: 'r', quote: 'q q q', lens: 'stream-moments', score: 70, signals: {}, why: [], warnings: [], status: 'new', createdAt: '', ...over });
const CUR = 'tw-4000000002';
saveCandidates({ videoId: CUR, candidates: [cand('c01', { score: 90 }), cand('c02', { startMs: 60_000, endMs: 80_000 }), cand('c03', { startMs: 120_000, endMs: 140_000, score: 40 }), cand('c04', { startMs: 180_000, endMs: 200_000, status: 'made', clipId: `${CUR}-c04` })] });
const decide = (over: Record<string, unknown>) => ({ candidateId: 'c01', niche: 'reaction-meme', fit: 80, decision: 'keep', reason: 'a clean scare that works on mute for anyone', ...over });
const curErr = (d: Record<string, unknown>) => applyCuration(CUR, [d]).refused[0]?.errors.join(' | ') ?? '';

test('a drop has to be argued: a ground, a weight, and never just a low score', () => {
  assert.match(curErr(decide({ candidateId: 'c03', decision: 'drop', reason: 'the virality score is only 40 so it is weak' })), /names its ground.*A low score is not a ground/);
  assert.match(curErr(decide({ candidateId: 'c03', decision: 'drop', ground: 'broken' })), /removalWeight/);
  assert.match(curErr(decide({ candidateId: 'c03', decision: 'drop', ground: 'no-niche', removalWeight: 80 })), /contradicts niche "reaction-meme"/);
  assert.match(curErr(decide({ candidateId: 'c03', decision: 'drop', ground: 'duplicate', removalWeight: 80 })), /names the stronger candidate/);
  assert.match(curErr(decide({ candidateId: 'c04', decision: 'drop', ground: 'broken', removalWeight: 80 })), /already a clip/);
  assert.match(curErr(decide({ niche: 'none' })), /only for a drop/);
  assert.match(curErr(decide({ niche: 'IRL sports fail' })), /niche/, 'a niche outside the vocabulary is refused');
  assert.match(curErr(decide({ candidateId: 'c99' })), /no candidate c99/);
  assert.equal(loadCuration(CUR).decisions.length, 0, 'nothing refused is written');
});

test('the ledger covers every candidate, only drops change status, and a reversed drop comes back', () => {
  const r = applyCuration(CUR, [
    decide({ angle: 'jumpscare', fixes: ['trim the 8 s of dark room at the head'] }),
    decide({ candidateId: 'c02', niche: 'story', fit: 55, decision: 'review', reason: 'the story lands but needs a context line to make sense' }),
    decide({ candidateId: 'c03', niche: 'none', fit: 5, decision: 'drop', ground: 'duplicate', duplicateOf: 'c01', removalWeight: 85, reason: 'the same scare as c01 from four seconds later' }),
  ]);
  assert.equal(r.refused.length, 0, JSON.stringify(r.refused));
  assert.deepEqual(r.skipped, ['c03']);
  assert.deepEqual(r.undecided, ['c04'], 'the made clip still needs a decision');
  const status = () => Object.fromEntries(loadCandidates(CUR).candidates.map((c) => [c.id, c.status]));
  assert.deepEqual(status(), { c01: 'new', c02: 'new', c03: 'skipped', c04: 'made' });
  const ledger = loadCuration(CUR);
  assert.equal(ledger.decisions.find((d) => d.candidateId === 'c01')!.score, 90, 'scores are copied from the candidate, not typed');
  assert.equal(ledger.decisions.find((d) => d.candidateId === 'c01')!.removalWeight, 0);
  assert.equal(ledger.decisions.find((d) => d.candidateId === 'c03')!.removalWeight, 85);
  // the curator looks again and keeps it: the candidate comes back
  const again = applyCuration(CUR, [decide({ candidateId: 'c03', niche: 'reaction-meme', fit: 60, decision: 'review', reason: 'a different angle on the scare; let the user choose between them' })]);
  assert.deepEqual(again.restored, ['c03']);
  assert.equal(status().c03, 'new');
  assert.equal(loadCuration(CUR).decisions.length, 3, 'one decision per candidate');
  assert.deepEqual(undecidedIn(CUR), ['c04']);
});

test('the vocabulary has no duplicate keys and every term says what it means', () => {
  for (const [name, section] of Object.entries(VOCABULARY)) {
    const keys = section.terms.map((t) => t.key);
    assert.equal(new Set(keys).size, keys.length, `${name} has a duplicate key`);
    assert.ok(section.terms.every((t) => t.means.length > 10 && /^[a-z0-9-]+$/.test(t.key)), name);
  }
});

test('one writer at a time per video file, and a dead holder does not block', async () => {
  const fs = await import('node:fs');
  const { withVideoLock } = await import('../src/core/lock');
  const { paths } = await import('../src/core/paths');
  const order: string[] = [];
  const slow = withVideoLock('tw-lock', 'transcript', async () => {
    order.push('a starts');
    await new Promise((r) => setTimeout(r, 150));
    order.push('a ends');
  });
  const second = withVideoLock('tw-lock', 'transcript', async () => void order.push('b runs'));
  await Promise.all([slow, second]);
  assert.deepEqual(order, ['a starts', 'a ends', 'b runs']);
  assert.ok(!fs.existsSync(paths.videoFile('tw-lock', 'transcript.lock')), 'released');
  // a process that died holding the lock
  fs.writeFileSync(paths.videoFile('tw-lock', 'transcript.lock'), '999999');
  assert.equal(await withVideoLock('tw-lock', 'transcript', async () => 'ran'), 'ran');
  // a failure inside still releases it
  await assert.rejects(withVideoLock('tw-lock', 'transcript', async () => Promise.reject(new Error('whisper crashed'))), /whisper crashed/);
  assert.equal(await withVideoLock('tw-lock', 'transcript', async () => 'again'), 'again');
});

test('a moment with no queue can be recorded by the expert who found it', () => {
  const FOUND = 'tw-4000000003';
  still(FOUND, '25:02');
  const found = (over: Record<string, unknown>) => ({ queueId: 'clip@0:25:00', verdict: 'confirm', found: true, archetype: 'anecdote', moment: '25:02', start: '24:40', end: '25:20', seen: ['frame 25:02: he is talking to a handheld camera', 'said: the sun revolves around the earth'], confidence: 0.6, reason: 'A rambling wrong explanation that lands on a confident last line.', ...over });
  const err = (v: Record<string, unknown>) => applyQueueVerdicts(FOUND, data, [v]).refused[0]?.errors.join(' | ') ?? '';
  assert.match(err(found({ start: undefined })), /says where it is: set "start"/);
  assert.match(err(found({ verdict: 'reject', rejected: 'lore' })), /is for a moment you are confirming/);
  assert.match(err(found({ queueId: 'clip@0:26:30' })), /is not the moment/);
  assert.match(err(found({ queueId: 'meme@0:10:00', moment: '10:00', start: '9:50', end: '10:10' })), /there is already a queue here \(meme@0:10:00\)/);
  assert.match(err(found({ seen: ['said: the sun revolves around the earth'] })), /cites a frame/, 'the same rules as any confirm');
  assert.match(err({ queueId: 'clip@0:25:00', verdict: 'confirm', archetype: 'anecdote', seen: ['frame 25:02: x y z'], confidence: 0.6, reason: 'no queue and not marked found' }), /no clip queue near 0:25:00/);
  const r = applyQueueVerdicts(FOUND, data, [found({})]);
  assert.equal(r.refused.length, 0, JSON.stringify(r.refused));
  const v = loadQueueReview(FOUND).verdicts[0];
  assert.equal(v.found, true);
  assert.equal(v.queueId, 'clip@0:25:00');
  assert.deepEqual(confirmedMoments(loadQueueReview(FOUND)).map((m) => m.primary.queueId), ['clip@0:25:00']);
  // the extractor can ask for windows on it: the queue is rebuilt from the ledger
  const q = queueFromVerdict(v);
  assert.equal(q.peakMs, 25 * MIN + 2000);
  assert.equal(q.anchor, 'expert');
  assert.ok(q.startMs <= 24 * MIN + 40_000 && q.endMs >= 25 * MIN + 20_000);
});

test('a queue that moved a few seconds is still judged; a moment both experts passed on is flagged', () => {
  const ledger = loadQueueReview(VID);
  const all = (['meme', 'viral', 'clip'] as const).flatMap((kind) => queuesFrom(data, { kind, limit: 50 }));
  const moved = all.map((q) => (q.id === 'meme@0:10:00' ? { ...q, id: 'meme@0:10:10', peakMs: q.peakMs + 10_000 } : q));
  assert.ok(!pendingQueues(ledger, moved).some((q) => q.id === 'meme@0:10:10'), 'the verdict on meme@0:10:00 covers it');
  const v = (queueId: string, kind: string, rejected: string, peakMs: number) => ({ queueId, kind, verdict: 'reject', rejected, seen: [], risks: [], confidence: 0.7, reason: '', queue: { startMs: peakMs - 5000, endMs: peakMs + 5000, peakMs, anchor: 'audio', score: 1, witnesses: [] }, at: '' });
  const passed = { videoId: 'x', updatedAt: '', verdicts: [v('meme@0:05:00', 'meme', 'other-kind', 5 * MIN), v('clip@0:05:05', 'clip', 'other-kind', 5 * MIN + 5000), v('meme@0:08:00', 'meme', 'other-kind', 8 * MIN), v('clip@0:08:00', 'clip', 'nothing-happened', 8 * MIN), v('viral@0:12:00', 'viral', 'no-reach', 12 * MIN)] } as never;
  assert.deepEqual(orphanedMoments(passed).map((g) => g.map((x: { queueId: string }) => x.queueId)), [['meme@0:05:00', 'clip@0:05:05']], 'each said it was the other one\'s; a moment someone really judged is not an orphan');
  // seen on a fresh stream: these three were flagged, and each had been judged
  const merge = (queueId: string, kind: string, peakMs: number) => ({ ...v(queueId, kind, '', peakMs), verdict: 'merge', rejected: undefined, mergeInto: 'meme@0:20:00' });
  const judged = { videoId: 'x', updatedAt: '', verdicts: [
    v('clip@0:15:00', 'clip', 'other-kind', 15 * MIN), merge('meme@0:15:00', 'meme', 15 * MIN), // the meme expert merged it into a gag it confirmed
    v('clip@0:17:00', 'clip', 'other-kind', 17 * MIN), v('meme@0:17:00', 'meme', 'no-reach', 17 * MIN), // the meme expert looked and said it has no reach
    v('clip@0:19:00', 'clip', 'other-kind', 19 * MIN), v('viral@0:19:00', 'viral', 'no-reach', 19 * MIN), // the virality expert only said it will not travel
  ] } as never;
  assert.deepEqual(orphanedMoments(judged).map((g) => g.map((x: { queueId: string }) => x.queueId)), [['clip@0:19:00', 'viral@0:19:00']]);
});

test('a cited frame has to be a still somebody fetched', () => {
  const LOOK = 'tw-4000000009';
  still(LOOK, '10:00');
  fs.writeFileSync(path.join(corePaths.videoFile(LOOK, 'frames'), `${parseTime('15:00')}_1280.jpg`), 'x'); // a wide still counts too
  const err = (v: Record<string, unknown>) => applyQueueVerdicts(LOOK, data, [v]).refused[0]?.errors.join(' | ') ?? '';
  assert.match(err(verdict({ seen: ['frame 10:30: he falls off the chair'] })), /cites frame 0:10:30, but no still was ever fetched for that second: run `clip frames tw-4000000009 0:10:30`/);
  assert.match(err(verdict({ seen: ['frame 10:00: he falls', 'frame 12:00: he gets up', 'frame 12:10: he leaves'] })), /cites frame 0:12:00, 0:12:10, but no still was ever fetched for those seconds/);
  assert.equal(err(verdict({ seen: ['frame 10:01: he falls off the chair'] })), '', 'a still within a second of the cited time counts');
  const reject = { queueId: 'meme@0:15:00', verdict: 'reject', rejected: 'nothing-happened', confidence: 0.9, reason: 'a shout, nothing on screen' };
  assert.match(err({ ...reject, seen: ['frame 15:20: a menu'] }), /no still was ever fetched/, 'a reject that cites a frame is held to it too');
  assert.equal(err({ ...reject, seen: ['frame 15:00: a menu', 'chat: LOL x4'] }), '');
  // only a line that starts with "frame <time>" is a citation
  assert.deepEqual(citedFrames(['frame 1:36:27: hands on his head', 'frames 2:00 and 2:05: the same shot', 'said: one frame at 3:00', 'chat: lol']), [5_787_000, 120_000]);
});

test('a quoted line has to be in the transcript, where there is one', () => {
  const SAID = 'tw-4000000010';
  still(SAID, '10:00');
  const err = (seen: string[]) => applyQueueVerdicts(SAID, data, [verdict({ queueId: 'clip@0:10:00', archetype: 'anecdote', seen: ['frame 10:00: two people on a couch', ...seen] })]).refused[0]?.errors.join(' | ') ?? '';
  assert.equal(err(['said: word word done. word word']), '');
  assert.match(err(['said: my mom dated a famous rapper once']), /"my mom dated a famous rapper once" is not in the transcript within a few minutes of the moment/);
  assert.equal(err(['said (after the cut): Word, WORD — done']), '', 'case and punctuation do not matter');
  assert.match(err(['said: word word done. … he never said this part']), /"he never said this part" is not in the transcript/, 'each part of a split quote is checked');
  assert.equal(err(['said: oh no']), '', 'two words prove nothing either way');
  // where nobody transcribed, the line cannot be checked: unknown is not wrong
  assert.deepEqual(findSaid(words, 'anything at all here', 20 * MIN, 25 * MIN), { known: false });
  assert.equal(findSaid(words, 'word word done', 9 * MIN, 11 * MIN).atMs, 9 * MIN + 30_000 + 6 * 300);
  assert.deepEqual(findSaid(words, 'he never said this', 9 * MIN, 11 * MIN), { known: true });
  assert.deepEqual(saidParts(['frame 1:00: x', 'said: a b c / d e f', 'transcript (later): g h']), ['a b c', 'd e f', 'g h']);
});

test('the still a frame line stands on is the nearest one, the plain one first', () => {
  const NEAR = 'tw-4000000011';
  still(NEAR, '10:00', '10:02');
  const wide = path.join(corePaths.videoFile(NEAR, 'frames'), `${parseTime('10:00')}_1280.jpg`);
  fs.writeFileSync(wide, 'x');
  const stills = stillFiles(NEAR);
  assert.equal(stills.length, 3);
  assert.equal(path.basename(stillNear(stills, parseTime('10:00'))!), '600000.jpg');
  assert.equal(path.basename(stillNear(stills, parseTime('10:01.4'))!), '602000.jpg');
  assert.equal(stillNear(stills, parseTime('10:04')), undefined);
});
