// The upload schedule the operator sets in the Studio (Settings → Uploads): how many go up in any 24
// hours, how far apart, the hours they may go in, how long after the upload a Short goes live, and a pause.
// Saved in library/upload-schedule.json; the uploader (tools/upload-cron.ts) reads it every minute, so a
// change needs no restart. With no file, the settings (UPLOADS_PER_DAY, UPLOAD_MIN, LEAD_MIN) are the
// schedule. A file that cannot be read pauses uploads rather than letting them run on defaults.
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJson, writeJson } from '../core/paths';
import { setting } from '../core/config';
import { gapWords, type PaceRule, type UploadWindow } from './pace';

export interface UploadSchedule extends PaceRule {
  /** A Short goes live this many minutes after its upload finishes. */
  leadMin: number;
}

export const scheduleFile = () => path.join(paths.library, 'upload-schedule.json');

/** What a schedule may say; outside these it is refused with why. */
export const SCHEDULE_BOUNDS = { perDay: [1, 50], everyMin: [0, 1440], leadMin: [1, 1440] } as const;

export const defaultSchedule = (): UploadSchedule => ({ perDay: setting('UPLOADS_PER_DAY'), everyMin: setting('UPLOAD_MIN'), leadMin: setting('LEAD_MIN') });

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const zoneOk = (z: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return true;
  } catch {
    return false;
  }
};

/** A schedule from what the page sent (or the file held), or an error that says what is wrong. Pure. */
export function checkSchedule(raw: unknown): UploadSchedule {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (k: keyof typeof SCHEDULE_BOUNDS, label: string) => {
    const v = r[k];
    const [lo, hi] = SCHEDULE_BOUNDS[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`${label} must be a whole number from ${lo} to ${hi}.`);
    return v;
  };
  const out: UploadSchedule = { perDay: num('perDay', 'Uploads per day'), everyMin: num('everyMin', 'Minutes between uploads'), leadMin: num('leadMin', 'Minutes until it goes live') };
  if (r.window !== undefined && r.window !== null) {
    const w = r.window as Partial<UploadWindow>;
    if (typeof w.from !== 'string' || !HHMM.test(w.from) || typeof w.to !== 'string' || !HHMM.test(w.to)) throw new Error('Posting hours are two times, like 09:00 and 23:00.');
    if (w.from === w.to) throw new Error('Posting hours must start and end at different times.');
    if (typeof w.timeZone !== 'string' || !zoneOk(w.timeZone)) throw new Error(`"${String(w.timeZone)}" is not a time zone.`);
    out.window = { from: w.from, to: w.to, timeZone: w.timeZone };
  }
  if (r.paused === true) out.paused = true;
  return out;
}

/** The schedule in force: the saved one, the settings when none is saved, paused when the file is unreadable. */
export function loadSchedule(): UploadSchedule & { problem?: string } {
  const file = scheduleFile();
  if (!fs.existsSync(file)) return defaultSchedule();
  try {
    return checkSchedule(readJson(file));
  } catch (e) {
    return { ...defaultSchedule(), paused: true, problem: `${path.relative(paths.root, file)} could not be read (${(e as Error).message}); uploads are paused until it is saved again` };
  }
}

export const scheduleSaved = () => fs.existsSync(scheduleFile());

export function saveSchedule(raw: unknown): UploadSchedule {
  const s = checkSchedule(raw);
  writeJson(scheduleFile(), s);
  return s;
}

/** Back to the settings' schedule (the file goes). */
export function resetSchedule(): UploadSchedule {
  fs.rmSync(scheduleFile(), { force: true });
  return defaultSchedule();
}

const minutesOf = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
/** Minutes the posting window is open in a day (all day without one). */
export const windowMinutes = (w?: UploadWindow) => (w ? (minutesOf(w.to) - minutesOf(w.from) + 1440) % 1440 : 1440);

/** How many can actually go up in a day: the cap, or fewer when the gap and the hours allow fewer. Pure. */
export function dailyMost(s: Pick<UploadSchedule, 'perDay' | 'everyMin' | 'window'>): number {
  // uploads at the window's start and every gap after it, while the window is open (09:00–21:00 every 3 h: 4)
  return s.everyMin === 0 ? s.perDay : Math.min(s.perDay, Math.ceil(windowMinutes(s.window) / s.everyMin));
}

/** What to tell the operator before they save. Pure. */
export function scheduleWarnings(s: UploadSchedule): string[] {
  const out: string[] = [];
  const most = dailyMost(s);
  if (most < s.perDay) out.push(`With ${gapWords(s.everyMin)} between uploads${s.window ? ` and ${s.window.from}–${s.window.to}` : ''}, at most ${most} go up in a day, not ${s.perDay}.`);
  if (s.perDay > 10) out.push("YouTube refused this channel's 11th upload in a day on 2026-11-19 and 11-20; more than 10 a day will likely be held by its limit.");
  if (s.everyMin < 60) out.push("Uploads less than an hour apart look mass-produced, which YouTube's spam policy names (the 2026-11-22 review, after 26 went up in one day).");
  return out;
}

/** The schedule in one line, for the log and the page. Pure. */
export function scheduleWords(s: UploadSchedule): string {
  if (s.paused) return 'paused';
  return `at most ${s.perDay} in 24 hours, ${gapWords(s.everyMin)} apart${s.window ? `, between ${s.window.from} and ${s.window.to} (${s.window.timeZone})` : ', any time of day'}, live ${s.leadMin} min after upload`;
}
