import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

export default defineMarker({
  type: 'shake',
  label: 'Shake',
  description: 'Camera shake for impact moments.',
  kind: 'span',
  layer: 'camera',
  color: '#f97316',
  order: 2,
  defaultDurationMs: 600,
  params: z.object({
    intensity: z.number().min(0).max(1).default(0.5).describe('How hard (1 = 40 px)'),
    speed: z.number().min(2).max(30).default(14).describe('Shakes per second'),
    rotate: z.boolean().default(true).describe('Add a little rotation'),
    decay: z.boolean().default(true).describe('Fade the shake out over the span'),
  }),
});
