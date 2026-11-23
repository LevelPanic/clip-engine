import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

export default defineMarker({
  type: 'zoom',
  label: 'Zoom',
  description: 'Push in on a point ("snap" is an instant punch-in; "smooth" eases in and out), or start zoomed in and pull back to reveal (direction out).',
  kind: 'span',
  layer: 'camera',
  color: '#8b5cf6',
  order: 1,
  defaultDurationMs: 1500,
  params: z.object({
    scale: z.number().min(1).max(3).default(1.35).describe('How far to zoom (1 = none)'),
    easing: z.enum(['smooth', 'snap']).default('smooth').describe('smooth eases; snap cuts in and out'),
    rampMs: z.number().int().min(0).max(2000).default(300).describe('Ease time in and out (smooth only)'),
    focusX: z.number().min(0).max(1).default(0.5).describe('Horizontal focus: 0 left, 1 right'),
    focusY: z.number().min(0).max(1).default(0.42).describe('Vertical focus: 0 top, 1 bottom'),
    direction: z.enum(['in', 'out']).default('in').describe('in: push in and back out · out: start zoomed in and pull back over rampMs (the reveal)'),
  }),
});
