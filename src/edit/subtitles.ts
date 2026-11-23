// The subtitle expert: should this clip have captions at all, what kind, where, and which words are wrong.
//
// Captions are not free. On a music/crowd clip they add noise; on a clip with burned-in captions they
// duplicate; on a text-heavy screen they cover the content. When they do belong, the style and position
// depend on the background, the framing and the platform safe zone. This module makes that call and
// lists the word-level fixes; the skill/agent checks the frames and has the final say.
import { lookOf } from '../core/captionLooks';
import { paths, readJsonIf } from '../core/paths';
import { loadProject, saveProject } from '../core/project';
import { loadCandidates } from '../candidates';
import { loadMeta } from '../ingest/ingest';
import { CHAR_EM, CAPTION_WIDTH } from '../core/captionMetrics';
import { detectReactions, reactionWeight } from '../discover/signals/audio';
import type { AudioEventsFile } from '../ingest/audioEvents';
import { maskSwearing, swearIn } from '../core/risk';
import type { CaptionSettings, Project, Transcript, Word, VideoMeta } from '../core/schemas';

const FILLERS = new Set(['so', 'yeah', 'um', 'uh', 'like', 'well', 'okay', 'right', 'and', 'but', 'alright']);
// Only the true hesitation sounds are safe to hide automatically. "Yeah", "right", "and" and "we'll"
// can carry meaning; flag them for the expert instead of deleting them.
const AUTO_HIDE = new Set(['um', 'uh', 'uhh', 'erm', 'hmm', 'mm', 'mmm']);
const FUNCTION = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'is', 'it', 'i', 'you', 'we', 'they', 'he', 'she', 'that', 'this', 'was', 'were', 'be', 'been', 'for', 'on', 'at', 'as', 'with', 'but', 'not']);
const NON_SPEECH = /\[(music|laughter|applause|cheering|bleep|__)\]/gi;

export interface SubtitleIssue {
  wordIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  fix: string; // "" hides the word
  kind: 'duplicate' | 'filler' | 'censor' | 'profanity' | 'overflow' | 'timing' | 'repetition' | 'capitalization';
  severity: 'warn' | 'info';
  why: string;
  confidence: number;
}

export interface CaptionDecision {
  enabled: boolean;
  style: CaptionSettings['style'];
  position: number;
  uppercase: boolean;
  fontSize: number;
  why: string;
  risks: string[];
  confidence: number;
}

export interface SubtitleReview {
  clipId: string;
  score: number;
  verdict: 'clean' | 'needs-fixes';
  decision: CaptionDecision;
  issues: SubtitleIssue[];
  stats: { words: number; shown: number; hidden: number; speechPerSec: number; repeated: number; longWords: number; profanity: number };
}

const cleanWord = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const shownText = (w: Word, fixes: Record<string, string>) => {
  const fixed = fixes[String(w.i)];
  const text = (fixed ?? w.text).replace(/\[__\]/g, '****');
  return text.trim() ? text : null;
};

