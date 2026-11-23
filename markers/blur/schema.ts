import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

// Hide part of the picture (docs/research/censorship-review-2026-11-22.md, B3): incidental nudity in the
// background, a slur in an on-screen chat, a bystander's face, a document. Not a fix for a clip whose
// subject is the nude body: a blurred shower scene is still a shower-scene clip (cut those, or drop them).
// The box is in the 9:16 frame's own coordinates, so it is placed on what the viewer sees, under the
// captions, the credit and any text. A static box: a moving subject needs one marker per stretch.
export default defineMarker({
  type: 'blur',
  label: 'Blur',
  description: 'Blur or black out a box of the picture for the span (incidental nudity, a slur in an on-screen chat, a bystander, a document).',
  kind: 'span',
  layer: 'overlay',
  color: '#64748b',
  order: 13,
  zIndex: 12, // over the picture, under tint (15), captions (20), the credit (25) and text (30)
  defaultDurationMs: 2000,
  params: z.object({
    x: z.number().min(0).max(1).default(0.3).describe('Left edge (fraction of the 9:16 frame width)'),
    y: z.number().min(0).max(1).default(0.4).describe('Top edge (fraction of the frame height)'),
    w: z.number().min(0.02).max(1).default(0.4).describe('Width (fraction of the frame width)'),
    h: z.number().min(0.02).max(1).default(0.2).describe('Height (fraction of the frame height)'),
    look: z.enum(['blur', 'black']).default('blur').describe('blur: soft, the scene still reads · black: nothing shows'),
    strength: z.number().min(6).max(80).default(36).describe('Blur radius in px'),
  }),
});
