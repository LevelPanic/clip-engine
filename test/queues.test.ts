// Queue checkers on synthetic streams with known answers: what counts as a witness, where the moment
// is placed (chat trails it), what each kind's gate lets through, and what is unknown rather than quiet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueBinScore, queueGate, queuesFrom, coverageOf, describeCoverage, findQueue, type QueueData } from '../src/scan/queues';
import { riskTerms, slurIn, chatSlurs } from '../src/core/risk';
import { detectReactions, type AudioDetection, type ReactionKind } from '../src/discover/signals/audio';
import type { ChatMessage } from '../src/discover/chatAnalysis';
import type { Word } from '../src/core/schemas';

const MIN = 60_000;
const SEC = 1000;
/** `perTenSec` distinct chatters every 10 s from `from` to `to`, saying `text`. */
function steady(from: number, to: number, perTenSec: number, text = 'hello'): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let t = from; t < to; t += 10_000) for (let k = 0; k < perTenSec; k++) out.push([t + k * (10_000 / perTenSec), `u${t}_${k}`, text]);
  return out;
}
const burst = (at: number, chatters: number, text: string): ChatMessage[] => Array.from({ length: chatters }, (_, k) => [at + (k * 9000) / chatters, `b${at}_${k}`, text] as ChatMessage);
const heard = (kind: ReactionKind, startMs: number): AudioDetection => ({ kind, startMs, endMs: startMs + 2250, peak: 0.9, windows: 2 });
/** Talk at `perSec` words a second. */
const talk = (from: number, to: number, perSec = 3): Word[] => {
  const out: Word[] = [];
  for (let t = from, i = 0; t < to; t += SEC / perSec, i++) out.push({ i, startMs: Math.round(t), endMs: Math.round(t + SEC / perSec - 40), text: i % 9 === 8 ? 'done.' : 'word' });
  return out;
};
const DUR = 30 * MIN;
const all = [{ startMs: 0, endMs: DUR }];
const stream = (over: Partial<QueueData> = {}): QueueData => ({
  durationMs: DUR,
  platform: 'twitch',
  chat: { messages: steady(0, DUR, 3), fetched: all },
  reactions: [],
  audioAnalysed: true,
  clips: [],
  clipsFetched: true,
  transcript: { words: [], tags: [], covered: all },
  titleHits: [],
  excluded: [],
  ...over,
});
const withChat = (extra: ChatMessage[]) => ({ messages: [...steady(0, DUR, 3), ...extra].sort((a, b) => a[0] - b[0]), fetched: all });

const bin = { chatUnique: 50, chatBaseline: 20, reactions: {}, clipCount: 0, clipViews: 0, speechWpm: 0, hasSpeech: false, titleMatch: 0 };

test('a loud short reaction scores highest as a meme queue', () => {
  const input = { ...bin, reactions: { shout: 3, laugh: 2 }, clipCount: 1, clipViews: 20 };
  const meme = queueBinScore({ ...input, kind: 'meme' });
  const viral = queueBinScore({ ...input, kind: 'viral' });
  const clip = queueBinScore({ ...input, kind: 'clip' });
  assert.ok(meme.score > viral.score, `${meme.score} vs ${viral.score}`);
  assert.ok(meme.score > clip.score, `${meme.score} vs ${clip.score}`);
  assert.deepEqual(meme.witnesses, ['chat', 'reaction', 'clips']);
});

test('a talky, titled story scores highest as a clip queue, and talk alone is no witness', () => {
  const input = { ...bin, chatUnique: 22, speechWpm: 220, hasSpeech: true, titleMatch: 0.9 };
  const meme = queueBinScore({ ...input, kind: 'meme' });
  const viral = queueBinScore({ ...input, kind: 'viral' });
  const clip = queueBinScore({ ...input, kind: 'clip' });
  assert.ok(clip.score > meme.score, `${clip.score} vs ${meme.score}`);
  assert.ok(clip.score > viral.score, `${clip.score} vs ${viral.score}`);
  assert.deepEqual(clip.witnesses, []);
});

