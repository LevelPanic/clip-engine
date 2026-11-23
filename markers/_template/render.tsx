// TEMPLATE renderer. The same component draws the Studio preview and the exported MP4.
// Inside Component, frame 0 is the marker's start (it runs inside a <Sequence>).
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import type { z } from 'zod';
import { defineRender } from '../../src/markers/define';
import type schema from './schema';

type P = z.infer<typeof schema.params>;

export default defineRender<P>({
  // overlay / audio markers:
  Component: ({ params, durationInFrames }) => {
    const frame = useCurrentFrame();
    // fade in over 4 frames, out over the last 4
    const k = interpolate(frame, [0, 4, durationInFrames - 4, durationInFrames], [0, 1, 1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    return <AbsoluteFill style={{ backgroundColor: params.color, opacity: params.opacity * k, mixBlendMode: 'multiply' }} />;
  },

  // camera markers instead return a CSS transform for the current frame (origin top-left, pixels):
  // camera: (params, { frame, durationInFrames, fps, width, height }) => `scale(1.1)`,
});
