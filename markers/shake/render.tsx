import { random } from 'remotion';
import type { z } from 'zod';
import { defineRender } from '../../src/markers/define';
import type schema from './schema';

type P = z.infer<typeof schema.params>;

// Smooth noise: random values at `speed` per second, linearly blended between them.
const noise = (seed: string, x: number) => {
  const i = Math.floor(x);
  const f = x - i;
  const a = random(`${seed}-${i}`) * 2 - 1;
  const b = random(`${seed}-${i + 1}`) * 2 - 1;
  return a + (b - a) * f;
};

export default defineRender<P>({
  camera: (p, { frame, durationInFrames, fps, width, height, markerId }) => {
    const x = (frame / fps) * p.speed;
    const fade = p.decay ? 1 - frame / durationInFrames : 1;
    const amp = p.intensity * 40 * fade;
    const dx = noise(`${markerId}x`, x) * amp;
    const dy = noise(`${markerId}y`, x) * amp;
    const rot = p.rotate ? noise(`${markerId}r`, x) * 1.5 * p.intensity * fade : 0;
    const s = 1 + (2.2 * amp) / width; // zoom just enough that edges never show
    const cx = width / 2;
    const cy = height / 2;
    return `translate(${cx}px, ${cy}px) rotate(${rot}deg) scale(${s}) translate(${-cx + dx}px, ${-cy + dy}px)`;
  },
});
