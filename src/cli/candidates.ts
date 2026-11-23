// Clip candidates: list, add, score and change them, and make a clip from one.
import fs from 'node:fs';
import type { Command } from 'commander';
import { STUDIO, type Action } from './shared';

export function register(program: Command, action: Action) {
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
}
