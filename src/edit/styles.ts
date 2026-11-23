// Edit styles: named recipes for the popular short-form edits. autoedit applies one to a clip:
// it finds the moments (punchlines before laughs, shouted lines, sentence starts, dead air) and the
// style decides what happens there. Browser-safe, so the Studio can list them.
import type { CaptionSettings } from '../core/schemas';

export type CutTransition = 'none' | 'crossfade' | 'whip' | 'flash' | 'zoom' | 'glitch';

export interface EditStyle {
  key: string;
  label: string;
  description: string;
  captions?: Partial<Omit<CaptionSettings, 'fixes' | 'position'>>;
  /** On-screen hook text over the opening. */
  hook: { style: 'hook' | 'highlight' | 'outline' | 'street' | 'comment' | 'title' } | null;
  /** What lands on a punchline (the content word just before a laugh). */
  punch: {
    zoom?: { scale: number; easing: 'snap' | 'smooth' };
    sfx?: string[]; // picked at random (stable per clip)
    sfxOn?: 'all' | 'first-last';
    flash?: boolean; // on the first punchline
    shake?: boolean;
    emoji?: string[]; // popped on the laugh
    riser?: boolean; // a riser building into the biggest (last) punchline
  } | null;
  /** No laughs in the clip: a slow push-in on the quoted line. */
  pushIn: boolean;
  /** "Retention" punch-ins: a snap zoom on every other sentence, so the frame keeps moving. */
  retention?: { minSentenceMs: number; scale: number };
  /** SHOUTED words (all caps in the captions) and exclamations. */
  emphasis?: { sfx: string[]; zoom: number };
  /** A shake where the audio hears shouting or screaming. */
  shouts?: boolean;
  /** Dead-air jump cuts and what happens at each join. */
  cuts: { silence: boolean; transition: CutTransition; sfx?: string };
}

export const STYLES: EditStyle[] = [
  {
    key: 'clean',
    label: 'Clean',
    description: 'Captions, hook text, dead-air cuts and one slow push-in. No sound effects.',
    captions: { style: 'native', uppercase: false, fontSize: 60 },
    hook: { style: 'comment' },
    punch: null,
    pushIn: true,
    cuts: { silence: true, transition: 'none' },
  },
  {
    key: 'punch',
    label: 'Podcast punch',
    description: 'Snap zoom and a boom on punchlines, a flash on the first, dead-air cuts.',
    captions: { style: 'street', uppercase: true, fontSize: 96 },
    hook: { style: 'street' },
    punch: { zoom: { scale: 1.35, easing: 'snap' }, sfx: ['boom.wav', 'pop.wav'], sfxOn: 'first-last', flash: true },
    pushIn: true,
    cuts: { silence: true, transition: 'none' },
  },
  {
    key: 'hype',
    label: 'Hype / meme',
    description:
      'Random booms, shakes and emoji pops on laughs, a riser into the payoff, punch-ins on every other sentence, glitch jump cuts, pops on shouted words.',
    captions: { style: 'street', uppercase: true, fontSize: 100, highlightColor: '#FFE14D' },
    hook: { style: 'street' },
    punch: {
      zoom: { scale: 1.4, easing: 'snap' },
      sfx: ['boom.wav', 'bass-drop.wav', 'pop.wav'],
      sfxOn: 'all',
      flash: true,
      shake: true,
      emoji: ['😂', '💀', '🤣', '😭'],
      riser: true,
    },
    pushIn: false,
    retention: { minSentenceMs: 1800, scale: 1.12 },
    emphasis: { sfx: ['pop.wav', 'shutter.wav'], zoom: 1.2 },
    shouts: true,
    cuts: { silence: true, transition: 'glitch', sfx: 'glitch.wav' },
  },
  {
    key: 'story',
    label: 'Story',
    description: 'Smooth push-ins, crossfades with a whoosh on cuts, sentence-case italic captions. Calm and clean.',
    captions: { style: 'commentary', uppercase: false, fontSize: 68 },
    hook: { style: 'comment' },
    punch: { zoom: { scale: 1.15, easing: 'smooth' } },
    pushIn: true,
    cuts: { silence: true, transition: 'crossfade', sfx: 'whoosh.wav' },
  },
];

export const styleByKey = (key: string | undefined) => STYLES.find((s) => s.key === key) ?? STYLES.find((s) => s.key === 'punch')!;
