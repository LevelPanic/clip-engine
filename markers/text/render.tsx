import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { z } from 'zod';
import { defineRender } from '../../src/markers/define';
import { FONT } from '../../src/markers/context';
import { fontFamilyOf } from '../../src/markers/fonts';
import type schema from './schema';

type P = z.infer<typeof schema.params>;

/** Twitch's name colours; a name always gets the same one. */
const NAME_COLORS = ['#ff4a80', '#9147ff', '#00b5ad', '#ff7f50', '#1e90ff', '#2e8b57', '#daa520', '#ff69b4', '#8a2be2', '#00c8af'];
export const nameColor = (name: string) => NAME_COLORS[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % NAME_COLORS.length];

/** "name: message", with the name in its colour; a line with no name is the message alone. */
const ChatLine: React.FC<{ text: string }> = ({ text }) => {
  const k = text.indexOf(': ');
  if (k <= 0 || k > 26) return <>{text}</>;
  const name = text.slice(0, k);
  return (
    <>
      <span style={{ color: nameColor(name) }}>{name}</span>
      <span style={{ color: '#efeff1' }}>: {text.slice(k + 2)}</span>
    </>
  );
};

export default defineRender<P>({
  Component: ({ params: p, durationInFrames }) => {
    const frame = useCurrentFrame();
    const { fps, height } = useVideoConfig();
    const out = interpolate(frame, [durationInFrames - 5, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const pop = spring({ frame, fps, config: { damping: 12, stiffness: 180 }, durationInFrames: 12 });
    const scale = p.animation === 'pop' ? 0.6 + 0.4 * pop : 1;
    const fadeIn = p.animation === 'none' ? 1 : interpolate(frame, [0, 6], [0, 1], { extrapolateRight: 'clamp' });
    const outline = (w: number): React.CSSProperties => ({ color: '#fff', WebkitTextStroke: `${Math.max(2, Math.round(p.fontSize * w))}px #000`, paintOrder: 'stroke', textShadow: `0 ${Math.round(p.fontSize * 0.06)}px ${Math.round(p.fontSize * 0.18)}px rgba(0,0,0,0.7)` });
    const box: React.CSSProperties =
      p.style === 'hook'
        ? { background: '#000', color: '#fff', padding: '10px 26px', borderRadius: 16 }
        : p.style === 'highlight'
          ? { background: '#FFE14D', color: '#000', padding: '10px 26px', borderRadius: 16 }
          : p.style === 'box'
            ? { background: '#fff', color: '#000', padding: '6px 22px', borderRadius: 14, fontFamily: fontFamilyOf('montserrat'), fontWeight: 800, lineHeight: 1.42 }
            : p.style === 'chat'
              ? { background: 'rgba(24,24,27,0.94)', color: '#efeff1', padding: '14px 26px', borderRadius: 18, fontFamily: fontFamilyOf('montserrat'), fontWeight: 700, lineHeight: 1.3, boxShadow: '0 6px 24px rgba(0,0,0,0.45)' }
          : p.style === 'title'
            ? { background: '#E5252A', color: '#fff', padding: '8px 22px', borderRadius: 14, fontFamily: fontFamilyOf('poppins'), fontWeight: 700 }
            : p.style === 'street'
              ? { ...outline(0.14), fontFamily: fontFamilyOf('barlow'), fontStyle: 'italic', fontWeight: 900, textTransform: 'uppercase', lineHeight: 1.1 }
              : p.style === 'comment'
                ? { ...outline(0.12), fontFamily: fontFamilyOf('montserrat'), fontStyle: 'italic', fontWeight: 800, lineHeight: 1.18 }
                : { color: '#fff', WebkitTextStroke: `${Math.round(p.fontSize * 0.16)}px #000`, paintOrder: 'stroke' };
    return (
      <AbsoluteFill>
        <div
          style={{
            position: 'absolute',
            left: 80,
            right: 80,
            top: p.y * height,
            textAlign: 'center',
            transform: `translateY(-50%) scale(${scale})`,
            opacity: Math.min(out, fadeIn),
          }}
        >
          <span
            style={{
              display: 'inline',
              fontFamily: FONT,
              fontWeight: 900,
              fontSize: p.fontSize,
              lineHeight: 1.35,
              ...box,
              whiteSpace: 'pre-wrap',
              boxDecorationBreak: 'clone',
              WebkitBoxDecorationBreak: 'clone',
            }}
          >
            {p.style === 'chat' ? <ChatLine text={p.text} /> : p.text}
          </span>
        </div>
      </AbsoluteFill>
    );
  },
});
