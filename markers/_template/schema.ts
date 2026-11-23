// TEMPLATE: copy this folder to markers/<your-type>/ and set `type` to the folder name.
// Folders starting with "_" are ignored, so this one never shows up in the palette.
import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

export default defineMarker({
  type: '_template', // ← must equal the folder name
  label: 'Tint',
  description: 'Washes the frame in a colour for the span (example marker).',
  kind: 'span', // 'span' (start + end) or 'point' (one moment; set renderMs)
  layer: 'overlay', // 'camera' (return a transform), 'overlay' (draw on top) or 'audio' (play sound)
  color: '#06b6d4', // timeline colour
  order: 50, // palette position; 1–9 get number hotkeys
  zIndex: 15, // overlays only: captions sit at 20
  defaultDurationMs: 1500, // spans: length when dropped with M
  // renderMs: 400,        // points: how long the effect renders after the marker
  params: z.object({
    // Every param needs a default. min/max become sliders; enums become dropdowns.
    // .meta({ ui: 'color' }) gives a colour picker; .meta({ ui: 'sfx' }) a sound picker.
    color: z.string().default('#ff2d55').meta({ ui: 'color' }).describe('Tint colour'),
    opacity: z.number().min(0).max(1).default(0.35).describe('Strength'),
  }),
});