test('viewer clips push the viral checker above the other two', () => {
  const input = { ...bin, chatUnique: 60, clipCount: 3, clipViews: 240 };
  const meme = queueBinScore({ ...input, kind: 'meme' });
  const viral = queueBinScore({ ...input, kind: 'viral' });
  const clip = queueBinScore({ ...input, kind: 'clip' });
  assert.ok(viral.score > clip.score, `${viral.score} vs ${clip.score}`);
  assert.ok(viral.score > meme.score, `${viral.score} vs ${meme.score}`);
});

test('each kind has its own gate', () => {
  const e = { witnesses: [] as ('chat' | 'reaction' | 'clips')[], mood: 'neutral' as const, clipViews: 0, hasSpeech: false, speechCovered: true, titleMatch: 0 };
  assert.equal(queueGate('meme', { ...e, witnesses: ['reaction'] }), true);
  assert.equal(queueGate('meme', { ...e, witnesses: ['chat'], mood: 'funny' }), true);
  assert.equal(queueGate('meme', { ...e, witnesses: ['chat'], mood: 'hype' }), false, 'cheering is not a gag');
  assert.equal(queueGate('viral', { ...e, witnesses: ['chat'] }), false, 'one witness is not reach');
  assert.equal(queueGate('viral', { ...e, witnesses: ['chat', 'reaction'] }), true);
  assert.equal(queueGate('viral', { ...e, witnesses: ['clips'], clipViews: 100 }), true);
  assert.equal(queueGate('clip', { ...e, witnesses: ['reaction'] }), false, 'a story needs words');
  assert.equal(queueGate('clip', { ...e, witnesses: ['reaction'], hasSpeech: true }), true);
  assert.equal(queueGate('clip', { ...e, witnesses: ['reaction'], speechCovered: false }), true, 'not transcribed is unknown, not silent');
  assert.equal(queueGate('clip', { ...e, hasSpeech: true, titleMatch: 0.9 }), true, 'the moment the title promises');
});

test('classifier noise is not a reaction', () => {
  const ev = (label: string, confidence: number, ms = 1000) => ({ ms, label, confidence });
  const file = (events: ReturnType<typeof ev>[]) => ({ events, windowMs: 1500, hopMs: 750 });
  assert.deepEqual(detectReactions(file([ev('gasp', 0.9), ev('booing', 0.95), ev('battle_cry', 0.9), ev('laughter', 0.35), ev('shout', 0.5)])), []);
  const d = detectReactions(file([ev('laughter', 0.7, 1000), ev('laughter', 0.8, 1750), ev('screaming', 0.7, 9000)]));
  assert.deepEqual(d.map((x) => [x.kind, x.startMs, x.windows]), [['laugh', 1000, 2], ['shout', 9000, 1]]);
});

test('a laugh and the chat spike it caused are one meme queue, placed on the laugh', () => {
  const data = stream({ reactions: [heard('laugh', 10 * MIN)], chat: withChat(burst(10 * MIN + 15 * SEC, 30, 'KEKW')) });
  const q = queuesFrom(data, { kind: 'meme' });
  assert.equal(q.length, 1);
  assert.equal(q[0].anchor, 'audio');
  assert.equal(q[0].peakMs, 10 * MIN);
  assert.equal(q[0].id, 'meme@0:10:00');
  assert.deepEqual(q[0].witnesses, ['chat', 'reaction']);
  assert.equal(q[0].signals.chat.mood, 'funny');
  assert.equal(q[0].signals.chat.top[0].text, 'KEKW');
  assert.ok(q[0].startMs <= 10 * MIN - 8 * SEC && q[0].endMs >= 10 * MIN + 10 * SEC, `${q[0].startMs}–${q[0].endMs}`);
  // the same moment is a viral queue too (two witnesses), with a wider region
  const v = queuesFrom(data, { kind: 'viral' });
  assert.equal(v.length, 1);
  assert.ok(v[0].endMs - v[0].startMs > q[0].endMs - q[0].startMs);
});

