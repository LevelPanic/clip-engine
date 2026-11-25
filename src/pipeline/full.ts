// The unattended full process, in the same order as the manual pipeline:
//   queue-check (three experts in parallel + coordinator check)
//   -> clip-extractor
//   -> clip-curator
//   -> edit
//
// Each stage is an OpenCode/DeepSeek agent reading the same skill files a human would. The watchlist
// only orchestrates and verifies; it never approves or uploads. The quick one-judge pass remains the
// path for YouTube videos/podcasts, where the manual process is the quick /clip pass.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths } from '../core/paths';
import { fmtTime } from '../core/time';
import { findOpencode } from '../judge';
import { loadCandidates } from '../candidates';
import { listReviews } from '../review/db';
import { AVOIDS, loadCuration, riskyCandidates, type CurationDecision } from '../curate';
import { setting } from '../core/config';

export interface FullPipelineOptions {
  videoId: string;
  fromMs: number;
  toMs: number;
  creator: string;
  maxKeep?: number;
  /**
   * What the community did at the moment this job is for (the watchlist's tracked moment): its time,
   * viewer clips and chat. The experts get it, so a moment viewers clipped is judged even when the
   * checkers made no queue for it.
   */
  moment?: { peakMs: number; fromMs: number; toMs: number; why: string[]; titles: string[] };
  /** Where a job left off: the last stage that finished and what it made (the watchlist's checkpoint). */
  resume?: { stage?: string; data?: Record<string, unknown> };
  /** Called as each stage finishes, so the job can record it (and resume there after a restart). */
  onStage?: (stage: PipelineStage, data: Record<string, unknown>) => void;
  log?: (s: string) => void;
}

/** The stages, in order. A job that stopped after one resumes at the next. */
export const PIPELINE_STAGES = ['queue-check', 'extract', 'curate', 'edit'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
/** The stages still to run after `lastDone` (all of them when nothing finished). Pure. */
export function stagesToRun(lastDone?: string): Set<PipelineStage> {
  const i = PIPELINE_STAGES.indexOf(lastDone as PipelineStage);
  return new Set(PIPELINE_STAGES.slice(i + 1));
}

export interface FullPipelineResult {
  clips: string[];
  note: string;
}

const logLine = (s: string) => console.log(`${new Date().toISOString()}  ${s}`);

/**
 * Run the CLI without blocking this process (a worker renews its job's lease every minute while a stage
 * runs; a blocking call would let the lease run out). A signal that was not the timeout is a restart:
 * the error says "interrupted" and the watchlist puts the job back in line.
 */
export function cli(args: string[], timeout = 30 * 60_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('./clip', args, { cwd: paths.root });
    let out = '';
    let timedOut = false;
    child.stdout?.on('data', (b) => (out += b));
    child.stderr?.on('data', (b) => (out += b));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeout);
    child.on('error', (e) => (clearTimeout(timer), reject(e)));
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (sig && !timedOut) return reject(new Error(`interrupted: ./clip ${args[0]} stopped by ${sig}`));
      resolve({ ok: code === 0, out: timedOut ? `${out}\n./clip ${args[0]} timed out` : out.trim() });
    });
  });
}

