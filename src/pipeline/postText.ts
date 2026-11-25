// A new title or description for a clip's post, in the direction the reviewer gives (the review page's
// Regenerate title / Regenerate description). One run of the pipeline's model with everything it needs in
// the prompt; it writes its options to a file, and this checks them before the reviewer sees them. The
// description is the post's caption: the credit block and the hashtags under it are the engine's
// (src/core/post.ts) and are never rewritten here.
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJsonIf } from '../core/paths';
import { postFor } from '../core/post';
import type { Transcript, VideoMeta } from '../core/schemas';
import { loadProject, suggestedPost } from '../project';
import { loadCandidates } from '../candidates';
import { sexualTitleWords } from '../qa/adult';
import { runAgent } from './full';

export type PostField = 'title' | 'caption';

/** How many options each asks for, and the longest one kept (YouTube's title limit is 100). */
export const POST_TEXT = { title: { options: 3, max: 100 }, caption: { options: 2, max: 600 } } as const;

export interface PostTextBrief {
  field: PostField;
  creator: string;
  platform: 'Twitch' | 'YouTube';
  game?: string;
  durationS: number;
  context?: string;
  reason?: string;
  hook?: string;
  words: string;
  title: string;
  caption: string;
  note?: string;
}

const RULES: Record<PostField, string[]> = {
  title: [
    'Under 60 characters is best; never over 90. No colon.',
    'Name the person with the short name viewers use (the creator, or whoever the moment is about); never "he", "she" or "this streamer".',
    'A present- or past-tense action, one word in ALL CAPS for the beat, and one or two reaction emojis at the end.',
    'Say what happens; it must be true to the words and the moment below. No promise the clip does not pay off.',
    'Never a sexual word (sex, sexy, nude, naked, topless, NSFW, strip club, lap dance, thirst trap, horny, lingerie and the like): the publisher refuses a title with one.',
    'English.',
  ],
  caption: [
    'One or two short sentences: the setup a viewer who has never seen this creator needs, naming them.',
    'No hashtags, links or credit line: the engine adds those under it.',
    'At most one emoji. No sexual words. English.',
  ],
};

/** The agent's whole brief. Pure. */
export function postTextPrompt(b: PostTextBrief, outFile: string): string {
  const what = b.field === 'title' ? 'title' : 'description (the lines above the credit and the hashtags)';
  const n = POST_TEXT[b.field].options;
  return [
    `You write the YouTube Shorts ${what} for one clip on a channel that clips streamers and credits them in every post.`,
    '',
    `The clip: ${b.creator} on ${b.platform}${b.game ? `, ${b.game}` : ''}, ${Math.round(b.durationS)} s.`,
    b.context ? `What the expert who saw the moment said: ${b.context}` : '',
    b.reason ? `The moment, as the extractor noted it: ${b.reason}` : '',
    b.hook ? `The hook line: "${b.hook}"` : '',
    `What is said in the clip: "${b.words || '(no words: a visual moment)'}"`,
    `The current title: "${b.title}"`,
    `The current description: "${b.caption}"`,
    '',
    `Rules for the ${b.field === 'title' ? 'title' : 'description'}:`,
    ...RULES[b.field].map((r) => `- ${r}`),
    '',
    `The reviewer's direction: ${b.note?.trim() ? b.note.trim() : 'none given: write better ones in the house style.'}`,
    '',
    `Write ${n} different options that follow the direction and the rules. Save them as JSON to ${outFile}, exactly {"options": ["…", "…"]}.`,
    'Do not read other files, run commands or change anything else: everything you need is above. Write the file and stop.',
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
}

/** Keep the options the publisher would take: text, not too long, and (for a title) no sexual word. Pure. */
export function checkOptions(field: PostField, raw: unknown): { options: string[]; dropped: string[] } {
  const list = Array.isArray((raw as { options?: unknown })?.options) ? ((raw as { options: unknown[] }).options) : [];
  const options: string[] = [];
  const dropped: string[] = [];
  for (const o of list) {
    if (typeof o !== 'string') continue;
    const text = o.replace(/^\s*["“]|["”]\s*$/g, '').replace(field === 'title' ? /\s+/g : /[ \t]+/g, ' ').trim();
    if (!text) continue;
    const words = field === 'title' ? sexualTitleWords(text) : [];
    if (words.length) dropped.push(`"${text}": the publisher refuses a title with ${words.join(', ')}`);
    else if (text.length > POST_TEXT[field].max) dropped.push(`"${text.slice(0, 60)}…": over ${POST_TEXT[field].max} characters`);
    else if (!options.includes(text)) options.push(text);
  }
  return { options, dropped };
}

/** The brief for a clip, from its project, candidate, expert line and transcript. */
export function briefFor(clipId: string, field: PostField, note?: string): PostTextBrief {
  const p = loadProject(clipId);
  const post = postFor(p.post, suggestedPost(p));
  const meta = readJsonIf<VideoMeta>(paths.videoFile(p.videoId, 'meta.json'));
  const cand = p.candidateId ? loadCandidates(p.videoId).candidates.find((c) => c.id === p.candidateId) : undefined;
  const seg = p.segments[0];
  const t = readJsonIf<Transcript>(paths.videoFile(p.videoId, 'transcript.json'));
  const words = (t?.words ?? []).filter((w) => w.startMs >= seg.startMs && w.endMs <= seg.endMs).map((w) => w.text).join(' ').slice(0, 1500);
  const ledger = cand?.queueId ? readJsonIf<{ verdicts: { queueId: string; context?: string }[] }>(paths.videoFile(p.videoId, 'queue-review.json')) : undefined;
  return {
    field,
    creator: meta?.channel ?? p.videoId,
    platform: p.videoId.startsWith('tw-') ? 'Twitch' : 'YouTube',
    game: meta?.chapters?.find((c) => seg.startMs >= c.startMs && seg.startMs < c.endMs)?.title ?? meta?.game,
    durationS: (seg.endMs - seg.startMs) / 1000,
    context: ledger?.verdicts.find((v) => v.queueId === cand?.queueId)?.context,
    reason: cand?.reason,
    hook: cand?.hook,
    words,
    title: post.title,
    caption: post.caption,
    note,
  };
}

/** Ask the model, read its file, keep what the publisher would take. Throws when nothing usable came back. */
export async function regeneratePostText(o: { clipId: string; field: PostField; note?: string; log: (s: string) => void }) {
  const dir = path.join(paths.cache, 'post-text');
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, `${o.clipId}-${o.field}-${Date.now()}.json`);
  const brief = briefFor(o.clipId, o.field, o.note);
  o.log(`writing ${POST_TEXT[o.field].options} ${o.field === 'title' ? 'titles' : 'descriptions'}`);
  await runAgent({ title: `post-text ${o.clipId} ${o.field}`, prompt: postTextPrompt(brief, path.relative(paths.root, outFile)), timeoutMs: 4 * 60_000, log: o.log });
  let raw: unknown;
  try {
    raw = readJsonIf<unknown>(outFile);
  } catch {
    throw new Error(`the model's file is not JSON (${path.relative(paths.root, outFile)})`);
  }
  if (raw === undefined) throw new Error('the model wrote no options (its log is in .cache/full/)');
  const r = checkOptions(o.field, raw);
  if (!r.options.length) throw new Error(`no usable option: ${r.dropped.join('; ') || 'the file had none'}`);
  return { field: o.field, ...r };
}
