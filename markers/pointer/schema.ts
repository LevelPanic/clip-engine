import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

// Point at something (reports/meme-edits-2026-11-22.md: an arrow, a circle, a label such as "0.1% CHANCE";
// Nick Eh 30's clip channel uses it in most Shorts). x/y is the thing pointed at, in the 9:16 frame.
export default defineMarker({
  type: 'pointer',
  label: 'Arrow',
  description: 'An arrow or a circle at a point in the frame, with an optional label: point at the item, the player, the number.',
  kind: 'span',
  layer: 'overlay',
  color: '#f87171',
  order: 17,
  zIndex: 33,
  defaultDurationMs: 2000,
  params: z.object({
    shape: z.enum(['arrow', 'circle']).default('arrow').describe('arrow points at x/y · circle rings it'),
    x: z.number().min(0).max(1).default(0.5).describe('What it points at: horizontal (fraction of the frame)'),
    y: z.number().min(0).max(1).default(0.5).describe('What it points at: vertical'),
    angle: z.number().min(0).max(359).default(315).describe('Arrow: the direction it comes from, in degrees (0 right, 90 down, 180 left, 270 up)'),
    size: z.number().int().min(60).max(700).default(260).describe('Arrow length or circle width in px'),
    label: z.string().default('').describe('Text at the arrow tail or above the circle; empty for none'),
    color: z.string().default('#FF2D2D').meta({ ui: 'color' }).describe('Colour'),
  }),
});

/** Where an arrow's tail is: `size` px from the point it aims at, in the direction it comes from. Pure. */
export function arrowTail(p: { x: number; y: number; angle: number; size: number }, w: number, h: number): { tx: number; ty: number; hx: number; hy: number } {
  const hx = p.x * w;
  const hy = p.y * h;
  const r = (p.angle * Math.PI) / 180;
  return { hx, hy, tx: hx + Math.cos(r) * p.size, ty: hy + Math.sin(r) * p.size };
}
