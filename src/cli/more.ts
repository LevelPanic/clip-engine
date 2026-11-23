// Discovery, candidates, clip editing, presets, render and studio commands.
import fs from 'node:fs';
import type { Command } from 'commander';
import { fmtTime, parseTime } from '../core/time';
import type { QueueKind } from '../scan/queues';
import type { EditorMode } from '../edit/editors';

type Action = <A extends unknown[]>(fn: (...args: A) => Promise<void> | void) => (...args: A) => Promise<void>;

const STUDIO = 'http://localhost:4400';

/** "--param scale=1.4" → { scale: 1.4 } (numbers, booleans and JSON are parsed; the rest stays text). */
function parseParams(list: string[] = [], json?: string): Record<string, unknown> {
  const out: Record<string, unknown> = json ? JSON.parse(json) : {};
  for (const kv of list) {
    const i = kv.indexOf('=');
    if (i < 1) throw new Error(`--param needs key=value, got "${kv}"`);
    const k = kv.slice(0, i);
    const v = kv.slice(i + 1);
    try {
      out[k] = JSON.parse(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

/** A JSON list from a file or stdin ("-"): either a bare array or { <key>: [...] }. */
function readList(src: string, key: string): unknown[] {
  const text = fs.readFileSync(src === '-' ? 0 : src, 'utf8');
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new Error(`${src === '-' ? 'stdin' : src} is not valid JSON: ${(e as Error).message}`);
  }
  const list = Array.isArray(j) ? j : (j as Record<string, unknown>)?.[key];
  if (!Array.isArray(list)) throw new Error(`expected a JSON array, or an object with a "${key}" array`);
  return list;
}

export function registerMore(program: Command, action: Action) {
  // ---------- discovery ----------

  program
    .command('discover <videoId>')
    .description('Run the signals and write seed windows to library/<id>/signals.json. A scanned stream defaults to its last pass')
    .option('--json', 'print signals.json seeds as JSON')
    .option('--from <time>', 'only pick seeds from here')
    .option('--to <time>', 'only pick seeds up to here')
    .option('--all', 'a scanned stream: pick seeds from everything scanned so far, not just the last pass')
    .action(
      action(async (id: string, o: { json?: boolean; from?: string; to?: string; all?: boolean }) => {
        const { discover, printSignals } = await import('../discover');
        const { loadMeta } = await import('../ingest/ingest');
        const { loadScan, scannedRanges } = await import('../scan');
        const last = loadScan(id).passes.at(-1);
        let range: { startMs: number; endMs: number } | undefined;
        if (o.from || o.to) range = { startMs: o.from ? parseTime(o.from) : 0, endMs: o.to ? parseTime(o.to) : loadMeta(id).durationMs };
        else if (last && !o.all) {
          range = { startMs: last.fromMs, endMs: last.toMs };
          console.log(`seeds from the last scan pass (${fmtTime(last.fromMs, 0)}–${fmtTime(last.toMs, 0)}); --all for everything scanned`);
        } else if (last && o.all) {
          const s = scannedRanges(loadScan(id));
          range = { startMs: s[0].startMs, endMs: s[s.length - 1].endMs };
        }
        const f = discover(id, { range });
        if (o.json) console.log(JSON.stringify(f.seeds, null, 2));
        else printSignals(f);
      }),
    );

  program
    .command('queues <videoId>')
    .description('Three queue checkers (meme, viral, clip) over a VOD range: chat, reactions heard in the audio, viewer clips, speech and title evidence')
    .option('--from <time>', 'start')
    .option('--to <time>', 'end')
    .option('--kind <kind>', 'meme | viral | clip | all', 'all')
    .option('--limit <n>', 'queues per checker', '8')
    .option('--transcribe [what]', 'a stream: first transcribe, then list. "range" = the whole range plus 2 min either side (about 4 min per 30 min; do this once before several agents read the same range); "regions" (default) = only the listed queue regions and the margins around them')
    .option('--dossier', 'for an expert: the queues of one --kind that have no verdict yet, in time order, each with the words around it, the read-on when it is asked for, and stills at the seconds that matter. At most four a call; it prints the command for the rest')
    .option('--queue <id>', 'with --dossier: this queue instead (repeatable), by the id `clip queues` prints', collect)
    .option('--json', 'print { coverage, queues } as JSON')
    .action(
      action(async (id: string, o: { from?: string; to?: string; kind: string; limit: string; transcribe?: boolean | string; json?: boolean; dossier?: boolean; queue?: string[] }) => {
        const { loadQueueData, queuesFrom, coverageOf, describeCoverage, queueTime, QUEUE_KINDS } = await import('../scan/queues');
        if (o.kind !== 'all' && !QUEUE_KINDS.includes(o.kind as QueueKind)) throw new Error(`--kind must be meme, viral, clip or all (got "${o.kind}")`);
        if (o.queue?.length && !o.dossier) throw new Error('--queue goes with --dossier');
        if (o.dossier) {
          if (o.kind === 'all') throw new Error('a dossier is one expert\'s view: give --kind meme, viral or clip');
          const { buildDossier } = await import('../scan/dossier');
          const kind = o.kind as QueueKind;
          const d = await buildDossier(id, kind, { fromMs: o.from ? parseTime(o.from) : undefined, toMs: o.to ? parseTime(o.to) : undefined, ids: o.queue, note: (line) => process.stderr.write(`${line}\n`) });
          if (o.json) return console.log(JSON.stringify(d, null, 2));
          const span = `${queueTime(d.range.startMs)}–${queueTime(d.range.endMs)}`;
          if (!d.all.length && !d.entries.length && !d.missing.length) {
            const c = coverageOf(await loadQueueData(id), d.range);
            if (c.blind) throw new Error(`nothing has been scanned in ${span} (no chat, no audio), so there are no queues to show. That is unknown, not quiet. Run \`clip scan ${id} --from ${queueTime(d.range.startMs)} --to ${queueTime(d.range.endMs)}\` first.`);
          }
          for (const w of d.warnings) console.log(`⚠ ${w}`);
          // whose stream it is and what it was showing: verdicts name the creator, and a watch-along is not their content
          try {
            const { loadMeta } = await import('../ingest/ingest');
            const meta = loadMeta(id);
            const chapter = meta.chapters?.find((c) => d.range.startMs >= c.startMs && d.range.startMs < c.endMs)?.title;
            console.log(`\nStream: ${meta.channel}${meta.platform === 'twitch' ? ' on Twitch' : ''} · "${meta.title}"${chapter ? ` · chapter at ${queueTime(d.range.startMs)}: ${chapter}` : meta.game ? ` · ${meta.game}` : ''}`);
          } catch {
            // no metadata: the queues still stand
          }
          const open = d.all.filter((x) => !x.judged).length;
          console.log(d.scoped ? `\n${kind.toUpperCase()} — ${d.all.length} queue${d.all.length === 1 ? '' : 's'} in ${span}, ${open} without a verdict` : `\n${kind.toUpperCase()} — the ${d.all.length === 1 ? 'queue' : `${d.all.length} queues`} you asked for`);
          for (const x of d.all) console.log(`  ${x.judged ? '✔' : '·'} ${x.queue.id.padEnd(14)} ${queueTime(x.queue.startMs)}–${queueTime(x.queue.endMs)}  ${(x.queue.witnesses.join('+') || 'context only').padEnd(20)} moment ${queueTime(x.queue.peakMs)} (${x.queue.anchor})${d.entries.some((e) => e.queue.id === x.queue.id) ? '   ← below' : ''}`);
          for (const m of d.missing) console.log(`✖ no ${kind} queue near ${m.split('@')[1] ?? m} any more: the id is wrong or the evidence changed. List again with \`clip queues ${id} --kind ${kind} --dossier --from … --to …\``);
          for (const e of d.entries) {
            const q = e.queue;
            console.log(`\n━━ ${q.id}   region ${queueTime(q.startMs)}–${queueTime(q.endMs)}   moment ${queueTime(q.peakMs)} (${q.anchor}${q.anchor === 'audio' || q.anchor === 'expert' ? '' : ': estimated, find it in the stills'})   witnesses: ${q.witnesses.join('+') || 'context only'}   score ${q.score}`);
            if (q.why.length) console.log(`   in the region: ${q.why.join(' · ')}`);
            // the words are below in full, so the list's one-line excerpt is left out
            for (const c of q.context.filter((x) => !x.startsWith('said:'))) console.log(`   ${c.slice(0, 260)}`);
            for (const r of q.risks) console.log(`   ⚠ ${r.replace('<id>', id)}`);
            console.log(`   words ${queueTime(e.window.fromMs)}–${queueTime(e.window.toMs)}:`);
            for (const line of e.words.split('\n')) console.log(`     ${line}`);
            if (e.readOn !== undefined) {
              console.log(`   read-on ${queueTime(e.window.toMs)}–${queueTime(e.window.readOnToMs!)} (${kind === 'clip' ? 'a story is always read on' : 'chat asks for it'}): a retraction, a reveal or a better landing would be here`);
              for (const line of e.readOn.split('\n')) console.log(`     ${line}`);
            }
            console.log('   stills (640 px) — read every path before you decide:');
            for (const st of e.stills) console.log(`     ${queueTime(st.ms)}  ${st.file ?? '(no still)'}`);
          }
          // the range goes with it, so the next call still lists (and warns about) this range and not the whole video
          const more = (ids: string[]) => `./clip queues ${id}${d.scoped ? ` --from ${queueTime(d.range.startMs)} --to ${queueTime(d.range.endMs)}` : ''} --kind ${kind} --dossier ${ids.map((x) => `--queue ${x}`).join(' ')}`;
          if (d.rest.length) {
            console.log(`\n${d.rest.flat().length} more without a verdict. After saving verdicts for the ones above:`);
            for (const ids of d.rest) console.log(`  ${more(ids)}`);
          } else if (d.entries.length) console.log(`\nThat is every ${kind} queue ${o.queue?.length ? 'you asked for' : `without a verdict in ${span}`}.`);
          else if (!d.missing.length) console.log(d.all.length ? `Every ${kind} queue in ${span} has a verdict.` : `No ${kind} queues in ${span}.`);
          return;
        }
        const kinds: QueueKind[] = o.kind === 'all' ? QUEUE_KINDS : [o.kind as QueueKind];
        let data = await loadQueueData(id);
        const range = { startMs: o.from ? parseTime(o.from) : 0, endMs: Math.min(data.durationMs, o.to ? parseTime(o.to) : data.durationMs) };
        if (range.endMs <= range.startMs) throw new Error(`the range ${queueTime(range.startMs)}–${queueTime(range.endMs)} is empty (the video is ${queueTime(data.durationMs)} long)`);
        if (o.transcribe && data.platform === 'twitch') {
          // transcribe once, here, so the readers that follow only read
          const { mergeRanges } = await import('../core/ranges');
          if (o.transcribe !== true && o.transcribe !== 'regions' && o.transcribe !== 'range') throw new Error(`--transcribe takes "regions" or "range" (got "${o.transcribe}")`);
          let need: { startMs: number; endMs: number }[];
          if (o.transcribe === 'range') {
            // everything an expert may read: the range, and two minutes either side for a setup before it or a reveal after it
            const a = Math.max(0, range.startMs - 120_000);
            const b = Math.min(data.durationMs, range.endMs + 120_000);
            need = [];
            for (let t = a; t < b; t += 600_000) need.push({ startMs: t, endMs: Math.min(b, t + 600_000) });
          } else {
            // the regions, with the margins the experts read around them (10 s before, 20 s after)
            const listed = kinds.flatMap((kind) => queuesFrom(data, { fromMs: range.startMs, toMs: range.endMs, kind, limit: Math.max(1, Number(o.limit)) }));
            need = mergeRanges(listed.map((q) => ({ startMs: Math.max(0, q.startMs - 15_000), endMs: Math.min(data.durationMs, q.endMs + 25_000) })), 20_000);
          }
          if (need.length) {
            const { ensureTranscribed } = await import('../ingest/windowed');
            const note = (line: string) => process.stderr.write(`${line}\n`);
            const r = await ensureTranscribed(id, need, note);
            note(`transcribed ${r.transcribed.length} region${r.transcribed.length === 1 ? '' : 's'} in ${r.seconds} s${r.failed.length ? `; ${r.failed.length} failed: ${r.failed[0].error}` : ''}`);
            data = await loadQueueData(id);
          }
        }
        const coverage = coverageOf(data, range);
        // unknown is not quiet: an unscanned range has no queues because nobody looked, not because nothing happened
        // the limit is a view, not a filter: say how many weaker queues it hides so none is dropped unseen
        const limit = Math.max(1, Number(o.limit));
        const every = kinds.map((kind) => queuesFrom(data, { fromMs: range.startMs, toMs: range.endMs, kind, limit: 500 }));
        const out = every.flatMap((qs) => qs.slice(0, limit));
        const hidden = Object.fromEntries(kinds.map((kind, k) => [kind, Math.max(0, every[k].length - limit)])) as Record<QueueKind, number>;
        const scanFirst = `Run \`clip scan ${id} --from ${queueTime(range.startMs)} --to ${queueTime(range.endMs)}\` first.`;
        if (coverage.blind && !out.length) throw new Error(`nothing has been scanned in ${queueTime(range.startMs)}–${queueTime(range.endMs)} (no chat, no audio), so there are no queues to show. That is unknown, not quiet. ${scanFirst}`);
        if (o.json) {
          console.log(JSON.stringify({ videoId: id, coverage, hidden, queues: out }, null, 2));
          return;
        }
        if (coverage.blind) console.log(`⚠ only viewer clips to go on: chat and audio were never scanned for this range. ${scanFirst}`);
        for (const line of describeCoverage(coverage)) console.log(`⚠ ${line}`);
        for (const kind of kinds) {
          const rows = out.filter((q) => q.kind === kind);
          console.log(`\n${kind.toUpperCase()} — ${rows.length} queue${rows.length === 1 ? '' : 's'}${hidden[kind] ? ` (+${hidden[kind]} weaker not shown; --limit ${limit + hidden[kind]} lists them)` : ''}`);
          for (const q of rows) {
            console.log(`  ${q.id.padEnd(14)} ${queueTime(q.startMs)}–${queueTime(q.endMs)}  score ${String(q.score).padStart(5)}  ${q.witnesses.join('+') || 'context only'}  moment ${queueTime(q.peakMs)} (${q.anchor})`);
            // the witnesses above are what the moment itself has; this line is everything in the region around it
            if (q.why.length) console.log(`         in the region: ${q.why.join(' · ')}`);
            for (const c of q.context) console.log(`         ${c.slice(0, 260)}`);
            for (const r of q.risks) console.log(`         ⚠ ${r.replace('<id>', id)}`);
          }
        }
        if (kinds.length === 1 && out.length) console.log(`\nTo judge them: \`./clip queues ${id} --from ${queueTime(range.startMs)} --to ${queueTime(range.endMs)} --kind ${kinds[0]} --dossier\` prints the words and saves the stills for the ones without a verdict, four at a time.`);
      }),
    );

  program
    .command('windows <videoId>')
    .description('Weighted extraction windows around each queue: what part of the region makes sense for a meme, viral or clip queue')
    .option('--from <time>', 'start')
    .option('--to <time>', 'end')
    .option('--kind <kind>', 'meme | viral | clip | all', 'all')
    .option('--queue <id>', 'only this queue (an id from `clip queues`, e.g. meme@1:46:25); repeatable', collect)
    .option('--queues <n>', 'queues per checker to inspect', '8')
    .option('--limit <n>', 'windows per queue', '3')
    .option('--json', 'print the queues and windows as JSON')
    .action(
      action(async (id: string, o: { from?: string; to?: string; kind: string; queue?: string[]; queues: string; limit: string; json?: boolean }) => {
        const { loadQueueData, queuesFrom, findQueue, queueTime, QUEUE_KINDS } = await import('../scan/queues');
        const { bestWindows, scoreWindow } = await import('../extract/window');
        if (o.kind !== 'all' && !QUEUE_KINDS.includes(o.kind as QueueKind)) throw new Error(`--kind must be meme, viral, clip or all (got "${o.kind}")`);
        const data = await loadQueueData(id);
        const { loadQueueReview, queueFromVerdict } = await import('../scan/review');
        const ledger = loadQueueReview(id);
        let picked: import('../scan/queues').Queue[];
        if (o.queue?.length) {
          // an id carries its moment's time, so look around it; no range needed
          picked = o.queue.map((qid) => {
            const m = /^(meme|viral|clip)@(\d+):(\d{2}):(\d{2})$/.exec(qid);
            if (!m) throw new Error(`"${qid}" is not a queue id (like meme@1:46:25); list them with \`clip queues ${id} --from … --to …\``);
            const at = (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000;
            const near = queuesFrom(data, { kind: m[1] as QueueKind, fromMs: Math.max(0, at - 120_000), toMs: at + 120_000, limit: 50 });
            let q = findQueue(near, qid);
            if (!q) {
              // a moment an expert found, or a queue the checkers no longer list: the ledger still has it
              const kept = ledger.verdicts.find((x) => x.queueId === qid && x.verdict === 'confirm');
              if (kept) q = queueFromVerdict(kept);
            }
            if (!q) throw new Error(`no ${m[1]} queue near ${queueTime(at)} any more (the evidence changed) and no confirmed verdict for it; run \`clip queues ${id} --from ${queueTime(Math.max(0, at - 300_000))} --to ${queueTime(at + 300_000)} --kind ${m[1]}\``);
            // an expert who confirmed this queue saw where the moment really is: score windows around that
            const v = ledger.verdicts.find((x) => x.queueId === q.id && x.verdict === 'confirm');
            if (!v || (v.momentMs === undefined && v.startMs === undefined && v.endMs === undefined)) return q;
            const moment = v.momentMs ?? q.peakMs;
            return { ...q, peakMs: moment, anchor: v.momentMs !== undefined ? ('expert' as const) : q.anchor, startMs: Math.max(0, Math.min(q.startMs, v.startMs ?? Infinity, moment - 10_000)), endMs: Math.min(data.durationMs, Math.max(q.endMs, v.endMs ?? 0, moment + 10_000)) };
          });
        } else {
          const kinds: QueueKind[] = o.kind === 'all' ? QUEUE_KINDS : [o.kind as QueueKind];
          const range = { fromMs: o.from ? parseTime(o.from) : 0, toMs: o.to ? parseTime(o.to) : data.durationMs };
          picked = kinds.flatMap((kind) => queuesFrom(data, { ...range, kind, limit: Number(o.queues) }));
        }
        const words = data.transcript?.words ?? [];
        const clips = data.clips.map((c) => ({ offsetMs: c.offsetMs, views: c.views, title: c.title }));
        const muted = data.excluded.map((m) => ({ startMs: m.startMs, endMs: m.endMs }));
        const out = picked.map((queue) => {
          // the cut the expert suggested, scored the same way, so it can be compared with the scorer's own
          const v = ledger.verdicts.find((x) => x.queueId === queue.id && x.verdict === 'confirm' && x.startMs !== undefined && x.endMs !== undefined);
          const expertWindow = v ? { startMs: v.startMs!, endMs: v.endMs!, ...scoreWindow({ kind: queue.kind, startMs: v.startMs!, endMs: v.endMs!, peakMs: queue.peakMs, words, reactions: data.reactions, clips, muted }) } : undefined;
          return {
            kind: queue.kind,
            queue,
            ...(expertWindow ? { expertWindow } : {}),
            windows: bestWindows({ queue, words, reactions: data.reactions, clips, muted, limit: Number(o.limit), durationMs: data.durationMs }),
          };
        });
        if (o.json) {
          console.log(JSON.stringify(out, null, 2));
          return;
        }
        for (const kind of QUEUE_KINDS) {
          const rows = out.filter((r) => r.kind === kind);
          if (!rows.length) continue;
          console.log(`\n${kind.toUpperCase()} — ${rows.length} queue${rows.length === 1 ? '' : 's'}`);
          for (const { queue, windows, expertWindow } of rows) {
            console.log(`  ${queue.id}  region ${queueTime(queue.startMs)}–${queueTime(queue.endMs)}  moment ${queueTime(queue.peakMs)} (${queue.anchor})  score ${queue.score}`);
            if (expertWindow) {
              const len = (expertWindow.endMs - expertWindow.startMs) / 1000;
              console.log(`    the expert's cut  ${fmtTime(expertWindow.startMs)}–${fmtTime(expertWindow.endMs)} (${len.toFixed(1)} s)  ${String(expertWindow.score).padStart(3)}  ${expertWindow.why.slice(0, 5).join(' · ')}${len < 15 || len > 60 ? ' · outside 15–60 s' : ''}`);
            }
            if (!queue.signals.speech.covered) console.log(`    ⚠ not fully transcribed: run \`clip transcript ${id} --from ${queueTime(Math.max(0, queue.startMs - 5000))} --to ${queueTime(queue.endMs + 5000)}\`, then run this again`);
            if (!windows.length) console.log('    no usable window (muted, or the region is shorter than 15 s)');
            for (const w of windows) {
              console.log(
                `    ${fmtTime(w.startMs)}–${fmtTime(w.endMs)} (${((w.endMs - w.startMs) / 1000).toFixed(1)} s)  ${String(w.score).padStart(3)}  ${w.why.slice(0, 5).join(' · ')}${
                  w.quote ? `\n      quote: "${w.quote}"` : ''
                }`,
              );
            }
          }
        }
      }),
    );

  program
    .command('vocab [section]')
    .description('The shared vocabulary the ledgers are checked against: archetypes, triggers, rejects, risks, niches, drops')
    .option('--json', 'print as JSON')
    .action(
      action(async (section: string | undefined, o: { json?: boolean }) => {
        const { VOCABULARY } = await import('../core/vocabulary');
        const keys = Object.keys(VOCABULARY) as (keyof typeof VOCABULARY)[];
        if (section && !keys.includes(section as never)) throw new Error(`no section "${section}"; try ${keys.join(', ')}`);
        const pick = section ? [section as keyof typeof VOCABULARY] : keys;
        if (o.json) return console.log(JSON.stringify(Object.fromEntries(pick.map((k) => [k, VOCABULARY[k].terms])), null, 2));
        for (const k of pick) {
          console.log(`\n${VOCABULARY[k].title}  [${k}]`);
          for (const t of VOCABULARY[k].terms) console.log(`  ${t.key.padEnd(17)} ${t.means}${t.cut ? `\n${' '.repeat(20)}cut: ${t.cut}` : ''}`);
        }
      }),
    );

  program
    .command('queue-review <videoId> [file]')
    .description('The queue experts\' verdicts (library/<id>/queue-review.json). With a JSON file (or "-"): validate and save verdicts. Without: show the ledger')
    .option('--from <time>', 'with --pending: start of the range')
    .option('--to <time>', 'with --pending: end of the range')
    .option('--kind <kind>', 'only this expert\'s verdicts: meme | viral | clip | all', 'all')
    .option('--pending', 'only say which queues in the range (--from, --to, --kind) have no verdict yet')
    .option('--evidence', 'for whoever checks the experts: every confirm in the range with the still each "frame" line stands on and where each "said:" line is in the transcript')
    .option('--json', 'print as JSON')
    .action(
      action(async (id: string, src: string | undefined, o: { from?: string; to?: string; kind: string; pending?: boolean; evidence?: boolean; json?: boolean }) => {
        const { loadQueueData, queuesFrom, queueTime, QUEUE_KINDS } = await import('../scan/queues');
        const { applyQueueVerdicts, loadQueueReview, confirmedMoments, pendingQueues, orphanedMoments } = await import('../scan/review');
        const data = await loadQueueData(id);
        if (src) {
          // three experts save into one ledger: one at a time, or a save can drop another's verdicts
          const { withVideoLock } = await import('../core/lock');
          const inputs = readList(src, 'verdicts');
          const r = await withVideoLock(id, 'queue-review', async () => applyQueueVerdicts(id, data, inputs), 60_000);
          if (o.json) console.log(JSON.stringify(r, null, 2));
          else {
            console.log(`saved ${r.saved.length}, refused ${r.refused.length}`);
            for (const v of r.saved) console.log(`  ${v.verdict.padEnd(7)} ${v.queueId.padEnd(14)} ${v.archetype ?? v.rejected ?? `→ ${v.mergeInto}`}${v.trigger ? ` · ${v.trigger}` : ''}${v.risks.length ? ` · ⚠ ${v.risks.join(', ')}` : ''}`);
            for (const x of r.refused) console.log(`✖ refused ${(x.input as { queueId?: string }).queueId ?? '?'}: ${x.errors.join('; ')}`);
          }
          if (r.refused.length) process.exitCode = 1;
          return;
        }
        const ledger = loadQueueReview(id);
        const kinds: QueueKind[] = o.kind === 'all' ? QUEUE_KINDS : [o.kind as QueueKind];
        if (o.kind !== 'all' && !QUEUE_KINDS.includes(o.kind as QueueKind)) throw new Error(`--kind must be meme, viral, clip or all (got "${o.kind}")`);
        if (o.pending) {
          // one question, one answer: which queues in this range still have no verdict
          const listed = kinds.flatMap((kind) => queuesFrom(data, { kind, fromMs: o.from ? parseTime(o.from) : 0, toMs: o.to ? parseTime(o.to) : data.durationMs, limit: 500 }));
          const pending = pendingQueues(ledger, listed);
          if (o.json) return console.log(JSON.stringify({ videoId: id, queues: listed.length, pending: pending.map((q) => q.id) }, null, 2));
          const what = o.kind === 'all' ? 'queue' : `${o.kind} queue`;
          if (!listed.length) console.log(`no ${what}s in the range`);
          else if (!pending.length) console.log(`every ${what} in the range has a verdict (${listed.length})`);
          else console.log(`${pending.length} of ${listed.length} ${what}s in the range have no verdict yet: ${pending.map((q) => q.id).join(', ')}`);
          for (const g of orphanedMoments(ledger)) console.log(`⚠ nobody judged ${queueTime(g[0].momentMs ?? g[0].queue.peakMs)}: ${g.map((v) => `${v.queueId} was passed on as ${v.rejected}`).join('; ')}. One expert has to decide it`);
          return;
        }
        if (o.evidence) {
          // a verdict is a report, not proof: this puts each claim next to the thing it stands on
          const { citedFrames, stillFiles, stillNear, saidParts, saidCheckable, findSaid, saidRange } = await import('../scan/review');
          const lo = o.from ? parseTime(o.from) : 0;
          const hi = o.to ? parseTime(o.to) : data.durationMs;
          const stills = stillFiles(id);
          const rows = ledger.verdicts.filter((v) => kinds.includes(v.kind) && v.verdict === 'confirm' && (v.momentMs ?? v.queue.peakMs) >= lo && (v.momentMs ?? v.queue.peakMs) <= hi);
          if (!rows.length) console.log('no confirms in the range');
          for (const v of rows) {
            const win = v.startMs !== undefined && v.endMs !== undefined ? `  window ${fmtTime(v.startMs)}–${fmtTime(v.endMs)}` : '';
            console.log(`\n${v.queueId}  ${v.archetype}${v.trigger ? ` · ${v.trigger}` : ''} · confidence ${v.confidence}  moment ${queueTime(v.momentMs ?? v.queue.peakMs)}${win}${v.risks.length ? `  ⚠ ${v.risks.join(', ')}` : ''}`);
            const span = saidRange(v.queue, v.momentMs);
            for (const line of v.seen) {
              console.log(`  ${line}`);
              for (const ms of citedFrames([line])) console.log(`      → ${stillNear(stills, ms) ?? `(no still on disk for ${queueTime(ms)} any more: \`clip frames ${id} ${queueTime(ms)}\`)`}`);
              for (const part of saidParts([line]).filter(saidCheckable)) {
                const hit = findSaid(data.transcript?.words ?? [], part, span.fromMs, span.toMs);
                console.log(`      ${!hit.known ? '? nothing transcribed there to check it against' : hit.atMs !== undefined ? `✓ said at ${queueTime(hit.atMs)}` : `✖ not in the transcript near the moment: "${part.slice(0, 60)}"`}`);
              }
            }
          }
          if (rows.length) console.log('\nRead each still and compare it with the line above it. A still that does not show what its line says means the expert did not look.');
          return;
        }
        const verdicts = ledger.verdicts.filter((v) => kinds.includes(v.kind));
        const moments = confirmedMoments(ledger).filter((m) => o.kind === 'all' || [m.primary, ...m.also].some((v) => kinds.includes(v.kind)));
        if (o.json) return console.log(JSON.stringify({ videoId: id, moments, verdicts }, null, 2));
        if (!verdicts.length) console.log('No verdicts yet. The queue experts write them: /queue-check, or `clip queue-review <id> <file>`.');
        if (moments.length) console.log(`${moments.length} confirmed moment${moments.length === 1 ? '' : 's'} (one clip each):`);
        for (const m of moments) {
          const v = m.primary;
          const win = v.startMs !== undefined && v.endMs !== undefined ? `  window ${fmtTime(v.startMs)}–${fmtTime(v.endMs)}` : '';
          console.log(`  ${queueTime(m.momentMs)}  ${v.queueId}${m.also.length ? ` (also ${m.also.map((a) => a.queueId).join(', ')})` : ''}  ${v.archetype}${v.trigger ? ` · ${v.trigger}` : ''} · confidence ${v.confidence}${v.visual ? ' · visual' : ''}${v.found ? ' · found by the expert (no queue)' : ''}${win}`);
          console.log(`           ${v.reason}`);
          if (v.cut) console.log(`           the cut: ${v.cut}`);
          if (v.context) console.log(`           context a cold viewer needs: ${v.context}`);
          // a second reading is not lost: the extractor sees its cut too
          for (const a of m.also.filter((x) => x.verdict === 'confirm')) {
            const w = a.startMs !== undefined && a.endMs !== undefined ? ` window ${fmtTime(a.startMs)}–${fmtTime(a.endMs)}` : '';
            console.log(`           second reading, ${a.kind} expert (${a.archetype}${a.trigger ? ` · ${a.trigger}` : ''}, ${a.confidence})${w}: ${a.reason.slice(0, 220)}${a.reason.length > 220 ? '…' : ''}`);
            if (a.cut) console.log(`             its cut: ${a.cut.slice(0, 220)}${a.cut.length > 220 ? '…' : ''}`);
          }
          const risks = [...new Set([v, ...m.also].flatMap((x) => x.risks))];
          if (risks.length) console.log(`           ⚠ check before posting: ${risks.join(', ')}`);
        }
        const rejects = verdicts.filter((v) => v.verdict === 'reject');
        if (rejects.length) {
          const by = new Map<string, number>();
          for (const v of rejects) by.set(v.rejected ?? '?', (by.get(v.rejected ?? '?') ?? 0) + 1);
          console.log(`${rejects.length} rejected: ${[...by].map(([k, n]) => `${k} ×${n}`).join(', ')}`);
        }
        for (const g of orphanedMoments(ledger)) console.log(`⚠ nobody judged ${queueTime(g[0].momentMs ?? g[0].queue.peakMs)}: ${g.map((v) => `${v.queueId} was passed on as ${v.rejected}`).join('; ')}. One expert has to decide it`);
      }),
    );

  program
    .command('curate <videoId> [file]')
    .description('The curator\'s ledger (library/<id>/curation.json). With a JSON file (or "-"): validate and save decisions, and skip the drops. Without: show the ledger')
    .option('--json', 'print as JSON')
    .action(
      action(async (id: string, src: string | undefined, o: { json?: boolean }) => {
        const { applyCuration, loadCuration, undecidedIn } = await import('../curate');
        if (src) {
          const { withVideoLock } = await import('../core/lock');
          const inputs = readList(src, 'decisions');
          const r = await withVideoLock(id, 'curation', async () => applyCuration(id, inputs), 60_000);
          if (o.json) console.log(JSON.stringify(r, null, 2));
          else {
            console.log(`saved ${r.saved.length}, refused ${r.refused.length}${r.skipped.length ? ` · dropped ${r.skipped.join(', ')}` : ''}${r.restored.length ? ` · restored ${r.restored.join(', ')}` : ''}`);
            for (const x of r.refused) console.log(`✖ refused ${(x.input as { candidateId?: string }).candidateId ?? '?'}: ${x.errors.join('; ')}`);
            if (r.undecided.length) console.log(`⚠ no decision yet for ${r.undecided.join(', ')}: the ledger must cover every candidate`);
          }
          if (r.refused.length) process.exitCode = 1;
          return;
        }
        const ledger = loadCuration(id);
        const undecided = undecidedIn(id);
        if (o.json) return console.log(JSON.stringify({ ...ledger, undecided }, null, 2));
        if (!ledger.decisions.length) console.log('No curation yet. /clip-curator writes it, or `clip curate <id> <file>`.');
        for (const d of ledger.decisions) {
          console.log(`${d.candidateId}  ${d.decision.padEnd(6)} ${`${d.niche}${d.angle ? ` (${d.angle})` : ''}`.padEnd(34)} fit ${String(d.fit).padStart(3)}${d.decision === 'drop' ? `  ${d.ground ?? ''} · removal weight ${d.removalWeight}` : ''}  ${d.title ?? ''}`);
          console.log(`       ${d.reason}`);
          for (const fx of d.fixes ?? []) console.log(`       fix: ${fx}`);
        }
        if (undecided.length) console.log(`⚠ no decision yet for ${undecided.join(', ')}`);
      }),
    );

  program
    .command('live')
    .description('The most-watched Twitch streams right now')
    .option('--limit <n>', 'how many to list', '20')
    .action(
      action(async (o: { limit: string }) => {
        const { twitchApi } = await import('../ingest/twitch');
        const rows = await twitchApi().topStreams(Number(o.limit));
        rows.forEach((r, i) => console.log(`${String(i + 1).padStart(2)} ${String(r.viewers).padStart(6)}  ${r.login.padEnd(20)} ${r.game.padEnd(24)} ${r.title.slice(0, 80)}`));
      }),
    );

  program
    .command('topics')
    .description('The topics the watchlist follows (topics.json), what is live in each on Twitch now, and which stream it would take next; --suggest lists trending categories to add')
    .option('--suggest', 'trending Twitch categories that are not topics yet, with their English viewers')
    .option('--youtube', 'also count live YouTube viewers for each (slower: one search each)')
    .option('--limit <n>', 'with --suggest: how many categories to read', '20')
    .action(
      action(async (o: { suggest?: boolean; youtube?: boolean; limit: string }) => {
        const { twitchApi } = await import('../ingest/twitch');
        const { loadTopics, topicPicks, youtubeLive, NOT_A_TOPIC, TOPIC_TOP } = await import('../scan/topics');
        const { loadChannel, optedOut } = await import('../core/channel');
        const api = twitchApi();
        const topics = loadTopics();
        const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
        const ytViewers = async (q: string) => {
          try {
            const live = (await youtubeLive(q, 10)).filter((x) => x.verified);
            return `YouTube live ${k(live.reduce((a, x) => a + x.viewers, 0))} (top: ${live.slice(0, 2).map((x) => `${x.channel} ${k(x.viewers)}`).join(', ') || 'none'})`;
          } catch (e) {
            return `YouTube: ${(e as Error).message.slice(0, 80)}`;
          }
        };
        if (o.suggest) {
          const have = new Set(topics.map((t) => t.twitch.toLowerCase()));
          const games = (await api.topGames(Number(o.limit))).filter((g) => !NOT_A_TOPIC.has(g.name.toLowerCase()));
          console.log('Trending on Twitch now (all languages, then English among the top 20 streams); ✓ = already a topic\n');
          for (const g of games) {
            const en = await api.categoryStreams(g.name, { limit: 20 }).catch(() => []);
            const enViewers = en.reduce((a, x) => a + x.viewers, 0);
            const line = `${have.has(g.name.toLowerCase()) ? '✓' : ' '} ${g.name.padEnd(30)} ${k(g.viewers).padStart(6)} viewers · English ${k(enViewers).padStart(6)} (${en.slice(0, 2).map((x) => `${x.name} ${k(x.viewers)}`).join(', ')})`;
            console.log(o.youtube ? `${line}\n      ${await ytViewers(g.name)}` : line);
          }
          console.log('\nAdd one to topics.json: { "name": …, "twitch": "<category as above>", "youtube": "<search>", "minViewers": 2000 }');
          return;
        }
        if (!topics.length) return console.log('no topics: add them to topics.json (`clip topics --suggest` lists trending categories)');
        const { loadCreators } = await import('../core/creators');
        const creators = loadCreators();
        const found = [];
        for (const t of topics) {
          const streams = await api.categoryStreams(t.twitch, { limit: 20 }).catch((e: Error) => (console.log(`${t.name}: ${e.message}`), []));
          found.push(...streams.map((x) => ({ ...x, topic: t.name })));
          const big = streams.filter((x) => x.viewers >= t.minViewers);
          const line = `${t.enabled ? ' ' : '(off)'} ${t.name.padEnd(20)} ${t.twitch.padEnd(24)} ${String(big.length).padStart(2)} English streams over ${k(t.minViewers)}: ${big.slice(0, 3).map((x) => `${x.name} ${k(x.viewers)}`).join(', ')}`;
          console.log(o.youtube && t.youtube ? `${line}\n      ${await ytViewers(t.youtube)}` : line);
        }
        const channel = loadChannel();
        // the same inputs the watchlist uses (tools/watchlist.ts → checkTopics), so the preview is what the
        // daemon takes: each topic's top 3, listed creators and broadcasts skipped before left out
        const { listStreams } = await import('../track/db');
        const tracked = new Set(listStreams().map((x) => x.videoId));
        const { picks, skipped } = topicPicks(topics, found, {
          watched: new Set(creators.filter((c) => c.platform === 'twitch').map((c) => c.handle.toLowerCase())),
          optedOut: (login) => !!optedOut({ login }, channel),
          unusable: new Map(listStreams({ status: 'skipped' }).map((x) => [x.videoId, x.skipReason ?? 'skipped'])),
        });
        console.log(`\neach topic's top ${TOPIC_TOP} (tracked = already in the tracker; the check only adds the new ones):`);
        for (const t of topics.filter((x) => x.enabled)) {
          const mine = picks.filter((p) => p.topic === t.name);
          console.log(`  ${t.name.padEnd(20)} ${mine.length ? mine.map((p) => `${p.name} (${k(p.viewers)}${tracked.has(`tw-${p.vodId}`) ? ', tracked' : ', new'})`).join(' · ') : 'none eligible'}`);
        }
        const why = skipped.filter((s) => !/viewers, under|top \d/.test(s.why));
        if (why.length) console.log(`passed over:\n${why.slice(0, 12).map((s) => `  ${s.topic}: ${s.login} (${k(s.viewers)}): ${s.why}`).join('\n')}`);
      }),
    );

  program
    .command('frames <videoId> <times...>')
    .description('Save stills at these times (e.g. 1:59:40 2:00:28) for the judge to look at; prints their paths')
    .option('--width <px>', 'image width', '640')
    .action(
      action(async (id: string, times: string[], o: { width: string }) => {
        // a queue id (clip@1:20:00) or a typo is not a video: refuse instead of making library/<it>/frames
        const { paths: p } = await import('../core/paths');
        if (!(await import('node:fs')).existsSync(p.videoFile(id, 'meta.json'))) throw new Error(`No video "${id}" in the library. A queue id such as clip@1:20:00 is not a video id: give the video (tw-…) and the times.`);
        const { grabFrames } = await import('../ingest/frames');
        const fs = await import('node:fs');
        const warnings: string[] = [];
        const files = await grabFrames(id, times.map((t) => parseTime(t)), Number(o.width), (w) => warnings.push(w));
        // only print a path that holds the second it is named for
        files.forEach((f, k) => console.log(fs.existsSync(f) ? `${times[k]}  ${f}` : `${times[k]}  (no still)`));
        for (const w of warnings) console.log(`⚠ ${w}`);
        if (warnings.length && !files.some((f) => fs.existsSync(f))) process.exitCode = 1;
      }),
    );

  program
    .command('judge <videoId>')
    .description('Find candidates with the Claude judge (default) or the experimental heuristic judge')
    .option('--provider <name>', 'claude, opencode, or heuristic (experimental)', process.env.CLIP_JUDGE ?? 'claude')
    .option('--lens <name>', 'lens (default: stream-moments for Twitch, podcast-general for YouTube)')
    .option('--want <n>', 'aim for this many candidates', '8')
    .option('--from <time>', 'start of the range to judge')
    .option('--to <time>', 'end of the range to judge')
    .action(
      action(async (videoId: string, o: { provider: string; lens?: string; want: string; from?: string; to?: string }) => {
        if (!!o.from !== !!o.to) throw new Error('give both --from and --to, or neither');
        const { judgeVideo } = await import('../judge');
        const r = await judgeVideo(videoId, {
          provider: o.provider as 'claude' | 'opencode' | 'heuristic',
          lens: o.lens,
          want: Number(o.want),
          range: o.from && o.to ? { startMs: parseTime(o.from), endMs: parseTime(o.to) } : undefined,
          log: console.log,
        });
        console.log(`${r.added} candidates in ${r.seconds}s: ${r.reply}`);
      }),
    );

  const cands = program.command('candidates').description('Clip candidates for a video');

  cands
    .command('add <videoId> [file]')
    .description('Validate and add candidates from a JSON file (or stdin with "-"): [{start,end,title,hook,reason,quote,score,scores,lens,kind?,queueId?,visual?}]')
    .option('--no-footage', "don't queue the footage download for the accepted candidates")
    .action(
      action(async (id: string, file = '-', o: { footage: boolean } = { footage: true }) => {
        const { addCandidates, readCandidateInputs, printCandidate } = await import('../candidates');
        const r = addCandidates(id, readCandidateInputs(file), { footage: o.footage });
        console.log(`accepted ${r.accepted.length}, rejected ${r.rejected.length}`);
        r.accepted.forEach((c) => printCandidate(c));
        for (const x of r.rejected) {
          const inp = x.input as { title?: string; start?: string; end?: string };
          console.log(`✖ rejected "${inp.title ?? '?'}" (${inp.start}–${inp.end}): ${x.errors.join('; ')}`);
        }
        for (const n of r.notes) console.log(`\n⚠ ${n}`);
        if (!r.accepted.length && r.rejected.length) process.exitCode = 1;
      }),
    );

  cands
    .command('list <videoId>')
    .action(
      action(async (id: string) => {
        const { loadCandidates, printCandidate } = await import('../candidates');
        const f = loadCandidates(id);
        if (!f.candidates.length) console.log('No candidates yet. Run the /clip skill or `clip candidates add`.');
        f.candidates.forEach((c) => printCandidate(c)); // loadCandidates already ranks them
      }),
    );

  cands
    .command('score <videoId> <candidateId>')
    .description('Correct a candidate\'s scores and re-rank the list: the funnel scores (0–10, all together), the quality score (0–100), or both')
    .option('--stop <n>', 'first 1–2 s: would a stranger stop?')
    .option('--hold <n>', 'does it hold to the payoff?')
    .option('--share <n>', 'a reason to send it?')
    .option('--standalone <n>', 'understood with no context?')
    .option('--payoff <n>', 'a clear outcome or punchline?')
    .option('--delivery <n>', 'does it deliver what the opening promised? (defaults to payoff)')
    .option('--score <n>', 'the quality score, 0–100: is this a good moment at all? (anchors in agents/vocabulary.md, section 4)')
    .action(
      action(async (videoId: string, candidateId: string, o: Record<string, string>) => {
        const { loadCandidates, saveCandidates, printCandidate } = await import('../candidates');
        const { ViralityScoresSchema } = await import('../core/schemas');
        const funnel = ['stop', 'hold', 'share', 'standalone', 'payoff'];
        const given = funnel.filter((k) => o[k] !== undefined);
        if (!given.length && o.score === undefined) throw new Error('nothing to set: give the funnel scores (--stop --hold --share --standalone --payoff, and --delivery), --score, or both');
        if (given.length && given.length < funnel.length) throw new Error(`the funnel scores are set together: ${funnel.filter((k) => o[k] === undefined).map((k) => `--${k}`).join(', ')} missing`);
        const f = loadCandidates(videoId);
        const cand = f.candidates.find((c) => c.id === candidateId);
        if (!cand) throw new Error(`No candidate ${candidateId} for ${videoId}`);
        const before = { score: cand.score, virality: cand.virality, verdict: cand.verdict };
        if (given.length) {
          cand.scores = ViralityScoresSchema.parse({
            stop: Number(o.stop),
            hold: Number(o.hold),
            share: Number(o.share),
            standalone: Number(o.standalone),
            payoff: Number(o.payoff),
            ...(o.delivery !== undefined ? { delivery: Number(o.delivery) } : {}),
          });
        }
        if (o.score !== undefined) {
          const quality = Number(o.score);
          if (!(quality >= 0 && quality <= 100)) throw new Error(`--score is 0–100 (got "${o.score}")`);
          cand.score = quality;
        }
        const saved = saveCandidates(f);
        const after = saved.candidates.find((c) => c.id === candidateId)!;
        // what changed, in one line: the full print below looks the same when only the quality score moved
        console.log(`${candidateId}: score ${before.score} → ${after.score} · virality ${before.virality ?? '–'} → ${after.virality ?? '–'} · verdict ${before.verdict ?? '–'} → ${after.verdict ?? '–'}`);
        printCandidate(after, console.log);
      }),
    );

  cands
    .command('lens <videoId> <candidateId> <lens>')
    .description('Change a candidate’s lens (it picks the talk or stream scoring weights)')
    .action(
      action(async (videoId: string, candidateId: string, lens: string) => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { paths } = await import('../core/paths');
        const { loadCandidates, saveCandidates, printCandidate } = await import('../candidates');
        if (!fs.existsSync(path.join(paths.root, 'lenses', `${lens}.md`))) throw new Error(`No lens "${lens}" in lenses/`);
        const f = loadCandidates(videoId);
        const cand = f.candidates.find((c) => c.id === candidateId);
        if (!cand) throw new Error(`No candidate ${candidateId} for ${videoId}`);
        cand.lens = lens;
        const saved = saveCandidates(f);
        printCandidate(saved.candidates.find((c) => c.id === candidateId)!, console.log);
      }),
    );

  cands
    .command('refresh <videoId>')
    .description('Recompute signals and warnings for existing candidates (after discovery changes)')
    .action(
      action(async (id: string) => {
        const { refreshCandidates, printCandidate } = await import('../candidates');
        refreshCandidates(id).candidates.forEach((c) => printCandidate(c));
      }),
    );

  cands
    .command('skip <videoId> <candidateId>')
    .action(
      action(async (id: string, cid: string) => {
        const { setCandidateStatus } = await import('../candidates');
        setCandidateStatus(id, cid, 'skipped');
        console.log(`skipped ${cid}`);
      }),
    );

  cands
    .command('clear <videoId>')
    .description('Remove all candidates that were not made into clips')
    .action(
      action(async (id: string) => {
        const { loadCandidates, saveCandidates } = await import('../candidates');
        const f = loadCandidates(id);
        f.candidates = f.candidates.filter((c) => c.status === 'made');
        saveCandidates(f);
        console.log(`kept ${f.candidates.length} made candidates`);
      }),
    );

  program
    .command('make <videoId> <candidateId>')
    .description('Turn a candidate into an editable clip')
    .option('--no-split', 'skip the automatic split; keep the full-frame blur/crop for events, IRL or no clean facecam')
    .action(
      action(async (id: string, cid: string, o: { split: boolean }) => {
        const { makeClip } = await import('../candidates');
        const clipId = await makeClip(id, cid, { split: o.split });
        console.log(`${clipId}\n${STUDIO}/#/clip/${clipId}`);
      }),
    );

  // ---------- clips ----------

  program
    .command('clips')
    .description('List clip projects')
    .action(
      action(async () => {
        const { listClips, loadProject } = await import('../core/project');
        const fs = await import('node:fs');
        const { paths } = await import('../core/paths');
        for (const id of listClips()) {
          const p = loadProject(id);
          const seg = p.segments[0];
          const exported = fs.existsSync(`${paths.exports}/${id}.mp4`) ? 'exported' : '';
          console.log(`${p.title}  (${id})  ${fmtTime(seg.startMs)}–${fmtTime(seg.endMs)}  ${String(p.markers.length).padStart(2)} markers  ${exported}`);
        }
      }),
    );

  program
    .command('show <clipId>')
    .description('Print a clip project as JSON')
    .action(
      action(async (clipId: string) => {
        const { loadProject } = await import('../core/project');
        console.log(JSON.stringify(loadProject(clipId), null, 2));
      }),
    );

  program
    .command('trim <clipId>')
    .description('Set the clip in/out points (source time; "+3" = 3 s after the current in-point)')
    .option('--in <time>')
    .option('--out <time>')
    .action(
      action(async (clipId: string, o: { in?: string; out?: string }) => {
        const { loadProject, saveProject } = await import('../core/project');
        const p = loadProject(clipId);
        const seg = p.segments[0];
        const inMs = o.in ? parseTime(o.in, seg.startMs) : seg.startMs;
        const outMs = o.out ? parseTime(o.out, seg.startMs) : seg.endMs;
        if (outMs - inMs < 1000) throw new Error('out must be at least 1 s after in');
        if (inMs < 0 || outMs > p.sourceDurationMs) throw new Error('outside the video');
        p.segments = [{ startMs: inMs, endMs: outMs }];
        saveProject(p);
        console.log(`${clipId}: ${fmtTime(inMs)}–${fmtTime(outMs)} (${((outMs - inMs) / 1000).toFixed(1)} s)`);
      }),
    );

  program
    .command('set <clipId> <assignments...>')
    .description('Change clip settings, e.g. `clip set X captions.style=boxed framing.mode=crop framing.cropX=0.4 title="New"`')
    .action(
      action(async (clipId: string, assignments: string[]) => {
        const { loadProject, saveProject } = await import('../core/project');
        const p = loadProject(clipId) as unknown as Record<string, unknown>;
        for (const a of assignments) {
          const i = a.indexOf('=');
          if (i < 1) throw new Error(`Expected key=value, got "${a}"`);
          const keys = a.slice(0, i).split('.');
          if (!['title', 'captions', 'framing'].includes(keys[0])) throw new Error(`Only title, captions.* and framing.* can be set here`);
          let v: unknown = a.slice(i + 1);
          try {
            v = JSON.parse(v as string);
          } catch {}
          let obj = p;
          for (const k of keys.slice(0, -1)) obj = obj[k] as Record<string, unknown>;
          obj[keys[keys.length - 1]] = v;
        }
        saveProject(p as never); // schema-validated
        console.log('saved');
      }),
    );

  program
    .command('caption-fix <clipId> <word> <text>')
    .description('Correct a caption word by its index (#123) or time (14:50.2). Use "" to hide the word.')
    .action(
      action(async (clipId: string, word: string, text: string) => {
        const { loadProject, saveProject } = await import('../core/project');
        const { loadTranscript } = await import('../ingest/ingest');
        const p = loadProject(clipId);
        let idx: number;
        if (/^#?\d+$/.test(word) && !word.includes(':')) idx = Number(word.replace('#', ''));
        else {
          const ms = parseTime(word);
          const w = loadTranscript(p.videoId).words.reduce((a, b) => (Math.abs(b.startMs - ms) < Math.abs(a.startMs - ms) ? b : a));
          idx = w.i;
        }
        const w = loadTranscript(p.videoId).words[idx];
        if (!w) throw new Error(`No word #${idx}`);
        p.captions.fixes[String(idx)] = text;
        saveProject(p);
        console.log(`#${idx} at ${fmtTime(w.startMs)}: "${w.text}" → "${text}"`);
      }),
    );

  program
    .command('subtitles <clipId>')
    .description('Subtitle expert: whether captions belong, the right style/position, and word-level fixes; applies them by default')
    .option('--review', 'only review; do not change the clip')
    .option('--force', 'overwrite existing word fixes')
    .option('--no-settings', 'word fixes only: leave the caption look and on/off as they are (after a decision made from the frames)')
    .option('--enable', 'allow turning captions back on when they are off')
    .option('--json', 'print the full review as JSON')
    .action(
      action(async (clipId: string, o: { review?: boolean; force?: boolean; settings: boolean; enable?: boolean; json?: boolean }) => {
        const { reviewSubtitles, applySubtitleFixes } = await import('../edit/subtitles');
        const applied = o.review ? undefined : await applySubtitleFixes(clipId, { force: !!o.force, settings: o.settings, enable: !!o.enable });
        const r = applied?.review ?? (await reviewSubtitles(clipId));
        if (o.json) {
          console.log(JSON.stringify(applied ? { ...r, applied: applied.applied, changed: applied.changed, kept: applied.kept } : r, null, 2));
          return;
        }
        const d = r.decision;
        console.log(
          `engine says: captions ${d.enabled ? 'ON' : 'OFF'} · ${d.style} · y ${d.position.toFixed(2)} · ${d.uppercase ? 'uppercase' : 'sentence case'} · ${d.fontSize}px`,
        );
        console.log(`  ${d.why}`);
        for (const risk of d.risks) console.log(`  risk: ${risk}`);
        console.log(`${r.score}/100 · ${r.verdict} · ${r.stats.words} words · ${r.stats.hidden} hidden · ${r.issues.length} notes on words`);
        for (const i of r.issues.slice(0, 20)) {
          console.log(`  #${i.wordIndex} ${fmtTime(i.startMs)}  "${i.text}" → ${i.fix === '' ? '(hide)' : `"${i.fix}"`}  [${i.kind}] ${i.why}`);
        }
        if (applied) {
          console.log(`applied ${applied.applied} word fix${applied.applied === 1 ? '' : 'es'}${applied.changed.length ? `; changed ${applied.changed.join(', ')}` : '; caption settings unchanged'}`);
          for (const k of applied.kept) console.log(`  kept: ${k}`);
        }
      }),
    );

  // ---------- markers ----------

  program
    .command('credit <clipId>')
    .description('Name the creator on screen for the whole clip. New clips have it already; this adds it to an older clip, changes what it says, or takes it off')
    .option('--text <text>', 'what it says (default: twitch.tv/<login>, or youtube.com/@<channel>)')
    .option('--label <label>', 'the platform badge before it (default: ▶ YouTube / 🎮 Twitch)')
    .option('--remove', 'take the credit off this clip (QA then fails the export, unless channel.json turns the credit off)')
    .action(
      action(async (clipId: string, o: { text?: string; label?: string; remove?: boolean }) => {
        const { setCredit, CREDIT } = await import('../core/project');
        const p = await setCredit(clipId, o);
        const m = p.markers.find((x) => x.type === CREDIT);
        console.log(m ? `credit on ${clipId}: ${String(m.params.label ?? '🎥')} ${String(m.params.text)}` : `no credit on ${clipId}`);
      }),
    );

  program
    .command('intro <clipId>')
    .description('Show or set the short premise line that sits in the hook text (4–8 words, explains the clip)')
    .option('--text <text>', 'the line; omit to print the current one')
    .action(
      action(async (clipId: string, o: { text?: string }) => {
        const { setIntro } = await import('../core/project');
        const r = await setIntro(clipId, o);
        const text = r.current ?? (r.marker ? String((r.marker.params as Record<string, unknown>).text) : undefined);
        console.log(text ? `intro on ${clipId}: ${text}` : `no intro on ${clipId}`);
      }),
    );

  const marker = program.command('marker').description('Add, list, change and remove markers');

  marker
    .command('types')
    .description('List marker types and their parameters')
    .action(
      action(async () => {
        const { loadMarkerSchemas } = await import('../markers/registry-node');
        const { z } = await import('zod');
        let n = 1;
        for (const t of (await loadMarkerSchemas()).values()) {
          console.log(`${n++}. ${t.type} (${t.kind}, ${t.layer}): ${t.description}`);
          const js = z.toJSONSchema(t.params) as { properties?: Record<string, Record<string, unknown>> };
          for (const [k, s] of Object.entries(js.properties ?? {})) {
            const range = s.enum ? (s.enum as string[]).join('|') : s.minimum !== undefined ? `${s.minimum}–${s.maximum}` : s.type;
            console.log(`     ${k} = ${JSON.stringify(s.default)}  (${range})${s.description ? `  ${s.description}` : ''}`);
          }
        }
      }),
    );

  marker
    .command('list <clipId>')
    .action(
      action(async (clipId: string) => {
        const { loadProject } = await import('../core/project');
        const p = loadProject(clipId);
        const inMs = p.segments[0].startMs;
        if (!p.markers.length) console.log('no markers');
        for (const m of p.markers) {
          const when = m.endMs !== undefined ? `${fmtTime(m.startMs)}–${fmtTime(m.endMs)}` : fmtTime(m.startMs);
          console.log(`${m.id}  ${m.type.padEnd(6)} ${when.padEnd(18)} (+${((m.startMs - inMs) / 1000).toFixed(2)} s)  ${JSON.stringify(m.params)}`);
        }
      }),
    );

  marker
    .command('add <clipId> <type>')
    .description('Add a marker. Times are source time (14:50.2) or "+3.5" = seconds after the clip in-point')
    .requiredOption('--at <time>', 'start')
    .option('--to <time>', 'end (spans only; default length otherwise)')
    .option('--param <key=value>', 'parameter (repeatable)', collect)
    .option('--params <json>', 'parameters as JSON')
    .action(
      action(async (clipId: string, type: string, o: { at: string; to?: string; param?: string[]; params?: string }) => {
        const { addMarker, loadProject } = await import('../core/project');
        const inMs = loadProject(clipId).segments[0].startMs;
        const { marker: m } = await addMarker(clipId, {
          type,
          startMs: parseTime(o.at, inMs),
          endMs: o.to ? parseTime(o.to, inMs) : undefined,
          params: parseParams(o.param, o.params),
        });
        console.log(`${m.id}  ${m.type} at ${fmtTime(m.startMs)}${m.endMs ? `–${fmtTime(m.endMs)}` : ''}  ${JSON.stringify(m.params)}`);
      }),
    );

  marker
    .command('update <clipId> <markerId>')
    .option('--at <time>')
    .option('--to <time>')
    .option('--param <key=value>', 'parameter (repeatable)', collect)
    .option('--params <json>')
    .action(
      action(async (clipId: string, id: string, o: { at?: string; to?: string; param?: string[]; params?: string }) => {
        const { updateMarker, loadProject } = await import('../core/project');
        const inMs = loadProject(clipId).segments[0].startMs;
        const { marker: m } = await updateMarker(clipId, id, {
          startMs: o.at ? parseTime(o.at, inMs) : undefined,
          endMs: o.to ? parseTime(o.to, inMs) : undefined,
          params: o.param || o.params ? parseParams(o.param, o.params) : undefined,
        });
        console.log(`${m.id}  ${m.type} at ${fmtTime(m.startMs)}${m.endMs ? `–${fmtTime(m.endMs)}` : ''}  ${JSON.stringify(m.params)}`);
      }),
    );

  marker
    .command('rm <clipId> <markerId>')
    .action(
      action(async (clipId: string, id: string) => {
        const { removeMarker } = await import('../core/project');
        removeMarker(clipId, id);
        console.log(`removed ${id}`);
      }),
    );

  program
    .command('markers-gen', { hidden: true })
    .description('Regenerate markers/index.generated.ts')
    .action(
      action(async () => {
        const { generateMarkerIndex } = await import('../markers/registry-node');
        console.log(generateMarkerIndex() ? 'updated markers/index.generated.ts' : 'up to date');
      }),
    );

  program
    .command('suggest-cuts <clipId>')
    .description('Propose jump cuts on dead air (pauses between words); accept them in the Studio or with `clip accept`')
    .option('--min-gap <ms>', 'shortest pause to cut', '700')
    .option('--keep <ms>', 'breath kept at each side', '120')
    .action(
      action(async (clipId: string, o: { minGap: string; keep: string }) => {
        const { loadProject, saveProject } = await import('../core/project');
        const { suggestSilenceCuts } = await import('../edit/suggest');
        const p = loadProject(clipId);
        const cuts = await suggestSilenceCuts(p, { minGapMs: Number(o.minGap), keepMs: Number(o.keep) });
        p.markers = [...p.markers, ...cuts].sort((a, b) => a.startMs - b.startMs);
        saveProject(p);
        const saved = cuts.reduce((a, c) => a + (c.endMs! - c.startMs), 0);
        console.log(`proposed ${cuts.length} cuts, removing ${(saved / 1000).toFixed(1)} s of dead air`);
      }),
    );

  program
    .command('autoedit <clipIds...>')
    .description('First-pass edit as proposed markers: hook text, punchline zoom/boom/flash, dead-air cuts, caption fixes')
    .option('--accept', 'add the edits as accepted, not proposed')
    .option('--reframe', 'also track faces and switch to crop framing')
    .option('--no-cuts', "don't propose dead-air cuts")
    .option('--preset <name>', 'apply this preset first')
    .option('--style <name>', 'clean | punch | hype | story (default punch); `clip styles` lists them')
    .action(
      action(async (clipIds: string[], o: { accept?: boolean; reframe?: boolean; cuts: boolean; preset?: string; style?: string }) => {
        const { autoEdit, printAutoEdit } = await import('../edit/autoedit');
        for (const id of clipIds) printAutoEdit(await autoEdit(id, { accept: !!o.accept, reframe: !!o.reframe, cuts: o.cuts ? undefined : false, preset: o.preset, style: o.style }));
      }),
    );

  program
    .command('editors <clipId>')
    .description('Meme and expert editors review a clip and add their edits to it as proposed markers (captions and the review note are left alone)')
    .option('--meme', 'meme editor only')
    .option('--expert', 'expert editor only')
    .option('--review', 'only review; do not add the suggestions to the clip')
    .option('--accept', 'add them accepted, not proposed')
    .option('--json', 'print the full reviews as JSON')
    .action(
      action(async (clipId: string, o: { meme?: boolean; expert?: boolean; review?: boolean; accept?: boolean; json?: boolean }) => {
        const { reviewClip, applyEditorSuggestions } = await import('../edit/editors');
        const modes: EditorMode[] = o.meme && !o.expert ? ['meme'] : o.expert && !o.meme ? ['expert'] : ['meme', 'expert'];
        const reviews = [];
        for (const mode of modes) {
          if (!o.review) {
            const { review, added, skipped } = await applyEditorSuggestions(clipId, mode, { accept: !!o.accept });
            reviews.push(review);
            if (!o.json) console.log(`${mode}  added ${added} ${o.accept ? 'accepted' : 'proposed'} marker${added === 1 ? '' : 's'} to the clip${skipped ? ` (${skipped} skipped: an edit is already there)` : ''}`);
          } else reviews.push(await reviewClip(clipId, mode));
        }
        if (o.json) {
          console.log(JSON.stringify(reviews, null, 2));
          return;
        }
        for (const r of reviews) {
          console.log(`${r.mode.padEnd(6)} fit ${String(r.score).padStart(3)}/100  ${r.summary}`);
          for (const s of r.suggestions) {
            const at = fmtTime(s.startMs);
            const span = s.endMs !== undefined ? `–${fmtTime(s.endMs)}` : '';
            console.log(`  + ${s.type.padEnd(7)} ${at}${span}  ${s.why}`);
          }
          for (const n of r.notes) console.log(`  → ${n}`);
          if (r.risks.length) console.log(`  risks: ${r.risks.join('; ')}`);
        }
      }),
    );

  program
    .command('censor <clipIds...>')
    .description('Bleep what the clip says that must not be heard: every slur, and the f-words in its first 3 s (--swears all: every strong swear). Captions mask the text by themselves; render again after')
    .option('--swears <scope>', 'open (the f-words in the first 3 s), all (every strong swear) or none (slurs only)', 'open')
    .option('--mute', 'silence only, no bleep tone')
    .option('--propose', 'add the bleeps as proposed markers for the reviewer to accept')
    .option('--review', 'only say what it would bleep')
    .option('--json')
    .action(
      action(async (clipIds: string[], o: { swears: string; mute?: boolean; propose?: boolean; review?: boolean; json?: boolean }) => {
        const { censorClip } = await import('../edit/censor');
        const { maskSwearing } = await import('../core/risk');
        if (!['open', 'all', 'none'].includes(o.swears)) throw new Error('--swears is open, all or none');
        const out = [];
        for (const id of clipIds) {
          const r = await censorClip(id, { swears: o.swears as 'open' | 'all' | 'none', sound: o.mute ? 'mute' : 'tone', propose: !!o.propose, review: !!o.review });
          out.push(r);
          if (o.json) continue;
          const words = r.hits.map((h) => `"${maskSwearing(h.word)}" at ${fmtTime(h.atMs, 1)} (${h.why})`).join(', ');
          const verb = o.review ? 'would bleep' : o.propose ? 'proposed bleeps over' : 'bleeped';
          console.log(r.hits.length ? `${id}: ${verb} ${r.hits.length} word${r.hits.length === 1 ? '' : 's'} in ${r.spans.length} span${r.spans.length === 1 ? '' : 's'}: ${words}` : `${id}: nothing to bleep`);
          if (r.replaced && !o.review) console.log(`  replaced ${r.replaced} bleep${r.replaced === 1 ? '' : 's'} from the last pass`);
          if (r.saved && !o.review && !o.propose) console.log(`  render again for the export to have it: ./clip render ${id}`);
        }
        if (o.json) console.log(JSON.stringify(out, null, 2));
      }),
    );

  program
    .command('post <clipId>')
    .description('Show the post text (title, caption, hashtags); set any part with the options ("" goes back to the suggestion)')
    .option('--title <text>')
    .option('--caption <text>')
    .option('--hashtags <text>')
    .action(
      action(async (clipId: string, o: { title?: string; caption?: string; hashtags?: string }) => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { loadProject, saveProject, suggestedPost } = await import('../core/project');
        const { postFor, postFile } = await import('../core/post');
        const { paths } = await import('../core/paths');
        let p = loadProject(clipId);
        if (o.title !== undefined || o.caption !== undefined || o.hashtags !== undefined) {
          const next = { ...p.post };
          for (const k of ['title', 'caption', 'hashtags'] as const) if (o[k] !== undefined) next[k] = o[k]!.trim() || undefined;
          p = saveProject({ ...p, post: Object.values(next).some(Boolean) ? next : undefined });
        }
        const suggestion = suggestedPost(p);
        if (suggestion.titles?.length) console.log(`title options:\n${suggestion.titles.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}\n`);
        const text = postFile(postFor(p.post, suggestion));
        if (fs.existsSync(path.join(paths.exports, `${clipId}.mp4`))) fs.writeFileSync(path.join(paths.exports, `${clipId}.txt`), text);
        console.log(text);
      }),
    );

  program
    .command('duplicate <clipId>')
    .description('Copy a clip (…-v2) to try a different edit; review state and exports are not copied')
    .action(
      action(async (clipId: string) => {
        const { duplicateClip } = await import('../candidates');
        const id = duplicateClip(clipId);
        console.log(`${id}  ${STUDIO}/#/clip/${id}`);
      }),
    );

  program
    .command('delete <clipId>')
    .description('Delete a clip: project and exports move to clips/.trash/, and its candidate can be made again')
    .action(
      action(async (clipId: string) => {
        const { deleteClip } = await import('../candidates');
        console.log(`moved to ${deleteClip(clipId).trash}`);
      }),
    );

  program
    .command('styles')
    .description('List the edit styles autoedit can apply')
    .action(
      action(async () => {
        const { STYLES } = await import('../edit/styles');
        for (const st of STYLES) console.log(`${st.key.padEnd(7)} ${st.label}: ${st.description}`);
      }),
    );

  program
    .command('reframe <clipId>')
    .description('Track faces and propose reframe markers so the 9:16 crop follows the speaker, for the whole clip or --from/--to a range')
    .option('--accept', 'add them as accepted, not proposed')
    .option('--from <time>', 'only this range (source time, or +s after the in-point)')
    .option('--to <time>', 'end of the range')
    .action(
      action(async (clipId: string, o: { accept?: boolean; from?: string; to?: string }) => {
        const { autoReframe } = await import('../reframe/apply');
        const { loadProject } = await import('../core/project');
        const inMs = loadProject(clipId).segments[0].startMs;
        const range = o.from || o.to ? { startMs: o.from ? parseTime(o.from, inMs) : inMs, endMs: o.to ? parseTime(o.to, inMs) : Infinity } : undefined;
        const r = await autoReframe(clipId, { accept: !!o.accept, range, log: console.log });
        if ('split' in r && r.split) console.log('using the split facecam/gameplay layout');
        else console.log(`${o.accept ? 'added' : 'proposed'} ${r.keyframes} reframe keyframes (${r.cuts} cuts); faces in ${r.faces}/${r.samples} samples`);
      }),
    );

  program
    .command('split <clipId>')
    .description('Find the facecam and switch the clip to the split layout: facecam on top, gameplay below')
    .option('--detector <name>', 'hybrid (default), insightface or vision', process.env.CLIP_FACE_DETECTOR ?? 'hybrid')
    .action(
      action(async (clipId: string, o: { detector: string }) => {
        const { detectSplit } = await import('../reframe/split');
        const { loadProject } = await import('../core/project');
        const r = await detectSplit(clipId, { log: console.log, detector: o.detector as 'insightface' | 'vision' });
        if (!r.found) {
          console.log(`no stable facecam found (${r.reason ?? 'no face'}); framing unchanged`);
          return;
        }
        const b = loadProject(clipId).framing.split;
        const fmt = (v: number) => v.toFixed(2);
        console.log(`split layout: cam ${fmt(b.cam.x)},${fmt(b.cam.y)} ${fmt(b.cam.w)}×${fmt(b.cam.h)} · game ${fmt(b.game.x)},${fmt(b.game.y)} ${fmt(b.game.w)}×${fmt(b.game.h)} · cam band ${Math.round(b.camShare * 100)}%`);
      }),
    );

  program
    .command('accept <clipId> [markerIds...]')
    .description('Accept proposed markers (all of them, or the ones listed)')
    .option('--reject', 'remove them instead')
    .action(
      action(async (clipId: string, ids: string[], o: { reject?: boolean }) => {
        const { loadProject, saveProject } = await import('../core/project');
        const p = loadProject(clipId);
        const { acceptProposals, rejectProposals } = await import('../core/proposals');
        const n = p.markers.filter((m) => m.proposed && (!ids.length || ids.includes(m.id))).length;
        saveProject(o.reject ? rejectProposals(p, ids) : acceptProposals(p, ids));
        console.log(`${o.reject ? 'rejected' : 'accepted'} ${n} marker${n === 1 ? '' : 's'}`);
      }),
    );

  // ---------- presets ----------

  const preset = program.command('preset').description('Save a clip’s look and apply it to other clips');

  preset.command('list').action(
    action(async () => {
      const { listPresets } = await import('../core/project');
      console.log(listPresets().join('\n') || '(no presets)');
    }),
  );

  preset
    .command('save <clipId> <name>')
    .description('Save markers (relative to the clip edges), caption style and framing')
    .action(
      action(async (clipId: string, name: string) => {
        const { loadProject, presetFromProject, presetFile } = await import('../core/project');
        const { writeJson } = await import('../core/paths');
        const pr = presetFromProject(loadProject(clipId), name);
        writeJson(presetFile(name), pr);
        console.log(`saved preset ${name} (${pr.markers.length} markers)`);
      }),
    );

  preset
    .command('apply <name> <clipId>')
    .option('--add', 'keep existing markers instead of replacing them')
    .action(
      action(async (name: string, clipId: string, o: { add?: boolean }) => {
        const { loadProject, saveProject, loadPreset, applyPreset } = await import('../core/project');
        const p = await applyPreset(loadProject(clipId), loadPreset(name), o.add ? 'add' : 'replace');
        saveProject(p);
        console.log(`applied ${name} to ${clipId} (${p.markers.length} markers)`);
      }),
    );

  // ---------- batch ----------

  program
    .command('batch <inputs...>')
    .description('Links, a file of links, or a channel/playlist URL → judged, edited, rendered, QA\'d clips in the review queue')
    .option('--lens <name>', 'judging lens', 'podcast-general')
    .option('--per-video <n>', 'clips to make per video', '5')
    .option('--judge <how>', 'claude (headless Claude Code) or none (stop after discovery)', 'claude')
    .option('--no-autoedit', 'skip the automatic first-pass edit')
    .option('--reframe', 'track faces and crop to the speaker')
    .option('--style <style>', 'edit style for the first pass: clean, punch, hype or story (`clip styles`)', 'punch')
    .option('--no-render', "don't render")
    .option('--limit <n>', 'videos to take from a channel or playlist', '5')
    .action(
      action(
        async (
          inputs: string[],
          o: { lens: string; perVideo: string; judge: string; autoedit: boolean; reframe?: boolean; style: string; render: boolean; limit: string },
        ) => {
          const { startBatch } = await import('../jobs/batch');
          const { STYLES } = await import('../edit/styles');
          if (!STYLES.some((st) => st.key === o.style)) throw new Error(`no style "${o.style}"; try ${STYLES.map((st) => st.key).join(', ')}`);
          const batch = { lens: o.lens, perVideo: Number(o.perVideo), judge: o.judge as 'claude' | 'none', autoedit: o.autoedit, reframe: !!o.reframe, style: o.style, render: o.render };
          const { batchId, videos } = await startBatch(inputs, batch, Number(o.limit));
          console.log(`batch ${batchId}: ${videos.length} video${videos.length > 1 ? 's' : ''} queued (${o.perVideo} clips each, lens ${o.lens}, judge ${o.judge})`);
          console.log(`follow it: ./clip batch-status ${batchId}   ·   review: http://localhost:4400/#/review`);
        },
      ),
    );

  program
    .command('batch-continue [batchId]')
    .description('After judging by hand (/clip in a session), carry a batch on: make the top clips, then edit, render and QA them')
    .action(
      action(async (batchId?: string) => {
        const { jobsDb, listJobs } = await import('../jobs/queue');
        const { afterJudge } = await import('../jobs/pipeline');
        const { ensureWorker } = await import('../jobs/worker');
        const { loadCandidates } = await import('../candidates');
        const id = batchId ?? (jobsDb().prepare('SELECT id FROM batches ORDER BY createdAt DESC LIMIT 1').get() as { id: string } | undefined)?.id;
        if (!id) throw new Error('no batches');
        const jobs = listJobs({ batchId: id, limit: 2000 });
        for (const ingest of jobs.filter((j) => j.kind === 'ingest' && j.state === 'done')) {
          const v = ingest.videoId!;
          if (jobs.some((j) => j.videoId === v && j.clipId)) continue; // already carried on
          if (!loadCandidates(v).candidates.some((c) => c.status === 'new')) {
            console.log(`${v}: no candidates yet; judge it with /clip ${v}`);
            continue;
          }
          const made = await afterJudge({ ...ingest, videoId: v });
          console.log(`${v}: made ${made.length} clips → ${made.join(', ')}`);
        }
        ensureWorker();
      }),
    );

  program
    .command('batch-status [batchId]')
    .description('Where a batch is: per video and per clip, with time per clip')
    .action(
      action(async (batchId?: string) => {
        const { jobsDb, listJobs } = await import('../jobs/queue');
        const id = batchId ?? (jobsDb().prepare('SELECT id FROM batches ORDER BY createdAt DESC LIMIT 1').get() as { id: string } | undefined)?.id;
        if (!id) return console.log('no batches yet');
        const jobs = listJobs({ batchId: id, limit: 2000 }).reverse();
        const secs = (j: { startedAt: string | null; finishedAt: string | null }) => (j.startedAt && j.finishedAt ? (Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000 : 0);
        const videos = [...new Set(jobs.map((j) => j.videoId).filter(Boolean))] as string[];
        console.log(`batch ${id}`);
        for (const v of videos) {
          const vj = jobs.filter((j) => j.videoId === v);
          const stage = (k: string) => {
            const j = vj.filter((x) => x.kind === k).pop();
            return j ? `${k} ${j.state}${j.state === 'running' && j.progress ? ` (${j.progress.slice(0, 40)})` : ''}` : null;
          };
          console.log(`\n${v}: ${['ingest', 'discover', 'judge'].map(stage).filter(Boolean).join(' → ')}`);
          const clips = [...new Set(vj.map((j) => j.clipId).filter(Boolean))] as string[];
          for (const c of clips) {
            const cj = vj.filter((j) => j.clipId === c);
            const last = cj[cj.length - 1];
            const t = cj.reduce((a, j) => a + secs(j), 0);
            const qa = cj.find((j) => j.kind === 'qa' && j.state === 'done')?.result as { passed?: boolean; issues?: number } | null;
            console.log(`  ${c.padEnd(18)} ${last.kind} ${last.state}${last.state === 'failed' ? `: ${last.error?.split('\n')[0]}` : ''}  ${t.toFixed(0)} s${qa ? `  QA ${qa.passed ? 'passed' : 'FAILED'} (${qa.issues} notes)` : ''}`);
          }
        }
        const done = jobs.filter((j) => j.kind === 'qa' && j.state === 'done').length;
        const start = jobs.find((j) => j.startedAt)?.startedAt;
        const end = [...jobs].reverse().find((j) => j.finishedAt)?.finishedAt;
        const wall = start && end ? (Date.parse(end) - Date.parse(start)) / 1000 : 0;
        const perVideo = videos.map((v) => jobs.filter((j) => j.videoId === v && !j.clipId).reduce((a, j) => a + secs(j), 0));
        const perClip = jobs.filter((j) => j.clipId).reduce((a, j) => a + secs(j), 0) / Math.max(1, new Set(jobs.map((j) => j.clipId).filter(Boolean)).size);
        console.log(`\n${done} clips ready for review · wall clock ${(wall / 60).toFixed(1)} min · per video (ingest+judge) ${(perVideo.reduce((a, b) => a + b, 0) / Math.max(1, perVideo.length) / 60).toFixed(1)} min · per clip (edit+render+QA) ${perClip.toFixed(0)} s`);
        const failed = jobs.filter((j) => j.state === 'failed');
        if (failed.length) console.log(`${failed.length} failed jobs: ./clip jobs --retry <id>`);
      }),
    );

  // ---------- review & learning ----------

  program
    .command('review <clipId> <decision>')
    .description('Record a review decision: approve | reject | changes | submit (send for review)')
    .option('--note <text>', 'what to change, or why')
    .option('--reason <list>', 'why it was rejected or sent back, comma-separated: boring, layout, cut, title, context')
    .option('--adult', '18+: upload it age-restricted on YouTube (default: what the 18+ check in QA found)')
    .option('--no-adult', 'not 18+, whatever the 18+ check found')
    .action(
      action(async (clipId: string, decision: string, o: { note?: string; reason?: string; adult?: boolean }) => {
        const map: Record<string, 'approved' | 'rejected' | 'changes' | 'review'> = { approve: 'approved', reject: 'rejected', changes: 'changes', submit: 'review' };
        if (!map[decision]) throw new Error('decision must be approve, reject, changes or submit');
        const { setReview, parseReasons } = await import('../review');
        const reasons = parseReasons(o.reason);
        if (reasons && map[decision] !== 'rejected' && map[decision] !== 'changes') throw new Error('--reason goes with reject or changes');
        const p = setReview(clipId, map[decision], o.note, reasons, o.adult);
        console.log(`${clipId}: ${map[decision]}${reasons ? ` [${reasons.join(', ')}]` : ''}${p.review?.adult ? ' 18+' : ''}${o.note ? ` (${o.note})` : ''}`);
      }),
    );

  program
    .command('adult [clipIds...]')
    .description('The 18+ check: sexual content in a clip (said, chat, the queue experts, NudeNet on stills); stored in its QA report for the review page')
    .option('--review', 'every clip waiting in To review')
    .option('--json', 'print JSON')
    .action(
      action(async (ids: string[], o: { review?: boolean; json?: boolean }) => {
        const { recheckAdult } = await import('../qa/adult');
        const { reviewQueue } = await import('../review');
        const list = [...ids, ...(o.review ? reviewQueue().filter((q) => q.review.status === 'review' && q.exported).map((q) => q.id) : [])];
        if (!list.length) throw new Error('name clips or pass --review');
        for (const id of list) {
          const a = await recheckAdult(id);
          if (o.json) {
            console.log(JSON.stringify({ clipId: id, adult: a }));
            continue;
          }
          if (!a) {
            console.log(`${id}: no QA report (render it first)`);
            continue;
          }
          console.log(`${id}: ${a.detected ? '18+' : 'not 18+'} (${a.points} points)${a.reasons.length ? `: ${a.reasons.join('; ')}` : ''}`);
          console.log(`  looked at ${a.looked.words} words, ${a.looked.chatters ?? 'no'} chatters, ${a.looked.stills ?? 'no'} stills${a.looked.experts ? ', the experts\' ledger' : ''}${a.missing.length ? `; missing: ${a.missing.join(', ')}` : ''}`);
        }
      }),
    );

  program
    .command('unsafe [clipIds...]')
    .description('The never-post check (nudity, a slur said, a minor, a sexual title): what the publishers refuse, approved or not')
    .option('--review', 'every clip waiting in To review or sent back for changes')
    .option('--approved', 'every approval not uploaded yet')
    .option('--look', 'run the 18+ check on the frames first where it never looked (NudeNet, a few seconds a clip)')
    .option('--save', "store it in each clip's QA report, as a render would (the review page shows it as ✖ unsafe)")
    .option('--json', 'print JSON')
    .action(
      action(async (ids: string[], o: { review?: boolean; approved?: boolean; look?: boolean; save?: boolean; json?: boolean }) => {
        const { neverPost, recheckUnsafe } = await import('../qa/unsafe');
        const { listReviews } = await import('../review/db');
        const rows = listReviews();
        const list = [
          ...ids,
          ...(o.review ? rows.filter((r) => r.status === 'review' || r.status === 'changes').map((r) => r.clipId) : []),
          ...(o.approved ? rows.filter((r) => r.status === 'approved' && r.uploadStatus !== 'uploaded').map((r) => r.clipId) : []),
        ];
        if (!list.length) throw new Error('name clips, or pass --review or --approved');
        let hit = 0;
        for (const id of [...new Set(list)]) {
          let reasons;
          try {
            if (o.save) await recheckUnsafe(id);
            reasons = await neverPost(id, { look: !!o.look });
          } catch (e) {
            console.log(o.json ? JSON.stringify({ clipId: id, error: (e as Error).message }) : `${id}: not checked (${(e as Error).message.split('\n')[0]})`);
            continue;
          }
          if (reasons.length) hit++;
          if (o.json) console.log(JSON.stringify({ clipId: id, reasons }));
          else if (reasons.length) console.log(`${id}: never posted\n${reasons.map((r) => `  ${r.kind}: ${r.why}`).join('\n')}`);
        }
        if (!o.json) console.log(`${hit} of ${new Set(list).size} would be refused`);
      }),
    );

  program
    .command('reviews')
    .description('The review/approval database the uploader reads: status, picked, upload, link')
    .option('--status <status>', 'review | approved | rejected | changes')
    .option('--json', 'print JSON')
    .action(
      action(async (o: { status?: string; json?: boolean }) => {
        const { listReviews } = await import('../review/db');
        const rows = listReviews(o.status as never);
        if (o.json) return console.log(JSON.stringify(rows, null, 2));
        for (const r of rows) {
          console.log(`${r.title}  (${r.clipId})  ${r.status.padEnd(8)}  picked=${r.picked}  ${r.uploadStatus ?? '-'}  ${r.youtubeUrl ?? ''}`);
        }
      }),
    );

  program
    .command('stats')
    .description('What gets approved and performs: by lens, queue expert, niche, quality, virality, verdict, delivery, platform and signal')
    .option('--json', 'print JSON')
    .action(
      action(async (o: { json?: boolean }) => {
        const { stats } = await import('../review');
        const s = stats();
        if (o.json) return console.log(JSON.stringify(s, null, 2));
        console.log(`${s.decisions} decisions, ${s.approved} approved${s.imported ? `, ${s.imported} performance rows imported` : ''}`);
        if (s.turnedDown) {
          console.log(`\nwhy ${s.turnedDown} were rejected or sent back`);
          for (const r of s.byReason) console.log(`  ${r.label.padEnd(24)} ${String(r.clips).padStart(3)} clips  ${String(r.share).padStart(3)}%`);
        }
        const table = (title: string, rows: { key: string; clips: number; approvalRate: number; medianViews: number | null; medianOutcome?: number | null }[]) => {
          if (!rows.length) return;
          console.log(`\n${title}`);
          for (const r of rows.sort((a, b) => b.clips - a.clips))
            console.log(
              `  ${r.key.padEnd(24)} ${String(r.clips).padStart(3)} clips  ${String(r.approvalRate).padStart(3)}% approved${r.medianViews !== null ? `  median ${r.medianViews} views` : ''}${r.medianOutcome !== null && r.medianOutcome !== undefined ? `  outcome ${r.medianOutcome}` : ''}`,
            );
        };
        table('by lens', s.byLens);
        table('by queue expert', s.byKind);
        table('by niche', s.byNiche);
        table('by quality score', s.byScore);
        table('by virality', s.byVirality);
        table('by verdict', s.byVerdict);
        table('by delivery', s.byDelivery);
        table('by platform', s.byPlatform);
        table('by signal', s.bySignal);
        if (s.calibration.n)
          console.log(
            `\ncalibration (${s.calibration.n} with outcomes): virality ρ=${s.calibration.virality ?? '—'} · quality ρ=${s.calibration.quality ?? '—'} · signal ρ=${s.calibration.convergence ?? '—'}`,
          );
        if (s.notes.length) console.log(`\nreviewer notes:\n${s.notes.map((n) => `  ${n.clipId} (${n.status}): ${n.note}`).join('\n')}`);
      }),
    );

  program
    .command('perf-import <csv>')
    .description('Import posted-clip numbers: CSV with clipId,platform,views[,avgViewPct][,likes]')
    .action(
      action(async (csv: string) => {
        const { importPerformance } = await import('../review');
        console.log(`imported ${importPerformance(csv)} rows`);
      }),
    );

  // ---------- render & studio ----------

  program
    .command('render <clipId>')
    .description('Render exports/<clipId>.mp4 (1080×1920, H.264/AAC)')
    .option('--wait', 'wait for the video download if it is still running')
    .option('--keep-layout', 'a split whose camera band has no face is reported, not switched to blur-fit')
    .action(
      action(async (clipId: string, o: { wait?: boolean; keepLayout?: boolean }) => {
        const { renderClip } = await import('../render');
        await renderClip(clipId, { wait: !!o.wait, keepLayout: !!o.keepLayout });
        const { qaClip } = await import('../qa');
        const q = await qaClip(clipId);
        console.log(`QA ${q.passed ? 'passed' : 'FAILED'}${q.loudnessLufs !== null ? ` · ${q.loudnessLufs.toFixed(1)} LUFS` : ''}`);
        for (const i of q.issues) console.log(`  ${i.level === 'fail' ? '✖' : '·'} ${i.check}: ${i.detail}`);
      }),
    );

  program
    .command('auth <service>')
    .description('Connect a publishing account (youtube)')
    .action(
      action(async (service: string) => {
        if (service !== 'youtube') throw new Error(`Unknown service "${service}". Only youtube is supported.`);
        const { authYoutube } = await import('../publish/youtube');
        await authYoutube();
      }),
    );

  const tiktok = program.command('tiktok').description('Connect TikTok and upload a clip to the TikTok inbox draft');

  tiktok
    .command('auth')
    .description('Connect a TikTok account (desktop Login Kit + PKCE; needs tiktok_secrets.json)')
    .action(
      action(async () => {
        const { authTikTok } = await import('../publish/tiktok');
        const t = await authTikTok();
        console.log(`TikTok connected · open_id ${t.open_id} · scope ${t.scope}`);
      }),
    );

  tiktok
    .command('upload <clipId>')
    .description('Upload the export to the TikTok inbox as a draft; finish the post inside TikTok')
    .option('--force', 'upload again even if a TikTok record exists')
    .action(
      action(async (clipId: string, o: { force?: boolean }) => {
        const { uploadTikTokInbox } = await import('../publish/tiktok');
        const rec = await uploadTikTokInbox(clipId, { force: !!o.force, log: console.log });
        console.log(`TikTok inbox: ${rec.publishId} · ${rec.status}`);
      }),
    );

  tiktok
    .command('post <clipId>')
    .description('Direct Post as a private post (SELF_ONLY); needs video.publish and a private TikTok account')
    .option('--force', 'post again even if a direct-post record exists')
    .action(
      action(async (clipId: string, o: { force?: boolean }) => {
        const { directPostTikTok } = await import('../publish/tiktok');
        const rec = await directPostTikTok(clipId, { force: !!o.force, log: console.log });
        console.log(`TikTok direct: ${rec.publishId} · ${rec.status} · ${rec.privacy}`);
      }),
    );

  tiktok
    .command('status <publishId>')
    .description('Check a TikTok upload status')
    .action(
      action(async (publishId: string) => {
        const { tiktokStatus } = await import('../publish/tiktok');
        const r = await tiktokStatus(publishId);
        console.log(`${r.status}${r.fail ? ` · ${r.fail}` : ''}`);
      }),
    );

  program
    .command('publish <clipId>')
    .description('Publish an exported post-verdict clip to YouTube (scheduled private: +5 min, then +10, +15…)')
    .option('--privacy <status>', 'public, unlisted or private (only with --now)', 'unlisted')
    .option('--publish-at <iso>', 'schedule at this exact time instead of the next slot')
    .option('--now', 'upload immediately instead of scheduling')
    .option('--category <id>', 'YouTube category id', '20')
    .option('--force', 'publish even if the verdict or QA says not to')
    .option('--age-restricted', '18+: age-restricted on YouTube (default: the review decision)')
    .option('--no-age-restricted', 'not 18+, whatever the review decided')
    .action(
      action(async (clipId: string, o: { privacy: string; publishAt?: string; now?: boolean; category: string; force?: boolean; ageRestricted?: boolean }) => {
        const { publishYoutube } = await import('../publish/youtube');
        const rec = await publishYoutube(clipId, {
          privacy: o.privacy as 'public' | 'unlisted' | 'private',
          publishAt: o.publishAt,
          immediate: !!o.now,
          categoryId: o.category,
          force: !!o.force,
          ageRestricted: o.ageRestricted,
          log: console.log,
        });
        console.log(
          rec.heldPrivate
            ? `uploaded ${rec.url} private (18+): ${rec.heldPrivate}`
            : rec.publishAt
              ? `scheduled ${rec.url} for ${new Date(rec.publishAt).toLocaleString()} (private until then${rec.ageRestricted ? ', age-restricted' : ''})`
              : `posted ${rec.url} (${rec.privacy}${rec.ageRestricted ? ', age-restricted' : ''})`,
        );
      }),
    );

  program
    .command('analytics')
    .description('Import YouTube Analytics for published clips into the performance log')
    .option('--days <n>', 'date range ending today', '28')
    .option('--clip <id>', 'only this clip')
    .action(
      action(async (o: { days: string; clip?: string }) => {
        const { fetchPublishedAnalytics } = await import('../publish/analytics');
        const { appendPerformance } = await import('../review');
        const rows = await fetchPublishedAnalytics({ days: Number(o.days), clipId: o.clip });
        if (!rows.length) {
          console.log('no published clips yet; run `./clip publish <clipId>` first');
          return;
        }
        const usable = rows.filter((r) => r.views > 0);
        appendPerformance(
          usable.map((r) => ({
            clipId: r.clipId!,
            platform: 'youtube',
            views: r.views,
            engagedViews: r.engagedViews,
            avgViewPct: r.avgViewPct,
            avgViewDurationS: r.avgViewDurationS,
            likes: r.likes,
            comments: r.comments,
            shares: r.shares,
            subscribersGained: r.subscribersGained,
            stayedProxy: r.stayedProxy,
            outcome: r.outcome,
            importedAt: new Date().toISOString(),
          })),
        );
        for (const r of rows)
          console.log(
            r.views
              ? `${r.clipId}  views ${r.views} · engaged ${r.engagedViews} (${Math.round(r.stayedProxy * 100)}%) · avg ${r.avgViewPct.toFixed(1)}% · shares ${r.shares} · subs ${r.subscribersGained} · outcome ${r.outcome}`
              : `${r.clipId}  no analytics yet (YouTube lags 2–3 days)`,
          );
      }),
    );

  program
    .command('qa <clipId>')
    .description('Check an export: length, loudness, dead air, black frames, caption overflow, content risk')
    .action(
      action(async (clipId: string) => {
        const { qaClip } = await import('../qa');
        const q = await qaClip(clipId);
        console.log(`QA ${q.passed ? 'passed' : 'FAILED'} · ${q.durationS.toFixed(1)} s${q.loudnessLufs !== null ? ` · ${q.loudnessLufs.toFixed(1)} LUFS` : ''}`);
        for (const i of q.issues) console.log(`  ${i.level === 'fail' ? '✖' : '·'} ${i.check}: ${i.detail}`);
      }),
    );

  program
    .command('open [target]')
    .description('Open the Studio in the browser (starting it if needed): a video id → its candidates, a clip id → the editor, "review" → the review queue')
    .option('--no-browser', 'just make sure the Studio is running and print the link')
    .action(
      action(async (target: string | undefined, o: { browser: boolean }) => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { spawn } = await import('node:child_process');
        const { paths } = await import('../core/paths');
        const up = () => fetch(`${STUDIO}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
        if (!(await up())) {
          fs.mkdirSync(paths.cache, { recursive: true });
          const logFile = path.join(paths.cache, 'studio.log');
          const out = fs.openSync(logFile, 'a');
          spawn(path.join(paths.root, 'clip'), ['studio'], { cwd: paths.root, detached: true, stdio: ['ignore', out, out] }).unref();
          process.stdout.write('starting the Studio');
          const until = Date.now() + 30_000;
          while (!(await up())) {
            if (Date.now() > until) throw new Error(`the Studio didn't start; see ${logFile}`);
            process.stdout.write('.');
            await new Promise((r) => setTimeout(r, 500));
          }
          console.log(` (log: ${path.relative(process.cwd(), logFile)})`);
        }
        const hash = !target
          ? ''
          : target === 'review' || target === 'jobs'
            ? `#/${target}`
            : fs.existsSync(paths.project(target))
              ? `#/clip/${target}`
              : fs.existsSync(paths.video(target))
                ? `#/video/${target}`
                : (() => {
                    throw new Error(`"${target}" is not a video id, a clip id, "review" or "jobs"`);
                  })();
        const url = `${STUDIO}/${hash}`;
        console.log(url);
        if (o.browser) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
      }),
    );

  program
    .command('studio')
    .description('Start the Studio (candidate review + editor) on http://localhost:4400')
    .option('--port <port>', 'port', '4400')
    .action(
      action(async (o: { port: string }) => {
        const { startStudio } = await import('../studio/server');
        await startStudio(Number(o.port));
      }),
    );
}
