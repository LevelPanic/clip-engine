import React from 'react';
import { AbsoluteFill, random, useCurrentFrame } from 'remotion';
import type { z } from 'zod';
import { defineRender } from '../../src/markers/define';
import type schema from './schema';

type P = z.infer<typeof schema.params>;

export default defineRender<P>({
  // the picture: stepped jitter and skew, changing every other frame like a bad signal
  camera: (p, { frame, width, markerId }) => {
    const step = Math.floor(frame / 2);
    const r = (k: string) => random(`${markerId}-${k}-${step}`) * 2 - 1;
    const dx = r('x') * 40 * p.intensity;
    const skew = r('s') * 8 * p.intensity;
    const s = 1 + 0.08 * p.intensity; // cover the edges the jitter would reveal
    return `translate(${(width / 2) * (1 - s) + dx}px, 0px) scale(${s}) skewX(${skew}deg)`;
  },
  // on top: a few RGB-tinted horizontal slices
  Component: ({ params: p, markerId }) => {
    const frame = useCurrentFrame();
    const step = Math.floor(frame / 2);
    const bars = Array.from({ length: 5 }, (_, k) => {
      const r = (n: string) => random(`${markerId}-bar-${k}-${n}-${step}`);
      return { top: r('y') * 100, h: 2 + r('h') * 10, color: ['rgba(255,0,80,0.45)', 'rgba(0,255,220,0.4)', 'rgba(255,255,255,0.35)'][k % 3], dx: (r('x') - 0.5) * 120 * p.intensity };
    });
    return (
      <AbsoluteFill style={{ mixBlendMode: 'screen' }}>
        {bars.map((b, k) => (
          <div key={k} style={{ position: 'absolute', left: b.dx, right: -b.dx, top: `${b.top}%`, height: `${b.h}%`, background: b.color }} />
        ))}
      </AbsoluteFill>
    );
  },
});