test('chat alone puts the moment before the spike, and says it is an estimate', () => {
  const spike = 10 * MIN + 15 * SEC;
  const q = queuesFrom(stream({ chat: withChat(burst(spike, 30, 'LMAOOO')) }), { kind: 'meme' });
  assert.equal(q.length, 1);
  assert.equal(q[0].anchor, 'chat');
  assert.ok(q[0].peakMs <= spike - 10 * SEC && q[0].peakMs >= spike - 25 * SEC, `moment ${q[0].peakMs - spike} ms from the spike`);
  assert.ok(q[0].startMs <= spike - 25 * SEC, 'the region reaches back past the chat lag');
  assert.ok(q[0].risks.some((r) => /estimated from chat/.test(r)));
});

test('cheering chat is not a meme, and one witness is not viral', () => {
  const data = stream({ chat: withChat(burst(10 * MIN, 30, 'POGGERS')) });
  assert.equal(queuesFrom(data, { kind: 'meme' }).length, 0);
  assert.equal(queuesFrom(data, { kind: 'viral' }).length, 0);
});

test('fast talk with no witness makes no queue of any kind', () => {
  const data = stream({ transcript: { words: talk(8 * MIN, 12 * MIN, 4.5), tags: [], covered: all } });
  for (const kind of ['meme', 'viral', 'clip'] as const) assert.equal(queuesFrom(data, { kind }).length, 0, kind);
});

test('a story queue needs words: silent is not a story, untranscribed is unknown', () => {
  const laugh = [heard('laugh', 10 * MIN)];
  const spoken = queuesFrom(stream({ reactions: laugh, transcript: { words: talk(9 * MIN + 20 * SEC, 10 * MIN + 20 * SEC), tags: [], covered: all } }), { kind: 'clip' });
  assert.equal(spoken.length, 1);
  assert.ok(spoken[0].signals.speech.words > 50);
  assert.ok(spoken[0].endMs - spoken[0].startMs >= 50 * SEC, 'a story region has room for the setup');
  assert.equal(queuesFrom(stream({ reactions: laugh }), { kind: 'clip' }).length, 0, 'transcribed and silent');
  const unknown = queuesFrom(stream({ reactions: laugh, transcript: { words: [], tags: [], covered: [] } }), { kind: 'clip' });
  assert.equal(unknown.length, 1);
  assert.ok(unknown[0].risks.some((r) => /not fully transcribed/.test(r)));
});

test('viewer clips people watched make a viral queue around the clip offset', () => {
  const data = stream({ clips: [{ offsetMs: 12 * MIN, durationMs: 30_000, views: 100, title: 'he fell', slug: 'a' }] });
  const q = queuesFrom(data, { kind: 'viral' });
  assert.equal(q.length, 1);
  assert.equal(q[0].anchor, 'clip');
  assert.equal(q[0].peakMs, 12 * MIN);
  assert.ok(q[0].startMs <= 12 * MIN - 30 * SEC && q[0].endMs >= 12 * MIN + 25 * SEC, 'covers a clip length either side of the offset');
  assert.equal(queuesFrom(stream({ clips: [{ offsetMs: 12 * MIN, durationMs: 30_000, views: 2, title: 'x', slug: 'b' }] }), { kind: 'viral' }).length, 0, 'a clip nobody watched is one weak witness');
});

test('a raid is busy chat, not a moment', () => {
  const data = stream({ chat: withChat([...burst(10 * MIN, 40, 'WW raid'), ...burst(10 * MIN + 3000, 20, 'louuiRaid KEKW')]) });
  assert.equal(queuesFrom(data, { kind: 'meme' }).length, 0);
  assert.equal(queuesFrom(data, { kind: 'viral' }).length, 0);
});

test('muted stretches never make a queue', () => {
  const data = stream({ reactions: [heard('laugh', 10 * MIN)], excluded: [{ startMs: 9 * MIN + 50 * SEC, endMs: 10 * MIN + 20 * SEC, category: 'muted' }] });
  assert.equal(queuesFrom(data, { kind: 'meme' }).length, 0);
});

test('two moments a minute apart are two queues, and a range only returns its own', () => {
  const data = stream({ reactions: [heard('laugh', 10 * MIN), heard('shout', 11 * MIN)] });
  assert.deepEqual(queuesFrom(data, { kind: 'meme' }).map((q) => q.id).sort(), ['meme@0:10:00', 'meme@0:11:00']);
  assert.deepEqual(queuesFrom(data, { kind: 'meme', fromMs: 10 * MIN + 30 * SEC, toMs: 12 * MIN }).map((q) => q.id), ['meme@0:11:00']);
});

