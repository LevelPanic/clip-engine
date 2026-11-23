import React, { useContext } from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import type { z } from 'zod';
import { defineRender } from '../../src/markers/define';
import { ClipContext, FONT } from '../../src/markers/context';
import type schema from './schema';

type P = z.infer<typeof schema.params>;

// A small pill. In a split layout it sits on the seam between the camera and the game, so it never
// crosses the creator's face; otherwise near the top, below where the platforms put their own header.
export default defineRender<P>({
  Component: ({ params: p }) => {
    const { height } = useVideoConfig();
    const { seam } = useContext(ClipContext);
    const y = p.y > 0 ? p.y : (seam ?? 0.105);
    const platform = /youtube/i.test(p.label) ? '#ff4d4d' : /twitch/i.test(p.label) ? '#a970ff' : '#ffffff';
    return (
      <AbsoluteFill>
        <div style={{ position: 'absolute', left: 60, right: 60, top: y * height, textAlign: 'center', transform: 'translateY(-50%)', opacity: p.opacity }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              background: 'rgba(0, 0, 0, 0.72)',
              border: `1px solid ${platform}66`,
              color: '#fff',
              padding: '7px 18px',
              borderRadius: 999,
              fontFamily: FONT,
              fontWeight: 700,
              fontSize: p.fontSize,
              lineHeight: 1.3,
              whiteSpace: 'nowrap',
              boxShadow: '0 4px 18px rgba(0,0,0,0.25)',
            }}
          >
            <span style={{ color: platform, fontWeight: 800 }}>{p.label}</span>
            <span style={{ opacity: 0.96 }}>{p.text}</span>
          </span>
        </div>
      </AbsoluteFill>
    );
  },
});
