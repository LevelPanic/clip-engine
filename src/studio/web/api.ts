// Fetch helpers, live events and tiny shared hooks for the Studio.
import { useEffect, useRef, useSyncExternalStore, useCallback } from 'react';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((j as { error?: string }).error ?? res.statusText, res.status);
  return j as T;
}

// ---------- server-sent events (one connection shared by every component) ----------

export type StudioEvent =
  | { type: 'hello' }
  | { type: 'project'; clipId: string; rev: number }
  | { type: 'video'; videoId: string; file: string }
  | { type: 'export'; clipId: string }
  | { type: 'upload-status' }
  | { type: 'job'; job: SlimJob };

export interface SlimJob {
  id: number;
  kind: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: string | null;
  error: string | null;
  videoId: string | null;
  clipId: string | null;
  result: Record<string, unknown> | null;
}

export interface Footage {
  full: boolean;
  audio: boolean;
  sections: { startMs: number; endMs: number }[];
  sectionBytes: number;
  stillImage?: boolean;
}

export interface MediaRef {
  url: string;
  offsetMs: number;
  startMs: number;
  endMs: number;
  width: number;
  height: number;
  fps: number;
  kind: 'full' | 'section';
}

export function footageLabel(f?: Footage | null, jobs: SlimJob[] = []): string {
  const dl = jobs.find((j) => (j.kind === 'sections' || j.kind === 'full') && (j.state === 'running' || j.state === 'queued'));
  if (dl) return dl.state === 'running' ? `downloading ${dl.progress ?? ''}`.trim() : 'download queued';
  if (!f) return '';
  if (f.full) return 'full video on disk';
  if (f.sections.length) return `${f.sections.length} section${f.sections.length > 1 ? 's' : ''} on disk (${Math.round(f.sectionBytes / 1e6)} MB)`;
  return 'no footage yet';
}

const listeners = new Set<(e: StudioEvent) => void>();
let source: EventSource | undefined;

export function useEvents(handler: (e: StudioEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!source) {
      source = new EventSource('/api/events');
      source.onmessage = (m) => {
        const e = JSON.parse(m.data) as StudioEvent;
        listeners.forEach((l) => l(e));
      };
    }
    const l = (e: StudioEvent) => ref.current(e);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
}

/**
 * A function that runs at most once per `ms`, after the last call (trailing). Pages reload on live
 * events; while agents work those arrive several a second, and each reload is a full API fetch.
 */
export function useDebounced(fn: () => void, ms = 1500): () => void {
  const ref = useRef(fn);
  ref.current = fn;
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => ref.current(), ms);
  }, [ms]);
}

// ---------- a tiny observable value (the playhead updates 30×/s without re-rendering the editor) ----------

export function createStore<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => {
      if (v === value) return;
      value = v;
      subs.forEach((s) => s());
    },
    subscribe: (s: () => void) => {
      subs.add(s);
      return () => void subs.delete(s);
    },
  };
}
export type Store<T> = ReturnType<typeof createStore<T>>;

/**
 * Sound in the Studio's players. Off each time the Studio loads (nothing plays out loud on its own);
 * turning it on in any player keeps it on for the rest of the visit, so the next clip does not mute again.
 */
export const soundOn = createStore<boolean>(false);

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}

// ---------- routing ----------

export type Route = { page: 'library' } | { page: 'review'; id?: string } | { page: 'jobs' } | { page: 'video'; id: string } | { page: 'clip'; id: string };

export function parseRoute(hash: string): Route {
  const [, page, id] = hash.replace(/^#/, '').split('/');
  if (page === 'video' && id) return { page: 'video', id };
  if (page === 'clip' && id) return { page: 'clip', id };
  // #/review/<clipId> opens the review page on that clip (its tab), e.g. back from the editor
  if (page === 'review') return id ? { page: 'review', id } : { page: 'review' };
  if (page === 'jobs') return { page: 'jobs' };
  return { page: 'library' };
}

export const go = (hash: string) => {
  window.location.hash = hash;
};

export const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};
