// Caption looks: how the words are drawn. Browser-safe data, read by the caption renderer, the
// Studio, QA (how wide a page may get) and the subtitle engine (which look a clip gets).
//
// Studied on the top streamer-clip Shorts of 2025–26 (SpeedUniverse 9.1M, Jynxzi 8.5M, Kai Cenat
// Shorts, ClipsTycoon, MoreCaseOh, xQc Clips; reports/edits-research-2026-11-18.md). What they share:
// short phrases, not a running transcript; a heavy italic with a thick outline in the middle of the
// picture; a whole phrase turned yellow when it is the beat, not every word lit up in turn; and often
// no captions at all. The old default (`bold`: Montserrat 900 caps, every spoken word turning yellow)
// is the look every auto-captioner ships, which is why our clips looked like default settings.

export type CaptionLookKey = 'street' | 'commentary' | 'comic' | 'native' | 'bold' | 'boxed' | 'clean';

/** How the highlight colour is used: the word being said, a whole phrase that is shouted, a colour per phrase, or never. */
export type HighlightMode = 'word' | 'loud' | 'cycle' | 'none';

export interface CaptionLook {
  key: CaptionLookKey;
  label: string;
  /** Font family key, resolved in src/composition/fonts.ts. */
  font: 'barlow' | 'montserrat' | 'luckiest' | 'poppins';
  weight: number;
  italic: boolean;
  /** Average glyph width in em at this font (caps when `uppercase`); the renderer shrinks a page that would not fit. */
  em: number;
  /** Outline width as a fraction of the font size (0 = none). */
  stroke: number;
  shadow: 'none' | 'soft' | 'hard';
  highlight: HighlightMode;
  /** Most words on screen at once (0 = as many as fit the timing). */
  maxWords: number;
  uppercase: boolean;
  /** The size it is designed at, in px. */
  fontSize: number;
  animation: 'pop' | 'snap' | 'rise' | 'none';
  /** A box behind the words. */
  box: boolean;
}

export const CAPTION_LOOKS: Record<CaptionLookKey, CaptionLook> = {
  street: {
    key: 'street',
    label: 'Street: 2–3 word phrases, heavy italic, thick outline, a shouted phrase in colour',
    font: 'barlow',
    weight: 800,
    italic: true,
    em: 0.5,
    stroke: 0.14,
    shadow: 'soft',
    highlight: 'loud',
    maxWords: 3,
    uppercase: true,
    fontSize: 96,
    animation: 'snap',
    box: false,
  },
  commentary: {
    key: 'commentary',
    label: 'Commentary: sentence case italic with an outline, a line at a time (talk, stories)',
    font: 'montserrat',
    weight: 800,
    italic: true,
    em: 0.58,
    stroke: 0.12,
    shadow: 'soft',
    highlight: 'loud',
    maxWords: 6,
    uppercase: false,
    fontSize: 68,
    animation: 'rise',
    box: false,
  },
  comic: {
    key: 'comic',
    label: 'Comic: chunky caps, each phrase its own colour (memes, countdowns)',
    font: 'luckiest',
    weight: 400,
    italic: false,
    em: 0.66,
    stroke: 0.12,
    shadow: 'hard',
    highlight: 'cycle',
    maxWords: 3,
    uppercase: true,
    fontSize: 84,
    animation: 'pop',
    box: false,
  },
  native: {
    key: 'native',
    label: 'Native: plain sentence-case text like the app’s own, a thin outline (calm clips)',
    font: 'poppins',
    weight: 600,
    italic: false,
    em: 0.56,
    stroke: 0.07,
    shadow: 'soft',
    highlight: 'none',
    maxWords: 7,
    uppercase: false,
    fontSize: 60,
    animation: 'none',
    box: false,
  },
  bold: {
    key: 'bold',
    label: 'Karaoke (the old default): caps, every spoken word lit up in turn',
    font: 'montserrat',
    weight: 900,
    italic: false,
    em: 0.72,
    stroke: 0.17,
    shadow: 'none',
    highlight: 'word',
    maxWords: 0,
    uppercase: true,
    fontSize: 78,
    animation: 'pop',
    box: false,
  },
  boxed: {
    key: 'boxed',
    label: 'Boxed: white on a dark box (busy screens)',
    font: 'montserrat',
    weight: 800,
    italic: false,
    em: 0.66,
    stroke: 0,
    shadow: 'none',
    highlight: 'word',
    maxWords: 0,
    uppercase: false,
    fontSize: 70,
    animation: 'pop',
    box: true,
  },
  clean: {
    key: 'clean',
    label: 'Clean: white with a shadow',
    font: 'montserrat',
    weight: 700,
    italic: false,
    em: 0.6,
    stroke: 0,
    shadow: 'soft',
    highlight: 'word',
    maxWords: 0,
    uppercase: false,
    fontSize: 70,
    animation: 'pop',
    box: false,
  },
};

export const CAPTION_LOOK_KEYS = Object.keys(CAPTION_LOOKS) as CaptionLookKey[];
export const lookOf = (style: string): CaptionLook => CAPTION_LOOKS[style as CaptionLookKey] ?? CAPTION_LOOKS.street;

/** Colours a `cycle` look gives its phrases in turn (the countdown channels' lime, pink, cyan, yellow). */
export const CYCLE_COLORS = ['#FFFFFF', '#7CFF4F', '#FF5DB1', '#4FE3FF', '#FFE14D'];

const SHOUTED = /^[^a-z]*[A-Z]{3,}[^a-z]*$/;

/**
 * Is this phrase the beat? Pure. A word written in capitals by the transcript (shouted), an exclamation,
 * or a word the editor marked (`emphasis`, word ids as strings). Questions are not loud.
 */
export function isLoud(tokens: { text: string; id?: number }[], emphasis: ReadonlySet<string> = new Set()): boolean {
  return tokens.some((t) => {
    const w = t.text.trim();
    return /!/.test(w) || SHOUTED.test(w) || (t.id !== undefined && emphasis.has(String(t.id)));
  });
}

/** Split caption pages so none holds more than `max` words, keeping each word's timing. Pure. */
export function splitPages<T extends { text: string; fromMs: number; toMs: number }>(
  pages: { text: string; startMs: number; durationMs: number; tokens: T[] }[],
  max: number,
): { text: string; startMs: number; durationMs: number; tokens: T[] }[] {
  if (!max) return pages;
  return pages.flatMap((p) => {
    if (p.tokens.length <= max) return [p];
    // even chunks: 7 words as 3+2+2 reads better than 3+3+1
    const n = Math.ceil(p.tokens.length / max);
    const base = Math.floor(p.tokens.length / n);
    const extra = p.tokens.length % n;
    const out: { text: string; startMs: number; durationMs: number; tokens: T[] }[] = [];
    for (let c = 0, i = 0; c < n; c++) {
      const size = base + (c < extra ? 1 : 0);
      const tokens = p.tokens.slice(i, i + size);
      i += size;
      const first = tokens[0];
      const last = tokens[tokens.length - 1];
      out.push({ text: tokens.map((t) => t.text).join('').trim(), startMs: first.fromMs, durationMs: last.toMs - first.fromMs, tokens });
    }
    return out;
  });
}
