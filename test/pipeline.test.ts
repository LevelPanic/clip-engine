// The unattended pipeline's hand-offs (src/pipeline/full.ts): a moment job works on its own candidates only.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pickForEdit, momentBrief, passCandidates } = await import('../src/pipeline/full');

const d = (candidateId: string, decision: 'keep' | 'review' | 'drop', fit: number, reason = `${candidateId} reason`) => ({ candidateId, decision, fit, reason });

test("the editor gets this pass's kept candidates only, strongest fit first, never an older leftover", () => {
  const decisions = [d('c01', 'keep', 95), d('c07', 'keep', 70), d('c08', 'keep', 81), d('c09', 'drop', 99)];
  // c01 is a leftover from an earlier range scan: kept, no clip, and a higher fit than anything new
  assert.deepEqual(pickForEdit(['c07', 'c08', 'c09'], decisions, new Set(), 1), [{ id: 'c08' }]);
  assert.deepEqual(pickForEdit(['c07', 'c08', 'c09'], decisions, new Set(), 3), [{ id: 'c08' }, { id: 'c07' }]);
});

test('when the curator kept nothing, its best "for the reviewer" candidate goes to review with the concern; a drop never does', () => {
  const decisions = [d('c04', 'review', 74, 'the cut ends before the payoff'), d('c05', 'review', 64), d('c06', 'drop', 90)];
  assert.deepEqual(pickForEdit(['c04', 'c05', 'c06'], decisions, new Set(), 1), [{ id: 'c04', concern: 'the cut ends before the payoff' }]);
  assert.deepEqual(pickForEdit(['c06'], decisions, new Set(), 1), [], 'only a drop: nothing to edit');
});

test('a candidate that already has a clip is not made again', () => {
  assert.deepEqual(pickForEdit(['c02', 'c03'], [d('c02', 'keep', 90), d('c03', 'keep', 60)], new Set(['c02']), 1), [{ id: 'c03' }]);
});

test('the experts are told which moment the community picked, with its evidence', () => {
  const b = momentBrief({ peakMs: (4 * 3600 + 49 * 60 + 10) * 1000, fromMs: (4 * 3600 + 48 * 60 + 35) * 1000, toMs: (4 * 3600 + 49 * 60 + 57) * 1000, why: ['2 viewer clips, 38,018 views, 2 people clipped it'], titles: ['xQc commits Grand Theft Auto for the first time in GTA 6'] });
  assert.match(b, /4:49:10/);
  assert.match(b, /38,018 views/);
  assert.match(b, /commits Grand Theft Auto/);
});

test("a pass's candidates: the ones just extracted, plus an unclipped one already inside the window; nothing from elsewhere", () => {
  const MIN = 60_000;
  const cands = [
    { id: 'c04', status: 'new', startMs: 10 * MIN + 21_000, endMs: 10 * MIN + 52_000 }, // the first run's cut of this moment
    { id: 'c01', status: 'new', startMs: 4 * 60 * MIN, endMs: 4 * 60 * MIN + 30_000 }, // a leftover hours away
    { id: 'c02', status: 'made', startMs: 9 * MIN, endMs: 9 * MIN + 20_000 }, // has a clip already
    { id: 'c03', status: 'skipped', startMs: 11 * MIN, endMs: 11 * MIN + 20_000 }, // dropped
  ];
  assert.deepEqual(passCandidates([], cands, 8 * MIN + 58_000, 12 * MIN + 43_000), ['c04']);
  const withNew = [...cands, { id: 'c09', status: 'new', startMs: 10 * MIN + 30_000, endMs: 11 * MIN }];
  assert.deepEqual(passCandidates(['c09'], withNew, 8 * MIN + 58_000, 12 * MIN + 43_000), ['c09', 'c04']);
});

test('an extractor addition outside the window is not the pass\'s, even though the extractor just made it', () => {
  const MIN = 60_000;
  const cands = [
    { id: 'c10', status: 'new', startMs: 10 * MIN, endMs: 10 * MIN + 30_000 }, // inside the 45 s job window
    { id: 'c11', status: 'new', startMs: 70 * MIN, endMs: 70 * MIN + 30_000 }, // an hour away
  ];
  assert.deepEqual(passCandidates(['c10', 'c11'], cands, 10 * MIN - 10_000, 10 * MIN + 35_000), ['c10']);
});

test('a job that stopped after a stage resumes at the next one', async () => {
  const { stagesToRun } = await import('../src/pipeline/full');
  assert.deepEqual([...stagesToRun()], ['queue-check', 'extract', 'curate', 'edit']);
  assert.deepEqual([...stagesToRun('extract')], ['curate', 'edit']);
  assert.deepEqual([...stagesToRun('edit')], []);
  assert.deepEqual([...stagesToRun('scanned')], ['queue-check', 'extract', 'curate', 'edit'], 'a stage before the pipeline: all of it');
});

test('after a restart, a clip the job already submitted counts, and only picks without one go to the editor', async () => {
  const { outputsFor } = await import('../src/pipeline/full');
  const picks = [{ id: 'c04' }, { id: 'c06', concern: 'cut ends early' }];
  const r = outputsFor('tw-1', picks, ['tw-1-c04', 'tw-1-c02', 'tw-9-c06']);
  assert.deepEqual(r.clips, ['tw-1-c04'], "the job's own clip, not another candidate's or another video's");
  assert.deepEqual(r.todo.map((p) => p.id), ['c06']);
  assert.deepEqual(outputsFor('tw-1', [{ id: 'c04' }], ['tw-1-c04-v2']).clips, ['tw-1-c04-v2'], 'a copy counts');
});