/** One run of the pipeline's model through OpenCode (its whole output is kept in .cache/full/); the last lines of what it said. */
export async function runAgent(o: { title: string; prompt: string; timeoutMs: number; log: (s: string) => void }): Promise<string> {
  const opencode = findOpencode();
  if (!opencode) throw new Error('OpenCode CLI not found');
  const model = setting('CLIP_PIPELINE_MODEL');
  const dir = path.join(paths.cache, 'full');
  fs.mkdirSync(dir, { recursive: true });
  const slug = o.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 90) || 'stage';
  const outFile = path.join(dir, `${Date.now()}-${slug}.log`);
  o.log(`${o.title}: started (${model})`);
  const child = spawn(opencode, ['run', '--model', model, '--auto', '--archived', '--title', o.title, o.prompt], {
    cwd: paths.root,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    detached: true,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout?.on('data', (b) => (stdout += b));
  child.stderr?.on('data', (b) => (stderr += b));
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }, o.timeoutMs);
  let signal: string | null = null;
  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (c, sig) => {
      signal = sig;
      resolve(c ?? 1);
    });
  });
  clearTimeout(timer);
  fs.writeFileSync(outFile, `$ ${opencode} run --model ${model} --auto ...\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  const status = timedOut ? `timeout after ${Math.round(o.timeoutMs / 60_000)}m` : `exit ${code}`;
  o.log(`${o.title}: ${status} · ${path.relative(paths.root, outFile)}`);
  if (timedOut) throw new Error(`${o.title} timed out`);
  // killed from outside (a restart): SIGTERM/SIGINT, or the exit codes a process gives for them
  if (signal || code === 130 || code === 143) throw new Error(`interrupted: ${o.title} stopped (${signal ?? `exit ${code}`})`);
  if (code !== 0) throw new Error(`${o.title} exited ${code}: ${(stderr || stdout).trim().split('\n').slice(-3).join(' ')}`);
  return stdout.trim().split('\n').slice(-2).join(' ');
}

const EXPERTS = [
  { name: 'meme', kind: 'meme', file: '.claude/agents/meme-expert.md' },
  { name: 'virality', kind: 'viral', file: '.claude/agents/virality-expert.md' },
  { name: 'story', kind: 'clip', file: '.claude/agents/story-expert.md' },
];

/** One line on the community moment, for the experts and the extractor. */
export function momentBrief(m: NonNullable<FullPipelineOptions['moment']>): string {
  const titles = m.titles.length ? ` Viewer clip titles: "${m.titles.slice(0, 3).join('" · "')}".` : '';
  return `This range is here because of one moment the community picked out: at about ${fmtTime(m.peakMs, 0)} (region ${fmtTime(m.fromMs, 0)}–${fmtTime(m.toMs, 0)}), ${m.why.join('; ')}.${titles}`;
}

function expertPrompt(e: (typeof EXPERTS)[number], id: string, from: string, to: string, only?: string[], moment?: FullPipelineOptions['moment']): string {
  return [
    `Read ${e.file} and follow it as your instructions.`,
    `Video ${id}, range ${from}–${to}, kind ${e.kind}.`,
    moment ? momentBrief(moment) : '',
    // viewer clips are reach: the virality expert owns a community moment no queue covers
    moment && e.name === 'virality' && !only?.length
      ? 'If no queue covers that moment, look at it anyway (its stills and words) and save one verdict on it: confirm it as a found moment ("found": true, see "A moment with no queue") or reject it with a ground.'
      : '',
    only?.length ? `Only review these queues: ${only.join(', ')}. Do not review other queues.` : `Review every ${e.kind} queue in the range.`,
    e.name === 'story' ? 'Also do the read-on sweep for the whole range.' : '',
    'Save confirm / reject / merge verdicts with ./clip queue-review. Do not add candidates, make clips, edit, or ask questions.',
    'Work from the project root. Reply with a short report: queues reviewed, confirmed, rejected.',
  ]
    .filter(Boolean)
    .join(' ');
}

async function pendingQueues(id: string, from: string, to: string): Promise<string[]> {
  const r = await cli(['queue-review', id, '--pending', '--from', from, '--to', to], 2 * 60_000);
  if (!r.ok || !/no verdict|pending|without a verdict|nobody judged/i.test(r.out)) return [];
  return [...new Set([...r.out.matchAll(/\b(?:meme|viral|clip)@[0-9:]+/g)].map((m) => m[0]))];
}

async function queueCheck(id: string, fromMs: number, toMs: number, log: (s: string) => void, moment?: FullPipelineOptions['moment']) {
  const from = fmtTime(fromMs, 0);
  const to = fmtTime(toMs, 0);
  // The watchlist usually scanned already; this is idempotent and guarantees the range is transcribed
  // before the experts start, exactly as the manual queue-check step 2 requires.
  const q = await cli(['queues', id, '--from', from, '--to', to, '--limit', '20', '--transcribe', 'range'], 30 * 60_000);
  if (!q.ok) throw new Error(`queues/transcribe failed: ${q.out.split('\n').slice(-3).join(' ')}`);

  log(`queue-check ${id} ${from}–${to}: three experts in parallel`);
  await Promise.all(
    EXPERTS.map((e) =>
      runAgent({
        title: `${e.name} expert ${id} ${from}-${to}`,
        prompt: expertPrompt(e, id, from, to, undefined, moment),
        timeoutMs: setting('FULL_EXPERT_TIMEOUT_MIN') * 60_000,
        log,
      }),
    ),
  );

  const pending = await pendingQueues(id, from, to);
  // each expert judges only its own kind (agents/queue-expert.md), so each gets only its kind's
  // pending queues; an expert with none left is not started again
  const mine = (e: (typeof EXPERTS)[number]) => pending.filter((q) => q.startsWith(`${e.kind}@`));
  const again = EXPERTS.filter((e) => mine(e).length);
  if (again.length) {
    log(`queue-check: ${pending.length} pending queue${pending.length === 1 ? '' : 's'}; sending them back to the ${again.map((e) => e.name).join(', ')} expert${again.length === 1 ? '' : 's'}`);
    const retries = await Promise.allSettled(
      again.map((e) =>
        runAgent({
          title: `${e.name} retry ${id} ${from}-${to}`,
          prompt: expertPrompt(e, id, from, to, mine(e), moment),
          timeoutMs: setting('FULL_EXPERT_TIMEOUT_MIN') * 60_000,
          log,
        }),
      ),
    );
    for (const r of retries) if (r.status === 'rejected') log(`queue-check retry failed: ${(r.reason as Error).message.slice(0, 200)}`);
  }

  // Coordinator check: the manual step 4 reads the evidence and risk flags. Keep it as its own agent;
  // it does not add candidates or edit. A failed verifier is logged, not fatal: the experts' ledger is
  // already on disk and the extractor can use it.
  try {
    const verify = await runAgent({
      title: `queue-check verifier ${id} ${from}-${to}`,
      prompt: [
        `Read .claude/skills/queue-check/SKILL.md and act as the coordinator for video ${id}, range ${from}–${to}.`,
        'The three experts have saved verdicts. Do step 4 only: pending, evidence, risk flags.',
        'Where step 4 says to send queues back to an expert, list them in your reply instead: the pipeline already sent the pending ones back once.',
        'Do not add candidates, make clips, edit, or start other agents. Do not ask questions.',
        'Reply with the confirmed moments, coverage gaps and risk flags.',
      ].join(' '),
      timeoutMs: setting('FULL_VERIFY_TIMEOUT_MIN') * 60_000,
      log,
    });
    log(`queue-check verifier: ${verify.slice(0, 240)}`);
  } catch (e) {
    log(`queue-check verifier failed (continuing): ${(e as Error).message.slice(0, 200)}`);
  }
}

async function extract(id: string, fromMs: number, toMs: number, log: (s: string) => void, moment?: FullPipelineOptions['moment']): Promise<string[]> {
  const from = fmtTime(fromMs, 0);
  const to = fmtTime(toMs, 0);
  const before = new Set(loadCandidates(id).candidates.map((c) => c.id));
  const reply = await runAgent({
    title: `extractor ${id} ${from}-${to}`,
    prompt: [
      `Read .claude/skills/clip-extractor/SKILL.md and follow it as your instructions.`,
      `Video ${id}. Only extract confirmed moments whose time is inside ${from}–${to}; ignore confirmed moments outside this range.`,
      'Every confirmed moment in this range becomes one candidate. Read the words and frames at both edges, choose the cut, score the batch, write extract.json and add the candidates.',
      moment ? `${momentBrief(moment)} A cut of that moment must contain what viewers clipped, through its payoff.` : '',
      'Do not curate, make clips, edit, or ask questions. Work from the project root. Reply with the candidate ids.',
    ]
      .filter(Boolean)
      .join(' '),
    timeoutMs: setting('FULL_EXTRACT_TIMEOUT_MIN') * 60_000,
    log,
  });
  const added = loadCandidates(id).candidates.filter((c) => !before.has(c.id)).map((c) => c.id);
  log(`extract: ${added.length} candidate${added.length === 1 ? '' : 's'} added${added.length ? ` (${added.join(', ')})` : ''} · ${reply.slice(0, 200)}`);
  return added;
}

async function curate(id: string, fromMs: number, toMs: number, ids: string[], log: (s: string) => void) {
  const from = fmtTime(fromMs, 0);
  const to = fmtTime(toMs, 0);
  const reply = await runAgent({
    title: `curator ${id} ${from}-${to}`,
    prompt: [
      `Read .claude/skills/clip-curator/SKILL.md and follow it as your instructions.`,
      `Video ${id}. Curate only these candidates, which this pass extracted from ${from}–${to}: ${ids.join(', ')}. Every other candidate of the video keeps the decision it has: do not decide or change them.`,
      'Assign niche, angle and fit; keep / review / drop with a reason; write curate.json and run ./clip curate.',
      'Do not edit, make clips, or ask questions. Work from the project root. Reply with keep / review / drop counts.',
    ].join(' '),
    timeoutMs: setting('FULL_CURATE_TIMEOUT_MIN') * 60_000,
    log,
  });
  log(`curate: ${reply.slice(0, 240)}`);
}

/**
 * This pass's candidates: what the extractor just added, and any candidate already inside the window
 * with no clip (a moment run again keeps the candidate its first run made; the extractor rightly does
 * not extract it twice). Candidates elsewhere in the stream are never this pass's. Pure.
 */
export function passCandidates(added: string[], candidates: { id: string; status: string; startMs: number; endMs: number }[], fromMs: number, toMs: number): string[] {
  const inside = (c: { startMs: number; endMs: number }) => c.startMs < toMs && c.endMs > fromMs;
  // what the extractor added counts only inside the window: its additions are a before/after diff over
  // the whole broadcast, and the prompt's "only inside this range" is not enforcement
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const mine = added.filter((id) => byId.has(id) && inside(byId.get(id)!));
  const inWindow = candidates.filter((c) => c.status === 'new' && inside(c)).map((c) => c.id);
  return [...new Set([...mine, ...inWindow])];
}

/**
 * Which of this pass's candidates the editor makes into clips: what the curator kept, strongest fit
 * first; when it kept none, the strongest one it left for the reviewer (it reaches the review queue
 * with the curator's concern, instead of waiting where nobody looks). A drop stays dropped. Pure.
 */
export function pickForEdit(ids: string[], decisions: Pick<CurationDecision, 'candidateId' | 'decision' | 'fit' | 'reason'>[], made: Set<string>, maxKeep: number, risky: Map<string, string[]> = new Map()): { id: string; concern?: string }[] {
  // a risky moment (sexual, a slur, a minor: `riskyCandidates`) goes to the editor only as a keep that
  // says how the cut leaves the risk out; never as the fallback "review" pick, which is how the nude
  // shower clip reached the editor and the channel (docs/research/censorship-review-2026-11-22.md)
  const mine = decisions
    .filter((d) => ids.includes(d.candidateId) && !made.has(d.candidateId))
    .filter((d) => !risky.has(d.candidateId) || (d.decision === 'keep' && AVOIDS.test(d.reason)))
    .sort((a, b) => b.fit - a.fit);
  const keep = mine.filter((d) => d.decision === 'keep');
  if (keep.length) return keep.slice(0, maxKeep).map((d) => ({ id: d.candidateId }));
  return mine
    .filter((d) => d.decision === 'review')
    .slice(0, maxKeep)
    .map((d) => ({ id: d.candidateId, concern: d.reason }));
}

/**
 * A pass's output, reconciled against the review records: a pick that already has a clip in review (in
 * any state) was made by this job, maybe by an attempt a restart cut short, and counts; only the rest
 * still need the editor. (A pick never had a clip when it was picked: `pickForEdit` leaves made ones out.)
 * Without this, a restart after the clip was submitted credited the job with nothing. Pure.
 */
export function outputsFor<P extends { id: string }>(videoId: string, picks: P[], reviewed: string[]): { clips: string[]; todo: P[] } {
  const mine = (p: P) => reviewed.filter((c) => c === `${videoId}-${p.id}` || c.startsWith(`${videoId}-${p.id}-`));
  return { clips: picks.flatMap(mine), todo: picks.filter((p) => !mine(p).length) };
}

const reviewedClips = (videoId: string) => listReviews().filter((r) => r.videoId === videoId).map((r) => r.clipId);

async function edit(id: string, fromMs: number, toMs: number, creator: string, allPicks: { id: string; concern?: string }[], log: (s: string) => void) {
  const from = fmtTime(fromMs, 0);
  const to = fmtTime(toMs, 0);
  const already = outputsFor(id, allPicks, reviewedClips(id));
  if (already.clips.length) log(`edit: already in review from an earlier attempt: ${already.clips.join(', ')}`);
  const picks = already.todo;
  if (!picks.length) return already.clips;
  const review = picks.filter((p) => p.concern);
  const reply = await runAgent({
    title: `editor ${id} ${from}-${to}`,
    prompt: [
      `Read .claude/skills/edit/SKILL.md and follow it as your instructions.`,
      `Video ${id}. Make and edit a clip for exactly these candidates: ${picks.map((p) => p.id).join(', ')}. Do not make, edit, render or submit any other candidate or clip of this video.`,
      ...review.map((p) => `The curator left ${p.id} for the reviewer: "${p.concern}". Do the fixes it names that you can (the cut first), and put what is left in the hand-over for the reviewer.`),
      'Do not change the layout: the engine sets it at render (split sized to the cam, the whole frame for non-game categories, blur-fit when the camera band has no face). If it still looks wrong, say so in your reply.',
      'Run the meme and expert editors as proposals, check every proposal against the words and the screen, settle captions, bleep what must not be heard (`./clip censor <clip>`), render, read QA, fix what fails, check the post text, and submit each clip to review.',
      `The creator is ${creator}. Do not approve or upload. Do not ask questions. Work from the project root. Reply with the clip ids submitted.`,
    ].join(' '),
    timeoutMs: setting('FULL_EDIT_TIMEOUT_MIN') * 60_000,
    log,
  });
  // only this pass's picks count as its clips (a clip id is <video>-<candidate>, or -v2 for a copy)
  const out = outputsFor(id, allPicks, reviewedClips(id));
  log(`edit: ${out.clips.length} review clip${out.clips.length === 1 ? '' : 's'}${out.todo.length ? ` (${out.todo.map((p) => p.id).join(', ')} not submitted)` : ''} · ${reply.slice(0, 200)}`);
  return out.clips;
}

export async function runFullPipeline(o: FullPipelineOptions): Promise<FullPipelineResult> {
  const log = o.log ?? logLine;
  const from = fmtTime(o.fromMs, 0);
  const to = fmtTime(o.toMs, 0);
  const maxKeep = o.maxKeep ?? setting('MAX_KEEP');
  log(`full pipeline ${o.videoId} ${from}–${to} (${o.creator})`);

  const run = stagesToRun(o.resume?.stage);
  const saved = o.resume?.data ?? {};
  const done = (stage: PipelineStage, data: Record<string, unknown> = {}) => o.onStage?.(stage, data);
  if (o.resume?.stage) log(`resuming after ${o.resume.stage}`);
  // the edit had finished before the restart: its saved clips are the result (a candidate that is now
  // made would otherwise drop out of the pass and the job would report nothing)
  if (o.resume?.stage === 'edit') {
    const clips = (saved.clips as string[] | undefined) ?? [];
    return { clips, note: clips.length ? `full pipeline: ${clips.length} review clip${clips.length === 1 ? '' : 's'} (${clips.join(', ')}), finished before a restart` : `full pipeline: no clip reached review for ${from}–${to}` };
  }

  if (run.has('queue-check')) {
    await queueCheck(o.videoId, o.fromMs, o.toMs, log, o.moment);
    done('queue-check');
  }
  let extracted: string[];
  let added: string[];
  if (run.has('extract')) {
    extracted = await extract(o.videoId, o.fromMs, o.toMs, log, o.moment);
    added = passCandidates(extracted, loadCandidates(o.videoId).candidates, o.fromMs, o.toMs);
    done('extract', { extracted, pass: added });
  } else {
    extracted = (saved.extracted as string[] | undefined) ?? [];
    // the pass as it was decided: a candidate made since (by this job) must not drop out of it
    added = (saved.pass as string[] | undefined) ?? passCandidates(extracted, loadCandidates(o.videoId).candidates, o.fromMs, o.toMs);
  }
  if (!added.length) return { clips: [], note: `full pipeline: no candidates extracted for ${from}–${to}` };
  const outside = extracted.filter((x) => !added.includes(x));
  if (outside.length) log(`extractor added ${outside.join(', ')} outside ${from}–${to}: not this pass's, left for review by hand`);
  const earlier = added.filter((x) => !extracted.includes(x));
  if (earlier.length) log(`candidates without a clip already in ${from}–${to}: ${earlier.join(', ')}`);
  let picks: { id: string; concern?: string }[];
  if (run.has('curate')) {
    await curate(o.videoId, o.fromMs, o.toMs, added, log);
    const cands = loadCandidates(o.videoId).candidates;
    const made = new Set(cands.filter((c) => c.status === 'made').map((c) => c.id));
    const risky = riskyCandidates(o.videoId, cands.filter((c) => added.includes(c.id)));
    picks = pickForEdit(added, loadCuration(o.videoId).decisions, made, maxKeep, risky);
    const held = [...risky].filter(([id]) => !picks.some((p) => p.id === id));
    if (held.length) log(`not edited, flagged: ${held.map(([id, f]) => `${id} (${f.join('; ')})`).join(', ')}`);
    done('curate', { picks });
  } else picks = (saved.picks as typeof picks | undefined) ?? [];
  if (!picks.length) {
    const why = loadCuration(o.videoId).decisions.filter((d) => added.includes(d.candidateId)).map((d) => `${d.candidateId} ${d.decision}`).join(', ');
    return { clips: [], note: `full pipeline: the curator kept nothing from ${from}–${to} (${why || 'no decision'})` };
  }
  log(`edit: ${picks.map((p) => `${p.id}${p.concern ? ' (left for the reviewer)' : ''}`).join(', ')}`);
  let clips: string[];
  if (run.has('edit')) {
    clips = await edit(o.videoId, o.fromMs, o.toMs, o.creator, picks, log);
    done('edit', { clips });
  } else clips = (saved.clips as string[] | undefined) ?? [];
  return {
    clips,
    note: clips.length
      ? `full pipeline: ${clips.length} review clip${clips.length === 1 ? '' : 's'} (${clips.join(', ')})${picks.some((p) => p.concern) ? ', left for the reviewer by the curator' : ''}`
      : `full pipeline: no clip reached review for ${from}–${to} (picked ${picks.map((p) => p.id).join(', ')})`,
  };
}

