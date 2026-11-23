// The contract every marker type folder implements. Browser-safe.
//
// markers/<type>/schema.ts  → export default defineMarker({...})   (pure data + zod; the CLI loads this)
// markers/<type>/render.tsx → export default defineRender({...})   (React/Remotion; preview + export)
import type React from 'react';
import type { z } from 'zod';
import type { TimeEffect } from '../core/timeline';

export type MarkerKind = 'span' | 'point';
export type MarkerLayer = 'camera' | 'overlay' | 'audio' | 'time' | 'framing';

export interface MarkerMeta<S extends z.ZodObject = z.ZodObject> {
  /** Folder name and the `type` stored in project.json. */
  type: string;
  label: string;
  description: string;
  /** span = has a start and an end; point = a single moment (e.g. a boom). */
  kind: MarkerKind;
  /** camera: transform the picture · overlay: draw on top · audio: play sound ·
   *  time: restructure the timeline (cut, speed, freeze) · framing: move the 9:16 crop. */
  layer: MarkerLayer;
  /** time markers: what they do to the timeline. */
  time?: (params: z.infer<S>) => { effect: TimeEffect; transition?: { kind: string; durationMs: number } };
  /** framing markers: how the picture is framed from this moment on: blur-fit, or a crop at cropX. A span
   *  marker that returns `untilEnd` frames only its own span and then goes back to what was there before. */
  framing?: (params: z.infer<S>) => FramingKey & { untilEnd?: boolean };
  /** audio markers: the level of the clip's own sound while the marker plays (0 mutes it; tMs from the
   *  marker's start). The preview, the export and the checks on what is said (a muted word is not said) all read it. */
  gain?: (params: z.infer<S>, tMs: number) => number;
  /** camera markers: a CSS filter for the picture while the marker plays ("grayscale(1)"; tMs from the marker's
   *  start). Applied to the video only, never to captions or overlays; the preview and the export match. */
  filter?: (params: z.infer<S>, tMs: number) => string;
  /** Timeline colour. */
  color: string;
  /** Palette position (1–9 hotkeys follow this order). */
  order?: number;
  /** Spans: length when dropped with M. */
  defaultDurationMs?: number;
  /** Points: how long the effect keeps rendering after the marker. */
  renderMs?: number | ((params: z.infer<S>) => number);
  /** Stacking order for overlays (captions sit at 20). */
  zIndex?: number;
  /** Overlays: draw for the whole clip, whatever the marker's own time is (a credit line, a watermark).
   *  Trimming the clip never leaves it short. */
  fill?: 'clip';
  params: S;
}

export interface MarkerRenderProps<P> {
  params: P;
  /** Frames this marker renders for (span length, or renderMs for points). */
  durationInFrames: number;
  markerId: string;
}

export interface CameraContext {
  /** Frame relative to the marker start. */
  frame: number;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  markerId: string;
}

export interface MarkerRender<P> {
  /** overlay / audio markers: rendered inside a <Sequence> that starts at the marker. */
  Component?: React.FC<MarkerRenderProps<P>>;
  /** camera markers: return a CSS transform (pixels, transform-origin 0 0) for this frame. */
  camera?: (params: P, ctx: CameraContext) => string;
}

export function defineMarker<S extends z.ZodObject>(meta: MarkerMeta<S>): MarkerMeta<S> {
  return meta;
}

export function defineRender<P>(render: MarkerRender<P>): MarkerRender<P> {
  return render;
}

export type MarkerType = MarkerMeta & MarkerRender<any>;

export function markerRenderMs(t: MarkerMeta, params: Record<string, unknown>): number {
  if (typeof t.renderMs === 'function') return t.renderMs(params as never);
  return t.renderMs ?? 500;
}

export function sortMarkerTypes<T extends MarkerMeta>(types: T[]): T[] {
  return [...types].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.type.localeCompare(b.type));
}

import { spanToT, type TimeMap, type TimeMarker } from '../core/timeline';
import type { Marker } from '../core/schemas';

/** The time markers of a project, in the form the time map wants. */
export function timeMarkers(markers: Marker[], typeOf: (type: string) => MarkerMeta | undefined): TimeMarker[] {
  return markers.flatMap((m) => {
    const t = typeOf(m.type);
    if (!t?.time) return [];
    const parsed = t.params.safeParse(m.params);
    const { effect, transition } = t.time((parsed.success ? parsed.data : m.params) as never);
    return [{ id: m.id, startMs: m.startMs, endMs: m.endMs, effect, transition, proposed: m.proposed }];
  });
}

/** How the picture is framed: blur-fit, a crop, the split, or, for a span inside a split, one of its two
 *  pictures alone (`cam`: the facecam filling the frame; `game`: the stream filling it; `soloGeometry`). */
export type FrameMode = 'crop' | 'blur' | 'split' | 'cam' | 'game';

export interface FramingKey {
  mode: FrameMode;
  cropX: number;
  easeMs: number;
  /** The start of a span that frames only itself (a facecam-only or game-only span). */
  solo?: boolean;
  /** The end of that span: back to the framing before it (`resolveKeys` fills the mode in). */
  restore?: boolean;
}

