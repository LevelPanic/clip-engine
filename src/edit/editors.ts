// Two editors review a clip for two different jobs.
//
//   meme   — is there a quick, loopable gag here? Hook text, a punch-in on the punch word, an emoji
//            and a flash on the reaction, tight cuts that keep the comic pause. Short and loud wins.
//   expert — is the story clean? Start on the first word, cut dead air, put a context hook over the
//            opening, push in on the key line, and say when the ending or the length is wrong.
//
// Both find the moments first (where someone laughed or screamed, the word just before it, the quoted
// line, the pauses) and place edits on them; nothing is placed at a fixed fraction of the clip.
// `applyEditorSuggestions` writes the edits as proposed markers (source editor:meme / editor:expert),
// so the reviewer can accept them in the Studio or with `clip accept`.
//
// What the editors do NOT touch: captions (the subtitle expert owns them: `clip subtitles`) and the
// review note (the reviewer's words). What they think about either goes into `notes`.
import { paths, readJsonIf } from '../core/paths';
import { loadProject, saveProject, newMarkerId } from '../core/project';
import { loadCandidates } from '../candidates';
import { loadQa } from '../qa';
import { loadMarkerSchemas } from '../markers/registry-node';
import { detectReactions, reactionWeight, type ReactionKind } from '../discover/signals/audio';
import { subtractRanges } from '../core/ranges';
import type { AudioEventsFile } from '../ingest/audioEvents';
import type { Candidate, Marker, Project, SplitLayout, Transcript, Word } from '../core/schemas';
import { seamOf } from '../core/layout';
import { pickChatLine, type ChatLine } from './chatCard';
import type { ChatMessage } from '../discover/chatAnalysis';

export type EditorMode = 'meme' | 'expert';

/** How far under the seam of a split layout a line of text sits: clear of the credit that is on the seam. */
const UNDER_SEAM = 0.075;

/**
 * Where a top line of text goes. In a split layout the top band is the creator's camera, so the line
 * goes just under the seam, over the top of the game; otherwise near the top. Pure.
 */
export function hookYFor(framing: { mode?: string; split?: Partial<SplitLayout> } | undefined): number {
  if (framing?.mode !== 'split') return 0.18;
  const sp = framing.split ?? {};
  const seam = seamOf({ cam: sp.cam ?? { x: 0, y: 0, w: 0.3, h: 0.3 }, game: sp.game ?? { x: 0, y: 0, w: 1, h: 1 }, camShare: sp.camShare ?? 0.35, canvasPad: sp.canvasPad, camTopPad: sp.camTopPad, content: sp.content });
  return Math.round(Math.min(0.6, seam + UNDER_SEAM) * 1000) / 1000;
}

/** The text style that goes with a caption look: hook lines and narrator lines match the captions. Pure. */
export function hookStyleFor(captionStyle: string | undefined): 'street' | 'comment' | 'hook' {
  if (captionStyle === 'street' || captionStyle === 'comic') return 'street';
  if (captionStyle === 'commentary' || captionStyle === 'native') return 'comment';
  return 'hook';
}

export interface EditorMetrics {
  /** The text style hook lines take, matching the caption look (`hookStyleFor`). */
  hookStyle: 'street' | 'comment' | 'hook';
  /** Where a line of text at the top goes: under the seam of a split layout (the top band is the creator's face), near the top otherwise. */
  hookY: number;
  durationMs: number;
  durationS: number;
  words: number;
  firstWordMs: number | null;
  lastWordMs: number | null;
  firstWordRelMs: number | null;
  lastWordRelMs: number | null;
  endsQuestion: boolean;
  laughs: number;
  screams: number;
  /** Reactions heard inside the clip (laughs, shouts, cheers, caption laugh tags), in order. */
  reactions: { kind: ReactionKind; ms: number; endMs: number }[];
  /** The first reaction worth punching in on (not in the opening 1.5 s), and the word that set it off. */
  reactionMs: number | null;
  reactionKind: ReactionKind | null;
  punchMs: number | null;
  punchWord: string | null;
  /** Where the candidate's quoted line is said (else the clip's last sentence): the line to push in on. */
  keyLineMs: number | null;
  keyLineEndMs: number | null;
  /** Pauses between words with nothing audible in them. A laugh or a scream is not dead air. */
  deadAirMs: number;
  deadAirGaps: { startMs: number; endMs: number }[];
  /** Pauses left alone because a reaction follows: the beat before the laugh is the timing of the joke. */
  comicPauses: { startMs: number; endMs: number }[];
  captions: boolean;
  hasHookText: boolean;
  currentMarkers: string[];
  signalChat: number;
  signalAudio: number;
  signalClips: number;
  rendered: boolean;
  qaPassed: boolean;
  qaWarnings: string[];
  /** The words inside the clip, source ms (for the fail ending, the countdown, the tint words). */
  clipWords: { text: string; startMs: number; endMs: number }[];
  /** Source stretches the clip's cuts remove (accepted or proposed), for time-skip cards. */
  skips: { startMs: number; endMs: number }[];
  /** The line chat said best about the moment (`pickChatLine`), for a chat card. */
  chatLine: ChatLine | null;
  /** The clip is (or will be, once its facecam is found at render) a split: facecam-only and game-only spans need one. */
  split: boolean;
}