/**
 * A clip the reviewer sent back (C in the review page, with a note): the editor does what the note asks
 * first, renders, reads QA and submits it to review again with a hand-over that starts with the request.
 * The note overrides the curator's and editors' choices; a layout request may switch the clip to the
 * whole frame (the engine otherwise owns the layout). Returns the editor's reply.
 */
export async function reviseClip(o: { clipId: string; note: string; creator: string; log?: (s: string) => void }): Promise<string> {
  const log = o.log ?? logLine;
  return runAgent({
    title: `revise ${o.clipId}`,
    prompt: [
      `Read .claude/skills/edit/SKILL.md and follow it as your instructions, for one clip: ${o.clipId}.`,
      `The reviewer sent it back with this request: "${o.note.replace(/"/g, "'").slice(0, 1200)}".`,
      'Do what the request asks first; it overrides the curator\'s and the editors\' choices. Keep the rest of the edit as it is unless the request needs it changed.',
      'If the request is about the layout or the camera (a wrong face in the camera band, black bars, chat in the picture), you may switch the clip to the whole frame (`./clip set <clip> framing.mode=blur`) or crop away the problem with a reframe marker; otherwise leave the layout to the engine.',
      'There is no blur effect: to hide something (nudity, a slur in an on-screen chat), crop or zoom away from it, or cut the seconds it is on screen. If the request cannot be done with the tools there are, say exactly what is left.',
      `Render, read QA, fix what fails, then submit it with a hand-over: \`./clip review ${o.clipId} submit --note "You asked: <the request in a few words>. Changed: <what you did>. <anything left>"\`.`,
      `The creator is ${o.creator}. Do not approve or upload. Do not make or change any other clip. Do not ask questions. Work from the project root. Reply with what you changed.`,
    ].join(' '),
    timeoutMs: setting('FULL_EDIT_TIMEOUT_MIN') * 60_000,
    log,
  });
}
