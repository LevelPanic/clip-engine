// Whether the observer daemon (tools/observer.ts) is running: its heartbeat file, shared with the
// watchlist (which starts it) without importing the daemon itself.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../core/paths';

export const observerHeartbeatFile = () => path.join(paths.library, 'observer.json');

export interface ObserverHeartbeat {
  pid: number;
  at: string;
  streams?: number;
  readH?: number;
  toReadH?: number;
}

/** The observer that is running, if any: its pid is alive and it beat in the last 10 minutes. */
export function runningObserver(): ObserverHeartbeat | undefined {
  try {
    const h = JSON.parse(fs.readFileSync(observerHeartbeatFile(), 'utf8')) as ObserverHeartbeat;
    process.kill(h.pid, 0);
    return Date.now() - Date.parse(h.at) < 10 * 60_000 ? h : undefined;
  } catch {
    return undefined;
  }
}

export function writeHeartbeat(extra: Partial<ObserverHeartbeat> = {}) {
  fs.writeFileSync(observerHeartbeatFile(), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...extra }));
}
