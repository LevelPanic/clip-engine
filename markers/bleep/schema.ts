import { z } from 'zod';
import { defineMarker } from '../../src/markers/define';

// The bleep (docs/research/censorship-review-2026-11-22.md, B2): the clip's own sound is silenced for the
// span, and a tone plays over it unless it is a plain mute. `clip censor` places one over each slur said
// and each f-word in the open, from the transcript's word times. A word under a bleep is not "said" for
// the never-post and careful checks (src/qa/adult.ts → wordsThatPlay).
export default defineMarker({
  type: 'bleep',
  label: 'Bleep',
  description: "Silence the clip's sound over a word (a slur, an f-word in the open, explicit lyrics) and play a bleep tone, or nothing, instead.",
  kind: 'span',
  layer: 'audio',
  color: '#f43f5e',
  order: 12,
  defaultDurationMs: 450,
  gain: () => 0,
  params: z.object({
    sound: z.enum(['tone', 'mute']).default('tone').describe('tone: a bleep over the silence · mute: silence only'),
    volume: z.number().min(0).max(1).default(0.5).describe("The tone's level (the export is loudness-normalised after)"),
  }),
});
