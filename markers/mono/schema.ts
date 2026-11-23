import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

// Colour drains out of the picture (reports/meme-edits-2026-11-22.md: 14% of top clip Shorts), most often on a
// fail ending with a freeze: the last frame holds and goes grey. A `filter` hook: the video only, so the
// captions, the credit and any text stay in colour.
export default defineMarker({
  type: 'mono',
  label: 'B&W',
  description: 'Drain the colour from the picture for the span: the fail ending, the freeze on a loss, a sad beat.',
  kind: 'span',
  layer: 'camera',
  color: '#a1a1aa',
  order: 14,
  defaultDurationMs: 1500,
  filter: (p, tMs) => {
    const k = p.rampMs > 0 ? Math.min(1, tMs / p.rampMs) : 1;
    return `grayscale(${(p.amount * k).toFixed(3)}) contrast(${(1 + p.contrast * k).toFixed(3)})`;
  },
  params: z.object({
    amount: z.number().min(0).max(1).default(1).describe('How much colour goes (1 = black and white)'),
    rampMs: z.number().int().min(0).max(2000).default(300).describe('How long the colour takes to drain'),
    contrast: z.number().min(0).max(0.6).default(0.15).describe('Extra contrast, so grey does not read as washed out'),
  }),
});
