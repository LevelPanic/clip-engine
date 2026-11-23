import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

// The frame rotates a few degrees (reports/meme-edits-2026-11-22.md: 27% of top clip Shorts, most often
// together with a snap zoom on a shout, alternating sides). It is scaled up just enough that no corner ever
// shows (`tiltCover`).
export default defineMarker({
  type: 'tilt',
  label: 'Tilt',
  description: 'Rotate the frame a few degrees (a dutch tilt), on a shout or a punch-in; scaled so no corner shows.',
  kind: 'span',
  layer: 'camera',
  color: '#c084fc',
  order: 15,
  defaultDurationMs: 900,
  params: z.object({
    degrees: z.number().min(-25).max(25).default(6).describe('How far, clockwise (negative: the other way)'),
    easing: z.enum(['snap', 'smooth']).default('snap').describe('snap jumps to the angle; smooth eases in and out'),
    rampMs: z.number().int().min(0).max(1500).default(250).describe('Ease time in and out (smooth only)'),
  }),
});