/** Framing keyframes from framing markers (sorted). A span marker whose framing is `untilEnd` gives two keys. */
export function framingKeys(markers: Marker[], typeOf: (type: string) => MarkerMeta | undefined, includeProposed = true): (FramingKey & { atMs: number })[] {
  return markers
    .flatMap((m) => {
      const t = typeOf(m.type);
      if (!t?.framing || (m.proposed && !includeProposed)) return [];
      const parsed = t.params.safeParse(m.params);
      const { untilEnd, ...key } = t.framing((parsed.success ? parsed.data : m.params) as never);
      if (!untilEnd || m.endMs === undefined) return [{ atMs: m.startMs, ...key }];
      return [
        { atMs: m.startMs, ...key, solo: true },
        { atMs: m.endMs, mode: key.mode, cropX: key.cropX, easeMs: 0, restore: true },
      ];
    })
    .sort((a, b) => a.atMs - b.atMs || Number(!!b.restore) - Number(!!a.restore));
}

/**
 * Keys with each span's end filled in: a `restore` becomes the framing that was in force when its span
 * began. A facecam-only or game-only span needs a split to pick from: one that starts over blur-fit or a
 * crop (no facecam was found, or the split fell back) changes nothing, and neither does its end. Pure;
 * framingAt and the ffmpeg chain (src/render/framing.ts) both read keys through it.
 */
export function resolveKeys(keys: (FramingKey & { atMs: number })[], base: { mode: FrameMode; cropX: number }): (FramingKey & { atMs: number })[] {
  let cur = { mode: base.mode, cropX: base.cropX };
  const open: ({ mode: FrameMode; cropX: number } | null)[] = [];
  const out: (FramingKey & { atMs: number })[] = [];
  for (const k of keys) {
    if (k.restore) {
      const before = open.pop();
      if (!before) continue; // its span never took effect
      cur = before;
      out.push({ atMs: k.atMs, mode: before.mode, cropX: before.cropX, easeMs: 0 });
      continue;
    }
    if (k.solo) {
      if (cur.mode !== 'split') {
        open.push(null);
        continue;
      }
      open.push(cur);
    }
    cur = { mode: k.mode, cropX: k.cropX };
    out.push(k);
  }
  return out;
}

/** Framing at a source moment: the clip's base framing, changed by each key before it. The crop pans
 *  (eases) between crop keys; switching between blur-fit, crop and split is a cut. */
export function framingAt(keys: (FramingKey & { atMs: number })[], base: { mode: FrameMode; cropX: number }, src: number): { mode: FrameMode; cropX: number } {
  let mode = base.mode;
  let x = base.cropX;
  for (const key of resolveKeys(keys, base)) {
    if (src < key.atMs) break;
    if (key.mode !== mode || mode !== 'crop') {
      mode = key.mode;
      x = key.cropX;
      continue;
    }
    const p = key.easeMs > 0 ? Math.min(1, (src - key.atMs) / key.easeMs) : 1;
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // ease in-out
    x = x + (key.cropX - x) * e;
  }
  return { mode, cropX: x };
}

/** cropX at a source moment (kept for callers that only care about the crop position). */
export function cropAt(keys: (FramingKey & { atMs: number })[], base: number, src: number): number {
  return framingAt(keys, { mode: 'crop', cropX: base }, src).cropX;
}

/** A stretch of the edited timeline where an audio marker sets the level of the clip's own sound. */
export interface GainSpan {
  tStart: number;
  tEnd: number;
  gain: (tMs: number) => number;
}

/** The gain spans of a project's markers, on the edited timeline. Pass only the markers that play (no proposed ones for an export). */
export function gainSpans(markers: Marker[], typeOf: (type: string) => MarkerMeta | undefined, map: TimeMap): GainSpan[] {
  return markers.flatMap((m) => {
    const t = typeOf(m.type);
    if (!t?.gain || m.endMs === undefined) return [];
    const span = spanToT(map, m.startMs, m.endMs);
    if (!span) return [];
    const parsed = t.params.safeParse(m.params);
    const params = (parsed.success ? parsed.data : m.params) as never;
    return [{ tStart: span.tStart, tEnd: span.tEnd, gain: (ms: number) => t.gain!(params, ms) }];
  });
}

/** The level of the clip's own sound at edited time t: 1, times every gain span over it (each kept to 0–1). */
export function gainAt(spans: GainSpan[], t: number): number {
  let g = 1;
  for (const s of spans) if (t >= s.tStart && t < s.tEnd) g *= Math.max(0, Math.min(1, s.gain(t - s.tStart)));
  return g;
}

/** A stretch of the edited timeline where a marker filters the picture. */
export interface FilterSpan {
  tStart: number;
  tEnd: number;
  filter: (tMs: number) => string;
}

/** The filter spans of a project's markers, on the edited timeline (pass only the markers that play). */
export function filterSpans(markers: Marker[], typeOf: (type: string) => MarkerMeta | undefined, map: TimeMap): FilterSpan[] {
  return markers.flatMap((m) => {
    const t = typeOf(m.type);
    if (!t?.filter || m.endMs === undefined) return [];
    const span = spanToT(map, m.startMs, m.endMs);
    if (!span) return [];
    const parsed = t.params.safeParse(m.params);
    const params = (parsed.success ? parsed.data : m.params) as never;
    return [{ tStart: span.tStart, tEnd: span.tEnd, filter: (ms: number) => t.filter!(params, ms) }];
  });
}

/** The CSS filter for the picture at edited time t: every filter span over it, in order; '' when none. */
export function filterAt(spans: FilterSpan[], t: number): string {
  return spans
    .filter((s) => t >= s.tStart && t < s.tEnd)
    .map((s) => s.filter(t - s.tStart))
    .filter(Boolean)
    .join(' ');
}
