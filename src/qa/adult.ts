// The 18+ check: does a clip carry sexual content that YouTube should age-restrict? Four leads, each
// with what was found and where: what the queue experts flagged, what is said in the clip, what chat
// typed while it played, and what NudeNet (tools/nudity, MIT, on-device) sees in stills of the export.
// They add up to points; `detected` is where the review page's 18+ check starts. The reviewer decides,
// and the approval carries the decision to the upload (src/publish/youtube.ts). Runs with QA
// (src/qa/index.ts) and is stored in exports/<clip>.qa.json as `adult`; `clip adult` runs it again.
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJsonIf } from '../core/paths';
import { run } from '../core/proc';
import { loadProject } from '../project';
import { fmtTime } from '../core/time';
import { setting } from '../core/config';

export interface AdultCheck {
  detected: boolean;
  points: number;
  /** What raised it, strongest first. Empty when nothing was found. */
  reasons: string[];
  /** What was looked at: words in the clip, people in chat while it played, stills, the experts' ledger. */
  looked: { words: number; chatters: number | null; stills: number | null; experts: boolean };
  /** A source that could not be read (no transcript, no chat, the detector failed). */
  missing: string[];
  /** Stills NudeNet saw nudity in (from 2026-11-22; older reports say it only in `reasons`). */
  nudity?: { stills: number; of: number; best: number; firstMs: number; labels: string[] };
  checkedAt: string;
}

/** Points at which the check starts ticked. */
export const ADULT_POINTS = 4;

/** Said in the clip: words that are sexual on their own. */
const EXPLICIT = /^(porn|porno|pornhub|dildos?|vibrators?|blowjobs?|handjobs?|orgasms?|masturbat\w*|cum|cumming|creampie|nudes|naked|nude|topless|strippers?|onlyfans|horny|boners?|erections?|threesomes?|sexting|hentai|nsfw)$/;
const EXPLICIT_PAIRS = /^(strip club|strip clubs|jerk off|jerking off|jack off|jacking off|sex tape|thirst trap|having sex|have sex|had sex|make love|making love)$/;
/** Said in the clip: words that are sexual in some uses and not in others (an insult, a joke, a game's line). */
const SUGGESTIVE = /^(sex|sexy|sexual|boobs?|boobies|tits|titties|booty|thong|lingerie|bikini|penis|vagina|dicks?|cocks?|pussy|gyat+|kinky|kink|fetish|thicc|stripping)$/;
/** Typed in chat: thirst, lewd emotes, NSFW calls. One per chatter counts. */
const LEWD_CHAT = /\b(gyat+t?|horny|bonk|nsfw|down bad|thirsty|booba|boobs?|tits|titties|thicc+|cleavage|sexy|naked|nude|nudes|onlyfans|porn|coom(er|ing)?|goon(er|ing))\b|🥵|🍑|🍆|💦|👅/i;