/** Word-level caption review. Pure: the tests pass fixed word arrays. */
export function reviewWords(words: Word[], settings: CaptionSettings): { issues: SubtitleIssue[]; stats: SubtitleReview['stats'] } {
  const issues: SubtitleIssue[] = [];
  let hidden = 0;
  let longWords = 0;
  let profanity = 0;
  let repeated = 0;
  const add = (w: Word, fix: string, kind: SubtitleIssue['kind'], why: string, severity: SubtitleIssue['severity'] = 'warn', confidence = 0.7) =>
    issues.push({ wordIndex: w.i, startMs: w.startMs, endMs: w.endMs, text: shownText(w, settings.fixes) ?? w.text, fix, kind, severity, why, confidence });

  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    const text = shownText(w, settings.fixes);
    if (text === null) continue;
    const bare = cleanWord(text);
    const prev = k > 0 ? shownText(words[k - 1], settings.fixes) : null;
    const next = k + 1 < words.length ? shownText(words[k + 1], settings.fixes) : null;

    // Three in a row is often intentional emphasis ("swim swim swim") or a Whisper loop. Flag it; let
    // the expert decide from the audio instead of hiding real words automatically.
    if (prev && next && cleanWord(prev) === bare && cleanWord(next) === bare) {
      repeated++;
      add(w, text, 'repetition', 'the same word repeats three times; verify intentional emphasis vs a Whisper loop', 'info', 0.5);
      continue;
    }
    if (prev && cleanWord(prev) === bare && bare.length > 1) {
      const functionWord = FUNCTION.has(bare);
      add(w, functionWord ? '' : text, 'duplicate', functionWord ? `duplicate function word ("${prev}")` : 'duplicate content word; verify it was really said twice', functionWord ? 'warn' : 'info', functionWord ? 0.85 : 0.35);
      if (functionWord) continue;
    }
    if (NON_SPEECH.test(text)) {
      NON_SPEECH.lastIndex = 0;
      add(w, '', 'censor', 'non-speech tag; it should not be a caption', 'warn', 0.95);
      continue;
    }
    NON_SPEECH.lastIndex = 0;
    if (text.includes('[__]') || text.includes('****')) {
      add(w, '****', 'censor', "YouTube's censor mark; keep it as ****", 'info', 0.6);
      continue;
    }
    if (FILLERS.has(bare) && (k === 0 || (prev && /[.!?…]$/.test(prev)) || (next && /^[A-Z]/.test(next)))) {
      const auto = AUTO_HIDE.has(bare);
      add(w, auto ? '' : text, 'filler', auto ? `"${w.text}" is a hesitation sound` : `"${w.text}" may be filler; hide only if it adds nothing`, 'info', auto ? 0.8 : 0.3);
      if (auto) continue;
    }
    if (swearIn(text)) {
      profanity++;
      add(
        w,
        text,
        'profanity',
        settings.censor !== false
          ? `masked in the captions (${maskSwearing(text)}); the audio still says it: \`clip censor\` bleeps it`
          : 'shown unmasked: captions.censor is off',
        'info',
        0.35,
      );
    }
    const len = text.replace(/[^\p{L}\p{N}]/gu, '').length;
    const em = CHAR_EM[settings.style];
    if (len >= 14 && CAPTION_WIDTH / (len * em) < settings.fontSize * 0.75) {
      longWords++;
      add(w, text, 'overflow', `"${text}" will shrink to fit; shorten or hide it`, 'warn', 0.6);
    }
    if (w.endMs - w.startMs > 2000) add(w, text, 'timing', 'over 2 s on screen; the caption may linger', 'info', 0.4);
    if (!settings.uppercase && k === 0 && /^[a-z]/.test(text)) add(w, text[0].toUpperCase() + text.slice(1), 'capitalization', 'first word of the clip starts lowercase', 'info', 0.4);
  }

  const shown = words.filter((w) => shownText(w, settings.fixes) !== null).length;
  return {
    issues,
    stats: {
      words: words.length,
      shown,
      hidden: words.length - shown,
      speechPerSec: words.length ? Math.round((words.length / Math.max(1, (words[words.length - 1].endMs - words[0].startMs) / 1000)) * 10) / 10 : 0,
      repeated,
      longWords,
      profanity,
    },
  };
}

/**
 * Should the clip have captions, and in what look/place? Pure. Everything it is given is about the
 * clip itself: its words, the non-speech tags inside it, and the reactions heard inside it.
 */
export function captionDecision(input: {
  meta: Pick<VideoMeta, 'game' | 'title' | 'platform'>;
  project: Pick<Project, 'framing' | 'captions'>;
  /** Transcript words inside the clip. */
  words: Word[];
  /** Non-speech tags inside the clip ([music], [laughter], [applause]). */
  tags: { tag: string }[];
  /** Laughs, cheers and shouts heard inside the clip. */
  reactions: number;
  durationMs: number;
}): CaptionDecision {
  const { meta, project, words, tags, reactions, durationMs } = input;
  const seconds = Math.max(1, durationMs / 1000);
  const speechPerSec = words.length / seconds;
  const nonSpeech = tags.filter((t) => /music|laugh|applause|cheer/i.test(t.tag)).length;
  const music = tags.filter((t) => /music/i.test(t.tag)).length;
  const game = (meta.game ?? '').toLowerCase();
  const busy = project.framing.mode === 'crop' || /fortnite|warzone|call of duty|gta|valorant|league|overwatch|deadlock/i.test(game);
  const talk = /just chatting|podcast|politics|news|interview/i.test(game);

  const risks: string[] = [];
  let enabled = true;
  let why = '';
  if (words.length < 5) {
    enabled = false;
    why = 'almost no speech; captions would be noise';
  } else if (durationMs < 5000) {
    enabled = false;
    why = 'the clip is under 5 s; captions do not have time to read';
  } else if (speechPerSec < 0.4 && reactions + nonSpeech >= Math.max(2, words.length / 4)) {
    enabled = false;
    why = `a few words (${words.length} in ${Math.round(seconds)} s) over crowd, laughter or music; the sound carries it, not the words`;
  } else if (music >= 2 && music > words.length * 0.25) {
    enabled = false;
    why = 'mostly music; lyrics as captions are noise (and often wrong)';
  } else {
    why = talk ? 'talk clip: captions help search and muted viewing; keep them calm' : 'spoken clip: captions carry the joke and the muted viewer';
    if (speechPerSec < 0.4) risks.push(`sparse speech (${words.length} words in ${Math.round(seconds)} s): check the captions are not mostly empty screen`);
  }
  if (/just chatting|irl/i.test(game) && !talk) risks.push('check the frame: IRL/just-chatting clips often have burned-in captions; if so, keep ours off');
  risks.push('check the frame for burned-in captions, facecam, scoreboard or chat at the caption position');

  // street (short italic phrases, thick outline) reads over a busy game as well as over a face; a talk
  // clip gets sentence-case commentary. The older bold/boxed/clean are the auto-captioner default look
  // (src/core/captionLooks.ts says why), kept only for clips that already use them.
  const style: CaptionDecision['style'] = talk && !busy ? 'commentary' : 'street';
  const look = lookOf(style);
  const position = project.framing.mode === 'crop' ? 0.74 : 0.72;
  const uppercase = look.uppercase;
  const fontSize = words.some((w) => (shownText(w, project.captions.fixes) ?? '').length >= 14) ? Math.round(look.fontSize * 0.82) : look.fontSize;
  return { enabled, style, position, uppercase, fontSize, why, risks, confidence: enabled ? 0.7 : 0.8 };
}