test('queue ids are stable and resolve when the moment moved a little', () => {
  const data = stream({ reactions: [heard('laugh', 10 * MIN + 2000)] });
  const a = queuesFrom(data, { kind: 'meme' });
  const b = queuesFrom(data, { kind: 'meme' });
  assert.deepEqual(a.map((q) => q.id), b.map((q) => q.id));
  assert.equal(a[0].id, 'meme@0:10:00');
  assert.equal(findQueue(a, 'meme@0:10:10')?.id, 'meme@0:10:00');
  assert.equal(findQueue(a, 'viral@0:10:00'), undefined);
  assert.equal(findQueue(a, 'meme@0:12:00'), undefined);
});

test('an unscanned range is blind, not quiet; a half-scanned one says what is missing', () => {
  const range = { startMs: 10 * MIN, endMs: 20 * MIN };
  const none = coverageOf(stream({ chat: undefined, audioAnalysed: false, clipsFetched: false, transcript: undefined }), range);
  assert.equal(none.blind, true);
  assert.equal(none.chat.state, 'none');
  const half = coverageOf(stream({ chat: { messages: [], fetched: [{ startMs: 0, endMs: 15 * MIN }] }, audioCovered: [{ startMs: 12 * MIN, endMs: 20 * MIN }] }), range);
  assert.equal(half.blind, false);
  assert.equal(half.chat.state, 'partial');
  assert.deepEqual(half.chat.missing, [{ startMs: 15 * MIN, endMs: 20 * MIN }]);
  assert.deepEqual(half.audio.missing, [{ startMs: 10 * MIN, endMs: 12 * MIN }]);
  // a YouTube video has no chat to miss, and its audio and transcript cover everything
  const yt = coverageOf(stream({ platform: 'youtube', chat: undefined, audioCovered: undefined, transcript: { words: [], tags: [{ ms: 1, tag: 'laughter' }] } }), range);
  assert.equal(yt.chat.state, 'n/a');
  assert.equal(yt.audio.state, 'full');
  assert.equal(yt.blind, false);
});

test('chat that was never fetched is flagged on the queue', () => {
  const q = queuesFrom(stream({ chat: undefined, reactions: [heard('laugh', 10 * MIN)] }), { kind: 'meme' });
  assert.equal(q.length, 1);
  assert.ok(q[0].risks.includes('chat not fetched here'));
  assert.equal(q[0].signals.chat.fetched, false);
});

test('risk words in chat or clip titles are named', () => {
  assert.deepEqual(riskTerms('LEEKED | he showed his address'), ['privacy (leak, dox, address): "leeked"']);
  assert.equal(riskTerms('nice clutch').length, 0);
  const q = queuesFrom(stream({ reactions: [heard('shout', 10 * MIN)], chat: withChat(burst(10 * MIN + 12 * SEC, 30, 'LEAKED')) }), { kind: 'meme' });
  assert.ok(q[0].risks.some((r) => /privacy/.test(r)), q[0].risks.join('; '));
});

test('a queue with no chat spike still reads what chat said over its region', () => {
  // found by a viewer clip; chat is steady (no spike) but a dozen people are calling it fake
  const doubters: ChatMessage[] = Array.from({ length: 12 }, (_, k) => [12 * MIN - 30_000 + k * 5000, `d${k}`, k % 2 ? 'FAKE' : 'AI']); // one every 5 s: busy, but no spike
  const data = stream({ clips: [{ offsetMs: 12 * MIN, durationMs: 30_000, views: 100, title: 'he bought it', slug: 'a' }], chat: withChat(doubters) });
  const q = queuesFrom(data, { kind: 'viral' })[0];
  assert.deepEqual(q.witnesses, ['clips']);
  assert.equal(q.signals.chat.spike, false);
  assert.ok(q.signals.chat.doubt >= 10, `doubt ${q.signals.chat.doubt}`);
  assert.equal(q.signals.chat.mood, 'irony');
  assert.ok(q.risks.some((r) => /call it fake, staged or AI/.test(r)));
  assert.ok(q.risks.some((r) => /read on before cutting/.test(r)));
});

