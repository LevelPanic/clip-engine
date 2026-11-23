import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

export default defineMarker({
  type: 'sfx',
  label: 'SFX',
  description: 'Play a sound from assets/sfx/ at this moment (the boom on the punchline).',
  kind: 'point',
  layer: 'audio',
  color: '#ef4444',
  order: 4,
  renderMs: 6000, // long enough for any one-shot; the file ends when it ends
  params: z.object({
    sound: z.string().default('boom.wav').meta({ ui: 'sfx' }).describe('File in assets/sfx/'),
    volume: z.number().min(0).max(2).default(0.9).describe('1 = original level'),
  }),
});
