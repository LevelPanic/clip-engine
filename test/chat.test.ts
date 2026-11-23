// Chat spike detection on synthetic chat with known answers, plus the edge cases that fool naive
// counters: spammers, bots, slow growth, unfetched gaps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChatSpikes, reactionOf, chatRates, readChat, normToken, type ChatMessage } from '../src/discover/chatAnalysis';

const MIN = 60_000;
/** `perTenSec` distinct chatters every 10 s from `from` to `to`, saying `text`. */
function steady(from: number, to: number, perTenSec: number, text = 'hello'): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let t = from; t < to; t += 10_000) for (let k = 0; k < perTenSec; k++) out.push([t + k * (10_000 / perTenSec), `u${t}_${k}`, text]);
  return out;
}
function burst(at: number, chatters: number, text: string): ChatMessage[] {
  return Array.from({ length: chatters }, (_, k) => [at + (k * 9000) / chatters, `b${at}_${k}`, text] as ChatMessage);
}
const all = (dur: number) => [{ startMs: 0, endMs: dur }];

test('quiet, steady chat has no spikes', () => {
  assert.deepEqual(findChatSpikes(steady(0, 10 * MIN, 3), all(10 * MIN), 10 * MIN), []);
});

test('a burst of laughing chatters is one funny spike just after the moment', () => {
  const msgs = [...steady(0, 10 * MIN, 3), ...burst(6 * MIN, 30, 'KEKW KEKW')].sort((a, b) => a[0] - b[0]);
  const spikes = findChatSpikes(msgs, all(10 * MIN), 10 * MIN);
  assert.equal(spikes.length, 1);
  const s = spikes[0];
  assert.ok(Math.abs(s.peakMs - 6 * MIN) <= 10_000, `peak at ${s.peakMs}`);
  assert.ok(s.ratio >= 5, `ratio ${s.ratio}`);
  assert.equal(s.reaction, 'funny');
  assert.equal(s.top[0].text, 'KEKW');
});

test('one person spamming is not a spike (distinct chatters, not messages)', () => {
  const spam: ChatMessage[] = Array.from({ length: 80 }, (_, k) => [6 * MIN + k * 100, 'spammer', 'LUL']);
  assert.deepEqual(findChatSpikes([...steady(0, 10 * MIN, 3), ...spam], all(10 * MIN), 10 * MIN), []);
});

test('bots are ignored', () => {
  const bots: ChatMessage[] = ['nightbot', 'streamelements', 'fossabot', 'moobot', 'streamlabs', 'sery_bot', 'wizebot'].flatMap((b) => Array.from({ length: 3 }, (_, k) => [6 * MIN + k * 1000, b, 'follow!'] as ChatMessage));
  assert.deepEqual(findChatSpikes([...steady(0, 10 * MIN, 3), ...bots], all(10 * MIN), 10 * MIN), []);
});

test('a stream that slowly gets busier has no spikes (normal follows it)', () => {
  const msgs: ChatMessage[] = [];
  for (let m = 0; m < 30; m++) msgs.push(...steady(m * MIN, (m + 1) * MIN, 2 + Math.floor(m / 3)));
  assert.deepEqual(findChatSpikes(msgs, all(30 * MIN), 30 * MIN), []);
});

test('chat outside fetched ranges is unknown, not quiet', () => {
  const msgs = [...steady(0, 5 * MIN, 3), ...steady(20 * MIN, 25 * MIN, 3)];
  const fetched = [{ startMs: 0, endMs: 5 * MIN }, { startMs: 20 * MIN, endMs: 25 * MIN }];
  const rate = chatRates(msgs, fetched, 25 * MIN);
  assert.ok(Number.isNaN(rate[Math.floor(10 * MIN / 5000)]));
  assert.deepEqual(findChatSpikes(msgs, fetched, 25 * MIN), []);
});

test('a spike right at the start of a fetched range still counts (normal from what follows)', () => {
  const msgs = [...burst(60 * MIN + 2_000, 25, 'W'), ...steady(60 * MIN, 66 * MIN, 3)].sort((a, b) => a[0] - b[0]);
  const spikes = findChatSpikes(msgs, [{ startMs: 60 * MIN, endMs: 66 * MIN }], 70 * MIN);
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].reaction, 'hype');
});

test('"clip it" requests are counted per person', () => {
  const asks: ChatMessage[] = Array.from({ length: 8 }, (_, k) => [6 * MIN + k * 500, `c${k}`, k % 2 ? 'CLIP IT' : 'clip that']);
  const msgs = [...steady(0, 10 * MIN, 3), ...burst(6 * MIN, 20, 'OMEGALUL'), ...asks].sort((a, b) => a[0] - b[0]);
  assert.equal(findChatSpikes(msgs, all(10 * MIN), 10 * MIN)[0].clipRequests, 8);
});

test('reaction words', () => {
  assert.equal(reactionOf('???'), 'shock');
  assert.equal(reactionOf('LETS GOOOO'), 'hype');
  assert.equal(reactionOf('o7'), 'fail');
  assert.equal(reactionOf('KEKW KEKW'), 'funny');
  assert.equal(reactionOf('no way'), 'shock');
  assert.equal(reactionOf('what did he say'), 'shock');
  assert.equal(reactionOf('nice weather today'), undefined);
});

test('a raid makes chat busy but is flagged, not taken for a moment', () => {
  const raid = burst(6 * MIN, 40, 'WW raid');
  const emote = burst(6 * MIN + 3000, 20, 'louuiRaid');
  const s = findChatSpikes([...steady(0, 10 * MIN, 3), ...raid, ...emote].sort((a, b) => a[0] - b[0]), all(10 * MIN), 10 * MIN);
  assert.equal(s.length, 1);
  assert.equal(s[0].raid, true);
  const laugh = findChatSpikes([...steady(0, 10 * MIN, 3), ...burst(6 * MIN, 40, 'KEKW')].sort((a, b) => a[0] - b[0]), all(10 * MIN), 10 * MIN);
  assert.ok(!laugh[0].raid);
});

