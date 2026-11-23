// clip watch: follow a live stream, a scan pass every few minutes, judging each pass's seeds into
// candidates, until the stream ends (then one last pass to the very end). Given a channel, it waits
// for the channel to go live. Runs in the foreground; scan.json carries its state for the Studio.
import fs from 'node:fs';
import { paths } from '../core/paths';
import { fmtTime } from '../core/time';
import { loadScan, saveScan, runPass, scannedRanges, type WatchState } from '../scan';
import { resolveInput } from '../scan/resolve';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function watch(link: string, o: { fromMs?: number; everyMs: number; judge: boolean; lens: string; log?: (s: string) => void }) {
  const log = o.log ?? ((s: string) => console.log(`${new Date().toLocaleTimeString('en-GB')}  ${s}`));
  const { twitchApi } = await import('../ingest/twitch');
  const api = twitchApi();
  const first = await resolveInput(link, api);
  const login = first.login;
  let id: string | undefined = first.login ? undefined : first.id;
  let judge = o.judge;

  const setState = (w: Omit<WatchState, 'pid' | 'everyMs'> | null) => {
    if (!id) return;
    const s = loadScan(id);
    if (w) s.watch = { pid: process.pid, everyMs: o.everyMs, ...(login ? { login } : {}), ...w };
    else delete s.watch;
    saveScan(s);
  };
  const stop = () => {
    setState(null);
    // stopped mid-pass: the pass's own cleanup won't run, so drop our lock here
    if (id) {
      const lock = paths.videoFile(id, 'scan.lock');
      if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.rmSync(lock, { force: true });
    }
    log('stopped');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  for (;;) {
    // a channel: wait until it's live, then follow that broadcast
    if (!id && login) {
      const b = await api.latestBroadcast(login);
      if (!b?.live) {
        log(`${login} is offline; checking again in ${fmtTime(o.everyMs, 0)}`);
        await sleep(o.everyMs);
        continue;
      }
      id = `tw-${b.vodId}`;
      log(`${login} is live: ${b.title} (${id})`);
    }
    if (!id) throw new Error('nothing to watch');
    if (!fs.existsSync(paths.videoFile(id, 'meta.json'))) {
      const { ingest } = await import('../ingest/ingest');
      await ingest(id, { audio: true, full: false, refresh: false, wait: false, log: () => {} });
    }

    setState({ state: 'scanning' });
    const scanned = scannedRanges(loadScan(id));
    let fromMs: number | undefined;
    if (!scanned.length) {
      const { loadMeta } = await import('../ingest/ingest');
      const meta = loadMeta(id);
      // by default the first pass starts 15 min before now, not at the start of an 8-hour stream
      fromMs = o.fromMs ?? first.fromMs ?? (meta.live ? Math.max(0, meta.durationMs - 15 * 60_000) : 0);
    }
    let live = true;
    try {
      const r = await runPass(id, { fromMs, cont: scanned.length > 0, log: (s) => log(`  ${s}`) });
      if ('upToDate' in r) {
        live = !!r.meta.live;
        log(`up to date: ${r.reason}`);
      } else {
        live = r.pass.live;
        log(`pass ${r.pass.n}: ${fmtTime(r.pass.fromMs, 0)}–${fmtTime(r.pass.toMs, 0)}, ${r.pass.seeds} seeds, ${r.pass.seconds} s${r.pass.notes.length ? ` (${r.pass.notes.join('; ')})` : ''}`);
        if (judge && r.pass.seeds > 0) {
          setState({ state: 'judging' });
          try {
            const { judgeVideo } = await import('../judge');
            const j = await judgeVideo(id, { lens: o.lens, range: { startMs: r.pass.fromMs, endMs: r.pass.toMs }, log: () => {} });
            log(`  judge: ${j.added} candidate${j.added === 1 ? '' : 's'} added`);
          } catch (e) {
            // e.g. the claude CLI isn't logged in: keep scanning, judge later with /clip <id> --continue
            log(`  judge failed, so later passes only scan: ${(e as Error).message}`);
            judge = false;
          }
        }
      }
    } catch (e) {
      log(`pass failed: ${(e as Error).message.split('\n')[0]}; trying again next time`);
    }

    if (!live) {
      // the stream has ended: one more pass reaches the very end, then stop
      const tail = await runPass(id, { cont: true, log: (s) => log(`  ${s}`) }).catch(() => null);
      if (tail && 'pass' in tail) log(`last pass ${tail.pass.n}: ${fmtTime(tail.pass.fromMs, 0)}–${fmtTime(tail.pass.toMs, 0)}, ${tail.pass.seeds} seeds`);
      setState({ state: 'ended', note: 'the stream ended' });
      log(`the stream has ended; scanned ${scannedRanges(loadScan(id)).map((r) => `${fmtTime(r.startMs, 0)}–${fmtTime(r.endMs, 0)}`).join(', ')}`);
      return;
    }
    setState({ state: 'waiting', nextAt: new Date(Date.now() + o.everyMs).toISOString() });
    await sleep(o.everyMs);
  }
}
