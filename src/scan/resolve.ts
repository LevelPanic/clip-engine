// Turn what someone pasted (a broadcast link, a channel, a clip, an id) into a library video, with
// the range it implies: a clip link scans around the clip, a link with ?t= starts there.
import fs from 'node:fs';
import { paths } from '../core/paths';
import { parseInput, sourceOf } from '../ingest/source';
import type { TwitchApi } from '../ingest/twitch';

export interface Resolved {
  id: string;
  fromMs?: number;
  toMs?: number;
  /** Channel input: the login, so a watcher can find the next broadcast. */
  login?: string;
  note?: string;
}

export async function resolveInput(input: string, api: TwitchApi): Promise<Resolved> {
  if (fs.existsSync(paths.videoFile(input, 'meta.json'))) return { id: input };
  const p = parseInput(input);
  if (p.kind === 'video') return { id: p.ref.id, ...(p.ref.atMs !== undefined ? { fromMs: p.ref.atMs } : {}) };
  if (p.kind === 'twitch-clip') {
    const c = await api.clip(p.slug);
    if (!c) throw new Error(`No Twitch clip "${p.slug}"`);
    if (!c.vodId) throw new Error(`The clip "${c.title}" isn't linked to a past broadcast (it may have been deleted or expired), so there's nothing around it to scan`);
    return { id: sourceOf(`tw-${c.vodId}`).id, fromMs: Math.max(0, c.offsetMs - 90_000), toMs: c.offsetMs + c.durationMs + 60_000, note: `around the clip "${c.title}"` };
  }
  const b = await api.latestBroadcast(p.login);
  if (!b) throw new Error(`${p.login} has no past broadcasts (past broadcasts may be turned off on this channel)`);
  return { id: `tw-${b.vodId}`, login: p.login, note: b.live ? `${p.login} is live now` : `${p.login}'s latest broadcast (not live)` };
}

/** "15m", "90s", "1h", "10:00" or seconds → ms. */
export function parseEvery(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(s.trim());
  if (m) return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'];
  if (/^\d+$/.test(s.trim())) return Number(s) * 1000;
  const t = /^(\d+):(\d{2})$/.exec(s.trim());
  if (t) return (Number(t[1]) * 60 + Number(t[2])) * 1000;
  throw new Error(`Can't read "${s}" as an interval; use 15m, 90s or 1h`);
}
