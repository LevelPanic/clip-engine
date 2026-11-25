// The upload schedule from Settings → Uploads (src/publish/schedule.ts) and the posting hours and pause in
// the pace (src/publish/pace.ts).
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { checkSchedule, dailyMost, scheduleWarnings, loadSchedule, saveSchedule, resetSchedule, scheduleFile, defaultSchedule, scheduleWords } = await import('../src/publish/schedule');
const { paceAt, windowOpenAt } = await import('../src/publish/pace');

const H = 3_600_000;
const base = { perDay: 8, everyMin: 180, leadMin: 5 };
const utc = (s: string) => Date.parse(`2026-11-24T${s}:00Z`);

test('a schedule is whole numbers in bounds, posting hours are two different HH:MM times in a real time zone', () => {
  assert.deepEqual(checkSchedule(base), base);
  assert.deepEqual(checkSchedule({ ...base, window: { from: '09:00', to: '23:00', timeZone: 'Europe/London' }, paused: true }), { ...base, window: { from: '09:00', to: '23:00', timeZone: 'Europe/London' }, paused: true });
  assert.throws(() => checkSchedule({ ...base, perDay: 0 }), /Uploads per day must be a whole number from 1 to 50/);
  assert.throws(() => checkSchedule({ ...base, perDay: null }), /Uploads per day/);
  assert.throws(() => checkSchedule({ ...base, everyMin: 2.5 }), /Minutes between uploads/);
  assert.throws(() => checkSchedule({ ...base, leadMin: 0 }), /Minutes until it goes live/);
  assert.throws(() => checkSchedule({ ...base, window: { from: '9am', to: '23:00', timeZone: 'UTC' } }), /two times/);
  assert.throws(() => checkSchedule({ ...base, window: { from: '09:00', to: '09:00', timeZone: 'UTC' } }), /different times/);
  assert.throws(() => checkSchedule({ ...base, window: { from: '09:00', to: '23:00', timeZone: 'Mars/Olympus' } }), /not a time zone/);
  assert.equal(checkSchedule({ ...base, paused: false }).paused, undefined);
});

test('how many can really go up in a day: the cap, or fewer when the gap and the hours allow fewer', () => {
  assert.equal(dailyMost(base), 8);
  assert.equal(dailyMost({ ...base, everyMin: 240 }), 6);
  assert.equal(dailyMost({ ...base, window: { from: '09:00', to: '21:00', timeZone: 'UTC' } }), 4, '09, 12, 15, 18');
  assert.equal(dailyMost({ ...base, window: { from: '22:00', to: '02:00', timeZone: 'UTC' } }), 2, 'overnight: 22, 01');
  assert.equal(dailyMost({ ...base, perDay: 3, everyMin: 0 }), 3);
});

test('the page warns about a cap the gap cannot reach, over 10 a day, and bursts under an hour apart', () => {
  assert.deepEqual(scheduleWarnings(checkSchedule(base)), []);
  const w = scheduleWarnings(checkSchedule({ ...base, perDay: 12, everyMin: 30, window: { from: '18:00', to: '20:00', timeZone: 'UTC' } }));
  assert.equal(w.length, 3);
  assert.match(w[0], /at most 4 go up in a day, not 12/);
  assert.match(w[1], /11th upload/);
  assert.match(w[2], /less than an hour apart/);
});

test('the posting hours: inside is now, outside waits for them to open, overnight windows wrap, and time zones count', () => {
  const w = { from: '09:00', to: '23:00', timeZone: 'UTC' };
  assert.equal(windowOpenAt(utc('12:00'), w), utc('12:00'));
  assert.equal(windowOpenAt(utc('07:30'), w), utc('09:00'));
  assert.equal(windowOpenAt(utc('23:30'), w), utc('23:30') + 9.5 * H, 'the next morning');
  const night = { from: '22:00', to: '02:00', timeZone: 'UTC' };
  assert.equal(windowOpenAt(utc('23:00'), night), utc('23:00'));
  assert.equal(windowOpenAt(utc('01:00'), night), utc('01:00'));
  assert.equal(windowOpenAt(utc('03:00'), night), utc('22:00'));
  // 09:00 in Karachi (UTC+5) is 04:00 UTC
  assert.equal(windowOpenAt(utc('02:00'), { from: '09:00', to: '23:00', timeZone: 'Asia/Karachi' }), utc('04:00'));
});

test('the pace waits for the posting hours after the gap, and a pause holds everything', () => {
  const now = utc('20:00');
  const p = paceAt({ perDay: 8, everyMin: 180, window: { from: '09:00', to: '21:00', timeZone: 'UTC' }, uploads: [utc('19:00')], limitRefusals: [], now });
  assert.equal(p.nextAt, utc('09:00') + 24 * H, '22:00 is after the hours: the next morning');
  assert.equal(p.waitsFor, 'window');
  const open = paceAt({ perDay: 8, everyMin: 180, window: { from: '09:00', to: '23:00', timeZone: 'UTC' }, uploads: [utc('15:00')], limitRefusals: [], now });
  assert.equal(open.nextAt, now);
  assert.equal(open.waitsFor, undefined);
  const paused = paceAt({ perDay: 8, everyMin: 180, paused: true, uploads: [], limitRefusals: [], now });
  assert.equal(paused.waitsFor, 'paused');
  assert.ok(paused.nextAt > now + 300 * 24 * H);
});

test('saved, it is the schedule; no file is the settings; an unreadable file pauses uploads rather than run on defaults', () => {
  resetSchedule();
  assert.deepEqual(loadSchedule(), defaultSchedule());
  saveSchedule({ ...base, perDay: 6 });
  assert.equal(loadSchedule().perDay, 6);
  assert.match(scheduleWords(loadSchedule()), /at most 6 in 24 hours, 3 hours apart, any time of day, live 5 min after upload/);
  fs.writeFileSync(scheduleFile(), '{"perDay": "lots"');
  const broken = loadSchedule();
  assert.equal(broken.paused, true);
  assert.match(broken.problem ?? '', /could not be read/);
  resetSchedule();
  assert.equal(fs.existsSync(scheduleFile()), false);
});
