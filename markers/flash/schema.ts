import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

export default defineMarker({
  type: 'flash',
  label: 'Flash',
  description: 'A full-frame flash that fades out. Good on a cut or a punchline.',
  kind: 'point',
  layer: 'overlay',
  color: '#facc15',
  order: 3,
  zIndex: 40,
  renderMs: (p) => p.durationMs,
  params: z.object({
    color: z.string().default('#ffffff').meta({ ui: 'color' }).describe('Flash colour'),
    durationMs: z.number().int().min(50).max(2000).default(250).describe('Fade-out length'),
    opacity: z.number().min(0.1).max(1).default(0.85).describe('Peak opacity'),
  }),
});
