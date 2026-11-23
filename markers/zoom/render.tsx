import { Easing, interpolate } from 'remotion';
import type { z } from 'zod';
import { defineRender } from '../../src/markers/define';
import type schema from './schema';

type P = z.infer<typeof schema.params>;

export default defineRender<P>({
  camera: (p, { frame, durationInFrames, fps, width, height }) => {
    let k = 1;
    if (p.direction === 'out') {
      // the reveal: zoomed in on the first frame, back to the full picture after rampMs (snap: 120 ms)
      const ramp = Math.max(1, Math.round(((p.easing === 'snap' ? 120 : p.rampMs) / 1000) * fps));
      k = interpolate(frame, [0, ramp], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
    } else if (p.easing === 'smooth') {
      const ramp = Math.min(Math.max(1, Math.round((p.rampMs / 1000) * fps)), Math.floor(durationInFrames / 2));
      if (ramp >= 1) {
        const opts = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) } as const;
        k = Math.min(
          interpolate(frame, [0, ramp], [0, 1], opts),
          interpolate(frame, [durationInFrames - ramp, durationInFrames], [1, 0], opts),
        );
      }
    }
    const s = 1 + (p.scale - 1) * k;
    // scale around the focus point (transform-origin is 0 0)
    return `translate(${p.focusX * width * (1 - s)}px, ${p.focusY * height * (1 - s)}px) scale(${s})`;
  },
});
