import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

export default defineMarker({
  type: 'glitch',
  label: 'Glitch',
  description: 'A short digital glitch: the picture jitters and skews under flickering colour bars.',
  kind: 'span',
  layer: 'camera',
  color: '#22d3ee',
  order: 11,
  zIndex: 42,
  defaultDurationMs: 350,
  params: z.object({
    intensity: z.number().min(0.1).max(1).default(0.6).describe('How hard'),
  }),
});
