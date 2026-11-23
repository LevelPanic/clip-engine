// Swearing, measured (docs/research/censorship-review-2026-11-22.md, A4): 61 of 62 clips with the f-word were
// never warned about it. QA now says how much strong swearing is heard, whether any is in the open (the
// careful period holds that), whether the captions show it unmasked, and whether the title swears. A
// warning, never a failure: a swear is the reviewer's call, a slur said is the never-post list's.
import { swearIn } from '../core/risk';
import { fmtTime } from '../core/time';
import { OPEN_MS } from './unsafe';

export interface LanguageCheck {
  /** Strong swears heard (bleeped ones are not), by kind. */
  heard: Record<string, number>;
  /** Swears under a bleep. */
  bleeped: number;
  /** The first f-word heard in the open, on the clip's clock. */
  openAtMs: number | null;
  /** Swears the captions show as they are (captions on, masking off). */
  captionsUnmasked: number;
  /** Swears in the post title. */
  title: string[];
}

/** Pure. `words` are the words that play (wordsThatPlay); `muted` ones are under a bleep. */
export function checkLanguage(e: { words: { raw: string; text: string; atMs: number; muted?: boolean }[]; captions: { enabled: boolean; censor?: boolean }; title: string }): LanguageCheck {
  const heard: Record<string, number> = {};
  let bleeped = 0;
  let openAtMs: number | null = null;
  let captionsUnmasked = 0;
  for (const w of e.words) {
    const kind = swearIn(w.raw);
    if (!kind) continue;
    if (w.muted) {
      bleeped++;
      continue;
    }
    heard[kind] = (heard[kind] ?? 0) + 1;
    if (kind === 'f-word' && w.atMs < OPEN_MS && openAtMs === null) openAtMs = w.atMs;
    if (e.captions.enabled && e.captions.censor === false && swearIn(w.text)) captionsUnmasked++;
  }
  const title = e.title.split(/\s+/).filter((t) => swearIn(t));
  return { heard, bleeped, openAtMs, captionsUnmasked, title };
}

/** The check as QA warnings, with what to do. Pure. */
export function languageWarnings(c: LanguageCheck): string[] {
  const out: string[] = [];
  const total = Object.values(c.heard).reduce((a, b) => a + b, 0);
  if (total) {
    const kinds = Object.entries(c.heard)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ×${n}`)
      .join(', ');
    out.push(`${total} strong swear${total === 1 ? '' : 's'} heard (${kinds})${c.bleeped ? `, ${c.bleeped} bleeped` : ''}`);
  }
  if (c.openAtMs !== null) out.push(`an f-word is heard in the first ${OPEN_MS / 1000} s (at ${fmtTime(c.openAtMs, 1)}): the careful period holds it; \`clip censor\` bleeps it`);
  if (c.captionsUnmasked) out.push(`the captions show ${c.captionsUnmasked} swear${c.captionsUnmasked === 1 ? '' : 's'} unmasked (captions.censor is off)`);
  if (c.title.length) out.push(`the title swears (${c.title.join(', ')}): say what happened instead`);
  return out;
}
