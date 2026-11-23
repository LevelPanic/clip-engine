// How wide each caption look's glyphs are, on average, in em. Used by the caption renderer to shrink a
// page that wouldn't fit and by QA to flag words that had to shrink a lot. The numbers live with the
// looks (src/core/captionLooks.ts).
import { CAPTION_LOOKS, type CaptionLookKey } from './captionLooks';

export const CHAR_EM = Object.fromEntries(Object.values(CAPTION_LOOKS).map((l) => [l.key, l.em])) as Record<CaptionLookKey, number>;
export const CAPTION_WIDTH = 900;