/** NudeNet labels: nudity, and clothing that shows what the label names. */
const EXPOSED = new Set(['FEMALE_BREAST_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'BUTTOCKS_EXPOSED', 'ANUS_EXPOSED']);
const REVEALING = new Set(['FEMALE_BREAST_COVERED', 'BUTTOCKS_COVERED', 'FEMALE_GENITALIA_COVERED']);
const MIN_SCORE = 0.5;
/** A single still with nudity counts in full only at this score. */
export const SURE_NUDITY = 0.7;
const STILL_EVERY_S = 2;
const CHAT_TRAILS_MS = 10_000;

export const normalWord = (s: string) => s.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9']/g, '');

/** Sexual words in a run of words, with the time of each (whatever clock `atMs` is on). */
export function sexualWords(words: { text: string; atMs: number }[]): { explicit: { word: string; atMs: number }[]; suggestive: { word: string; atMs: number }[] } {
  const explicit: { word: string; atMs: number }[] = [];
  const suggestive: { word: string; atMs: number }[] = [];
  const norm = words.map((w) => ({ w: normalWord(w.text), atMs: w.atMs }));
  for (let i = 0; i < norm.length; i++) {
    const { w, atMs } = norm[i];
    if (!w) continue;
    const pair = i + 1 < norm.length ? `${w} ${norm[i + 1].w}` : '';
    if (pair && EXPLICIT_PAIRS.test(pair)) {
      explicit.push({ word: pair, atMs });
      i++;
    } else if (EXPLICIT.test(w)) explicit.push({ word: w, atMs });
    else if (SUGGESTIVE.test(w)) suggestive.push({ word: w, atMs });
  }
  return { explicit, suggestive };
}

/** Distinct chatters in a range, and how many of them typed something lewd (with what). */
export function lewdChat(messages: [number, string, string][], startMs: number, endMs: number): { chatters: number; lewd: number; samples: string[] } {
  const all = new Set<string>();
  const lewd = new Set<string>();
  const samples: string[] = [];
  for (const [ms, user, text] of messages) {
    if (ms < startMs || ms >= endMs) continue;
    all.add(user);
    const m = LEWD_CHAT.exec(text);
    if (m && !lewd.has(user)) {
      lewd.add(user);
      const s = m[0].toLowerCase();
      if (!samples.includes(s)) samples.push(s);
    }
  }
  return { chatters: all.size, lewd: lewd.size, samples };
}

export interface AdultEvidence {
  explicit: { word: string; atMs: number }[];
  suggestive: { word: string; atMs: number }[];
  /** The kinds of queue expert that flagged the moment `sexual`. */
  experts: string[];
  lewdChatters: number;
  lewdSamples?: string[];
  /** Stills looked at (null: not looked at). */
  stills: number | null;
  /** Stills with nudity, by time in the clip. */
  exposed: { atMs: number; label: string; score: number }[];
  /** Stills with revealing clothing. */
  revealing: number;
}

const LABEL_WORDS: Record<string, string> = {
  FEMALE_BREAST_EXPOSED: 'exposed breasts',
  FEMALE_GENITALIA_EXPOSED: 'exposed genitals',
  MALE_GENITALIA_EXPOSED: 'exposed genitals',
  BUTTOCKS_EXPOSED: 'exposed buttocks',
  ANUS_EXPOSED: 'exposed anus',
};
const labelWords = (l: string) => LABEL_WORDS[l] ?? l.toLowerCase().replace(/_/g, ' ');
const said = (ws: { word: string; atMs: number }[]) =>
  ws.slice(0, 4).map((w) => `"${w.word}" at ${fmtTime(w.atMs, 0)}`).join(', ') + (ws.length > 4 ? ` and ${ws.length - 4} more` : '');

/** The points and the reasons. Pure, so the weights are tested (test/adult.test.ts). */
export function adultScore(e: AdultEvidence): { points: number; detected: boolean; reasons: string[] } {
  const parts: [number, string][] = [];
  if (e.exposed.length) {
    const first = e.exposed[0];
    const labels = [...new Set(e.exposed.map((x) => labelWords(x.label)))].join(', ');
    // nudity in two stills, or one the model is sure of, decides it. One still just over the bar is
    // a lead: on 101 rendered clips (2026-11-22) both such hits were bare skin (a tank top at 0.52,
    // a shoulder at 0.56), while GTA 6's nude shower showed in 7 of 19 stills.
    const best = Math.max(...e.exposed.map((x) => x.score));
    if (e.exposed.length >= 2 || best >= SURE_NUDITY)
      parts.push([6, `frames: nudity (${labels}) in ${e.exposed.length} of ${e.stills} stills, first at ${fmtTime(first.atMs, 0)} (NudeNet ${first.score.toFixed(2)})`]);
    else parts.push([2, `frames: possible nudity (${labels}) in 1 of ${e.stills} stills, at ${fmtTime(first.atMs, 0)} (NudeNet ${first.score.toFixed(2)}): look at it`]);
  }
  if (e.stills && e.stills >= 3 && e.revealing / e.stills >= 0.4) parts.push([2, `frames: revealing clothing in ${e.revealing} of ${e.stills} stills`]);
  if (e.experts.length) parts.push([e.experts.length >= 2 ? 3 : 2, `the queue experts flagged it sexual (${e.experts.join(', ')})`]);
  if (e.explicit.length) parts.push([Math.min(6, 2 * e.explicit.length), `said: ${said(e.explicit)}`]);
  if (e.suggestive.length) parts.push([Math.min(3, e.suggestive.length), `said (sexual in some uses): ${said(e.suggestive)}`]);
  if (e.lewdChatters >= 5) parts.push([e.lewdChatters >= 12 ? 3 : 2, `chat: ${e.lewdChatters} people typed lewd things while it played${e.lewdSamples?.length ? ` (${e.lewdSamples.slice(0, 4).join(', ')})` : ''}`]);
  parts.sort((a, b) => b[0] - a[0]);
  const points = parts.reduce((s, [p]) => s + p, 0);
  return { points, detected: points >= ADULT_POINTS, reasons: parts.map(([, r]) => r) };
}

/** Nudity the check is sure of (in two stills, or one at SURE_NUDITY): what the never-post check refuses. */
export function sureNudity(a: Pick<AdultCheck, 'nudity' | 'reasons'> | undefined): string | undefined {
  if (!a) return undefined;
  if (a.nudity) return a.nudity.stills >= 2 || a.nudity.best >= SURE_NUDITY ? `nudity (${a.nudity.labels.join(', ')}) in ${a.nudity.stills} of ${a.nudity.of} stills, first at ${fmtTime(a.nudity.firstMs, 0)} (NudeNet ${a.nudity.best.toFixed(2)})` : undefined;
  // a report from before `nudity` was stored: its full-weight frames reason (a lead reads "possible nudity")
  return a.reasons.find((r) => r.startsWith('frames: nudity ('))?.replace(/^frames: /, '');
}

/**
 * Sexual words in a title: what a viewer reads before the clip plays, and what YouTube's policy pages
 * name as a signal. Wider than what is counted in speech: "sex scene" or "gooner pics" in a title sells
 * the clip on sex even when nobody says the word.
 */
const SEXUAL_TITLE = /\b(nudes?|naked|nudity|topless|nsfw|sex|sexy|sexual|porn\w*|onlyfans|strippers?|strip ?clubs?|lap ?dances?|private dance|thirst ?trap|horny|fetish\w*|goon(er|ers|ing)?|boob(s|ies)?|tits|titties|penis|vagina|dildos?|lingerie|thong)\b/gi;
export const sexualTitleWords = (title: string): string[] => [...new Set([...title.matchAll(SEXUAL_TITLE)].map((m) => m[0].toLowerCase()))];

/**
 * Is a stream's moment sexual, from what the community did? A viewer-clip title with a sexual word, or a
 * chat that typed lewd things: 10+ people and 5%+ of everyone chatting over it. On the tracker's 4,691
 * moments (2026-11-22) the 95th percentile is 2% of chatters; GTA 6's nude shower was 7% (16 of 243), the
 * bed scene 10%, the strip club 9–11%; 50 moments (1%) pass the bar. Pure.
 */
export function sexualMoment(m: { titles: string[] }, chat?: { lewd: number; chatters: number; samples: string[] }): string | undefined {
  const words = m.titles.flatMap((t) => sexualTitleWords(t));
  if (words.length) return `viewer clips are titled for sex ("${m.titles.find((t) => sexualTitleWords(t).length)}")`;
  if (chat && chat.lewd >= 10 && chat.lewd / chat.chatters >= 0.05) return `chat was lewd over it (${chat.lewd} of ${chat.chatters} people: ${chat.samples.slice(0, 3).join(', ')})`;
  return undefined;
}

/** The kinds of queue expert that flagged a moment inside (or 5 s around) the range `sexual`. */
async function expertsSexual(videoId: string, r: { startMs: number; endMs: number }, queueId?: string): Promise<{ kinds: string[]; read: boolean }> {
  const { expertFlags } = await import('../scan/review');
  const flags = expertFlags(videoId, r, queueId);
  return { kinds: flags?.get('sexual') ?? [], read: !!flags };
}

/**
 * The words that play in the edited clip, on the clip's own clock: `text` as the captions show it
 * (caption fixes applied), `raw` as it was heard. A caption fix that hides a word does not mute it, so
 * a check of what is said reads `raw`.
 */
export async function wordsThatPlay(clipId: string): Promise<{ i: number; startMs: number; endMs: number; text: string; raw: string; atMs: number; muted: boolean }[]> {
  const p = loadProject(clipId);
  const seg = p.segments[0];
  const { loadMarkerSchemas } = await import('../markers/registry-node');
  const { timeMarkers, gainSpans, gainAt } = await import('../markers/define');
  const { buildTimeMap, srcToT } = await import('../core/timeline');
  const types = await loadMarkerSchemas();
  const accepted = p.markers.filter((m) => !m.proposed);
  const map = buildTimeMap(seg, timeMarkers(accepted, (t) => types.get(t)));
  // a word under a bleep (an audio marker that turns the clip's sound down) is not heard
  const gains = gainSpans(accepted, (t) => types.get(t), map);
  const { loadTranscript } = await import('../ingest/ingest');
  return loadTranscript(p.videoId)
    .words.filter((w) => w.startMs >= seg.startMs && w.startMs < seg.endMs)
    .map((w) => ({ w, t: srcToT(map, w.startMs), tEnd: srcToT(map, Math.max(w.startMs, w.endMs - 1)) }))
    .filter((x): x is { w: (typeof x)['w']; t: number; tEnd: number | null } => x.t !== null)
    .map(({ w, t, tEnd }) => ({
      i: w.i,
      startMs: w.startMs,
      endMs: w.endMs,
      text: p.captions.fixes[String(w.i)] ?? w.text,
      raw: w.text,
      atMs: t,
      muted: gainAt(gains, (t + (tEnd ?? t)) / 2) < 0.5,
    }));
}

/** NudeNet over one still every STILL_EVERY_S seconds of the export. */
async function framesOf(clipId: string): Promise<{ stills: number; exposed: AdultEvidence['exposed']; revealing: number } | { error: string }> {
  const file = path.join(paths.exports, `${clipId}.mp4`);
  if (!fs.existsSync(file)) return { error: 'no export' };
  const dir = path.join(paths.cache, 'adult', clipId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    // the first still is at 1 s (not on the open's first frame), then every STILL_EVERY_S
    const ff = await run('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', file, '-vf', `fps=1/${STILL_EVERY_S},scale=720:-2`, '-q:v', '3', path.join(dir, '%03d.jpg')]);
    const stills = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
    if (ff.code !== 0 || !stills.length) return { error: `no stills (${ff.stderr.trim().split('\n').pop() ?? 'ffmpeg failed'})` };
    const py = setting('CLIP_NUDITY_PY');
    const args = stills.map((f) => path.join(dir, f));
    const r = py ? await run(py, [path.join(paths.root, 'tools', 'nudity', 'main.py'), ...args]) : await run(path.join(paths.root, 'tools', 'nudity', 'run.sh'), args);
    if (r.code !== 0) return { error: `NudeNet failed (${r.stderr.trim().split('\n').pop()?.slice(0, 160) ?? `exit ${r.code}`})` };
    const out = JSON.parse(r.stdout) as { images: { file: string; detections?: { label: string; score: number }[] }[] };
    const exposed: AdultEvidence['exposed'] = [];
    let revealing = 0;
    for (const im of out.images) {
      const k = Number(path.basename(im.file, '.jpg'));
      const atMs = (1 + (k - 1) * STILL_EVERY_S) * 1000;
      const hits = (im.detections ?? []).filter((d) => d.score >= MIN_SCORE);
      const nude = hits.filter((d) => EXPOSED.has(d.label)).sort((a, b) => b.score - a.score)[0];
      if (nude) exposed.push({ atMs, label: nude.label, score: nude.score });
      else if (hits.some((d) => REVEALING.has(d.label))) revealing++;
    }
    return { stills: out.images.length, exposed, revealing };
  } catch (e) {
    return { error: (e as Error).message.split('\n')[0].slice(0, 160) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the 18+ check on a rendered clip. Never throws for a missing source: it says what it could not read. */
export async function checkAdult(clipId: string, opts: { frames?: boolean } = {}): Promise<AdultCheck> {
  const p = loadProject(clipId);
  const seg = p.segments[0];
  const missing: string[] = [];

  // words that play in the edited clip, as the captions show them, on the clip's own clock
  let clipWords: { text: string; atMs: number }[] = [];
  try {
    clipWords = (await wordsThatPlay(clipId)).filter((w) => !w.muted); // a bleeped word is not heard
  } catch {
    missing.push('no transcript');
  }
  const { explicit, suggestive } = sexualWords(clipWords);

  const { loadCandidates } = await import('../candidates');
  const cand = loadCandidates(p.videoId).candidates.find((c) => c.id === p.candidateId);
  const experts = await expertsSexual(p.videoId, seg, cand?.queueId);

  const { loadChat } = await import('../ingest/chat');
  const chat = loadChat(p.videoId);
  const seen = chat?.messages ? lewdChat(chat.messages, seg.startMs, seg.endMs + CHAT_TRAILS_MS) : null;
  if (!chat) missing.push('no chat');

  const frames = opts.frames === false ? { error: 'frames not asked for' } : await framesOf(clipId);
  if ('error' in frames) missing.push(`frames not checked: ${frames.error}`);

  const e: AdultEvidence = {
    explicit,
    suggestive,
    experts: experts.kinds,
    lewdChatters: seen?.lewd ?? 0,
    lewdSamples: seen?.samples,
    stills: 'error' in frames ? null : frames.stills,
    exposed: 'error' in frames ? [] : frames.exposed,
    revealing: 'error' in frames ? 0 : frames.revealing,
  };
  const s = adultScore(e);
  const nudity = e.exposed.length && e.stills
    ? { stills: e.exposed.length, of: e.stills, best: Math.max(...e.exposed.map((x) => x.score)), firstMs: e.exposed[0].atMs, labels: [...new Set(e.exposed.map((x) => labelWords(x.label)))] }
    : undefined;
  return {
    ...s,
    looked: { words: clipWords.length, chatters: seen ? seen.chatters : null, stills: e.stills, experts: experts.read },
    missing,
    ...(nudity ? { nudity } : {}),
    checkedAt: new Date().toISOString(),
  };
}

/** Run the check again and store it in the clip's QA report (for clips rendered before the check). */
export async function recheckAdult(clipId: string): Promise<AdultCheck | null> {
  const file = path.join(paths.exports, `${clipId}.qa.json`);
  const qa = readJsonIf<Record<string, unknown>>(file);
  if (!qa) return null;
  const adult = await checkAdult(clipId);
  const { writeJson } = await import('../core/paths');
  writeJson(file, { ...qa, adult });
  return adult;
}
