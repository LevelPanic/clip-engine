// Never posted, whatever the review said. A short list, from what got this channel's videos removed
// (reports/censorship-review-2026-11-22.md): nudity the 18+ check is sure of, a slur said in the clip, a
// moment the queue experts flagged for a minor, and a title that sells the clip on sex. It is enforced
// where the credit is: the publishers refuse it, --force or not, and the upload scheduler sets it aside.
// QA does not hold an approval back (user, 2026-11-22); this list does. 18+ does not make any of it
// postable: an age-restricted Short still falls under the nudity policy, and reaches almost no one.
//
// What the export shows is settled at render: QA stores this check (`unsafe` in exports/<clip>.qa.json)
// and the publisher adds what it finds now, so only a new render that no longer trips it clears it. The
// title is the exception: it is read when the clip is posted, so a new title clears it.
import path from 'node:path';
import { paths, readJsonIf } from '../core/paths';
import { slurIn, swearIn } from '../core/risk';
import { fmtTime } from '../core/time';
import type { AdultCheck } from './adult';

export type UnsafeKind = 'nudity' | 'slur' | 'minor' | 'title';
export interface UnsafeReason {
  kind: UnsafeKind;
  why: string;
}
export interface UnsafeCheck {
  reasons: UnsafeReason[];
  checkedAt: string;
}

/** A slur written so the reason can be read out loud on the review page: the first letter and stars. */
const masked = (w: string) => w[0] + '*'.repeat(Math.max(1, w.length - 1));

/** Slurs said in a run of words, as heard. "Sped" alone is the insult only in chat; said, it is the verb. Pure. */
export function saidSlurs(words: { raw: string; atMs: number }[]): { word: string; atMs: number }[] {
  return words.flatMap((w) => {
    if (/^sp[e3]d+s?$/i.test(w.raw.replace(/[^\p{L}\p{N}]/gu, ''))) return [];
    const s = slurIn(w.raw);
    return s ? [{ word: s, atMs: w.atMs }] : [];
  });
}

/** Each finding as a reason the clip stays off the channel, with what to do. Pure. */
export function unsafeReasons(e: { nudity?: string; slurs: { word: string; atMs: number }[]; minor: string[]; titleWords: string[] }): UnsafeReason[] {
  const out: UnsafeReason[] = [];
  if (e.nudity) out.push({ kind: 'nudity', why: `frames: ${e.nudity}. Cut or crop it out and render again` });
  if (e.slurs.length) {
    const at = e.slurs.slice(0, 3).map((s) => `"${masked(s.word)}" at ${fmtTime(s.atMs, 0)}`).join(', ');
    out.push({ kind: 'slur', why: `a slur is said: ${at}${e.slurs.length > 3 ? ` and ${e.slurs.length - 3} more` : ''}. Hiding it in the captions does not mute it: bleep it (\`clip censor\`) or cut it out, and render again` });
  }
  if (e.minor.length) out.push({ kind: 'minor', why: `the queue experts flagged someone under 18 as the subject (${e.minor.join(', ')})` });
  if (e.titleWords.length) out.push({ kind: 'title', why: `the title sells it on sex (${e.titleWords.join(', ')}): say what happened instead, and it uploads by itself` });
  return out;
}

