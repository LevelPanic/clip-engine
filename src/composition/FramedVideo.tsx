// One piece of source video in the 9:16 frame: blur-fit or fill-and-crop, at a given speed,
// optionally frozen. The renderer pre-frames in ffmpeg (media.framed) and the Studio does it in CSS.
import React from 'react';
import { Freeze, OffthreadVideo, useVideoConfig } from 'remotion';
import type { Framing } from '../core/schemas';
import type { FrameMode } from '../markers/define';
import type { ClipProps } from './props';
import { WIDTH as W, HEIGHT as H } from './props';
import { soloGeometry, splitGeometry, type Band } from '../core/layout';

interface Props {
  media: ClipProps['media'];
  /** The clip's framing, with the mode in force at this moment (a reframe or a facecam-only span may change it). */
  framing: Omit<Framing, 'mode'> & { mode: FrameMode };
  /** Crop position for this moment (reframe markers), overriding framing.cropX. */
  cropX: number;
  srcStartMs: number;
  rate: number;
  hold?: boolean;
  volume?: number | ((frame: number) => number);
}

export const FramedVideo: React.FC<Props> = ({ media, framing, cropX, srcStartMs, rate, hold, volume }) => {
  const { fps } = useVideoConfig();
  if (!media.src) return null;
  // trimBefore is in source-time frames and isn't scaled by playbackRate
  const trimBefore = Math.max(0, Math.round(((srcStartMs - media.offsetMs) * fps) / 1000));
  const common = { src: media.src, trimBefore, playbackRate: rate, pauseWhenBuffering: true } as const;
  const vol = hold ? 0 : volume;
  const wrap = (el: React.ReactElement) => (hold ? <Freeze frame={0}>{el}</Freeze> : el);

  if (media.framed) {
    return wrap(<OffthreadVideo {...common} muted={hold} volume={vol} style={{ position: 'absolute', inset: 0, width: W, height: H }} />);
  }

  const sw = media.width || 1920;
  const sh = media.height || 1080;
  // The blurred, darkened cover of the whole frame. Blur-fit and split both sit on it. It is drawn at
  // quarter size and scaled up, which keeps the blur cheap.
  const Q = 0.25;
  const bgW = sw * (H / sh) * Q;
  const cover = (
    <div style={{ position: 'absolute', left: 0, top: 0, width: W * Q, height: H * Q, overflow: 'hidden', transform: `scale(${1 / Q})`, transformOrigin: '0 0' }}>
      <OffthreadVideo
        {...common}
        muted
        style={{
          position: 'absolute',
          left: (W * Q - bgW) / 2,
          top: 0,
          width: bgW,
          height: H * Q,
          maxWidth: 'none',
          filter: 'blur(10px) brightness(0.5) saturate(1.2)',
          transform: 'scale(1.2)',
        }}
      />
    </div>
  );

  // A box of the source scaled to cover a band (zoomed around its centre), and the band's window.
  const place = (b: { x: number; y: number; w: number; h: number }, target: { width: number; height: number }, topAlign = false) => {
    const bw = b.w / framing.zoom;
    const bh = b.h / framing.zoom;
    const bx = b.x + (b.w - bw) / 2;
    const by = b.y + (b.h - bh) / 2;
    const scale = Math.max(target.width / (bw * sw), target.height / (bh * sh));
    return {
      position: 'absolute' as const,
      left: -(bx * sw + (bw * sw - target.width / scale) / 2) * scale,
      top: -(by * sh + (topAlign ? 0 : (bh * sh - target.height / scale) / 2)) * scale,
      width: sw * scale,
      height: sh * scale,
      maxWidth: 'none',
    };
  };
  const band = (b: Band) => ({ position: 'absolute' as const, left: b.left, top: b.top, width: b.width, height: b.height, overflow: 'hidden' as const });

  if (framing.mode === 'cam' || framing.mode === 'game') {
    // one picture of the split alone, on the blurred cover (soloGeometry; soloChain in the ffmpeg side)
    const g = soloGeometry(framing.split, framing.mode, sw, sh);
    return wrap(
      <>
        {cover}
        <div style={band(g)}>
          <OffthreadVideo {...common} muted={hold} volume={vol} style={place(g.box, g, framing.mode === 'cam')} />
        </div>
      </>,
    );
  }

  if (framing.mode === 'split') {
    // Facecam band on top, the stream under it, on the blurred cover (src/core/layout.ts places them;
    // splitChain in src/render/framing.ts draws the same). Each picture is the source cropped to a box
    // and scaled to cover its band; the cam copy is muted so audio plays once.
    const g = splitGeometry(framing.split, sw, sh);
    return wrap(
      <>
        {cover}
        <div style={band(g.cam)}>
          <OffthreadVideo {...common} muted style={place(g.cam.box, g.cam, true)} />
        </div>
        <div style={band(g.content)}>
          <OffthreadVideo {...common} muted={hold} volume={vol} style={place(g.content.box, g.content)} />
        </div>
      </>,
    );
  }

  if (framing.mode === 'crop') {
    const s = (H / sh) * framing.zoom;
    const vw = Math.max(W, sw * s);
    const vh = sh * (vw / sw);
    return wrap(
      <OffthreadVideo
        {...common}
        muted={hold}
        volume={vol}
        style={{ position: 'absolute', left: -(vw - W) * cropX, top: -(vh - H) / 2, width: vw, height: vh, maxWidth: 'none' }}
      />,
    );
  }

  // Blur-fit: the picture fits the width; the blurred cover fills the rest.
  const fs = (W / sw) * framing.zoom;
  const fw = sw * fs;
  const fh = sh * fs;
  return wrap(
    <>
      {cover}
      <OffthreadVideo {...common} muted={hold} volume={vol} style={{ position: 'absolute', left: (W - fw) / 2, top: (H - fh) / 2, width: fw, height: fh, maxWidth: 'none' }} />
    </>,
  );
};
