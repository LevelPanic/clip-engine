import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

// One picture of the split alone, for the span (reports/meme-edits-2026-11-22.md: top clip Shorts cut to the
// facecam alone on the laugh in 21% of them, to the stream alone in 16%; half of those land on a sudden
// sound). The layout goes back to the split when the span ends. It needs a split to pick from: over
// blur-fit or a crop (no facecam found, or the split fell back) it does nothing (`resolveKeys`).
export default defineMarker({
  type: 'solo',
  label: 'Cam / game only',
  description: 'For the span, show only the facecam (the laugh, the face) or only the stream (look at this), then go back to the split.',
  kind: 'span',
  layer: 'framing',
  color: '#2dd4bf',
  order: 18,
  defaultDurationMs: 1600,
  params: z.object({
    show: z.enum(['cam', 'game']).default('cam').describe('cam: the facecam fills the frame (up to 3.5×) · game: the stream fills it'),
  }),
  framing: (p) => ({ mode: p.show, cropX: 0.5, easeMs: 0, untilEnd: true }),
});
