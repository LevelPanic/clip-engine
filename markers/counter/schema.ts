import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

// A number on screen that changes as the clip plays (docs/research/meme-edits-2026-11-22.md: 14% of top clip
// Shorts): "3, 2, 1" over a countdown, a points tally, a "ROACH COUNTER", a stopwatch proving "2 SECONDS".
export default defineMarker({
  type: 'counter',
  label: 'Counter',
  description: 'A big number that steps from one value to another (3, 2, 1; a tally) or a running stopwatch, with an optional label.',
  kind: 'span',
  layer: 'overlay',
  color: '#facc15',
  order: 16,
  zIndex: 32,
  defaultDurationMs: 3000,
  params: z.object({
    mode: z.enum(['count', 'stopwatch']).default('count').describe('count: from → to, one step every stepMs · stopwatch: seconds since the marker started'),
    from: z.number().int().min(-999).max(9999).default(3).describe('First number (count)'),
    to: z.number().int().min(-999).max(9999).default(1).describe('Last number (count); it stays on it'),
    stepMs: z.number().int().min(100).max(10000).default(1000).describe('Time per step (count)'),
    label: z.string().default('').describe('A line over the number (e.g. ROACH COUNTER); empty for none'),
    x: z.number().min(0.05).max(0.95).default(0.5).describe('Horizontal position'),
    y: z.number().min(0.05).max(0.95).default(0.42).describe('Vertical position'),
    fontSize: z.number().int().min(40).max(400).default(220).describe('Size of the number in px'),
    color: z.string().default('#FFE14D').meta({ ui: 'color' }).describe('Colour of the number'),
  }),
});

/** What the counter shows `ms` after it starts, and which step that is (a new step pops in). Pure. */
export function counterAt(p: { mode: 'count' | 'stopwatch'; from: number; to: number; stepMs: number }, ms: number): { text: string; step: number } {
  if (p.mode === 'stopwatch') {
    const cs = Math.max(0, Math.floor(ms / 10));
    return { text: `${String(Math.floor(cs / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`, step: 0 };
  }
  const dir = p.to >= p.from ? 1 : -1;
  const steps = Math.abs(p.to - p.from);
  const step = Math.min(steps, Math.max(0, Math.floor(ms / p.stepMs)));
  return { text: String(p.from + dir * step), step };
}
