import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

export default defineMarker({
  type: 'cut',
  label: 'Cut',
  description: 'Remove this span (jump cut). The transition plays where the clip resumes.',
  kind: 'span',
  layer: 'time',
  color: '#94a3b8',
  order: 6,
  defaultDurationMs: 800,
  params: z.object({
    transition: z.enum(['none', 'crossfade', 'whip', 'flash', 'zoom', 'glitch']).default('none').describe('What happens at the join'),
    transitionMs: z.number().int().min(0).max(1000).default(200).describe('Transition length'),
  }),
  time: (p) => ({ effect: { kind: 'remove' }, transition: { kind: p.transition, durationMs: p.transition === 'none' ? 0 : p.transitionMs } }),
});