export async function reviewSubtitles(clipId: string): Promise<SubtitleReview> {
  const p = loadProject(clipId);
  const t = readJsonIf<Transcript>(paths.videoFile(p.videoId, 'transcript.json'));
  const audio = readJsonIf<AudioEventsFile>(paths.videoFile(p.videoId, 'audio-events.json'));
  const meta = loadMeta(p.videoId);
  const seg = p.segments[0];
  const inClip = (ms: number) => ms >= seg.startMs && ms <= seg.endMs;
  const words = (t?.words ?? []).filter((w) => w.startMs >= seg.startMs && w.endMs <= seg.endMs);
  const { issues, stats } = reviewWords(words, p.captions);
  // only what is inside the clip: the whole video's laugh tags say nothing about these 30 seconds
  const tags = (t?.tags ?? []).filter((g) => inClip(g.ms));
  const reactions = (audio ? detectReactions(audio) : []).filter((d) => reactionWeight(d) >= 1 && inClip(d.startMs)).length;
  const decision = captionDecision({ meta, project: p, words, tags, reactions, durationMs: seg.endMs - seg.startMs });
  const penalty = issues.reduce((s, i) => s + (i.severity === 'warn' ? 6 : 2), 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  return { clipId, score, verdict: issues.some((i) => i.severity === 'warn') ? 'needs-fixes' : 'clean', decision, issues, stats };
}

export interface SubtitleApplyResult {
  review: SubtitleReview;
  applied: number;
  /** Caption settings that changed, as "style bold → boxed". Empty when nothing changed. */
  changed: string[];
  /** What the engine would have set but left alone, and why. */
  kept: string[];
}

/**
 * Apply the engine's word fixes and caption look to the clip.
 * - Word fixes never overwrite a fix that is already there, unless `force`.
 * - `settings: false` leaves the caption look and the on/off switch alone (word fixes only): use it
 *   after anyone has set captions by hand from the frames.
 * - Captions that are OFF stay off unless `enable`: a project starts with captions on, so "off" is
 *   always somebody's decision (burned-in captions, a facecam in the way, non-English audio) and the
 *   engine cannot see the frames that decision came from.
 */
export async function applySubtitleFixes(clipId: string, opts: { force?: boolean; settings?: boolean; enable?: boolean } = {}): Promise<SubtitleApplyResult> {
  const p = loadProject(clipId);
  const review = await reviewSubtitles(clipId);
  let applied = 0;
  for (const issue of review.issues) {
    if (issue.fix === issue.text) continue;
    const key = String(issue.wordIndex);
    if (p.captions.fixes[key] !== undefined && !opts.force) continue;
    p.captions.fixes[key] = issue.fix;
    applied++;
  }
  const changed: string[] = [];
  const kept: string[] = [];
  if (opts.settings !== false) {
    const d = review.decision;
    const before = { ...p.captions };
    let enabled = d.enabled;
    if (d.enabled && !before.enabled && !opts.enable) {
      enabled = false;
      kept.push('captions stay OFF: someone turned them off and the engine cannot see the frames; --enable turns them back on');
    }
    p.captions = { ...p.captions, enabled, style: d.style, position: d.position, uppercase: d.uppercase, fontSize: d.fontSize };
    if (before.enabled !== enabled) changed.push(`captions ${before.enabled ? 'on' : 'off'} → ${enabled ? 'on' : 'off'}`);
    if (before.style !== d.style) changed.push(`style ${before.style} → ${d.style}`);
    if (before.position !== d.position) changed.push(`position ${before.position} → ${d.position}`);
    if (before.uppercase !== d.uppercase) changed.push(d.uppercase ? 'sentence case → uppercase' : 'uppercase → sentence case');
    if (before.fontSize !== d.fontSize) changed.push(`size ${before.fontSize} → ${d.fontSize}`);
  } else kept.push('caption look and on/off left as they are (--no-settings)');
  if (applied || changed.length) saveProject(p);
  return { review, applied, changed, kept };
}
