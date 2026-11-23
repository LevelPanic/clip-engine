import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { z } from 'zod';
import { defineRender } from '../../src/markers/define';
import type schema from './schema';

type P = z.infer<typeof schema.params>;

// `backdrop-filter` blurs what is drawn under the box (the framed video), in the Studio and in the
// export alike; the slight darkening keeps a blurred patch from reading as a glitch. `black` is a solid box.
export default defineRender<P>({
  Component: ({ params }) => {
    const x = Math.min(params.x, 1 - 0.02);
    const y = Math.min(params.y, 1 - 0.02);
    const box: React.CSSProperties = {
      position: 'absolute',
      left: `${x * 100}%`,
      top: `${y * 100}%`,
      width: `${Math.min(params.w, 1 - x) * 100}%`,
      height: `${Math.min(params.h, 1 - y) * 100}%`,
      borderRadius: 18,
    };
    return (
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        {params.look === 'black' ? (
          <div style={{ ...box, background: 'black' }} />
        ) : (
          <div style={{ ...box, backdropFilter: `blur(${params.strength}px)`, WebkitBackdropFilter: `blur(${params.strength}px)`, background: 'rgba(0,0,0,0.12)' }} />
        )}
      </AbsoluteFill>
    );
  },
});
