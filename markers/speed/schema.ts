import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

export default defineMarker({
  type: 'speed',
  label: 'Speed',
  description: 'Play this span faster or slower (speed ramp). Audio keeps its pitch.',
  kind: 'span',
  layer: 'time',
  color: '#0ea5e9',
  order: 7,
  defaultDurationMs: 2000,
  params: z.object({
    rate: z.number().min(0.25).max(4).default(1.5).describe('Playback speed (1 = normal)'),
  }),
  time: (p) => ({ effect: { kind: 'speed', rate: p.rate } }),
});