test('stretched and repeated spellings are one token', () => {
  assert.equal(normToken('LMAOOOO'), 'lmao');
  assert.equal(normToken('hahahaha'), 'haha');
  assert.equal(normToken('lololol'), 'lol');
  assert.equal(normToken('WWWW'), 'w');
  assert.equal(normToken('KEKW!!'), 'kekw');
  assert.equal(reactionOf('LMAOOOO'), 'funny');
  assert.equal(reactionOf('AHAHAHAH'), 'funny');
  assert.equal(reactionOf('WWWWWW'), 'hype');
  assert.equal(reactionOf('LLLL'), 'fail');
  assert.equal(reactionOf('💀💀💀'), 'funny');
});

test('ordinary words count only when chat shouts or stretches them', () => {
  assert.equal(reactionOf('NO'), 'shock');
  assert.equal(reactionOf('nooooo'), 'shock');
  assert.equal(reactionOf('no I think he is right'), undefined);
  assert.equal(reactionOf('OOOO'), 'hype');
  assert.equal(reactionOf('yo how is everyone'), undefined);
});

test('the reactions a gag expert needs to tell apart', () => {
  assert.equal(reactionOf('monkaS'), 'tension');
  assert.equal(reactionOf('oh no'), 'tension');
  assert.equal(reactionOf('he is crashing out'), 'rage');
  assert.equal(reactionOf('MALDING'), 'rage');
  assert.equal(reactionOf('Clueless'), 'irony', 'chat knows what the streamer does not');
  assert.equal(reactionOf('COPIUM'), 'irony');
  assert.equal(reactionOf('absolute cinema'), 'irony');
  assert.equal(reactionOf('chat is this real'), 'irony');
  assert.equal(reactionOf('TRUE'), 'agree', 'a take landed: an opinion clip, not a gag');
  assert.equal(reactionOf('W take'), 'agree');
  assert.equal(reactionOf('ayo'), 'cringe');
  assert.equal(reactionOf('skill issue'), 'fail');
  assert.equal(reactionOf("he's cooked"), 'fail');
});

test('a burst of subs or a hype train is an event, not a reaction', () => {
  const subs: ChatMessage[] = Array.from({ length: 12 }, (_, k) => [1000 + k * 100, `g${k}`, k % 2 ? 'thanks for the gift sub!' : 'HYPE TRAIN PogChamp']);
  const r = readChat(subs, 0, 10_000);
  assert.equal(r.event, 'subs');
  assert.equal(readChat(burst(0, 20, 'KEKW'), 0, 10_000).event, undefined);
  assert.equal(readChat(burst(0, 20, 'WW raid'), 0, 10_000).event, 'raid');
});

test('one long message pasted by many is copypasta', () => {
  const pasta = burst(0, 8, 'this streamer has been falling off since the day he was born');
  assert.equal(readChat(pasta, 0, 10_000).copypasta, true);
  assert.equal(readChat(burst(0, 20, 'KEKW'), 0, 10_000).copypasta, false);
});

test('more ways to ask for a clip', () => {
  const asks: ChatMessage[] = ['CLIP', 'someone clip that', "that's a clip", 'clip chat', 'get the clip', 'nice paperclip'].map((t, k) => [k * 100, `c${k}`, t]);
  assert.equal(readChat(asks, 0, 10_000).clipRequests, 5);
});

test('chat calling it fake, staged or AI is counted per person', () => {
  const msgs: ChatMessage[] = ['AI', 'Ai', 'aiiiiii', 'cap', 'LARP', 'this is so fake', 'nice clip', 'captain'].map((t, k) => [k * 100, `d${k}`, t]);
  assert.equal(readChat(msgs, 0, 10_000).doubt, 6);
  assert.equal(reactionOf('LARP'), 'irony');
  assert.equal(reactionOf('cap'), 'irony');
});

test('chat answering yes and no to a question is a vote, not a reaction', () => {
  const vote: ChatMessage[] = [...burst(0, 21, 'yes'), ...burst(100, 9, 'NO'), ...burst(200, 4, 'Yessss'), ...burst(300, 3, 'Nah')];
  assert.equal(readChat(vote, 0, 10_000).event, 'vote');
  assert.equal(readChat([...burst(0, 32, 'no'), ...burst(100, 7, 'Yes'), ...burst(200, 2, 'Fuck no')], 0, 10_000).event, 'vote');
  // a scare: everyone types NO, nobody types yes
  assert.equal(readChat([...burst(0, 30, 'NO'), ...burst(100, 10, 'Stare')], 0, 10_000).event, undefined);
  // a few yes/no among a lot of laughing is not a vote
  assert.equal(readChat([...burst(0, 40, 'KEKW'), ...burst(100, 3, 'yes'), ...burst(200, 3, 'no')], 0, 10_000).event, undefined);
  // a vote inside a long, busy window: the voters are a fifth of the chatters, but yes and no are what chat repeated
  const crowd: ChatMessage[] = Array.from({ length: 120 }, (_, k) => [k * 700, `c${k}`, `message number ${k}`]);
  assert.equal(readChat([...crowd, ...burst(40_000, 17, 'Yes'), ...burst(40_100, 8, 'no'), ...burst(40_200, 4, 'Yessss'), ...burst(40_300, 3, 'Nah')], 0, 95_000).event, 'vote');
});