export interface EditorSuggestion {
  type: string; // a marker type
  startMs: number;
  endMs?: number;
  params: Record<string, unknown>;
  why: string;
  confidence: number;
}

export interface EditorReview {
  clipId: string;
  mode: EditorMode;
  score: number;
  verdict: 'strong' | 'possible' | 'weak';
  summary: string;
  suggestions: EditorSuggestion[];
  /** Things to do that are not a marker: trim the clip, ask the subtitle expert, rewrite the hook. */
  notes: string[];
  risks: string[];
  metrics: EditorMetrics;
}

const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const sentenceEnd = (s: string) => /[.!?]["')\]]?$/.test(s.trim());

const FILLER = /^(that|this|with|have|like|just|they|what|your|then|there|about|really|yeah|know|kind|sort|mean|gonna|going|think|okay|well|because|right|thing|stuff|guys|were|when|them|been|some|it's|that's|don't|i'm|you're)$/i;
const isContent = (w: Word) => {
  const core = w.text.replace(/[^A-Za-z']/g, '');
  return core.length >= 4 && !FILLER.test(core);
};

const MIN_GAP_MS = 1000;
/** A pause that ends this close before a reaction is the beat before the laugh: never cut it. */
const COMIC_BEAT_MS = 1500;

export function clipMetrics(
  p: Project,
  cand: Candidate | undefined,
  t: Pick<Transcript, 'words' | 'tags'> | undefined,
  ae: Pick<AudioEventsFile, 'events' | 'windowMs' | 'hopMs'> | undefined,
  qa?: { passed: boolean; issues: { level: string; check: string; detail: string }[] },
  more: { chat?: ChatMessage[]; skips?: { startMs: number; endMs: number }[] } = {},
): EditorMetrics {
  const seg = p.segments[0];
  const words = (t?.words ?? []).filter((w: Word) => w.startMs >= seg.startMs && w.endMs <= seg.endMs);
  // what was heard: the tuned audio detector, plus caption [laughter] tags (YouTube) where the audio has none nearby
  const heard = (ae ? detectReactions(ae) : []).filter((d) => reactionWeight(d) >= 1 && d.startMs >= seg.startMs && d.startMs <= seg.endMs).map((d) => ({ kind: d.kind, ms: d.startMs, endMs: d.endMs }));
  const tags = (t?.tags ?? []).filter((g) => /laugh|applause|cheer|chuckl/.test(g.tag) && g.ms >= seg.startMs && g.ms <= seg.endMs).map((g) => ({ kind: 'laugh' as ReactionKind, ms: g.ms, endMs: g.ms + 1500 }));
  const reactions = [...heard, ...tags.filter((g) => !heard.some((h) => Math.abs(h.ms - g.ms) < 2000))].sort((a, b) => a.ms - b.ms);

  // pauses between words, minus the stretches where someone is laughing or screaming
  const gaps: { startMs: number; endMs: number }[] = [];
  for (let i = 1; i < words.length; i++) if (words[i].startMs - words[i - 1].endMs > MIN_GAP_MS) gaps.push({ startMs: words[i - 1].endMs, endMs: words[i].startMs });
  const silent = subtractRanges(gaps, reactions.map((r) => ({ startMs: r.ms - 500, endMs: r.endMs + 500 }))).filter((g) => g.endMs - g.startMs > MIN_GAP_MS);
  const beforeReaction = (g: { startMs: number; endMs: number }) => reactions.some((r) => r.ms >= g.endMs && r.ms <= g.endMs + COMIC_BEAT_MS);
  const deadAirGaps = silent.filter((g) => !beforeReaction(g));
  const comicPauses = silent.filter(beforeReaction);

  // the reaction to punch in on, and the content word that set it off
  const reaction = reactions.find((r) => r.ms >= seg.startMs + 1500) ?? null;
  let punch: Word | undefined;
  if (reaction) {
    const near = words.filter((w) => w.startMs <= reaction.ms + 300 && w.endMs >= reaction.ms - 3500);
    punch = [...near].reverse().find(isContent) ?? near[near.length - 1];
  }

  // the key line: the candidate's quote where it is said, else the last sentence
  let keyStart: number | null = null;
  let keyEnd: number | null = null;
  const q = (cand?.quote ?? '').toLowerCase().replace(/[^a-z0-9' ]/g, '').split(/\s+/).filter(Boolean);
  if (q.length >= 3) {
    const norm = (w?: Word) => (w?.text ?? '').toLowerCase().replace(/[^a-z0-9']/g, '');
    const idx = words.findIndex((_, k) => q.slice(0, 3).every((x, j) => norm(words[k + j]) === x));
    if (idx >= 0) {
      keyStart = words[idx].startMs;
      keyEnd = words[Math.min(words.length - 1, idx + q.length - 1)].endMs;
    }
  }
  if (keyStart === null && words.length) {
    let k = words.length - 1;
    while (k > 0 && !sentenceEnd(words[k - 1].text) && words[k].startMs - words[k - 1].endMs < 600) k--;
    keyStart = words[k].startMs;
    keyEnd = words[words.length - 1].endMs;
  }

  const first = words[0];
  const last = words[words.length - 1];
  return {
    durationMs: seg.endMs - seg.startMs,
    durationS: Math.round((seg.endMs - seg.startMs) / 100) / 10,
    words: words.length,
    firstWordMs: first?.startMs ?? null,
    lastWordMs: last?.endMs ?? null,
    firstWordRelMs: first ? first.startMs - seg.startMs : null,
    lastWordRelMs: last ? last.endMs - seg.startMs : null,
    endsQuestion: !!last && /[?]["')\]]?$/.test(last.text),
    laughs: reactions.filter((r) => r.kind === 'laugh' || r.kind === 'cheer').length,
    screams: reactions.filter((r) => r.kind === 'shout').length,
    reactions,
    reactionMs: reaction?.ms ?? null,
    reactionKind: reaction?.kind ?? null,
    punchMs: punch?.startMs ?? reaction?.ms ?? null,
    punchWord: punch?.text ?? null,
    keyLineMs: keyStart,
    keyLineEndMs: keyEnd,
    deadAirMs: deadAirGaps.reduce((s, g) => s + (g.endMs - g.startMs), 0),
    deadAirGaps,
    comicPauses,
    captions: p.captions.enabled,
    hookY: hookYFor(p.framing),
    hookStyle: hookStyleFor(p.captions?.style),
    hasHookText: p.markers.some((m) => m.type === 'text' && m.startMs <= seg.startMs + 1200),
    currentMarkers: [...new Set(p.markers.filter((m) => !m.proposed).map((m) => m.type))],
    signalChat: cand?.signals?.chat ?? 0,
    signalAudio: cand?.signals?.audio ?? 0,
    signalClips: cand?.signals?.clips ?? 0,
    rendered: !!qa,
    qaPassed: qa?.passed ?? false,
    qaWarnings: (qa?.issues ?? []).filter((i) => i.level === 'warn').map((i) => i.detail),
    clipWords: words.map((w) => ({ text: w.text, startMs: w.startMs, endMs: w.endMs })),
    skips: more.skips ?? [],
    split: p.framing.mode === 'split' || !!p.autoSplit,
    // chat trails the moment by 5–25 s: read from the clip's start to 15 s after its end
    chatLine: more.chat ? pickChatLine(more.chat, seg.startMs, seg.endMs + 15_000) : null,
  };
}

/** The meme editor's read: short, loud, loopable, with a visible reaction. 0–100 fit, not quality. */
export function memeScore(m: EditorMetrics): number {
  let s = 0;
  s += Math.min(25, (m.laughs / Math.max(10, m.durationS)) * 80);
  s += Math.min(20, m.screams * 4);
  s += m.durationS <= 30 ? 20 : m.durationS <= 45 ? 10 : 0;
  s += m.signalChat * 15 + m.signalClips * 15;
  s += m.hasHookText ? 5 : 0;
  return Math.round(clamp(s / 100) * 100);
}

/** The expert editor's read: a fast open, a clean story, a real ending, sensible length. 0–100 fit. */
export function expertScore(m: EditorMetrics): number {
  let s = 0;
  s += m.firstWordRelMs !== null && m.firstWordRelMs <= 1500 ? 25 : m.firstWordRelMs !== null && m.firstWordRelMs <= 2500 ? 12 : 0;
  s += m.endsQuestion ? 0 : 20;
  s += m.deadAirMs < 500 ? 20 : m.deadAirMs < 1500 ? 10 : 0;
  s += m.durationS >= 15 && m.durationS <= 45 ? 20 : m.durationS <= 60 ? 10 : 0;
  s += m.words >= 30 ? 15 : m.words >= 15 ? 8 : 0;
  return Math.round(clamp(s / 100) * 100);
}

/** On-screen hook text from the judge's hook: the whole line if it is short, else its first clause. */
export function hookText(cand: Pick<Candidate, 'hook' | 'title'> | undefined, max = 7): { text: string; shortened: boolean } {
  const tidy = (s?: string) => (s ?? '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  const count = (s: string) => s.split(' ').filter(Boolean).length;
  const hook = tidy(cand?.hook);
  const title = tidy(cand?.title);
  if (hook && count(hook) <= max) return { text: hook, shortened: false };
  if (title && count(title) <= max) return { text: title, shortened: false };
  const src = hook || title;
  if (!src) return { text: '', shortened: false };
  const clause = src.split(/[,;:—–]| - /)[0].trim();
  if (count(clause) >= 2 && count(clause) <= max) return { text: clause, shortened: true };
  return { text: `${src.split(' ').slice(0, max).join(' ')}…`, shortened: true };
}

/** A clip is 15 s or more; cuts must not take it under that. */
const MIN_CLIP_MS = 15_000;

/**
 * The dead-air gaps worth cutting: the longest first, at most three, and never so much that the
 * clip drops under 15 s. Returns what was left alone, so the editor can say so.
 */
export function cuttableGaps(m: Pick<EditorMetrics, 'deadAirGaps' | 'durationMs'>, inset: number): { cuts: { startMs: number; endMs: number }[]; leftMs: number } {
  let budget = m.durationMs - MIN_CLIP_MS;
  const cuts: { startMs: number; endMs: number }[] = [];
  let leftMs = 0;
  for (const g of [...m.deadAirGaps].sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))) {
    const len = g.endMs - g.startMs - 2 * inset;
    if (cuts.length < 3 && len > 0 && len <= budget) {
      cuts.push({ startMs: g.startMs + inset, endMs: g.endMs - inset });
      budget -= len;
    } else leftMs += g.endMs - g.startMs;
  }
  return { cuts, leftMs };
}
const leftNote = (leftMs: number, m: Pick<EditorMetrics, 'durationS'>) => `left ${(leftMs / 1000).toFixed(1)} s of dead air: cutting it would take this ${m.durationS} s clip under 15 s. Extend the clip (\`clip trim\`) or keep the silence`;

// ── The meme-edit vocabulary from reports/meme-edits-2026-11-22.md (175 top clip Shorts) ──

/** Words that end a clip on a loss: the fail ending gets a freeze and black and white. */
const FAIL = /\b(died|dead|die|dying|lost|lose|losing|eliminated|wasted|failed|fail|game over|it'?s over|no{3,})\b/i;
/** Words a tint beat goes on: green for a win, pink for affection. */
const WIN = /\b(won|win|wins|winning|clutch|victory|let'?s go+|we did it)\b/i;
const LOVE = /\b(love|kiss|kissed|cute|babe|crush|marry|date)\b/i;
const NUMBER: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const numberOf = (w: string): number | null => {
  const b = w.toLowerCase().replace(/[^a-z0-9]/g, '');
  return NUMBER[b] ?? (/^\d{1,2}$/.test(b) ? Number(b) : null);
};

/** A clip that ends on a loss: a fail word in its last 5 s. Pure. */
export function failEnding(m: Pick<EditorMetrics, 'clipWords'>, clipEndMs: number): { word: string; ms: number } | null {
  const w = [...m.clipWords].reverse().find((x) => x.startMs >= clipEndMs - 5000 && FAIL.test(x.text));
  return w ? { word: w.text, ms: w.startMs } : null;
}

/** "Three, two, one": a run of 3+ numbers counting down by one, each within 1.6 s of the last. Pure. */
export function countdownIn(words: { text: string; startMs: number; endMs: number }[]): { from: number; to: number; startMs: number; endMs: number; stepMs: number } | null {
  for (let i = 0; i < words.length; i++) {
    const first = numberOf(words[i].text);
    if (first === null || first < 3) continue;
    const run = [words[i]];
    let want = first - 1;
    for (let j = i + 1; j < words.length && want >= 1; j++) {
      if (words[j].startMs - run[run.length - 1].startMs > 1600) break;
      const n = numberOf(words[j].text);
      if (n === null) continue;
      if (n !== want) break;
      run.push(words[j]);
      want--;
    }
    if (run.length >= 3) {
      const stepMs = Math.round((run[run.length - 1].startMs - run[0].startMs) / (run.length - 1));
      return { from: first, to: first - run.length + 1, startMs: run[0].startMs, endMs: run[run.length - 1].endMs + 600, stepMs };
    }
  }
  return null;
}

/** The one colour beat a clip gets: green on a win, pink on affection; none otherwise. Pure. */
export function tintBeat(words: { text: string; startMs: number }[], fromMs: number): { color: string; ms: number; word: string; why: string } | null {
  const win = words.find((w) => w.startMs >= fromMs && WIN.test(w.text));
  if (win) return { color: '#22c55e', ms: win.startMs, word: win.text, why: 'a green beat on the win' };
  const love = words.find((w) => w.startMs >= fromMs && LOVE.test(w.text));
  if (love) return { color: '#ff4fa3', ms: love.startMs, word: love.text, why: 'a pink beat on the affection' };
  return null;
}

/** The reactions to punch in on: after the first 1.5 s, at least 5 s apart, at most 3. Pure. */
export function punchReactions(m: Pick<EditorMetrics, 'reactions'>, clipStartMs: number, max = 3): EditorMetrics['reactions'] {
  const out: EditorMetrics['reactions'] = [];
  for (const r of m.reactions) {
    if (r.ms < clipStartMs + 1500) continue;
    if (out.length && r.ms - out[out.length - 1].ms < 5000) continue;
    out.push(r);
    if (out.length === max) break;
  }
  return out;
}

const LOOK = /^(look|watch|see|check)$/i;
const AT = /^(at|this|that|it|him|her|out)\b/i;
/** "Look at this", "watch this", "see that": the moment to show the stream alone. After the open, the first one. Pure. */
export function lookCue(words: { text: string; startMs: number }[], fromMs: number): { startMs: number; text: string } | null {
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i].text.replace(/[^a-z']/gi, '');
    const b = words[i + 1].text.replace(/[^a-z']/gi, '');
    if (words[i].startMs >= fromMs && LOOK.test(a) && AT.test(b)) return { startMs: words[i].startMs, text: `${a} ${b}`.toLowerCase() };
  }
  return null;
}

/** The word that set a reaction off: the last content word in the 3.5 s before it. Pure. */
function wordBefore(words: EditorMetrics['clipWords'], ms: number): { text: string; startMs: number } | null {
  const near = words.filter((w) => w.startMs <= ms + 300 && w.endMs >= ms - 3500);
  const content = [...near].reverse().find((w) => isContent({ i: 0, ...w }));
  return content ?? near[near.length - 1] ?? null;
}

/** The nearest start to `want` where [start, start + len] misses every removed stretch and fits in [lo, hi]; null if none. Pure. */
export function chatCardAt(want: number, len: number, removed: { startMs: number; endMs: number }[], lo: number, hi: number): number | null {
  const clear = (a: number) => a >= lo && a + len <= hi && !removed.some((r) => a < r.endMs && a + len > r.startMs);
  const options = [want, ...removed.flatMap((r) => [r.endMs + 100, r.startMs - len - 100])].filter(clear);
  return options.length ? options.sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0] : null;
}

const premiseEmoji = (kind: ReactionKind | null) => (kind === 'shout' ? ' 😱' : kind === 'laugh' || kind === 'cheer' ? ' 😂' : ' 💀');

/** Meme edits: the reaction is the joke; point at it, and cut what is not it. */
export function memeSuggestions(m: EditorMetrics, cand: Candidate | undefined, clipStartMs: number): { suggestions: EditorSuggestion[]; notes: string[] } {
  const out: EditorSuggestion[] = [];
  const notes: string[] = [];
  const clipEndMs = clipStartMs + m.durationMs;
  const hook = hookText(cand, 6);
  if (!m.hasHookText && hook.text) {
    // the hook supplies the missing setup; it must be gone before the hit so it never covers or spoils it
    // the premise box clip channels open with (36% of top Shorts): black on white strips, one emoji
    const until2 = Math.min(clipStartMs + 3500, (m.punchMs ?? Infinity) - 300);
    if (until2 - clipStartMs >= 1200) out.push({ type: 'text', startMs: clipStartMs, endMs: until2, params: { text: hook.text.replace(/[.!]+$/, '') + premiseEmoji(m.reactionKind), style: 'box', y: m.hookY, fontSize: 68, animation: 'pop' }, why: 'the premise box: what is going on, in the first second', confidence: hook.shortened ? 0.5 : 0.72 });
    else notes.push('the reaction comes in the first seconds: no premise box, it would cover the hit');
    if (hook.shortened) notes.push(`hook text was cut down from "${cand?.hook ?? cand?.title}": rewrite it as 6 words or fewer that name the premise without giving away the punchline`);
  }
  if (m.punchMs !== null && m.reactionMs !== null) {
    // a snap zoom on each reaction (at most 3, 5 s apart; the top clips use 2), a tilt with it on a shout
    const hits = punchReactions(m, clipStartMs);
    let side = 1;
    // in a split, the first laugh is the facecam alone (21% of top clip Shorts cut to it on the laugh)
    const camLaugh = m.split ? hits.find((r) => r.kind === 'laugh') : undefined;
    if (camLaugh) {
      const end = Math.min(clipEndMs, camLaugh.ms + 2400, Math.max(camLaugh.endMs + 400, camLaugh.ms + 1200));
      out.push({ type: 'solo', startMs: Math.max(clipStartMs, camLaugh.ms - 150), endMs: end, params: { show: 'cam' }, why: 'the facecam alone on the laugh, then back to the split', confidence: 0.55 });
    }
    hits.filter((r) => r !== camLaugh).forEach((r, k) => {
      const w = k === 0 ? (m.punchWord ? { text: m.punchWord, startMs: m.punchMs! } : null) : wordBefore(m.clipWords, r.ms);
      const at = k === 0 ? m.punchMs! : Math.max(w?.startMs ?? r.ms, r.ms - 1500);
      const end = Math.min(clipEndMs, Math.max(at + 900, r.ms + 600));
      const word = w ? `"${w.text}"` : 'the hit';
      out.push({ type: 'zoom', startMs: at, endMs: end, params: { scale: k === 0 ? 1.35 : 1.25, easing: 'snap', rampMs: 300, focusX: 0.5, focusY: 0.45 }, why: `punch in on ${word}, just before the ${r.kind}`, confidence: k === 0 ? 0.66 : 0.55 });
      if (r.kind === 'shout') {
        out.push({ type: 'tilt', startMs: at, endMs: end, params: { degrees: 6 * side, easing: 'snap', rampMs: 250 }, why: `a ${side > 0 ? 'right' : 'left'} tilt with the zoom on the shout (the top clips pair them)`, confidence: 0.55 });
        side = -side;
      }
    });
    out.push({ type: 'emoji', startMs: Math.min(clipEndMs - 300, m.reactionMs + 150), params: { emoji: m.reactionKind === 'shout' ? '😱' : '😂', x: 0.78, y: 0.28, durationMs: 900 }, why: `on the ${m.reactionKind}`, confidence: 0.6 });
    out.push({ type: 'flash', startMs: m.punchMs, params: { durationMs: 180, opacity: 0.45 }, why: 'one flash on the hit; more than one reads as noise', confidence: 0.48 });
  } else if (m.reactions.length) notes.push(`the ${m.reactions[0].kind} is in the first 1.5 s: the open is the hit, so no punch-in (a zoom there would fight the opening)`);
  else notes.push('no laugh or scream heard in this clip: no punch-in placed. If the gag is visual, place a zoom on it by hand');
  const gaps = cuttableGaps(m, 80);
  for (const cut of gaps.cuts) out.push({ type: 'cut', ...cut, params: { transition: 'none' }, why: 'dead air: nothing said and nothing heard', confidence: 0.7 });
  if (gaps.leftMs > 1500 && gaps.cuts.length < m.deadAirGaps.length && m.durationMs - MIN_CLIP_MS < m.deadAirMs) notes.push(leftNote(gaps.leftMs, m));
  // a silent open (no word for 0.8 s, no reaction): start tight and pull back, so the first second moves
  if (m.firstWordRelMs !== null && m.firstWordRelMs > 800 && !m.reactions.some((r) => r.ms < clipStartMs + 1500)) {
    out.push({ type: 'zoom', startMs: clipStartMs, endMs: clipStartMs + 900, params: { scale: 1.3, easing: 'smooth', rampMs: 700, focusX: 0.5, focusY: 0.42, direction: 'out' }, why: 'open tight and pull back to the whole picture (a reveal)', confidence: 0.4 });
  }
  // a fail ending: the last frame holds and drains (the clip must stay under a minute)
  const fail = failEnding(m, clipEndMs);
  if (fail && m.durationMs + 1000 <= 59_500) {
    out.push({ type: 'freeze', startMs: clipEndMs - 120, params: { durationMs: 1000, zoom: 1.08 }, why: `it ends on a loss ("${fail.word}"): hold the last frame`, confidence: 0.5 });
    out.push({ type: 'mono', startMs: clipEndMs - 400, endMs: clipEndMs, params: { amount: 1, rampMs: 300, contrast: 0.15 }, why: 'and drain its colour while it holds', confidence: 0.5 });
  }
  // one colour beat: green on a win, pink on affection
  const tint = tintBeat(m.clipWords, clipStartMs + 1500);
  if (tint) out.push({ type: 'tint', startMs: tint.ms, endMs: Math.min(clipEndMs, tint.ms + 450), params: { color: tint.color, opacity: 0.3 }, why: `${tint.why} ("${tint.word}")`, confidence: 0.45 });
  // "three, two, one" on screen
  const count = countdownIn(m.clipWords);
  if (count) out.push({ type: 'counter', startMs: count.startMs, endMs: Math.min(clipEndMs, count.endMs), params: { mode: 'count', from: count.from, to: count.to, stepMs: count.stepMs, label: '', x: 0.5, y: 0.42, fontSize: 220, color: '#FFE14D' }, why: `the countdown said out loud (${count.from} to ${count.to})`, confidence: 0.6 });
  // a cut that skips a long stretch says so
  for (const sk of m.skips.filter((x) => x.endMs - x.startMs >= 20_000).slice(0, 2)) {
    const secs = Math.round((sk.endMs - sk.startMs) / 1000);
    const label = secs >= 90 ? `*${Math.round(secs / 60)} MINUTES LATER*` : `*${secs} SECONDS LATER*`;
    out.push({ type: 'text', startMs: sk.endMs, endMs: Math.min(clipEndMs, sk.endMs + 1400), params: { text: label, style: 'street', y: m.hookY, fontSize: 70, animation: 'pop' }, why: `the cut skips ${secs} s: a time-skip card`, confidence: 0.55 });
  }
  // "look at this": the stream alone for 2 s (a split only; never over the facecam-only laugh)
  const look = m.split ? lookCue(m.clipWords, clipStartMs + 1500) : null;
  const camSpan = out.find((x) => x.type === 'solo');
  if (look && !(camSpan && look.startMs < camSpan.endMs! && look.startMs + 2000 > camSpan.startMs)) {
    out.push({ type: 'solo', startMs: look.startMs, endMs: Math.min(clipEndMs, look.startMs + 2000), params: { show: 'game' }, why: `the stream alone on "${look.text}"`, confidence: 0.5 });
  }
  // what chat said about it, as a chat card, after the premise box and clear of the end
  if (m.chatLine) {
    // clear of what any cut removes (the clip's own and the ones proposed above), so it is on screen for all 2.2 s
    const removed = [...m.skips, ...out.filter((x) => x.type === 'cut' && x.endMs !== undefined).map((x) => ({ startMs: x.startMs, endMs: x.endMs! }))];
    const at = chatCardAt(Math.max(clipStartMs + 3800, Math.min(m.chatLine.ms - 6000, clipEndMs - 2600)), 2200, removed, clipStartMs + 3800, clipEndMs);
    if (at !== null) out.push({ type: 'text', startMs: at, endMs: at + 2200, params: { text: `${m.chatLine.user}: ${m.chatLine.text}`, style: 'chat', y: m.hookY, fontSize: 54, animation: 'pop' }, why: `chat's line about it (${m.chatLine.echoes} said it)`, confidence: m.chatLine.echoes >= 2 ? 0.55 : 0.4 });
  }
  if (m.comicPauses.length) notes.push(`kept ${m.comicPauses.length} pause${m.comicPauses.length > 1 ? 's' : ''} that run into a reaction: the beat before the laugh is the timing of the joke`);
  // a long run-up to the reaction: speed the middle of it, never the two seconds before the hit
  if (m.reactionMs !== null && m.reactionMs - clipStartMs > 12_000) {
    const from = clipStartMs + 3000;
    const to = Math.min(m.reactionMs - 3000, from + 4000);
    if (to - from >= 2000) out.push({ type: 'speed', startMs: from, endMs: to, params: { rate: 1.25 }, why: `${((m.reactionMs - clipStartMs) / 1000).toFixed(0)} s of run-up before the reaction: speed its middle, keep the lines right before the hit at normal speed`, confidence: 0.4 });
  }
  if (m.reactionMs !== null && clipEndMs - m.reactionMs > 9000) notes.push(`the clip runs ${((clipEndMs - m.reactionMs) / 1000).toFixed(0)} s past the first reaction: for a loop, trim the out-point to a beat after the hit (\`clip trim\`)`);
  if (!m.captions) notes.push('captions are off: that is the subtitle expert\'s call (`clip subtitles`), not changed here');
  return { suggestions: out, notes };
}

/** Expert edits: protect the story, remove everything that is not it. */
export function expertSuggestions(m: EditorMetrics, cand: Candidate | undefined, clipStartMs: number): { suggestions: EditorSuggestion[]; notes: string[] } {
  const out: EditorSuggestion[] = [];
  const notes: string[] = [];
  const clipEndMs = clipStartMs + m.durationMs;
  // a silent open before the first word, unless something audible (a scream, a laugh) is the open
  const openReaction = m.reactions.some((r) => r.ms < (m.firstWordMs ?? Infinity));
  if (m.firstWordRelMs !== null && m.firstWordRelMs > 1200 && !openReaction) {
    out.push({ type: 'cut', startMs: clipStartMs, endMs: clipStartMs + m.firstWordRelMs - 200, params: { transition: 'none' }, why: `first word is ${(m.firstWordRelMs / 1000).toFixed(1)} s in; start on it`, confidence: 0.85 });
  }
  const gaps = cuttableGaps(m, 100);
  for (const cut of gaps.cuts) out.push({ type: 'cut', ...cut, params: { transition: 'none' }, why: 'dead air between sentences', confidence: 0.8 });
  if (gaps.leftMs > 1500 && gaps.cuts.length < m.deadAirGaps.length && m.durationMs - MIN_CLIP_MS < m.deadAirMs) notes.push(leftNote(gaps.leftMs, m));
  if (!m.hasHookText) {
    const hook = hookText(cand, 8);
    if (hook.text) out.push({ type: 'text', startMs: clipStartMs, endMs: clipStartMs + 3000, params: { text: hook.text, style: m.hookStyle, y: m.hookY, fontSize: m.hookStyle === 'street' ? 70 : 58, animation: 'fade' }, why: 'a context line: who this is and what is at stake, for a viewer who has never seen the stream', confidence: hook.shortened ? 0.45 : 0.68 });
    if (hook.shortened) notes.push(`context hook was cut down from "${cand?.hook ?? cand?.title}": rewrite it as 8 words or fewer`);
  }
  if (m.keyLineMs !== null) {
    const end = Math.min(clipEndMs, Math.max(m.keyLineEndMs ?? 0, m.keyLineMs + 1200));
    out.push({ type: 'zoom', startMs: m.keyLineMs, endMs: end, params: { scale: 1.12, easing: 'smooth', rampMs: 600, focusX: 0.5, focusY: 0.42 }, why: 'a slow push-in on the key line', confidence: 0.5 });
  }
  if (m.endsQuestion) notes.push('ends on a question: the answer is outside the cut. Extend the out-point to include it, or trim back to the last line that lands (`clip trim --out`)');
  if (m.durationS > 55) notes.push(`${m.durationS} s is long for a Short: trim about ${Math.round(m.durationS - 45)} s, keeping the setup line and the payoff`);
  if (!m.captions) notes.push('captions are off: that is the subtitle expert\'s call (`clip subtitles`), not changed here');
  return { suggestions: out, notes };
}

export async function reviewClip(clipId: string, mode: EditorMode): Promise<EditorReview> {
  const p = loadProject(clipId);
  const cand = loadCandidates(p.videoId).candidates.find((c) => c.id === p.candidateId);
  const t = readJsonIf<Transcript>(paths.videoFile(p.videoId, 'transcript.json'));
  const ae = readJsonIf<AudioEventsFile>(paths.videoFile(p.videoId, 'audio-events.json'));
  const qa = loadQa(clipId);
  // what the cuts remove (any time marker whose effect removes footage), and the moment's chat
  const types = await loadMarkerSchemas();
  const { timeMarkers } = await import('../markers/define');
  const skips = timeMarkers(p.markers, (x) => types.get(x)).filter((x) => x.effect.kind === 'remove' && x.endMs !== undefined).map((x) => ({ startMs: x.startMs, endMs: x.endMs! }));
  const { loadChat } = await import('../ingest/chat');
  const m = clipMetrics(p, cand, t, ae, qa, { chat: loadChat(p.videoId)?.messages, skips });
  const score = mode === 'meme' ? memeScore(m) : expertScore(m);
  const { suggestions, notes } = mode === 'meme' ? memeSuggestions(m, cand, p.segments[0].startMs) : expertSuggestions(m, cand, p.segments[0].startMs);
  const risks: string[] = [];
  if (!m.rendered) risks.push('not rendered yet: no QA to go on');
  else if (!m.qaPassed) risks.push('QA failed on the last render');
  if (m.endsQuestion) risks.push('ends on a question');
  if (m.deadAirMs > 1500) risks.push(`${(m.deadAirMs / 1000).toFixed(1)} s of dead air`);
  if (!t) risks.push('no transcript: edits are placed without words');
  if (!ae) risks.push('audio was not analysed: no laughs or screams to place edits on');
  const verdict = score >= 70 ? 'strong' : score >= 50 ? 'possible' : 'weak';
  // counts, not a verdict: whether it is a meme or a story was decided by the experts and the curator
  const summary =
    mode === 'meme'
      ? `${m.laughs} laugh${m.laughs === 1 ? '' : 's'}, ${m.screams} scream${m.screams === 1 ? '' : 's'} heard in ${m.durationS} s · chat ${m.signalChat} · ${(m.deadAirMs / 1000).toFixed(1)} s dead air`
      : `${m.durationS} s · first word at ${m.firstWordRelMs === null ? '—' : `${(m.firstWordRelMs / 1000).toFixed(1)} s`} · ${(m.deadAirMs / 1000).toFixed(1)} s dead air${m.endsQuestion ? ' · ends on a question' : ''}`;
  return { clipId, mode, score, verdict, summary, suggestions, notes, risks, metrics: m };
}

const overlaps = (m: Marker, startMs: number, endMs: number) => m.startMs < endMs && (m.endMs ?? m.startMs + 1) > startMs;

export async function applyEditorSuggestions(clipId: string, mode: EditorMode, opts: { accept?: boolean } = {}): Promise<{ review: EditorReview; added: number; skipped: number }> {
  const source = `editor:${mode}`;
  // re-running replaces this editor's previous pass: take it off first, so the review does not see its own
  // old premise box as "a hook is already there" and drop it
  let p = loadProject(clipId);
  if (p.markers.some((m) => m.source === source)) {
    saveProject({ ...p, markers: p.markers.filter((m) => m.source !== source) });
    p = loadProject(clipId);
  }
  const review = await reviewClip(clipId, mode);
  const types = await loadMarkerSchemas();
  let added = 0;
  let skipped = 0;
  for (const s of review.suggestions) {
    const meta = types.get(s.type);
    if (!meta) continue;
    const parsed = meta.params.safeParse(s.params);
    if (!parsed.success) continue;
    const startMs = Math.round(s.startMs);
    const endMs = Math.round(s.endMs ?? s.startMs + (meta.defaultDurationMs ?? 1200));
    // One edit per moment, whoever proposed it: the other editor, autoedit, the silence finder or a
    // person may already have a cut, a zoom or a hook text there.
    const taken = p.markers.some((m) => m.type === s.type && (meta.kind === 'span' ? overlaps(m, startMs, endMs) : Math.abs(m.startMs - startMs) < 400));
    if (taken) {
      skipped++;
      continue;
    }
    const marker: Marker = { id: newMarkerId(), type: s.type, startMs, ...(meta.kind === 'span' ? { endMs } : {}), params: parsed.data, ...(opts.accept ? {} : { proposed: true }), source };
    p.markers.push(marker);
    added++;
  }
  p.markers.sort((a, b) => a.startMs - b.startMs);
  saveProject(p);
  return { review, added, skipped };
}
