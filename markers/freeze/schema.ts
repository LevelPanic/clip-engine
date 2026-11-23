import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

export default defineMarker({
  type: 'freeze',
  label: 'Freeze',
  description: 'Hold this frame (silent) before playback continues: the reaction-face freeze.',
  kind: 'point',
  layer: 'time',
  color: '#e879f9',
  order: 8,
  renderMs: (p) => p.durationMs,
  params: z.object({
    durationMs: z.number().int().min(100).max(5000).default(1200).describe('How long to hold'),
    zoom: z.number().min(1).max(2).default(1.15).describe('Push in while frozen (1 = none)'),
  }),
  time: (p) => ({ effect: { kind: 'hold', durationMs: p.durationMs } }),
});
