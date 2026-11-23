import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { z } from 'zod';
import { defineRender } from '../../src/markers/define';
import { fontFamilyOf } from '../../src/markers/fonts';
import schema, { arrowTail } from './schema';

type P = z.infer<typeof schema.params>;

export default defineRender<P>({
  Component: ({ params: p }) => {
    const frame = useCurrentFrame();
    const { fps, width, height } = useVideoConfig();
    // drawn on over 0.25 s
    const draw = interpolate(frame, [0, Math.round(0.25 * fps)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const stroke = Math.max(8, Math.round(p.size * 0.045));
    const { tx, ty, hx, hy } = arrowTail(p, width, height);
    const label = (x: number, y: number) =>
      p.label ? (
        <div style={{ position: 'absolute', left: x, top: y, transform: 'translate(-50%, -50%)', whiteSpace: 'nowrap', fontFamily: fontFamilyOf('barlow'), fontStyle: 'italic', fontWeight: 900, fontSize: 64, color: '#fff', textTransform: 'uppercase', WebkitTextStroke: '6px #000', paintOrder: 'stroke', opacity: draw }}>
          {p.label}
        </div>
      ) : null;
    if (p.shape === 'circle') {
      const rx = p.size / 2;
      const ry = p.size * 0.42;
      const len = Math.PI * (rx + ry);
      return (
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
            <ellipse cx={hx} cy={hy} rx={rx} ry={ry} fill="none" stroke={p.color} strokeWidth={stroke} strokeDasharray={len} strokeDashoffset={len * (1 - draw)} strokeLinecap="round" transform={`rotate(-8 ${hx} ${hy})`} />
          </svg>
          {label(hx, hy - ry - 50)}
        </AbsoluteFill>
      );
    }
    // the arrow grows from its tail to the point
    const ex = tx + (hx - tx) * draw;
    const ey = ty + (hy - ty) * draw;
    const a = Math.atan2(hy - ty, hx - tx);
    const head = stroke * 3.2;
    const wing = (s: number) => `${ex - head * Math.cos(a + s)},${ey - head * Math.sin(a + s)}`;
    return (
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
          <line x1={tx} y1={ty} x2={ex} y2={ey} stroke="#000" strokeWidth={stroke + 8} strokeLinecap="round" opacity={0.35} />
          <line x1={tx} y1={ty} x2={ex} y2={ey} stroke={p.color} strokeWidth={stroke} strokeLinecap="round" />
          <polygon points={`${ex},${ey} ${wing(0.45)} ${wing(-0.45)}`} fill={p.color} stroke={p.color} strokeWidth={stroke * 0.4} strokeLinejoin="round" />
        </svg>
        {label(tx + Math.cos(a + Math.PI) * 60, ty + Math.sin(a + Math.PI) * 60)}
      </AbsoluteFill>
    );
  },
});
