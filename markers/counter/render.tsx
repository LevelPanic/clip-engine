import React from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { z } from 'zod';
import { defineRender } from '../../src/markers/define';
import { fontFamilyOf } from '../../src/markers/fonts';
import schema, { counterAt } from './schema';

type P = z.infer<typeof schema.params>;

export default defineRender<P>({
  Component: ({ params: p }) => {
    const frame = useCurrentFrame();
    const { fps, width, height } = useVideoConfig();
    const ms = (frame * 1000) / fps;
    const { text, step } = counterAt(p, ms);
    // each new number pops in
    const since = p.mode === 'count' ? frame - Math.round(((step * p.stepMs) / 1000) * fps) : frame;
    const pop = spring({ frame: since, fps, config: { damping: 11, stiffness: 200 }, durationInFrames: 10 });
    const outline = (size: number): React.CSSProperties => ({ WebkitTextStroke: `${Math.max(3, Math.round(size * 0.07))}px #000`, paintOrder: 'stroke', textShadow: `0 ${Math.round(size * 0.05)}px ${Math.round(size * 0.14)}px rgba(0,0,0,0.6)` });
    return (
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', left: p.x * width, top: p.y * height, transform: 'translate(-50%, -50%)', textAlign: 'center', whiteSpace: 'nowrap' }}>
          {p.label && (
            <div style={{ fontFamily: fontFamilyOf('barlow'), fontStyle: 'italic', fontWeight: 900, fontSize: Math.round(p.fontSize * 0.28), color: '#fff', textTransform: 'uppercase', ...outline(p.fontSize * 0.28) }}>{p.label}</div>
          )}
          <div style={{ fontFamily: fontFamilyOf('barlow'), fontWeight: 900, fontSize: p.fontSize, lineHeight: 1, color: p.color, transform: `scale(${p.mode === 'count' ? 0.55 + 0.45 * pop : 1})`, fontVariantNumeric: 'tabular-nums', ...outline(p.fontSize) }}>
            {text}
          </div>
        </div>
      </AbsoluteFill>
    );
  },
});
