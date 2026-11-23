import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import type { z } from 'zod';
import { defineRender } from '../../src/markers/define';
import type schema from './schema';

type P = z.infer<typeof schema.params>;

export default defineRender<P>({
  Component: ({ params, durationInFrames }) => {
    const frame = useCurrentFrame();
    const opacity = interpolate(frame, [0, durationInFrames], [params.opacity, 0], {
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.quad),
    });
    return <AbsoluteFill style={{ backgroundColor: params.color, opacity }} />;
  },
});
