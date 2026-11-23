// Marker types as the Studio sees them, plus small project-editing helpers.
import { z } from 'zod';
import { markerTypes } from '../../../markers/index.generated';
import { sortMarkerTypes, type MarkerType } from '../../markers/define';
import type { Marker, Project } from '../../core/schemas';

export const TYPES: MarkerType[] = sortMarkerTypes(markerTypes);
export const TYPE_MAP = new Map(TYPES.map((t) => [t.type, t]));

export interface ParamSchema {
  type?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  description?: string;
  ui?: string;
}

const jsonCache = new Map<string, Record<string, ParamSchema>>();
export function paramSchemas(t: MarkerType): Record<string, ParamSchema> {
  if (!jsonCache.has(t.type)) {
    const js = z.toJSONSchema(t.params) as { properties?: Record<string, ParamSchema> };
    jsonCache.set(t.type, js.properties ?? {});
  }
  return jsonCache.get(t.type)!;
}

export const newMarkerId = () => 'm_' + Math.random().toString(16).slice(2, 10);

export const sortMarkers = (ms: Marker[]) => [...ms].sort((a, b) => a.startMs - b.startMs);

export function patchMarker(p: Project, id: string, patch: Partial<Marker>): Project {
  return { ...p, markers: sortMarkers(p.markers.map((m) => (m.id === id ? { ...m, ...patch } : m))) };
}

export function markerLabel(m: Marker): string {
  const t = TYPE_MAP.get(m.type);
  if (m.type === 'text' && typeof m.params.text === 'string') return m.params.text;
  if (m.type === 'sfx' && typeof m.params.sound === 'string') return m.params.sound.replace(/\.\w+$/, '');
  if (m.type === 'zoom') return `${m.params.scale}×`;
  return t?.label ?? m.type;
}
