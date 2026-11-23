// Review and learning: decisions, 18+, the never-post check, the review list, stats and performance imports.
import type { Command } from 'commander';
import { type Action } from './shared';

export function register(program: Command, action: Action) {
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
}
