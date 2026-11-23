// The clip: the edited timeline (time map) of framed video pieces, camera markers, overlay/audio
// markers, join transitions and captions. Used live by the Studio's <Player> and by the renderer.
import React, { useMemo } from 'react';
import { AbsoluteFill, Easing, interpolate, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { markerRenderMs, framingKeys, framingAt, filterAt, filterSpans, gainAt, gainSpans, type GainSpan, type MarkerType } from '../markers/define';
import { msToFrames } from '../core/time';
import { spanToT, srcToT, tToSrc, type Piece, type TimeMap } from '../core/timeline';
import type { Marker } from '../core/schemas';
import { ClipContext, FONT } from './context';
import { seamOf } from '../core/layout';
import { FramedVideo } from './FramedVideo';
import { Captions, captionTokens } from './Captions';
import { type ClipProps, WIDTH as W, HEIGHT as H, clipMap } from './props';
import { typeOf } from './types';

interface Placed {
  m: Marker;
  t: MarkerType;
  params: Record<string, unknown>;
  tStart: number; // edited-timeline ms
  tEnd: number;
}

/** Markers on the edited timeline. A marker inside a cut is hidden, not deleted. */
function placeMarkers(markers: Marker[], map: TimeMap): Placed[] {
  return markers.flatMap((m) => {
    const t = typeOf(m.type);
    if (!t || t.layer === 'time' || t.layer === 'framing') return [];
    const parsed = t.params.safeParse(m.params); // fills defaults for params added after the marker was made
    const params = (parsed.success ? parsed.data : m.params) as Record<string, unknown>;
    if (t.fill === 'clip') return [{ m, t, params, tStart: map.tStart, tEnd: map.tEnd }];
    if (m.endMs !== undefined) {
      const span = spanToT(map, m.startMs, m.endMs);
      return span ? [{ m, t, params, ...span }] : [];
    }
    const at = srcToT(map, m.startMs);
    return at === null ? [] : [{ m, t, params, tStart: at, tEnd: at + markerRenderMs(t, params) }];
  });
}

export const ClipComposition: React.FC<ClipProps> = (props) => {
  const { project, words, media, assetBase, studio } = props;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const markers = useMemo(() => project.markers.filter((m) => studio || !m.proposed), [project.markers, studio]);
  const map = clipMap(props);
  const t = map.tStart + (frame * 1000) / fps; // edited-timeline ms at this frame
  const fr = (ms: number) => msToFrames(ms - map.tStart, fps); // timeline ms → composition frame

  const placed = useMemo(() => placeMarkers(markers, map), [markers, map]);
  const keys = useMemo(() => framingKeys(markers, typeOf), [markers]);
  // audio markers that turn the clip's own sound down (a bleep mutes the word under it)
  const gains = useMemo(() => gainSpans(markers, typeOf, map), [markers, map]);
  // markers that filter the picture (black and white); captions and overlays are drawn outside it
  const filters = useMemo(() => filterSpans(markers, typeOf, map), [markers, map]);
  const tokens = useMemo(() => captionTokens(words, project.captions, map), [words, project.captions, map]);

  // camera: every camera marker active at t contributes a transform
  const camera = placed
    .filter((p) => p.t.camera && t >= p.tStart && t < p.tEnd)
    .map((p) =>
      p.t.camera!(p.params, {
        frame: fr(t) - fr(p.tStart),
        durationInFrames: Math.max(1, fr(p.tEnd) - fr(p.tStart)),
        fps,
        width: W,
        height: H,
        markerId: p.m.id,
      }),
    );
  // join transitions that move the picture (whip pan, zoom punch)
  const joinFx = joinEffects(map, t);
  const transform = [...camera, joinFx.transform].filter(Boolean).join(' ');

  const inClip = t >= 0 && t < map.durationMs;
  // an overlay that names the creator sits between the camera and the game, not across a face
  const seam = framingAt(keys, project.framing, tToSrc(map, t)).mode === 'split' ? seamOf(project.framing.split) : undefined;

  return (
    <ClipContext.Provider value={{ assetBase, seam }}>
      <AbsoluteFill style={{ backgroundColor: 'black', overflow: 'hidden' }}>
        <AbsoluteFill style={{ transform: transform || undefined, transformOrigin: '0 0', filter: [joinFx.blur ? `blur(${joinFx.blur}px)` : '', filterAt(filters, t)].filter(Boolean).join(' ') || undefined }}>
          {map.pieces.map((p, k) => (
            <Sequence key={k} from={fr(p.tStart)} durationInFrames={Math.max(1, fr(p.tEnd) - fr(p.tStart))} name={`${p.kind} ${Math.round(p.srcStart)}`}>
              <PieceVideo piece={p} map={map} props={props} cropKeys={keys} markers={markers} gains={gains} />
            </Sequence>
          ))}
        </AbsoluteFill>

        {placed
          .filter((p) => p.t.Component)
          .sort((a, b) => (a.t.zIndex ?? 10) - (b.t.zIndex ?? 10))
          .map((p) => {
            const C = p.t.Component!;
            const dur = Math.max(1, fr(p.tEnd) - fr(p.tStart));
            return (
              <Sequence key={p.m.id} from={fr(p.tStart)} durationInFrames={dur} style={{ zIndex: p.t.zIndex ?? 10, opacity: p.m.proposed ? 0.6 : 1 }} name={`${p.t.type} ${p.m.id}`}>
                <C params={p.params} durationInFrames={dur} markerId={p.m.id} />
              </Sequence>
            );
          })}

        {joinFx.flash > 0 && <AbsoluteFill style={{ backgroundColor: 'white', opacity: joinFx.flash, zIndex: 45 }} />}

        {project.captions.enabled && <Captions tokens={tokens} settings={project.captions} clipEndMs={map.durationMs - map.tStart} />}

        {studio?.dimOutside && !inClip && (
          <AbsoluteFill style={{ background: 'rgba(0,0,0,0.6)', zIndex: 90, alignItems: 'center', justifyContent: 'flex-start' }}>
            <div style={{ marginTop: 120, fontFamily: FONT, fontWeight: 800, fontSize: 44, color: 'rgba(255,255,255,0.75)', letterSpacing: 4 }}>OUTSIDE CLIP</div>
          </AbsoluteFill>
        )}
        {studio?.safeZone && <SafeZone />}
      </AbsoluteFill>
    </ClipContext.Provider>
  );
};

/** One piece of the time map: plays (at its rate) or holds; fades in/out across crossfade joins. */
const PieceVideo: React.FC<{ piece: Piece; map: TimeMap; props: ClipProps; cropKeys: ReturnType<typeof framingKeys>; markers: Marker[]; gains: GainSpan[] }> = ({
  piece,
  map,
  props,
  cropKeys,
  markers,
  gains,
}) => {
  const frame = useCurrentFrame(); // frame within this piece
  const { fps } = useVideoConfig();
  const tHere = piece.tStart + (frame * 1000) / fps;
  const fadeIn = map.joins.find((j) => j.overlap && Math.abs(j.t - piece.tStart) < 1);
  const fadeOut = map.joins.find((j) => j.overlap && Math.abs(j.t + j.durationMs - piece.tEnd) < 1);
  const ramp = (tt: number) => {
    let v = 1;
    if (fadeIn) v = Math.min(v, Math.min(1, (tt - piece.tStart) / fadeIn.durationMs));
    if (fadeOut) v = Math.min(v, Math.min(1, (piece.tEnd - tt) / fadeOut.durationMs));
    return Math.max(0, v);
  };
  const opacity = fadeIn ? ramp(tHere) : 1;
  const src = tToSrc(map, tHere);
  // reframe markers can switch between blur-fit and a (panning) crop part-way through the clip
  const fr = framingAt(cropKeys, props.project.framing, src);

  // freeze: optional push-in while holding
  let holdZoom = 1;
  if (piece.kind === 'hold' && piece.markerId) {
    const m = markers.find((x) => x.id === piece.markerId);
    const z = Number(m?.params.zoom ?? 1);
    const p = interpolate(tHere, [piece.tStart, piece.tEnd], [0, 1], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
    holdZoom = 1 + (z - 1) * p;
  }

  return (
    <AbsoluteFill style={{ opacity, transform: holdZoom !== 1 ? `scale(${holdZoom})` : undefined }}>
      <FramedVideo
        media={props.media}
        framing={{ ...props.project.framing, mode: fr.mode }}
        cropX={fr.cropX}
        srcStartMs={piece.srcStart}
        rate={piece.rate}
        hold={piece.kind === 'hold'}
        volume={fadeIn || fadeOut || gains.some((g) => g.tEnd > piece.tStart && g.tStart < piece.tEnd) ? (f: number) => {
          const tt = piece.tStart + (f * 1000) / fps;
          return (fadeIn || fadeOut ? ramp(tt) : 1) * gainAt(gains, tt);
        } : 1}
      />
    </AbsoluteFill>
  );
};

/** Whip pans, zoom punches and flashes centred on cut joins. */
function joinEffects(map: TimeMap, t: number): { transform: string; blur: number; flash: number } {
  for (const j of map.joins) {
    if (j.overlap || j.kind === 'none' || j.durationMs <= 0) continue;
    const half = j.durationMs / 2;
    if (t < j.t - half || t > j.t + half) continue;
    const p = (t - (j.t - half)) / j.durationMs; // 0 → 1 across the join
    const peak = 1 - Math.abs(p - 0.5) * 2; // 0 → 1 → 0
    if (j.kind === 'whip') {
      // slide out left / in from the right, zoomed just enough that the edges never show black
      const dx = p < 0.5 ? -p * 2 * W * 0.15 : (1 - p) * 2 * W * 0.15;
      const s = 1 + 0.35 * peak;
      return { transform: `translate(${(W / 2) * (1 - s) + dx}px, ${(H / 2) * (1 - s)}px) scale(${s})`, blur: peak * 20, flash: 0 };
    }
    if (j.kind === 'zoom') {
      const s = 1 + 0.3 * peak;
      return { transform: `translate(${(W / 2) * (1 - s)}px, ${(H / 2) * (1 - s)}px) scale(${s})`, blur: peak * 10, flash: 0 };
    }
    if (j.kind === 'flash') return { transform: '', blur: 0, flash: 0.9 * peak };
    if (j.kind === 'glitch') {
      // stepped jitter around the join (changes every ~2 frames)
      const step = Math.floor(t / 66);
      const r = (k: number) => ((Math.sin(step * 12.9898 + k * 78.233) * 43758.5453) % 1);
      const s = 1.08;
      return { transform: `translate(${(W / 2) * (1 - s) + r(1) * 50 * peak}px, ${r(2) * 20 * peak}px) scale(${s}) skewX(${r(3) * 10 * peak}deg)`, blur: 0, flash: 0.25 * peak };
    }
  }
  return { transform: '', blur: 0, flash: 0 };
}

/** Keep faces, captions and text inside this box; platform UI covers the rest. */
export const SAFE = { left: 60, top: 240, right: 960, bottom: 1500 };

const SafeZone: React.FC = () => (
  <AbsoluteFill style={{ zIndex: 95, pointerEvents: 'none' }}>
    <div
      style={{
        position: 'absolute',
        left: SAFE.left,
        top: SAFE.top,
        width: SAFE.right - SAFE.left,
        height: SAFE.bottom - SAFE.top,
        border: '4px dashed rgba(0,255,170,0.7)',
        borderRadius: 12,
      }}
    />
    <div style={{ position: 'absolute', right: 0, top: 700, width: 120, height: 700, background: 'rgba(255,60,60,0.18)' }} />
    <div style={{ position: 'absolute', left: 0, bottom: 0, width: W, height: H - SAFE.bottom, background: 'rgba(255,60,60,0.18)' }} />
  </AbsoluteFill>
);
