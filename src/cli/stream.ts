// Stream commands: scan a range of a long or live broadcast, keep scanning it while it's live, read
// its chat.
import type { Command } from 'commander';
import { fmtTime, parseTime } from '../core/time';

type Action = <A extends unknown[]>(fn: (...args: A) => Promise<void> | void) => (...args: A) => Promise<void>;
const STUDIO = 'http://localhost:4400';

export function registerStream(program: Command, action: Action) {
  program
    .command('scan <link>')
    .description('Scan a range of a stream for moments: chat, viewer clips, audio and a transcript around the best seeds. A Twitch broadcast, channel or clip link, a YouTube link, or a library id')
    .option('--from <time>', 'start, e.g. 1:00:00 (default: the link\'s ?t=, else 0:00)')
    .option('--to <time>', 'end (default: now, less 3 min if it\'s live)')
    .option('--continue', 'scan from where the last pass stopped (2 min of overlap)')
    .option('--judge', 'then judge the seeds headless (claude -p) and add candidates')
    .option('--lens <name>', 'lens for --judge', 'stream-moments')
    .action(
      action(async (link: string, o: { from?: string; to?: string; continue?: boolean; judge?: boolean; lens: string }) => {
        const r = await scanOnce(link, { fromMs: o.from ? parseTime(o.from) : undefined, toMs: o.to ? parseTime(o.to) : undefined, cont: !!o.continue, log: (s) => console.log(`  ${s}`) });
        if (!r) return;
        if (o.judge) await judgeRange(r.id, r.range, o.lens);
      }),
    );

  program
    .command('moments <link>')
    .description('Where the clippable moments of a stream are, from what the community did: viewer clips (views, how many people clipped it) and chat laughing, across the whole broadcast. Best first (#rank, and the shadow ranking as alt #); only moments over the bar; "scanned" marks a region read before')
    .option('--chat-hours <h>', 'read chat for the last this many hours of the broadcast (fetched once, then only what is new)', '4')
    .option('--top <n>', 'how many to list', '8')
    .option('--json', 'print JSON (the watchlist reads this)')
    .action(
      action(async (link: string, o: { chatHours: string; top: string; json?: boolean }) => {
        const say = (t: string) => (o.json ? console.error(t) : console.log(t));
        const { r, meta, clips, chat, edge, ranked: all } = await rankStream(link, Number(o.chatHours), say);
        const { momentWindow } = await import('../scan/moments');
        // the top N under either ranking: the shadow one (altRank) is recorded too, to compare them later
        const ranked = all.filter((m) => (m.rank ?? 1e9) <= Number(o.top) || (m.altRank ?? 1e9) <= Number(o.top));
        if (o.json) {
          console.log(JSON.stringify({ videoId: r.id, channel: meta.channel, live: !!meta.live, durationMs: meta.durationMs, startedAt: meta.startedAt, clips: clips.length, moments: ranked.map((m) => ({ ...m, window: momentWindow(m, edge) })) }));
          return;
        }
        console.log(`${meta.channel} · ${r.id} · ${fmtTime(meta.durationMs, 0)}${meta.live ? ' (live)' : ''} · ${clips.length} viewer clips · chat ${chat?.disabled ? 'off' : `fetched ${fmtTime((chat?.fetched ?? []).reduce((n, x) => n + x.endMs - x.startMs, 0), 0)}`}`);
        if (!ranked.length) return console.log('nothing over the bar (no viewer clip with 50+ views or two clippers, no laugh burst of 5+ people)');
        for (const m of ranked) {
          const w = momentWindow(m, edge);
          console.log(`  ${m.id.padEnd(17)} #${String(m.rank).padEnd(2)} alt #${String(m.altRank).padEnd(2)} score ${String(Math.round(m.score)).padStart(7)}  scan ${fmtTime(w.startMs, 0)}–${fmtTime(w.endMs, 0)}  ${m.why.join(' · ')}${m.scanned ? ' · scanned' : ''}${m.titles.length ? `  "${m.titles.slice(0, 2).join('" · "')}"` : ''}`);
        }
      }),
    );

  program
    .command('track <link>')
    .description('Put a Twitch broadcast in the tracker by hand (a link you want clipped). Its moments are ranked now and go first: ahead of the listed creators and the topics, up to 4 of them')
    .action(
      action(async (link: string) => {
        const fs = await import('node:fs');
        const { paths } = await import('../core/paths');
        const { twitchApi } = await import('../ingest/twitch');
        const { resolveInput } = await import('../scan/resolve');
        const api = twitchApi();
        const r = await resolveInput(link, api);
        if (!r.id.startsWith('tw-')) throw new Error('the tracker follows Twitch broadcasts (viewer clips and chat say where the moments are)');
        if (!fs.existsSync(paths.videoFile(r.id, 'meta.json'))) {
          const { ingest } = await import('../ingest/ingest');
          await ingest(r.id, { audio: false, full: false, refresh: false, wait: false });
        }
        const { refreshTwitchMeta } = await import('../ingest/ingest');
        const meta = await refreshTwitchMeta(r.id, api);
        const { upsertStream, setStreamStatus, wrongStream, getStream } = await import('../track/db');
        upsertStream({ videoId: r.id, platform: 'twitch', creator: meta.channel ?? meta.login ?? r.id, login: meta.login ?? null, title: meta.title, game: meta.game ?? null, source: 'manual', live: !!meta.live, startedAt: meta.startedAt ?? null, durationMs: meta.durationMs });
        // a hand-added stream is wanted: bring it back if it was finished or skipped before
        const wrong = wrongStream({ title: meta.title, durationMs: meta.durationMs, live: !!meta.live, login: meta.login });
        if (wrong) console.log(`⚠ ${wrong}: tracking it anyway, because you asked`);
        if (getStream(r.id)?.status !== 'tracking') setStreamStatus(r.id, 'tracking');
        console.log(`tracking ${meta.channel} ${r.id} (${fmtTime(meta.durationMs, 0)}${meta.live ? ', live' : ''}): ${meta.title}`);
        // rank it now, so its moments are first in line for the watchlist's next job, not its next check
        const ranked = await rankStream(r.id, 2, (t) => console.log(`  ${t}`));
        const { upsertMoments, skipNeverClip } = await import('../track/db');
        const { momentWindow } = await import('../scan/moments');
        const { categoryAt } = await import('../project');
        const ms = skipNeverClip(ranked.ranked.filter((m) => (m.rank ?? 1e9) <= 12 || (m.altRank ?? 1e9) <= 12).map((m) => ({ ...m, window: momentWindow(m, ranked.edge), skip: undefined as string | undefined })), (t) => categoryAt(r.id, t));
        upsertMoments(r.id, ms, ranked.clips.length);
        const open = ms.filter((m) => !m.skip);
        if (!open.length) console.log('nothing over the bar yet (no viewer clip with 50+ views or two clippers, no laugh burst of 5+ people); the watchlist ranks it again every 20 minutes');
        else console.log(`${open.length} moment${open.length === 1 ? '' : 's'} over the bar, best ${open[0].id} (${open[0].why[0]}): first in line, ahead of the listed creators and the topics`);
      }),
    );

  program
    .command('rankers')
    .description('The two moment rankings side by side (the combined score the watchlist uses, and the shadow one that alternates viewer clips and laughter): of the moments you approved or rejected, how many each had in a stream\'s top N')
    .option('--top <n>', 'the top N per stream (the watchlist works at most 4 of a stream\'s moments)', '4')
    .action(
      action(async (o: { top: string }) => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { paths } = await import('../core/paths');
        const { listMoments, listStreams, momentRanker } = await import('../track/db');
        const top = Number(o.top);
        // the latest review decision per clip
        const decided = new Map<string, string>();
        const file = path.join(paths.library, 'feedback.jsonl');
        if (fs.existsSync(file))
          for (const line of fs.readFileSync(file, 'utf8').split('\n'))
            if (line.trim()) {
              const f = JSON.parse(line) as { clipId: string; status: string };
              decided.set(f.clipId, f.status);
            }
        const streams = new Map(listStreams().map((s) => [s.videoId, s]));
        const rows = listMoments().filter((m) => m.rank != null);
        const outcome = (m: (typeof rows)[number]) => {
          const ds = m.clipIds.map((c) => decided.get(c)).filter(Boolean);
          return ds.includes('approved') ? 'approved' : ds.includes('changes') ? 'changes' : ds.includes('rejected') ? 'rejected' : m.status === 'no-clip' ? 'no-clip' : undefined;
        };
        const judged = rows.filter((m) => outcome(m));
        const count = (k: string, by: 'rank' | 'altRank') => judged.filter((m) => outcome(m) === k && (m[by] ?? 1e9) <= top).length;
        console.log(`watchlist uses: ${momentRanker() === 'alternate' ? 'the shadow ranking (MOMENT_RANKER=alternate)' : 'the combined score (set MOMENT_RANKER=alternate to switch)'}`);
        console.log(`${rows.length} moments ranked both ways on ${new Set(rows.map((m) => m.videoId)).size} streams; ${judged.length} have an outcome\n`);
        console.log(`in a stream's top ${top}:      combined   shadow`);
        for (const k of ['approved', 'changes', 'rejected', 'no-clip']) console.log(`  ${k.padEnd(22)} ${String(count(k, 'rank')).padStart(8)} ${String(count(k, 'altRank')).padStart(8)}`);
        // where they disagree, and nothing is known yet: what a fair comparison still has to try
        const onlyAlt = rows.filter((m) => (m.altRank ?? 1e9) <= top && (m.rank ?? 1e9) > top && !outcome(m) && m.status === 'pending');
        console.log(`\nin the shadow top ${top} only, not tried yet: ${onlyAlt.length}`);
        for (const m of onlyAlt.slice(0, 12)) console.log(`  ${(streams.get(m.videoId)?.creator ?? m.videoId).padEnd(16)} ${m.momentId.padEnd(17)} #${m.rank} → alt #${m.altRank}  ${m.why.join(' · ')}`);
        if (judged.length < 20) console.log(`\n${judged.length} outcomes is too few to choose: keep the combined score until both have 20+ judged moments in their top ${top}.`);

        // the blind trial: moment jobs picked by one ranking only (or both), at the same cost, reviewed
        // without the reviewer knowing which ranking picked them
        const { listJobs } = await import('../track/jobs');
        const { trialOn } = await import('../track/db');
        const { trialSummary } = await import('../track/trial');
        const rowsByArm = trialSummary(listJobs({ kind: 'twitch-moment' }), decided);
        console.log(`\nBLIND TRIAL (${trialOn() ? 'running' : 'off: RANKER_TRIAL=0'}): jobs picked by one ranking only, reviewed blind`);
        console.log('  arm          jobs  finished  clips  approved  changes  rejected  waiting  no clip  void   approved per job');
        for (const r of rowsByArm)
          console.log(`  ${r.arm.padEnd(12)} ${String(r.jobs).padStart(4)} ${String(r.finished).padStart(9)} ${String(r.clips).padStart(6)} ${String(r.approved).padStart(9)} ${String(r.changes).padStart(8)} ${String(r.rejected).padStart(9)} ${String(r.waiting).padStart(8)} ${String(r.noClip).padStart(8)} ${String(r.void).padStart(5)}   ${r.finished ? `${Math.round((100 * r.approved) / r.finished)}%` : '—'}`);
        console.log('  (void: the broadcast could not be read or a stage failed; not counted for either ranking)');
        const judgedArm = (a: string) => { const r = rowsByArm.find((x) => x.arm === a); return r ? r.approved + r.changes + r.rejected + r.noClip : 0; };
        const need = Math.max(0, 20 - Math.min(judgedArm('score'), judgedArm('alternate')));
        console.log(need ? `  ${need} more judged job${need === 1 ? '' : 's'} in the thinner of the two one-ranking arms before reading anything into it` : '  both one-ranking arms have 20+ judged jobs: compare "approved per job"; switch with MOMENT_RANKER=alternate if the alternate arm wins');
      }),
    );

  program
    .command('streams [videoId]')
    .description('The tracker: every stream the watchlist follows (live, ended, skipped and why), what of each is done and what is next. With a video id: that stream\'s moments')
    .option('--all', 'include finished and skipped streams from earlier days')
    .action(
      action(async (videoId: string | undefined, o: { all?: boolean }) => {
        const { listStreams, listMoments, nextMoments, loadCoverage } = await import('../track/db');
        const { summary } = await import('../track/coverage');
        const { runningObserver } = await import('../track/observer');
        // how much of a stream's chat has been read (the observer's ledger; up to the live edge)
        const readOf = (x: { videoId: string; live: boolean; durationMs: number }) => {
          const edge = x.live ? Math.max(0, x.durationMs - 3 * 60_000) : x.durationMs;
          const sum = summary(loadCoverage(x.videoId, 'observe'), edge);
          return edge ? `read ${String(Math.round((100 * sum.doneMs) / edge)).padStart(3)}%` : '';
        };
        const ago = (iso: string | null) => {
          if (!iso) return '';
          const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
          return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
        };
        if (videoId) {
          const spans = loadCoverage(videoId, 'observe');
          if (spans.length) console.log(`read (chat): ${spans.map((x) => `${x.state} ${fmtTime(x.startMs, 0)}–${fmtTime(x.endMs, 0)}${x.reason ? ` (${x.reason})` : ''}`).join(' · ')}\n`);
          const ms = listMoments({ videoId });
          if (!ms.length) return console.log(`no moments recorded for ${videoId} (\`clip moments ${videoId}\` ranks them)`);
          for (const m of ms)
            console.log(`  ${m.momentId.padEnd(17)} ${m.status.padEnd(8)} score ${String(Math.round(m.score)).padStart(7)}  ${m.why[0] ?? ''}${m.titles[0] ? `  "${m.titles[0].slice(0, 50)}"` : ''}${m.clipIds.length ? `  → ${m.clipIds.join(', ')}` : ''}${m.note && m.status !== 'clipped' ? `  (${m.note.slice(0, 80)})` : ''}`);
          return;
        }
        const day = Date.now() - 24 * 3_600_000;
        const streams = listStreams().filter((x) => o.all || x.status === 'tracking' || Date.parse(x.updatedAt) >= day);
        const count = (id: string) => {
          const c: Record<string, number> = {};
          for (const m of listMoments({ videoId: id })) c[m.status] = (c[m.status] ?? 0) + 1;
          return ['clipped', 'no-clip', 'pending', 'queued', 'working', 'skipped', 'failed', 'covered'].filter((k) => c[k]).map((k) => `${c[k]} ${k}`).join(' · ');
        };
        const state = (x: (typeof streams)[number]) => count(x.videoId) || (x.status === 'done' && !x.rankedAt ? 'ended before tracking' : x.rankedAt ? 'nothing over the bar' : 'not ranked yet');
        const from = (src: string) => (src.startsWith('topic:') ? src.slice(6) : src.startsWith('creator') ? 'creator' : src);
        const show = (title: string, rows: typeof streams) => {
          if (!rows.length) return;
          console.log(`\n${title}`);
          for (const x of rows)
            console.log(`  ${x.creator.padEnd(16)} ${x.videoId.padEnd(15)} ${fmtTime(x.durationMs, 0).padStart(8)}  ${from(x.source).padEnd(12)} ${x.status === 'tracking' ? `${readOf(x)}  ` : ''}${x.status === 'skipped' ? `skipped: ${x.skipReason}` : state(x)}  ${x.status === 'tracking' ? `ranked ${ago(x.rankedAt) || 'never'}` : ''}  ${x.title.slice(0, 40)}`);
        };
        const obs = runningObserver();
        console.log(obs ? `observer running (pid ${obs.pid})${obs.toReadH != null ? `: ${obs.readH} h of chat read, ${obs.toReadH} h to read on ${obs.streams} streams` : ''}` : 'observer not running: the watchlist starts it at its next check (or `npx tsx tools/observer.ts --daemon`)');
        show('LIVE', streams.filter((x) => x.status === 'tracking' && x.live));
        show('ENDED, STILL TRACKED (viewer clips keep coming)', streams.filter((x) => x.status === 'tracking' && !x.live));
        show('DONE', streams.filter((x) => x.status === 'done'));
        show('SKIPPED', streams.filter((x) => x.status === 'skipped'));
        const next = nextMoments(8, 4);
        const { tierOf, TIER_NAMES } = await import('../track/db');
        console.log(`\nNEXT (by hand, then listed creators, then topics; each stream's best before anyone's second)`);
        if (!next.length) console.log('  nothing waiting over the bar');
        for (const m of next) {
          const st = streams.find((x) => x.videoId === m.videoId);
          console.log(`  ${TIER_NAMES[tierOf(st?.source ?? '')].padEnd(14)} ${(st?.creator ?? m.videoId).padEnd(16)} ${m.momentId.padEnd(17)} score ${String(Math.round(m.score)).padStart(7)}  ${m.why[0] ?? ''}${m.titles[0] ? `  "${m.titles[0].slice(0, 50)}"` : ''}`);
        }
      }),
    );

  program
    .command('watch <link>')
    .description('Follow a live stream: a scan pass every --every until it ends (then a last pass). A channel waits for it to go live')
    .option('--from <time>', 'where the first pass starts (default: 15 min before now)')
    .option('--every <interval>', 'time between passes, e.g. 15m', '15m')
    .option('--no-judge', "don't judge after each pass (judge later with /clip <id> --continue)")
    .option('--lens <name>', 'judging lens', 'stream-moments')
    .action(
      action(async (link: string, o: { from?: string; every: string; judge: boolean; lens: string }) => {
        const { watch } = await import('../pipeline/watch');
        const { parseEvery } = await import('../scan/resolve');
        await watch(link, { fromMs: o.from ? parseTime(o.from) : undefined, everyMs: parseEvery(o.every), judge: o.judge, lens: o.lens });
      }),
    );

  program
    .command('chat <videoId>')
    .description('Read a stream\'s chat: a range, or the strongest explosions across the whole video')
    .option('--from <time>', 'start of a range to read')
    .option('--to <time>', 'end of a range to read (at most 20 min)')
    .option('--top <n>', 'show this many chat explosions across the video', '15')
    .option('--json', 'print JSON')
    .action(
      action(async (id: string, o: { from?: string; to?: string; top: string; json?: boolean }) => {
        const { loadMeta } = await import('../ingest/ingest');
        const { loadChat, fetchChat } = await import('../ingest/chat');
        const meta = loadMeta(id);
        if (meta.platform !== 'twitch') throw new Error(`${id} has no stream chat (YouTube comments are in the transcript view and signals)`);
        const { twitchApi } = await import('../ingest/twitch');
        const { findChatSpikes, chatDigest } = await import('../discover/chatAnalysis');

        if (o.from || o.to) {
          if (!o.from || !o.to) throw new Error('give both --from and --to, or neither for the chat heatmap');
          const range = { startMs: parseTime(o.from), endMs: parseTime(o.to) };
          if (range.endMs - range.startMs > 20 * 60_000) throw new Error('Read chat at most 20 minutes at a time');
          await fetchChat(id, [{ startMs: Math.max(0, range.startMs - 6 * 60_000), endMs: range.endMs }], twitchApi());
          const chat = loadChat(id)!;
          if (chat.disabled) return console.log('Chat replay is turned off for this broadcast.');
          const lines = chatDigest(chat.messages, chat.fetched, meta.durationMs, range);
          if (o.json) return console.log(JSON.stringify(lines, null, 2));
          for (const l of lines) {
            const x = l.normal ? l.chatters / l.normal : 0;
            console.log(`[${fmtTime(l.ms, 0)}] ${String(l.chatters).padStart(3)} chatters${x >= 2 ? ` (${x.toFixed(1)}× normal)` : '               '}  ${l.top.join(' · ')}`);
          }
          return;
        }

        console.log(`reading ${fmtTime(meta.durationMs, 0)} of chat replay…`);
        await fetchChat(id, [{ startMs: 0, endMs: meta.durationMs }], twitchApi(), (s) => console.log(`  ${s}`));
        const chat = loadChat(id)!;
        if (chat.disabled) return console.log('Chat replay is turned off for this broadcast.');
        const spikes = findChatSpikes(chat.messages, chat.fetched, meta.durationMs)
          .filter((s) => !s.raid)
          .sort((a, b) => b.ratio * b.chatters - a.ratio * a.chatters)
          .slice(0, Math.max(1, Number(o.top)));
        if (o.json) return console.log(JSON.stringify(spikes, null, 2));
        if (!spikes.length) return console.log('No chat explosions in the fetched chat.');
        console.log(`${id} · ${spikes.length} strongest chat explosions`);
        for (const s of spikes) {
          const mood = s.reaction ?? 'unclassified';
          console.log(`[${fmtTime(s.peakMs, 0).padStart(7)}] ${s.ratio.toFixed(1)}× normal · ${String(s.chatters).padStart(3)} chatters · ${mood.padEnd(12)} ${s.top.slice(0, 3).map((t) => t.text).join(' · ')}`);
        }
      }),
    );
}