test('a viewer clip made too soon after its offset says which side to look', () => {
  const startedAt = '2026-11-11T20:00:00Z';
  const at = (ms: number) => new Date(Date.parse(startedAt) + ms).toISOString();
  const clip = { offsetMs: 12 * MIN, durationMs: 30_000, views: 100, title: 'x', slug: 'a' };
  const early = queuesFrom(stream({ startedAt, clips: [{ ...clip, createdAt: at(12 * MIN + 4000) }] }), { kind: 'viral' })[0];
  assert.ok(early.risks.some((r) => /made 4 s after its offset, sooner than its own 30 s, so its content is BEFORE the offset/.test(r)), early.risks.join(' | '));
  const late = queuesFrom(stream({ startedAt, clips: [{ ...clip, createdAt: at(12 * MIN + 50_000) }] }), { kind: 'viral' })[0];
  assert.ok(late.risks.some((r) => /look after the offset first/.test(r)));
  const unknown = queuesFrom(stream({ clips: [clip] }), { kind: 'viral' })[0];
  assert.ok(unknown.risks.some((r) => /look both sides/.test(r)));
});

test('slurs typed in chat during a region are counted, because chat is often on screen', () => {
  assert.equal(slurIn('that was a r3tarded purchase'), 'r3tarded');
  assert.equal(slurIn('RETARD'), 'retard');
  assert.equal(slurIn('this is so spicy'), undefined);
  assert.equal(slurIn('raccoons are cute, nighttime vibes'), undefined);
  assert.equal(slurIn('nice clip bro'), undefined);
  const msgs: ChatMessage[] = [[1000, 'a', 'retarded purchase'], [2000, 'b', 'lol'], [3000, 'a', 'so retarded'], [90_000, 'c', 'retard']];
  assert.deepEqual(chatSlurs(msgs, 0, 60_000), { count: 2, people: 1, firstMs: 1000 });
  const q = queuesFrom(stream({ reactions: [heard('laugh', 10 * MIN)], chat: withChat([[10 * MIN + 3000, 'x', 'Retarded purchase']]) }), { kind: 'meme' })[0];
  assert.equal(q.signals.chat.slurs, 1);
  assert.ok(q.risks.some((r) => /contains a slur \(typed at 0:10:03/.test(r)), q.risks.join(' | '));
});

test('the coverage warning says where the transcript is missing', () => {
  const c = coverageOf(stream({ transcript: { words: [], tags: [], covered: [{ startMs: 0, endMs: 12 * MIN }, { startMs: 15 * MIN, endMs: 30 * MIN }] } }), { startMs: 10 * MIN, endMs: 20 * MIN });
  assert.ok(describeCoverage(c).some((l) => /transcript not there for 0:12:00–0:15:00/.test(l)), describeCoverage(c).join(' | '));
});

test('a yes/no vote is busy chat, not a witness; a barely-watched clip in an unread part is not a story lead', () => {
  const vote = [...burst(10 * MIN, 21, 'yes'), ...burst(10 * MIN + 500, 12, 'NO')].sort((a, b) => a[0] - b[0]);
  for (const kind of ['meme', 'viral', 'clip'] as const) assert.equal(queuesFrom(stream({ chat: withChat(vote) }), { kind }).length, 0, kind);
  // with a laugh as well it is a queue, and the vote is named so the expert is not fooled by the spike
  const q = queuesFrom(stream({ chat: withChat(vote), reactions: [heard('laugh', 10 * MIN - 8000)] }), { kind: 'meme' })[0];
  assert.deepEqual(q.witnesses, ['reaction']);
  assert.ok(q.risks.some((r) => /voting yes and no/.test(r)), q.risks.join(' | '));
  const e = { witnesses: ['clips'] as ('chat' | 'reaction' | 'clips')[], mood: 'neutral' as const, hasSpeech: false, speechCovered: false, titleMatch: 0 };
  assert.equal(queueGate('clip', { ...e, clipViews: 4 }), false);
  assert.equal(queueGate('clip', { ...e, clipViews: 100 }), true);
  assert.equal(queueGate('clip', { ...e, clipViews: 4, hasSpeech: true, speechCovered: true }), true, 'with words read, one viewer clip is enough');
});
