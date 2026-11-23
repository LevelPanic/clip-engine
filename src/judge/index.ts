// The unattended judge: Claude Code in headless mode (`claude -p`) or OpenCode in headless mode
// (`opencode run`) executes the /clip skill's judging steps for a video. The no-LLM heuristic stays
// available only as an experiment. Measured chat explosions are appended as extra evidence; the
// skill's own setup/payoff logic still decides what becomes a candidate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../core/paths';
import { run } from '../core/proc';
import { loadCandidates } from '../candidates';
import { fmtTime } from '../core/time';
import { loadMeta } from '../ingest/ingest';
import { loadChat } from '../ingest/chat';
import { findChatSpikes } from '../discover/chatAnalysis';
import { setting } from '../core/config';

/** The claude CLI: CLIP_CLAUDE, then PATH, then the copy bundled with the Claude desktop app. */
export function findClaude(): string | null {
  const claude = setting('CLIP_CLAUDE');
  if (claude && fs.existsSync(claude)) return claude;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const f = path.join(dir, 'claude');
    if (fs.existsSync(f)) return f;
  }
  const base = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
  if (!fs.existsSync(base)) return null;
  const versions = fs.readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    for (const h of fs.existsSync(path.join(base, v)) ? fs.readdirSync(path.join(base, v)) : []) {
      const f = path.join(base, v, h, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}

/** The OpenCode CLI: CLIP_OPENCODE, the app bundle, the desktop CLI cache, then PATH. */
export function findOpencode(): string | null {
  const opencode = setting('CLIP_OPENCODE');
  if (opencode && fs.existsSync(opencode)) return opencode;
  const fixed = '/Applications/OpenCode.app/Contents/Resources/opencode-cli';
  if (fs.existsSync(fixed)) return fixed;
  const base = path.join(os.homedir(), 'Library', 'Application Support', 'ai.opencode.desktop', 'cli');
  if (fs.existsSync(base)) {
    const versions = fs.readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const f = path.join(base, v, 'opencode-cli');
      if (fs.existsSync(f)) return f;
    }
  }
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const f = path.join(dir, 'opencode');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export type JudgeProvider = 'claude' | 'opencode' | 'heuristic';

/** `CLIP_JUDGE=opencode` runs OpenCode Go (DeepSeek by default); `heuristic` is the no-LLM experiment. */
export const judgeProvider = (p?: string): JudgeProvider => (p === 'heuristic' ? 'heuristic' : p === 'opencode' ? 'opencode' : 'claude');

/** Measured chat explosions as extra evidence for the judge; no re-ordering, no accepting on chat alone. */
function chatEvidence(videoId: string, range?: { startMs: number; endMs: number }): string {
  try {
    const meta = loadMeta(videoId);
    if (meta.platform !== 'twitch') return '';
    const chat = loadChat(videoId);
    if (!chat || chat.disabled || !chat.fetched.length) return '';
    const spikes = findChatSpikes(chat.messages, chat.fetched, meta.durationMs)
      .filter((s) => !s.raid)
      .filter((s) => !range || (s.peakMs >= range.startMs && s.peakMs <= range.endMs))
      .sort((a, b) => b.ratio * b.chatters - a.ratio * a.chatters)
      .slice(0, 10);
    if (!spikes.length) return '';
    return [
      "Measured chat explosions in this range (additional evidence; verify them against the words and do not let chat override the skill's setup/payoff test):",
      ...spikes.map(
        (s) =>
          `- ${fmtTime(s.peakMs, 0)}  ${s.ratio.toFixed(1)}x normal, ${s.chatters} chatters${s.reaction ? `, ${s.reaction}` : ''}${s.top.length ? `; top: ${s.top.slice(0, 3).map((t) => t.text).join(', ')}` : ''}`,
      ),
    ].join('\n');
  } catch {
    return '';
  }
}

const cleanOutput = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').trim();

export async function judgeVideo(
  videoId: string,
  opts: { lens?: string; want?: number; range?: { startMs: number; endMs: number }; log?: (s: string) => void; provider?: JudgeProvider } = {},
) {
  const provider = judgeProvider(opts.provider ?? setting('CLIP_JUDGE'));
  if (provider === 'heuristic') {
    const { heuristicJudge } = await import('./heuristic');
    return heuristicJudge(videoId, opts);
  }
  const log = opts.log ?? (() => {});
  const before = loadCandidates(videoId).candidates.length;
  const stream = videoId.startsWith('tw-');
  const lens = opts.lens ?? (stream ? 'stream-moments' : 'podcast-general');
  const span = opts.range ? `${fmtTime(opts.range.startMs, 0)} to ${fmtTime(opts.range.endMs, 0)}` : '';
  const prompt = [
    stream
      ? `Judge clip candidates for the Twitch stream ${videoId} by following .claude/skills/clip/SKILL.md, the "Streams" section and steps 3 to 6, with the lens "${lens}".`
      : `Judge clip candidates for YouTube video ${videoId} by following .claude/skills/clip/SKILL.md, steps 2 to 6, with the lens "${lens}".`,
    opts.range ? `Only judge moments between ${span}: it's one scan pass, already done; its seeds come from \`./clip discover ${videoId} --from ${fmtTime(opts.range.startMs, 0)} --to ${fmtTime(opts.range.endMs, 0)}\`. Earlier passes may already have candidates; the validator rejects duplicates.` : '',
    `Score every candidate with the lens's quality score and the six funnel scores (stop, hold, share, standalone, payoff, delivery), using the 2 / 5 / 9 anchors in agents/vocabulary.md: rank the batch on each quality first, then give numbers. Do not apply any gate yourself; the engine computes virality, rank and verdict from honest scores. Fix or answer every "score check:" warning the validator prints.`,
    `Ingest is already done. Do not start the Studio and do not ask questions: this is an unattended batch run.`,
    `Aim for ${opts.want ?? (opts.range ? 'a few' : 10)} strong candidates${opts.range ? ' (fewer is fine; only real moments)' : ''}. When you're done, reply with one line: the accepted candidate ids.`,
  ]
    .filter(Boolean)
    .join(' ');
  const fullPrompt = [prompt, chatEvidence(videoId, opts.range)].filter(Boolean).join('\n\n');

  const t0 = Date.now();
  let reply = '';
  if (provider === 'opencode') {
    const opencode = findOpencode();
    if (!opencode) throw new Error('No OpenCode CLI found. Install OpenCode, or set CLIP_OPENCODE to its path.');
    const model = setting('CLIP_JUDGE_MODEL');
    log(`judging with opencode (${model}, lens ${lens})…`);
    const r = await run(opencode, ['run', '--model', model, '--auto', '--archived', '--title', `clip judge ${videoId}`, fullPrompt], {
      cwd: paths.root,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      onLine: (l) => l.trim() && log(l.slice(0, 200)),
    });
    if (r.code !== 0) {
      const msg = cleanOutput(r.stderr || r.stdout).split('\n').slice(-3).join(' ');
      throw new Error(`opencode exited ${r.code}: ${msg}`);
    }
    reply = cleanOutput(r.stdout);
  } else {
    const claude = findClaude();
    if (!claude) throw new Error('No claude CLI found. Install Claude Code, or set CLIP_CLAUDE to its path.');
    log(`judging with ${path.basename(claude)} (lens ${lens})…`);
    const r = await run(
      claude,
      ['-p', fullPrompt, '--output-format', 'text', '--max-turns', '80', '--allowedTools', 'Bash(./clip:*)', 'Read', 'Write', 'Edit'],
      { cwd: paths.root, env: { ...process.env, NODE_NO_WARNINGS: '1' }, onLine: (l) => l.trim() && log(l.slice(0, 200)) },
    );
    if (r.code !== 0) {
      const msg = cleanOutput(r.stderr || r.stdout).split('\n').slice(-3).join(' ');
      if (/not logged in|\/login/i.test(msg))
        throw new Error(
          opts.range
            ? `The claude CLI at ${claude} isn't logged in, so this pass wasn't judged. Run it once in a terminal and type /login. Until then, judge it in a Claude Code session with /clip ${videoId} --from ${fmtTime(opts.range.startMs, 0)} --to ${fmtTime(opts.range.endMs, 0)}.`
            : `The claude CLI at ${claude} isn't logged in. Run it once in a terminal and type /login. Until then, judge with /clip in a Claude Code session, then run \`clip batch-continue\`.`,
        );
      throw new Error(`claude exited ${r.code}: ${msg}`);
    }
    reply = cleanOutput(r.stdout);
  }
  const after = loadCandidates(videoId).candidates.length;
  return { added: after - before, seconds: Math.round((Date.now() - t0) / 1000), reply: reply.split('\n').slice(-3).join(' ') };
}
