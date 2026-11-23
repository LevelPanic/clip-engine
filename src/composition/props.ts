// What the clip composition needs. The Studio and the renderer build this the same way,
// so the export matches the preview.
import type { Project, Word } from '../core/schemas';
import { defaultCaptions, defaultFraming } from '../core/schemas';
import { FPS, msToFrames } from '../core/time';
import { buildTimeMap, type TimeMap } from '../core/timeline';
import { timeMarkers } from '../markers/define';
import { typeOf } from './types';

export const WIDTH = 1080;
export const HEIGHT = 1920;

export type ClipProps = {
  project: Project;
  /** Transcript words around the clip (captions). */
  words: Word[];
  /** The video file. It may be a cut or a section: `offsetMs` is the source time of its first frame.
   *  `framed`: already 1080×1920 with framing applied (the renderer does this in ffmpeg). */
  media: { src: string; offsetMs: number; width: number; height: number; framed?: boolean };
  /** Studio only: context shown (dimmed) before and after the clip, outside the edit. */
  pad?: { beforeMs: number; afterMs: number };
  /** URL prefix for files in assets/ (ends with "/"). */
  assetBase: string;
  /** Studio-only: overlays, and proposed markers previewed. The export never renders proposed markers. */
  studio?: { dimOutside: boolean; safeZone: boolean };
};

const cache = new WeakMap<object, TimeMap>();

/** The edited timeline for these props (memoised per project/pad object). */
export function clipMap(p: Pick<ClipProps, 'project' | 'pad' | 'studio'>): TimeMap {
  const key = p.project.markers;
  const hit = cache.get(key);
  if (hit && (hit as TimeMap & { _pad?: string })._pad === JSON.stringify([p.pad, !!p.studio, p.project.segments])) return hit;
  const map = buildTimeMap(p.project.segments[0], timeMarkers(p.project.markers, typeOf), {
    padBefore: p.pad?.beforeMs,
    padAfter: p.pad?.afterMs,
    includeProposed: !!p.studio,
  });
  (map as TimeMap & { _pad?: string })._pad = JSON.stringify([p.pad, !!p.studio, p.project.segments]);
  cache.set(key, map);
  return map;
}

export const durationInFrames = (p: Pick<ClipProps, 'project' | 'pad' | 'studio'>) => {
  const m = clipMap(p);
  return Math.max(1, msToFrames(m.tEnd - m.tStart, FPS));
};

export const placeholderProps: ClipProps = {
  project: {
    version: 1,
    rev: 0,
    id: 'placeholder',
    videoId: 'placeholder',
    title: 'placeholder',
    sourceDurationMs: 10_000,
    fps: 30,
    segments: [{ startMs: 0, endMs: 5000 }],
    markers: [],
    captions: defaultCaptions(),
    framing: defaultFraming(),
    createdAt: '',
    updatedAt: '',
  },
  words: [],
  media: { src: '', offsetMs: 0, width: 1920, height: 1080 },
  assetBase: '/',
};
