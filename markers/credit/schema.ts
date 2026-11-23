import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

export default defineMarker({
  type: 'credit',
  label: 'Credit',
  description: 'Who the clip is from and where to find them. Stays on screen for the whole clip.',
  kind: 'point',
  layer: 'overlay',
  // the clip is someone else's stream: the credit never ends early, however the clip is trimmed
  fill: 'clip',
  color: '#38bdf8',
  order: 20,
  zIndex: 25,
  params: z.object({
    text: z.string().default('twitch.tv/creator').describe('The creator, the way a viewer would look them up'),
    label: z.string().default('🎥').describe('What goes before it'),
    y: z.number().min(0).max(0.97).default(0).describe('Vertical position (fraction of height). 0 = where the layout has room: between the two pictures of a split, near the top otherwise'),
    fontSize: z.number().int().min(20).max(60).default(30).describe('Size in px'),
    opacity: z.number().min(0.3).max(1).default(0.9).describe('How strong it is'),
  }),
});
