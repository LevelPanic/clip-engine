import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

export default defineMarker({
  type: 'reframe',
  label: 'Reframe',
  description: 'Change the framing from here on: crop to a position (cut or pan), go back to blur-fit, or switch to the split facecam/gameplay layout.',
  kind: 'point',
  layer: 'framing',
  color: '#14b8a6',
  order: 9,
  renderMs: 1,
  params: z.object({
    mode: z.enum(['crop', 'blur', 'split']).default('crop').describe('crop: fill the frame at cropX · blur: whole picture, blurred fill · split: facecam over gameplay'),
    cropX: z.number().min(0).max(1).default(0.5).describe('Crop position: 0 left, 0.5 centre, 1 right'),
    easeMs: z.number().int().min(0).max(3000).default(0).describe('Pan time between crops (0 = cut)'),
  }),
  framing: (p) => ({ mode: p.mode, cropX: p.cropX, easeMs: p.easeMs }),
});
