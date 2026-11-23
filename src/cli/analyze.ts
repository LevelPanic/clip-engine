// Discovery and judgment: signals, the queue checkers and their windows, the experts' ledger, curation, live and topics, stills, the judge.
import fs from 'node:fs';
import type { Command } from 'commander';
import { fmtTime, parseTime } from '../core/time';
import type { QueueKind } from '../scan/queues';
import { collect, readList, type Action } from './shared';

export function register(program: Command, action: Action) {
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
}
