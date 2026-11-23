import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { z } from 'zod';
import { defineRender } from '../../src/markers/define';
import type schema from './schema';

type P = z.infer<typeof schema.params>;

export default defineRender<P>({
  Component: ({ params: p, durationInFrames, markerId }) => {
    const frame = useCurrentFrame();
    const { fps, width, height } = useVideoConfig();
    const pop = spring({ frame, fps, config: { damping: 9, stiffness: 220 }, durationInFrames: 14 });
    const rise = interpolate(frame, [0, durationInFrames], [0, -90], { extrapolateRight: 'clamp' });
    const fade = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    // a slight tilt that differs per marker, so several pops don't look stamped
    const tilt = ((markerId.charCodeAt(markerId.length - 1) % 9) - 4) * 3;
    return (
      <AbsoluteFill>
        <div
          style={{
            position: 'absolute',
            left: p.x * width,
            top: p.y * height,
            fontSize: p.size,
            lineHeight: 1,
            transform: `translate(-50%, -50%) translateY(${rise}px) scale(${0.3 + 0.7 * pop}) rotate(${tilt}deg)`,
            opacity: fade,
            filter: 'drop-shadow(0 8px 18px rgba(0,0,0,0.45))',
          }}
        >
          {p.emoji}
        </div>
      </AbsoluteFill>
    );
  },
});