/** One pass; ingests first if needed. Prints the pass and its seeds. Returns null when up to date. */
export async function scanOnce(link: string, o: { fromMs?: number; toMs?: number; cont: boolean; log: (s: string) => void }) {
  const fs = await import('node:fs');
  const { paths } = await import('../core/paths');
  const { twitchApi } = await import('../ingest/twitch');
  const { resolveInput } = await import('../scan/resolve');
  const r = await resolveInput(link, twitchApi());
  if (r.note) console.log(`${r.id}: ${r.note}`);
  if (!fs.existsSync(paths.videoFile(r.id, 'meta.json'))) {
    const { ingest } = await import('../ingest/ingest');
    await ingest(r.id, { audio: true, full: false, refresh: false, wait: false });
  }
  const { runPass } = await import('../scan');
  const res = await runPass(r.id, { fromMs: o.fromMs ?? r.fromMs, toMs: o.toMs ?? r.toMs, cont: o.cont, log: o.log });
  if ('upToDate' in res) {
    console.log(`Up to date: ${res.reason}.`);
    return null;
  }
  const p = res.pass;
  console.log(`\npass ${p.n}: ${fmtTime(p.fromMs, 0)}–${fmtTime(p.toMs, 0)} in ${p.seconds} s · ${p.chatMessages.toLocaleString('en-US')} chat messages · ${p.viewerClips} viewer clips · ${fmtTime(p.transcribedMs, 0)} transcribed${p.live ? ' · stream still live' : ''}`);
  for (const n of p.notes) console.log(`  ⚠ ${n}`);
  const { printSignals } = await import('../discover');
  printSignals(res.signals);
  console.log(`\nStudio: ${STUDIO}/#/video/${r.id}`);
  return { id: r.id, range: { startMs: p.fromMs, endMs: p.toMs }, pass: p };
}

export async function judgeRange(id: string, range: { startMs: number; endMs: number }, lens: string) {
  const { judgeVideo } = await import('../judge');
  const r = await judgeVideo(id, { lens, range, log: (s) => console.log(`  ${s}`) });
  console.log(`judge: ${r.added} candidate${r.added === 1 ? '' : 's'} added in ${r.seconds} s`);
  return r;
}


const rankStream = async (link: string, chatHours: number, say: (s: string) => void) => (await import('../track/rank')).rankStream(link, chatHours, say);
