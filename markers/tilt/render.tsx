import { Easing, interpolate } from 'remotion';
import type { z } from 'zod';
import { defineRender } from '../../src/markers/define';
import type schema from './schema';

type P = z.infer<typeof schema.params>;

/** The scale that keeps a w×h frame covered when it is rotated by `deg`. Pure. */
export function tiltCover(deg: number, w: number, h: number): number {
  const r = (Math.abs(deg) * Math.PI) / 180;
  return Math.cos(r) + Math.max(w / h, h / w) * Math.sin(r);
}

export default defineRender<P>({
  camera: (p, { frame, durationInFrames, fps, width, height }) => {
    let k = 1;
    if (p.easing === 'smooth') {
      const ramp = Math.min(Math.max(1, Math.round((p.rampMs / 1000) * fps)), Math.floor(durationInFrames / 2));
      const opts = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) } as const;
      k = Math.min(interpolate(frame, [0, ramp], [0, 1], opts), interpolate(frame, [durationInFrames - ramp, durationInFrames], [1, 0], opts));
    }
    const deg = p.degrees * k;
    const s = tiltCover(deg, width, height);
    // rotate and scale around the centre (transform-origin is 0 0)
    return `translate(${width / 2}px, ${height / 2}px) rotate(${deg}deg) scale(${s}) translate(${-width / 2}px, ${-height / 2}px)`;
  },
});
