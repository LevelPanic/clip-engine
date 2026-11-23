import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

export default defineMarker({
  type: 'text',
  label: 'Text',
  description: 'On-screen text such as the hook line at the top.',
  kind: 'span',
  layer: 'overlay',
  color: '#22c55e',
  order: 5,
  zIndex: 30,
  defaultDurationMs: 3000,
  params: z.object({
    text: z.string().default('WAIT FOR IT').describe('What it says'),
    style: z
      .enum(['hook', 'outline', 'highlight', 'street', 'comment', 'title', 'box', 'chat'])
      .default('hook')
      .describe('hook: white on black · outline: stroked · highlight: on yellow · street: heavy italic caps with an outline (matches street captions) · comment: sentence-case italic with an outline (a narrator line) · title: white on a red box (a title bar) · box: black on white strips, one per line (the premise box clip channels open with) · chat: a Twitch chat message card, "name: message"'),
    y: z.number().min(0.05).max(0.95).default(0.2).describe('Vertical position (fraction of height)'),
    fontSize: z.number().int().min(30).max(160).default(64).describe('Size in px'),
    animation: z.enum(['pop', 'fade', 'none']).default('pop').describe('How it appears'),
  }),
});
