import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

export default defineMarker({
  type: 'emoji',
  label: 'Emoji',
  description: 'A big emoji that pops in and floats away: 😂 on a laugh, 💀 on a roast, 🔥 on a flex.',
  kind: 'point',
  layer: 'overlay',
  color: '#fbbf24',
  order: 10,
  zIndex: 35,
  renderMs: (p) => p.durationMs,
  params: z.object({
    emoji: z.string().default('😂').describe('One or two emoji'),
    size: z.number().int().min(60).max(500).default(220).describe('Size in px'),
    x: z.number().min(0.05).max(0.95).default(0.78).describe('Horizontal position'),
    y: z.number().min(0.05).max(0.95).default(0.32).describe('Vertical position'),
    durationMs: z.number().int().min(300).max(3000).default(1100).describe('How long it stays'),
  }),
});
