// The censor pass (reports/censorship-review-2026-11-22.md, B2): a bleep over every slur said in the
// clip and over the f-words in its open, placed from the transcript's word times. A slur said is never
// posted (src/qa/unsafe.ts) and an f-word in the first 3 s is held through the careful period; a bleep
// clears both, because a word under it is not heard (wordsThatPlay). The captions mask the text by
// themselves (captions.censor); this is the sound.
//
// Re-running replaces this pass's bleeps (source editor:censor). A word already under someone else's
// bleep is left alone. Like the other editors it can propose instead of placing; by default it places,
// because an unplaced bleep changes nothing the checks or the viewer see.
import { loadProject, saveProject, newMarkerId } from '../core/project';
import { slurIn, swearIn } from '../core/risk';
import { OPEN_MS } from '../qa/unsafe';
import type { Marker } from '../core/schemas';

export const CENSOR_SOURCE = 'editor:censor';
/** Each bleep starts this long before its word and ends this long after, so no consonant leaks. */
export const WORD_PAD_MS = 80;
/** Bleeps closer than this become one (two swears in a row are one bleep, not two clicks). */
const JOIN_MS = 150;

export type SwearScope = 'open' | 'all' | 'none';

export interface CensorWord {
  i: number;
  raw: string;
  startMs: number;
  endMs: number;
  /** On the clip's own clock. */
  atMs: number;
  muted?: boolean;
}

export interface CensorHit {
  i: number;
  word: string;
  why: 'slur' | 'f-word in the open' | string;
  startMs: number;
  endMs: number;
  atMs: number;
}

/** The words to bleep: every slur, and the swears `swears` asks for (the f-words in the open by default). Pure. */
export function censorTargets(words: CensorWord[], o: { swears?: SwearScope; openMs?: number } = {}): CensorHit[] {
  const scope = o.swears ?? 'open';
  const openMs = o.openMs ?? OPEN_MS;
  return words.flatMap((w) => {
    if (w.muted) return [];
    const bare = w.raw.replace(/[^\p{L}\p{N}]/gu, '');
    const slur = slurIn(bare);
    // "sped" is the slur only typed alone in chat; said, it is the verb
    if (slur && slur !== 'sped') return [{ i: w.i, word: bare, why: 'slur', startMs: w.startMs, endMs: w.endMs, atMs: w.atMs }];
    const swear = swearIn(bare);
    if (!swear || scope === 'none') return [];
    if (scope === 'all') return [{ i: w.i, word: bare, why: swear, startMs: w.startMs, endMs: w.endMs, atMs: w.atMs }];
    return swear === 'f-word' && w.atMs < openMs ? [{ i: w.i, word: bare, why: 'f-word in the open', startMs: w.startMs, endMs: w.endMs, atMs: w.atMs }] : [];
  });
}

/** Bleep spans in source ms: each word padded, kept inside the clip, and joined when they touch. Pure. */
export function censorSpans(hits: CensorHit[], clip: { startMs: number; endMs: number }, pad = WORD_PAD_MS): { startMs: number; endMs: number; hits: CensorHit[] }[] {
  const out: { startMs: number; endMs: number; hits: CensorHit[] }[] = [];
  for (const h of [...hits].sort((a, b) => a.startMs - b.startMs)) {
    const s = Math.max(clip.startMs, h.startMs - pad);
    const e = Math.min(clip.endMs, Math.max(h.endMs, h.startMs + 120) + pad);
    const last = out[out.length - 1];
    if (last && s - last.endMs < JOIN_MS) {
      last.endMs = Math.max(last.endMs, e);
      last.hits.push(h);
    } else out.push({ startMs: s, endMs: e, hits: [h] });
  }
  return out;
}

export interface CensorResult {
  clipId: string;
  hits: CensorHit[];
  spans: { startMs: number; endMs: number; hits: CensorHit[] }[];
  /** Bleeps from an earlier pass that this one replaced. */
  replaced: number;
  saved: boolean;
}

/**
 * Bleep the clip. `review` only reports; `propose` adds the bleeps as proposed markers (the reviewer
 * accepts them); `sound: 'mute'` silences without the tone.
 */
export async function censorClip(
  clipId: string,
  o: { swears?: SwearScope; sound?: 'tone' | 'mute'; propose?: boolean; review?: boolean } = {},
): Promise<CensorResult> {
  const { wordsThatPlay } = await import('../qa/adult');
  let p = loadProject(clipId);
  const mine = p.markers.filter((m) => m.source === CENSOR_SOURCE);
  // this pass's earlier bleeps come off first, so the words under them are found again
  if (mine.length && !o.review) {
    p.markers = p.markers.filter((m) => m.source !== CENSOR_SOURCE);
    saveProject(p);
    p = loadProject(clipId);
  }
  let words: CensorWord[] = [];
  try {
    const all = await wordsThatPlay(clipId);
    // in review mode this pass's own bleeps are still on, so the words under them count as unbleeped
    const ownSpans = o.review ? mine.map((m) => ({ s: m.startMs, e: m.endMs ?? m.startMs })) : [];
    words = all.map((w) => ({ ...w, muted: w.muted && !ownSpans.some((x) => w.startMs < x.e && w.endMs > x.s) }));
  } catch {
    // no transcript: nothing to bleep from
  }
  const hits = censorTargets(words, { swears: o.swears });
  const seg = p.segments[0];
  const spans = censorSpans(hits, seg);
  if (o.review) return { clipId, hits, spans, replaced: 0, saved: false };
  const add: Marker[] = spans.map((s) => ({
    id: newMarkerId(),
    type: 'bleep',
    startMs: Math.round(s.startMs),
    endMs: Math.round(s.endMs),
    params: { sound: o.sound ?? 'tone', volume: 0.5 },
    source: CENSOR_SOURCE,
    ...(o.propose ? { proposed: true } : {}),
  }));
  if (add.length) {
    p.markers = [...p.markers, ...add].sort((a, b) => a.startMs - b.startMs);
    saveProject(p);
  }
  return { clipId, hits, spans, replaced: mine.length, saved: add.length > 0 || mine.length > 0 };
}
