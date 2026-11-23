// The upload scheduler's decisions (src/publish/scheduler.ts): what goes up, what is held, set aside or
// deferred, and what a failed upload means. They decide what goes public, so the order is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateApproval, readFailure, MIN_UPLOAD_S, type ApprovalFacts } from '../src/publish/scheduler';
import { LIFT_MARGIN_MS } from '../src/publish/pace';

const ok: ApprovalFacts = { clipId: 'c1', hasExport: true, title: 'Nick FLIPS the truck 💀', durationS: 24, alreadyUploaded: false, unsafe: [], unsafeText: '', sexualWords: [] };
const H = 3_600_000;

test('a clean approval uploads', () => {
  assert.deepEqual(gateApproval(ok), { action: 'upload' });
});

test('no export, a broken length or a Short over a minute is set aside; under 15 s is the reviewer\'s call', () => {
  assert.deepEqual(gateApproval({ ...ok, hasExport: false }), { action: 'set-aside', why: 'no export' });
  assert.equal(gateApproval({ ...ok, durationS: MIN_UPLOAD_S - 0.5 }).action, 'set-aside');
  assert.equal(gateApproval({ ...ok, durationS: 60.5 }).action, 'set-aside');
  assert.equal(gateApproval({ ...ok, durationS: 13.6 }).action, 'upload', 'a 13.6 s approval goes up');
});

test('a placeholder title is held, not refused (it uploads once the title is edited)', () => {
  assert.equal(gateApproval({ ...ok, title: 'Review clip 3' }).action, 'hold-title');
});

test('an approval that went up before is recorded as uploaded, never posted twice', () => {
  assert.deepEqual(gateApproval({ ...ok, alreadyUploaded: true }), { action: 'already-uploaded' });
});

test('the never-post list sets an approval aside; a sexual title alone is held for an edit', () => {
  const nudity = { kind: 'nudity', why: 'nudity in 3 stills' };
  const title = { kind: 'title', why: 'the title says nude' };
  assert.deepEqual(gateApproval({ ...ok, unsafe: [nudity, title], unsafeText: 'c1: nudity' }), { action: 'set-aside', why: 'c1: nudity' });
  const held = gateApproval({ ...ok, unsafe: [title], sexualWords: ['nude'] });
  assert.equal(held.action, 'hold-title');
  assert.match(held.action === 'hold-title' ? held.why : '', /nude/);
});

test('the careful period defers what it would hold, and only while it is on', () => {
  const careful = { until: '2026-12-06', reasons: ['an f-word in the first 3 s'] };
  const d = gateApproval({ ...ok, careful });
  assert.equal(d.action, 'defer');
  assert.match(d.action === 'defer' ? d.why : '', /careful period until 2026-12-06.*f-word/);
  assert.equal(gateApproval({ ...ok, careful: { until: '2026-12-06', reasons: [] } }).action, 'upload');
});

test('the order: a missing export beats the never-post list, which beats the careful period', () => {
  const unsafe = [{ kind: 'slur', why: 'a slur is said' }];
  const careful = { until: '2026-12-06', reasons: ['18+'] };
  assert.equal(gateApproval({ ...ok, hasExport: false, unsafe, careful }).action, 'set-aside');
  assert.equal((gateApproval({ ...ok, unsafe, unsafeText: 'slur', careful }) as { why?: string }).why, 'slur');
});

test("the channel's upload limit holds the clip until a day after the first upload of the last 24 hours", () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const uploads = [now - 20 * H, now - 3 * H];
  const f = readFailure('{"reason": "uploadLimitExceeded", "message": "The user has exceeded the number of videos they may upload."}', { now, uploads, retryMin: 60 });
  assert.equal(f.kind, 'hold');
  if (f.kind !== 'hold') return;
  assert.equal(f.hold, 'upload-limit');
  assert.equal(f.nextTryAt, uploads[0] + 24 * H + LIFT_MARGIN_MS);
  assert.match(f.said, /uploadLimitExceeded/);
});

test("the project's quota holds until midnight Pacific; a passing error until the retry interval", () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const q = readFailure('quotaExceeded', { now, uploads: [], retryMin: 60 });
  assert.equal(q.kind === 'hold' && q.hold, 'api-quota');
  assert.ok(q.kind === 'hold' && q.nextTryAt > now && new Date(q.nextTryAt - LIFT_MARGIN_MS).getUTCHours() === 8, 'midnight Pacific is 08:00 UTC in November');
  const e = readFailure('fetch failed\nECONNRESET', { now, uploads: [], retryMin: 60 });
  assert.deepEqual(e.kind === 'hold' && [e.hold, e.nextTryAt], ['error', now + 60 * 60_000]);
});

test('a broken login holds every approval; anything else is a refusal retrying cannot fix', () => {
  const now = Date.now();
  assert.equal(readFailure('token refresh failed: invalid_grant', { now, uploads: [], retryMin: 60 }).kind, 'auth');
  const r = readFailure('Error: exports/c1.mp4 was rendered without the creator\'s name on screen', { now, uploads: [], retryMin: 60 });
  assert.equal(r.kind, 'refused');
  assert.deepEqual(readFailure('', { now, uploads: [], retryMin: 60 }), { kind: 'refused', why: 'upload failed' });
});
