// The watchlist's switch and heartbeat, shared with the observer and the Studio without importing the
// daemon (tools/watchlist.ts).
//
// Pausing stops the watchlist finding new clips: no creator or topic checks, no new moment jobs, and the
// observer stops reading chat (it catches up from its ledger on resume). Change requests (C on the
// review page) still run, and the upload scheduler and the cleanup are separate daemons the switch does
// not touch. A moment job already running when the switch is pressed finishes.
import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJson } from '../core/paths';
import { pidAlive } from '../core/proc';
import type { JobKind } from './jobs';

export const pauseFile = () => path.join(paths.library, 'watchlist-pause.json');
export const watchlistHeartbeatFile = () => path.join(paths.library, 'watchlist-heartbeat.json');

export interface DiscoveryPause {
  paused: boolean;
  /** When it was paused or resumed. */
  at?: string;
}

/** Whether finding new clips is paused. No file means it runs. */
export function discoveryPause(): DiscoveryPause {
  try {
    const p = JSON.parse(fs.readFileSync(pauseFile(), 'utf8')) as DiscoveryPause;
    return { paused: p.paused === true, at: p.at };
  } catch {
    return { paused: false };
  }
}

export function setDiscoveryPaused(paused: boolean): DiscoveryPause {
  const now = discoveryPause();
  if (now.paused === paused && now.at) return now; // pressing it twice keeps the first time
  const next = { paused, at: new Date().toISOString() };
  writeJson(pauseFile(), next);
  return next;
}

/** The jobs the watchlist may start: paused, only change requests; otherwise any. */
export const claimableKinds = (paused: boolean): JobKind[] | undefined => (paused ? ['revise'] : undefined);

export interface WatchlistHeartbeat {
  pid: number;
  at: string;
  /** The job it is running, if any. */
  job?: { kind: JobKind; creator: string; videoId: string; momentId?: string };
  queued?: number;
}

/** The watchlist that is running, if any: its pid is alive and it beat in the last 3 minutes (it beats every minute). */
export function runningWatchlist(): WatchlistHeartbeat | undefined {
  try {
    const h = JSON.parse(fs.readFileSync(watchlistHeartbeatFile(), 'utf8')) as WatchlistHeartbeat;
    if (!pidAlive(h.pid)) return undefined;
    return Date.now() - Date.parse(h.at) < 3 * 60_000 ? h : undefined;
  } catch {
    return undefined;
  }
}

export function writeWatchlistHeartbeat(beat: Omit<WatchlistHeartbeat, 'pid' | 'at'>) {
  writeJson(watchlistHeartbeatFile(), { pid: process.pid, at: new Date().toISOString(), ...beat });
}
