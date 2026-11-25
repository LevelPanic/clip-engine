// The nav bar's switch for the watchlist: pause or resume finding new clips. Paused, the watchlist checks
// no creators or topics and starts no new clip jobs, and the observer reads no chat; change requests, the
// upload scheduler and the cleanup keep going (src/track/watchlist.ts).
import React, { useCallback, useEffect, useState } from 'react';
import { api, useDebounced, useEvents } from './api';
import { Button, Chip } from './ui';

interface WatchlistState {
  paused: boolean;
  at?: string;
  watchlist: { pid: number; at: string; job?: { kind: string; creator: string; videoId: string; momentId?: string }; queued?: number } | null;
  observer: boolean;
  waiting: { moments: number; changes: number };
}

const since = (at?: string) => (at ? new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export function DiscoverySwitch() {
  const [s, setS] = useState<WatchlistState>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const load = useCallback(() => api<WatchlistState>('/api/watchlist').then((x) => (setS(x), setErr(undefined)), () => undefined), []);
  const reload = useDebounced(() => void load(), 500);
  useEffect(() => {
    void load();
    // the heartbeat going stale (the daemon stopped) writes no file, so look again each minute
    const t = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(t);
  }, [load]);
  useEvents((e) => {
    if (e.type === 'watchlist') reload();
  });

  if (!s) return null;
  const flip = async () => {
    setBusy(true);
    try {
      setS(await api<WatchlistState>('/api/watchlist', { body: { paused: !s.paused } }));
      setErr(undefined);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const job = s.watchlist?.job;
  const finishing = s.paused && job?.kind === 'twitch-moment';
  const label = !s.watchlist ? 'Watchlist not running' : s.paused ? (finishing ? 'Paused · finishing a clip' : 'Finding clips paused') : 'Finding clips';
  const tone = !s.watchlist ? 'bad' : s.paused ? 'warn' : 'good';
  const doing = job ? (job.kind === 'revise' ? `Now: a change request (${job.videoId}).` : `Now: a clip from ${job.creator} ${job.momentId ?? ''}.`) : 'Now: nothing running.';
  const detail = [
    s.paused ? `Paused since ${since(s.at)}. No creator or topic checks, no new clip jobs, no chat reading.` : 'Checking creators and topics, reading chat, making clips.',
    'Change requests, the upload scheduler and the cleanup keep going either way.',
    s.watchlist ? doing : 'The watchlist daemon is not running: start it with `nohup npx tsx tools/watchlist.ts --daemon >> .cache/watchlist.log 2>&1 &` (the switch applies when it starts).',
    `Waiting: ${s.waiting.moments} clip job${s.waiting.moments === 1 ? '' : 's'}, ${s.waiting.changes} change request${s.waiting.changes === 1 ? '' : 's'}.`,
  ].join('\n');

  return (
    <span className="switch">
      <span role="status" title={detail}>
        <Chip tone={tone}>{err ? `Couldn't switch: ${err}` : label}</Chip>
      </span>
      <Button onClick={flip} disabled={busy} title={detail} aria-label={s.paused ? 'Resume finding new clips' : 'Pause finding new clips'}>
        {s.paused ? '▶ Resume' : '⏸ Pause'}
      </Button>
    </span>
  );
}