/** The check on a clip as it is now. `adult` is the clip's 18+ check (its frames are where nudity is seen). */
export async function checkUnsafe(clipId: string, adult?: AdultCheck): Promise<UnsafeCheck> {
  const { loadProject, suggestedPost } = await import('../core/project');
  const { postFor } = await import('../core/post');
  const { wordsThatPlay, sureNudity, sexualTitleWords } = await import('./adult');
  const { expertFlags } = await import('../scan/review');
  const { loadCandidates } = await import('../candidates');
  const p = loadProject(clipId);
  const cand = loadCandidates(p.videoId).candidates.find((c) => c.id === p.candidateId);
  let words: { raw: string; atMs: number }[] = [];
  try {
    words = (await wordsThatPlay(clipId)).filter((w) => !w.muted); // a bleeped word is not said
  } catch {
    // no transcript: nothing said can be checked (a muted or visual clip)
  }
  const flags = expertFlags(p.videoId, p.segments[0], cand?.queueId);
  const title = postFor(p.post, suggestedPost(p)).title;
  return {
    reasons: unsafeReasons({ nudity: sureNudity(adult), slurs: saidSlurs(words), minor: flags?.get('minor') ?? [], titleWords: sexualTitleWords(title) }),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * What keeps this export off the channel: what QA found when it was rendered (what the export shows)
 * plus what is true now, and the title as it is now. `look` runs the 18+ check's frames first when they
 * were never looked at (a clip rendered before the check), so nudity is never waved through unseen.
 */
export async function neverPost(clipId: string, o: { look?: boolean } = {}): Promise<UnsafeReason[]> {
  const qa = readJsonIf<{ adult?: AdultCheck; unsafe?: UnsafeCheck }>(path.join(paths.exports, `${clipId}.qa.json`));
  let adult = qa?.adult;
  if (o.look && qa && (!adult || adult.looked.stills === null)) {
    const { recheckAdult } = await import('./adult');
    adult = (await recheckAdult(clipId)) ?? adult;
  }
  const now = (await checkUnsafe(clipId, adult)).reasons;
  const rendered = (qa?.unsafe?.reasons ?? []).filter((r) => r.kind !== 'title');
  return [...rendered, ...now.filter((r) => !rendered.some((x) => x.kind === r.kind))];
}

/**
 * Store the check in a clip's QA report, as QA would at render (for clips rendered before it existed):
 * `unsafe`, and a `✖ unsafe` failure per reason so the review page shows it before Approve.
 */
export async function recheckUnsafe(clipId: string): Promise<UnsafeCheck | null> {
  const file = path.join(paths.exports, `${clipId}.qa.json`);
  const qa = readJsonIf<{ adult?: AdultCheck; passed: boolean; issues: { level: string; check: string; detail: string }[] }>(file);
  if (!qa) return null;
  const unsafe = await checkUnsafe(clipId, qa.adult);
  const issues = [...qa.issues.filter((i) => i.check !== 'unsafe'), ...unsafe.reasons.map((r) => ({ level: 'fail', check: 'unsafe', detail: `never posted: ${r.why}` }))];
  const { writeJson } = await import('../core/paths');
  writeJson(file, { ...qa, issues, passed: !issues.some((i) => i.level === 'fail'), unsafe });
  return unsafe;
}

export const neverPostText = (clipId: string, reasons: UnsafeReason[]) => `${clipId} is never posted (src/qa/unsafe.ts): ${reasons.map((r) => r.why).join('; ')}`;

// ── The careful period (channel.json → careful; reports/censorship-review-2026-11-22.md, C5) ──
// After YouTube removed two videos, only the cleanest approvals go up for two weeks. The rest are not
// refused: the scheduler holds them (`deferred`) and they go up by themselves once the period ends. What
// a reviewer must judge from the picture (the creator on screen and reacting, not a cutscene) is on the
// review page instead; most of the channel's streamers use an avatar, so the layout cannot tell.

export type CarefulKind = 'sexual' | 'adult' | 'swear-open';
export interface CarefulReason {
  kind: CarefulKind;
  why: string;
}

/** The first seconds a viewer hears: the open is what decides whether a Short is watched, and what is judged. */
export const OPEN_MS = 3_000;

/** F-words said in the open, as heard (a caption fix does not mute them; a bleep does, and the caller leaves those words out). Pure. */
export function openSwears(words: { raw: string; atMs: number }[], openMs = OPEN_MS): { word: string; atMs: number }[] {
  return words.filter((w) => w.atMs < openMs && swearIn(w.raw) === 'f-word').map((w) => ({ word: w.raw.replace(/[^\p{L}\p{N}]/gu, ''), atMs: w.atMs }));
}

/** What keeps an approval back while the careful period is on. Pure. */
export function carefulReasons(e: { sexual: string[]; adult: boolean; swears: { word: string; atMs: number }[] }): CarefulReason[] {
  const out: CarefulReason[] = [];
  if (e.sexual.length) out.push({ kind: 'sexual', why: `a queue expert flagged the moment sexual (${e.sexual.join(', ')})` });
  if (e.adult) out.push({ kind: 'adult', why: 'it is 18+ (an age-restricted Short reaches almost no one)' });
  if (e.swears.length) out.push({ kind: 'swear-open', why: `an f-word in the first ${OPEN_MS / 1000} s ("${masked(e.swears[0].word)}" at ${fmtTime(e.swears[0].atMs, 0)}): \`clip censor\` bleeps it` });
  return out;
}

/** The careful check on a clip as it is now. `adult`: the reviewer's 18+ decision (or what the 18+ check found). */
export async function checkCareful(clipId: string, adult: boolean): Promise<CarefulReason[]> {
  const { loadProject } = await import('../core/project');
  const { wordsThatPlay } = await import('./adult');
  const { expertFlags } = await import('../scan/review');
  const { loadCandidates } = await import('../candidates');
  const p = loadProject(clipId);
  const cand = loadCandidates(p.videoId).candidates.find((c) => c.id === p.candidateId);
  let words: { raw: string; atMs: number }[] = [];
  try {
    words = (await wordsThatPlay(clipId)).filter((w) => !w.muted); // a bleeped word is not said
  } catch {
    // no transcript: nothing said can be checked
  }
  const sexual = expertFlags(p.videoId, p.segments[0], cand?.queueId)?.get('sexual') ?? [];
  return carefulReasons({ sexual, adult, swears: openSwears(words) });
}
