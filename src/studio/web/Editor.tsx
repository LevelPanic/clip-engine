// The clip editor: palette + transcript | live 9:16 preview | inspector, with the timeline below.
// Edits autosave to clips/<id>/project.json; edits made by the CLI or agent appear live.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { ClipComposition } from '../../composition/ClipComposition';
import { durationInFrames, clipMap, WIDTH, HEIGHT, type ClipProps } from '../../composition/props';
import { srcToTNearest, tToSrc } from '../../core/timeline';
import type { Project, Word, Post } from '../../core/schemas';
import { FPS, FRAME_MS, fmtTime, clamp } from '../../core/time';
import { api, ApiError, createStore, go, isTyping, soundOn, useEvents, useStore, type Store, type SlimJob, type MediaRef } from './api';
import { Timeline, type Selection, type RangeAction } from './Timeline';
import { Inspector, fetchSfx } from './Inspector';
import { TYPES, TYPE_MAP, newMarkerId, sortMarkers, patchMarker } from './types';
import { framingKeys, framingAt } from '../../markers/define';
import { acceptProposals } from '../../core/proposals';
import { captionText } from '../../composition/Captions';
import { Chip, ShortcutLegend } from './ui';

interface ClipData {
  project: Project;
  tags: { ms: number; tag: string }[];
  meta: { title: string; channel: string; durationMs: number } | null;
  media: MediaRef | null;
  footageJob: SlimJob | null;
  export: { renderedAt: string; output: string; durationS: number; timings: { totalMs: number }; realtimeFactor: number; spec: Record<string, unknown> } | null;
  qa: { passed: boolean; loudnessLufs: number | null; issues: { level: string; check: string; detail: string }[]; checkedAt: string } | null;
  job: SlimJob | null;
  siblings: { id: string; title: string }[];
  postSuggestion: Post;
}

const PAD = 8000; // context shown before the in-point and after the out-point

const viewFor = (p: Project) => ({
  startMs: Math.max(0, p.segments[0].startMs - PAD),
  endMs: Math.min(p.sourceDurationMs, p.segments[0].endMs + PAD),
});

export function Editor({ clipId }: { clipId: string }) {
  const [data, setData] = useState<ClipData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [project, setProjectState] = useState<Project | null>(null);
  const projRef = useRef<Project | null>(null);
  const [view, setView] = useState<{ startMs: number; endMs: number } | null>(null);
  const [words, setWords] = useState<Word[]>([]);
  const wordsRange = useRef({ from: Infinity, to: -Infinity });
  const [wave, setWave] = useState<{ fromMs: number; stepMs: number; peaks: number[] } | null>(null);
  const [sel, setSel] = useState<Selection>(null);
  const [range, setRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [safeZone, setSafeZone] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved' | 'error'>('saved');
  const [toastMsg, setToastState] = useState<string | null>(null);
  const [job, setJob] = useState<ClipData['job']>(null);
  const [sfx, setSfx] = useState<string[]>([]);
  const [presets, setPresets] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [qaJob, setQaJob] = useState<SlimJob | null>(null);
  /** Playback started from the in-point stops (or loops) at the out-point. */
  const clipPlay = useRef(false);
  const loopRef = useRef(false);
  loopRef.current = loop;
  const playerRef = useRef<PlayerRef>(null);
  const playhead = useMemo(() => createStore(0), []); // source ms
  const playT = useMemo(() => createStore(0), []); // edited-timeline ms

  const savedRev = useRef(0);
  const dirty = useRef(false);
  const saving = useRef(false);
  const saveAgain = useRef(false);
  const saveTimer = useRef<number>(undefined);
  const hist = useRef<{ past: Project[]; future: Project[]; lastKey?: string; lastAt: number }>({ past: [], future: [], lastAt: 0 });

  const toast = useCallback((msg: string) => {
    setToastState(msg);
    window.setTimeout(() => setToastState((t) => (t === msg ? null : t)), 3500);
  }, []);

  const setProject = (p: Project) => {
    projRef.current = p;
    setProjectState(p);
  };

  // ---------- load & save ----------

  const load = useCallback(
    async (note?: string) => {
      try {
        const d = await api<ClipData>(`/api/clips/${clipId}`);
        setData(d);
        setJob(d.job);
        setProject(d.project);
        savedRev.current = d.project.rev;
        dirty.current = false;
        setSaveState('saved');
        setView((v) => v ?? viewFor(d.project));
        if (note) {
          // someone else changed the file: undoing past this point would silently revert their edit
          hist.current = { past: [], future: [], lastAt: 0 };
          toast(note);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [clipId, toast],
  );

  useEffect(() => {
    void load();
    fetchSfx().then(setSfx);
    api<string[]>('/api/presets').then(setPresets);
  }, [load]);

  const save = useCallback(async () => {
    if (saving.current) {
      saveAgain.current = true;
      return;
    }
    const p = projRef.current;
    if (!p) return;
    saving.current = true;
    setSaveState('saving');
    try {
      const r = await api<{ project: Project }>(`/api/clips/${clipId}`, {
        method: 'PUT',
        body: { project: { ...p, rev: savedRev.current }, baseRev: savedRev.current },
      });
      savedRev.current = r.project.rev;
      if (projRef.current === p) {
        dirty.current = false;
        setSaveState('saved');
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) await load('This clip changed on disk (CLI or agent), so it was reloaded.');
      else {
        setSaveState('error');
        toast(`Save failed: ${(e as Error).message}`);
      }
    } finally {
      saving.current = false;
      if (saveAgain.current) {
        saveAgain.current = false;
        void save();
      }
    }
  }, [clipId, load, toast]);

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    if (dirty.current) await save();
    while (saving.current) await new Promise((r) => setTimeout(r, 50));
  }, [save]);

  // leaving the clip (prev/next, back, closing the tab) saves the last edit instead of dropping it
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      void flushRef.current();
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      if (dirty.current) void flushRef.current();
    };
  }, []);

  /** Every edit goes through here: history (merging rapid edits with the same key), then autosave. */
  const update = useCallback(
    (fn: (p: Project) => Project, key?: string) => {
      const cur = projRef.current;
      if (!cur) return;
      const next = fn(cur);
      if (next === cur) return;
      const h = hist.current;
      const now = Date.now();
      if (!(key && key === h.lastKey && now - h.lastAt < 1500)) {
        h.past.push(cur);
        if (h.past.length > 300) h.past.shift();
      }
      h.future = [];
      h.lastKey = key;
      h.lastAt = now;
      setProject(next);
      dirty.current = true;
      setSaveState('unsaved');
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void save(), 400);
    },
    [save],
  );

  const undoRedo = (dir: 'undo' | 'redo') => {
    const h = hist.current;
    const from = dir === 'undo' ? h.past : h.future;
    const to = dir === 'undo' ? h.future : h.past;
    const p = from.pop();
    if (!p || !projRef.current) return;
    to.push(projRef.current);
    h.lastKey = undefined;
    setProject(p);
    dirty.current = true;
    setSaveState('unsaved');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void save(), 300);
  };

  // live updates from disk / renders
  useEvents((e) => {
    if (e.type === 'project' && e.clipId === clipId && e.rev > savedRev.current && !dirty.current && !saving.current) {
      void load('Updated from disk (CLI or agent edit).');
    }
    if (e.type === 'job' && e.job.kind === 'render' && e.job.clipId === clipId) setJob(e.job);
    if (e.type === 'job' && e.job.kind === 'qa' && e.job.clipId === clipId) setQaJob(e.job);
    const footageDone = e.type === 'job' && data && e.job.videoId === data.project.videoId && (e.job.kind === 'sections' || e.job.kind === 'full');
    if ((e.type === 'export' && e.clipId === clipId) || footageDone) {
      api<ClipData>(`/api/clips/${clipId}`).then((d) => setData((old) => (old ? { ...old, media: d.media, footageJob: d.footageJob, export: d.export, qa: d.qa } : d)));
    }
  });

  // ---------- words & waveform for the visible range ----------

  useEffect(() => {
    if (!view || !project) return;
    const r = wordsRange.current;
    if (view.startMs >= r.from && view.endMs <= r.to) return;
    const from = view.startMs - 30_000;
    const to = view.endMs + 30_000;
    api<Word[]>(`/api/videos/${project.videoId}/words?from=${from}&to=${to}`).then((w) => {
      wordsRange.current = { from, to };
      setWords(w);
    });
  }, [view, project?.videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!view || !data?.media) return;
    api<{ fromMs: number; stepMs: number; peaks: number[] }>(`/api/clips/${clipId}/waveform?from=${view.startMs}&to=${view.endMs}`).then(setWave, () => {});
  }, [view, clipId, data?.media]);

  // ---------- player ----------

  const inputProps = useMemo<ClipProps | null>(() => {
    if (!project || !view) return null;
    const seg = project.segments[0];
    return {
      project,
      words,
      media: data?.media ? { src: data.media.url, offsetMs: data.media.offsetMs, width: data.media.width, height: data.media.height } : { src: '', offsetMs: 0, width: 1920, height: 1080 },
      // context around the clip, shown dimmed (the edit itself is the time map)
      pad: { beforeMs: Math.min(PAD, seg.startMs), afterMs: Math.min(PAD, project.sourceDurationMs - seg.endMs) },
      assetBase: '/media/assets/',
      studio: { dimOutside: true, safeZone },
    };
  }, [project, words, view, data?.media, safeZone]);

  // the player runs on the edited timeline; the timeline UI and playhead stay in source time
  const map = inputProps ? clipMap(inputProps) : null;
  const frames = inputProps ? durationInFrames(inputProps) : 1;
  const seek = useCallback(
    (ms: number) => {
      if (!map) return;
      const t = srcToTNearest(map, ms);
      const f = clamp(Math.round(((t - map.tStart) * FPS) / 1000), 0, frames - 1);
      playerRef.current?.seekTo(f);
      const tf = map.tStart + (f * 1000) / FPS;
      playT.set(tf);
      playhead.set(tToSrc(map, tf));
    },
    [map, frames, playhead, playT],
  );

  const hasPlayer = !!inputProps;
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !map) return;
    const inFrame = Math.round((-map.tStart * FPS) / 1000); // t = 0 is the in-point
    const onFrame = (e: { detail: { frame: number } }) => {
      const tf = map.tStart + (e.detail.frame * 1000) / FPS;
      // reaching the out-point: loop back to the in-point, or stop there when playing the clip
      if (p.isPlaying() && tf >= map.durationMs && playT.get() < map.durationMs && (loopRef.current || clipPlay.current)) {
        if (loopRef.current) {
          p.seekTo(inFrame);
          playT.set(0);
          playhead.set(tToSrc(map, 0));
          return;
        }
        // stop on the out-point's last frame, even when the frame update came late
        p.pause();
        clipPlay.current = false;
        const outFrame = Math.round(((map.durationMs - map.tStart) * FPS) / 1000) - 1;
        p.seekTo(outFrame);
        const to = map.tStart + (outFrame * 1000) / FPS;
        playT.set(to);
        playhead.set(tToSrc(map, to));
        return;
      }
      playT.set(tf);
      playhead.set(tToSrc(map, tf));
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    p.addEventListener('frameupdate', onFrame);
    p.addEventListener('seeked', onFrame);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    p.addEventListener('ended', onPause);
    return () => {
      p.removeEventListener('frameupdate', onFrame);
      p.removeEventListener('seeked', onFrame);
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
      p.removeEventListener('ended', onPause);
    };
  }, [map, hasPlayer, playhead, playT]);

  // keep the playhead on the same source time when the view changes; start at the in-point
  const first = useRef(true);
  useEffect(() => {
    if (!view || !projRef.current) return;
    const target = first.current ? projRef.current.segments[0].startMs : playhead.get();
    first.current = false;
    const t = window.setTimeout(() => seek(target), 30);
    return () => window.clearTimeout(t);
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  /** After trimming, widen the view if the clip edges got close to (or past) it. */
  const onTrimEnd = useCallback(() => {
    const p = projRef.current;
    if (!p) return;
    setView((v) => {
      const seg = p.segments[0];
      if (v && seg.startMs - v.startMs >= 1500 && v.endMs - seg.endMs >= 1500 && v.endMs - v.startMs < seg.endMs - seg.startMs + 4 * PAD) return v;
      return viewFor(p);
    });
  }, []);

  // ---------- actions ----------

  const addMarkerAt = useCallback(
    (ms: number) => {
      const t = TYPES[paletteIdx];
      const p = projRef.current;
      if (!t || !p) return;
      const startMs = Math.round(clamp(ms, 0, p.sourceDurationMs - 1));
      const params = t.params.parse({}) as Record<string, unknown>;
      const m = {
        id: newMarkerId(),
        type: t.type,
        startMs,
        endMs: t.kind === 'span' ? Math.min(p.sourceDurationMs, startMs + (t.defaultDurationMs ?? 1000)) : undefined,
        params,
      };
      update((pp) => ({ ...pp, markers: sortMarkers([...pp.markers, m]) }));
      setSel({ kind: 'marker', id: m.id });
    },
    [paletteIdx, update],
  );

  const setInOut = (edge: 'in' | 'out', ms: number) => {
    const p = projRef.current;
    if (!p) return;
    const seg = { ...p.segments[0] };
    if (edge === 'in') {
      if (ms > seg.endMs - 1000) return toast('In must be at least 1 s before out');
      seg.startMs = Math.round(ms);
    } else {
      if (ms < seg.startMs + 1000) return toast('Out must be at least 1 s after in');
      seg.endMs = Math.round(ms);
    }
    update((pp) => ({ ...pp, segments: [seg] }));
    window.setTimeout(onTrimEnd);
  };

  /** Play from the in-point; stops at the out-point (or loops). */
  const playClip = () => {
    if (!projRef.current) return;
    seek(projRef.current.segments[0].startMs);
    clipPlay.current = true;
    playerRef.current?.play();
  };

  const duplicate = async () => {
    await flush();
    const { clipId: id } = await api<{ clipId: string }>(`/api/clips/${clipId}/duplicate`, { method: 'POST' });
    go(`#/clip/${id}`);
  };
  const remove = async () => {
    if (!projRef.current) return;
    if (!window.confirm(`Delete “${projRef.current.title}”? It moves to clips/.trash/ and its candidate can be made again.`)) return;
    const videoId = projRef.current.videoId;
    await api(`/api/clips/${clipId}/delete`, { method: 'POST' });
    go(`#/video/${videoId}`);
  };
  const setReviewStatus = async (status: string) => {
    await flush();
    await api(`/api/clips/${clipId}/review`, { body: { status } });
  };

  const exportClip = async () => {
    // proposed (dashed) markers are left out of exports; don't let a style's edits vanish silently
    const n = projRef.current?.markers.filter((m) => m.proposed).length ?? 0;
    if (n && window.confirm(`${n} proposed edit${n > 1 ? 's are' : ' is'} not accepted yet, so ${n > 1 ? 'they' : 'it'} won't be in the export.\n\nOK: accept them and export · Cancel: export without them`)) {
      update((p) => acceptProposals(p));
    }
    await flush();
    try {
      const j = await api<ClipData['job']>(`/api/clips/${clipId}/render`, { method: 'POST' });
      setJob(j);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const savePreset = async (name: string) => {
    await flush();
    await api('/api/presets', { body: { clipId, name } });
    setPresets(await api<string[]>('/api/presets'));
    toast(`Saved preset “${name}”`);
  };
  const applyPreset = async (name: string) => {
    await flush();
    const before = projRef.current;
    const r = await api<{ project: Project }>(`/api/clips/${clipId}/apply-preset`, { body: { name } });
    if (before) hist.current.past.push(before);
    savedRev.current = r.project.rev;
    setProject(r.project);
    toast(`Applied preset “${name}” (⌘Z to undo)`);
  };

  /** Quick effects: drop at the playhead (glitch also gets its sound, flash a shutter). */
  const addQuick = (type: string, extra: Record<string, unknown>) => {
    const p = projRef.current;
    const t = TYPE_MAP.get(type);
    if (!p || !t) return;
    const at = Math.round(playhead.get());
    const mk = (ty: string, params: Record<string, unknown>, len?: number) => {
      const tt = TYPE_MAP.get(ty)!;
      const endMs = tt.kind === 'span' ? Math.min(p.sourceDurationMs, at + (len ?? tt.defaultDurationMs ?? 1000)) : undefined;
      return { id: newMarkerId(), type: ty, startMs: at, endMs, params: { ...(tt.params.parse({}) as Record<string, unknown>), ...params } };
    };
    const ms = [mk(type, extra)];
    if (type === 'glitch' && TYPE_MAP.has('sfx')) ms.push(mk('sfx', { sound: 'glitch.wav', volume: 0.6 }));
    if (type === 'flash' && TYPE_MAP.has('sfx')) ms.push(mk('sfx', { sound: 'shutter.wav', volume: 0.7 }));
    update((pp) => ({ ...pp, markers: sortMarkers([...pp.markers, ...ms]) }));
    setSel({ kind: 'marker', id: ms[0].id });
  };

  // ---------- range actions ----------

  const onRangeAction = async (kind: RangeAction) => {
    const p = projRef.current;
    if (!p || !range) return;
    const { startMs, endMs } = range;
    const params = (type: string, extra: Record<string, unknown> = {}) => ({ ...(TYPE_MAP.get(type)!.params.parse({}) as Record<string, unknown>), ...extra });
    const add = (ms: { type: string; startMs: number; endMs?: number; params: Record<string, unknown> }[]) =>
      update((pp) => ({ ...pp, markers: sortMarkers([...pp.markers, ...ms.map((m) => ({ ...m, id: newMarkerId() }))]) }));
    if (kind === 'cut') add([{ type: 'cut', startMs, endMs, params: params('cut') }]);
    if (kind === 'speed') add([{ type: 'speed', startMs, endMs, params: params('speed') }]);
    if (kind === 'zoom') add([{ type: 'zoom', startMs, endMs, params: params('zoom', { scale: 1.2, easing: 'smooth', rampMs: 500 }) }]);
    if (kind === 'text') add([{ type: 'text', startMs, endMs, params: params('text', { text: 'Your text' }) }]);
    if (kind === 'crop' || kind === 'blur') {
      // switch framing for the span, then return to whatever was there before
      const keys = framingKeys(p.markers, (t) => TYPE_MAP.get(t));
      const at = framingAt(keys, p.framing, startMs);
      const after = framingAt(keys, p.framing, endMs);
      const into = { mode: kind, cropX: kind === 'crop' ? (at.mode === 'crop' ? at.cropX : p.framing.cropX) : at.cropX, easeMs: 0 };
      // a facecam-only span ends by itself; what a reframe can go back to is the split under it
      const back = { mode: after.mode === 'cam' || after.mode === 'game' ? 'split' : after.mode, cropX: after.cropX, easeMs: 0 };
      add([
        { type: 'reframe', startMs, params: params('reframe', into) },
        ...(endMs < p.segments[0].endMs - 100 ? [{ type: 'reframe', startMs: endMs, params: params('reframe', back) }] : []),
      ]);
    }
    if (kind === 'reframe') {
      await flush();
      try {
        await api(`/api/clips/${clipId}/action`, { body: { kind: 'reframe', range } });
        toast('Tracking faces in the selection… the proposed reframes appear in a few seconds');
      } catch (e) {
        toast((e as Error).message);
      }
    }
    if (kind !== 'reframe') toast(`Added ${kind === 'crop' ? 'crop' : kind === 'blur' ? 'blur-fit' : kind} for ${((endMs - startMs) / 1000).toFixed(1)} s (⌘Z to undo)`);
    setRange(null);
  };

  // ---------- keyboard ----------

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (isTyping(e)) return;
    const p = projRef.current;
    if (!p) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoRedo(e.shiftKey ? 'redo' : 'undo');
      return;
    }
    if (mod) return;
    const k = e.key;
    if (k === ' ') {
      e.preventDefault();
      playerRef.current?.toggle();
    } else if (k === 'i' || k === 'I') setInOut('in', playhead.get());
    else if (k === 'o' || k === 'O') setInOut('out', playhead.get());
    else if (k === 'm' || k === 'M') addMarkerAt(playhead.get());
    else if (k === 'l' || k === 'L') setLoop((v) => !v);
    else if (k === 'Enter') {
      playClip();
    } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      const d = (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1) * FRAME_MS;
      if (sel?.kind === 'marker') {
        const m = p.markers.find((x) => x.id === sel.id);
        if (m) {
          const startMs = Math.round(clamp(m.startMs + d, 0, p.sourceDurationMs));
          update((pp) => patchMarker(pp, m.id, { startMs, endMs: m.endMs !== undefined ? Math.round(m.endMs + (startMs - m.startMs)) : undefined }), `nudge:${m.id}`);
        }
      } else seek(playhead.get() + d);
    } else if ((k === 'Delete' || k === 'Backspace') && sel?.kind === 'marker') {
      e.preventDefault();
      update((pp) => ({ ...pp, markers: pp.markers.filter((x) => x.id !== sel.id) }));
      setSel(null);
    } else if ((k === 'a' || k === 'A') && sel?.kind === 'marker') {
      update((pp) => acceptProposals(pp, [sel.id]));
    } else if (k === '[' || k === ']') {
      const ms = Math.round(playhead.get());
      const seg = p.segments[0];
      setRange((r) => {
        const cur = r ?? { startMs: seg.startMs, endMs: seg.endMs };
        const next = k === '[' ? { startMs: ms, endMs: Math.max(cur.endMs, ms + 500) } : { startMs: Math.min(cur.startMs, ms - 500), endMs: ms };
        return { startMs: clamp(next.startMs, seg.startMs, seg.endMs), endMs: clamp(next.endMs, seg.startMs, seg.endMs) };
      });
    } else if (k === 'Escape') (setSel(null), setRange(null));
    else if (/^[1-9]$/.test(k) && Number(k) <= TYPES.length) setPaletteIdx(Number(k) - 1);
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // ---------- render ----------

  if (error) return <div className="page">✖ {error}</div>;
  if (!project || !view || !data || !inputProps) return <div className="page muted">Loading…</div>;
  const seg = project.segments[0];

  return (
    <div className="editor">
      <div className="topbar">
        <a className="back" href={`#/video/${project.videoId}`} title="Back to this video's candidates">
          ← Candidates
        </a>
        <a className="back" href={`#/review/${clipId}`} title="Back to the review page, on this clip">
          ↩ Review
        </a>
        <ClipNav clipId={clipId} siblings={data.siblings} />
        <div className="title grow" title={project.title}>
          {project.title}
        </div>
        <span className="save-state">{saveState === 'saved' ? 'saved' : saveState === 'saving' ? 'saving…' : saveState === 'unsaved' ? 'editing…' : '⚠ not saved'}</span>
        <button className="ghost" title="Undo (⌘Z)" aria-label="Undo" onClick={() => undoRedo('undo')}>
          ↶
        </button>
        <button className="ghost" title="Redo (⇧⌘Z)" aria-label="Redo" onClick={() => undoRedo('redo')}>
          ↷
        </button>
        <label className="check muted">
          <input type="checkbox" checked={safeZone} onChange={(e) => setSafeZone(e.target.checked)} /> safe zone
        </label>
        <ClipMenu onDuplicate={() => void duplicate()} onDelete={() => void remove()} />
        <select
          value={project.review?.status ?? 'editing'}
          onChange={(e) => void setReviewStatus(e.target.value)}
          title="Review status: send it to the review queue, or approve it yourself"
          aria-label="Review status"
          className="auto-width"
        >
          <option value="editing">editing</option>
          <option value="review">in review</option>
          <option value="approved">approved</option>
          <option value="changes">needs changes</option>
          <option value="rejected">rejected</option>
        </select>
        <QaChip qa={data.qa} job={qaJob} exp={data.export} />
        <ExportButton job={job} exp={data.export} clipId={clipId} title={project.title} onExport={exportClip} hasMedia={!!data.media} />
      </div>

      <div className="main">
        <div className="side">
          <div className="section">
            <h3>Markers</h3>
            {TYPES.map((t, i) => (
              <button type="button" key={t.type} className={`palette-item ${i === paletteIdx ? 'sel' : ''}`} aria-pressed={i === paletteIdx} onClick={() => setPaletteIdx(i)} title={t.description}>
                {i < 9 ? <kbd>{i + 1}</kbd> : <span className="kbd-space" />}
                <span className="swatch" style={{ background: t.color }} />
                <span className="grow">{t.label}</span>
                <span className="muted tiny">{t.kind}</span>
              </button>
            ))}
            <button type="button" className="full-width mt-2" onClick={() => addMarkerAt(playhead.get())}>
              Drop {TYPES[paletteIdx]?.label} at playhead <kbd>M</kbd>
            </button>
          </div>
          <div className="section">
            <h3>Transcript</h3>
            <TranscriptPanel words={words} project={project} playhead={playhead} sel={sel} onWord={(w) => (setSel({ kind: 'word', i: w.i }), seek(w.startMs))} />
          </div>
          <div className="section">
            <ShortcutLegend
              keys={[
                ['space', 'play'],
                ['enter', 'play clip'],
                ['L', 'loop'],
                ['I O', 'in / out'],
                ['M', 'drop marker'],
                ['1–9', 'type'],
                ['← →', 'frame'],
                ['⌫', 'delete'],
                ['⌘Z', 'undo'],
              ]}
            />
          </div>
        </div>

        <div className="stage">
          <div className="player-box">
            <Player
              ref={playerRef}
              component={ClipComposition}
              inputProps={inputProps}
              durationInFrames={frames}
              fps={FPS}
              compositionWidth={WIDTH}
              compositionHeight={HEIGHT}
              style={{ width: '100%', height: '100%' }}
              acknowledgeRemotionLicense
              clickToPlay={false}
              initiallyMuted={!soundOn.get()}
            />
          </div>
          {!data.media && (
            <div className="warn">
              Fetching this clip's footage{data.footageJob?.progress ? ` (${data.footageJob.progress})` : '…'} The preview shows captions and effects until it arrives.
            </div>
          )}
          <div className="transport">
            <button type="button" className="w-play" onClick={() => playerRef.current?.toggle()}>
              {playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button onClick={playClip} title="Play the clip from its in-point to its out-point (Enter)">
              ⏮ Play clip
            </button>
            <SoundButton playerRef={playerRef} />
            <label className="check muted" title="Loop between the in- and out-points (L)">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> loop
            </label>
            <TimeReadout store={playhead} tStore={playT} lengthMs={map?.durationMs ?? seg.endMs - seg.startMs} />
          </div>
        </div>

        <div className="side right">
          <Inspector
            project={project}
            sel={sel}
            setSel={setSel}
            update={update}
            words={words}
            sfx={sfx}
            presets={presets}
            onSavePreset={(n) => void savePreset(n)}
            onApplyPreset={(n) => void applyPreset(n)}
            onTrimEnd={onTrimEnd}
            onQuick={addQuick}
            postSuggestion={data.postSuggestion}
          />
        </div>
      </div>

      <Timeline
        project={project}
        view={view}
        words={words}
        tags={data.tags}
        wave={wave}
        playhead={playhead}
        seek={seek}
        sel={sel}
        setSel={setSel}
        paletteType={TYPES[paletteIdx]?.type ?? ''}
        update={update}
        onTrimEnd={onTrimEnd}
        range={range}
        setRange={setRange}
        onRangeAction={(k) => void onRangeAction(k)}
      />
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}

function TimeReadout({ store, tStore, lengthMs }: { store: Store<number>; tStore: Store<number>; lengthMs: number }) {
  const ms = useStore(store);
  const t = useStore(tStore);
  return (
    <span className="mono muted">
      <span className="text-strong">{fmtTime(t, 2)}</span> / {fmtTime(lengthMs, 1)} edited · source {fmtTime(ms, 2)}
    </span>
  );
}

function TranscriptPanel({
  words,
  project,
  playhead,
  sel,
  onWord,
}: {
  words: Word[];
  project: Project;
  playhead: Store<number>;
  sel: Selection;
  onWord: (w: Word) => void;
}) {
  const ms = useStore(playhead);
  const seg = project.segments[0];
  const shown = words.filter((w) => w.endMs >= seg.startMs - 6000 && w.startMs <= seg.endMs + 6000);
  return (
    <div className="transcript">
      {shown.map((w) => {
        const fix = project.captions.fixes[String(w.i)];
        const text = captionText(w, project.captions.fixes, project.captions.censor !== false);
        const cls = [
          'w',
          ms >= w.startMs && ms < w.endMs ? 'now' : '',
          fix !== undefined ? (text === null ? 'hidden' : 'fixed') : '',
          sel?.kind === 'word' && sel.i === w.i ? 'sel' : '',
          w.startMs < seg.startMs || w.startMs >= seg.endMs ? 'out' : '',
        ].join(' ');
        return (
          <React.Fragment key={w.i}>
            {w.speakerChange && <br />}
            <span className={cls} onClick={() => onWord(w)} title={fix !== undefined ? `captions heard “${w.text}”` : 'click to fix'}>
              {fix !== undefined ? fix || w.text : w.text}
            </span>{' '}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function ExportButton({
  job,
  exp,
  clipId,
  title,
  onExport,
  hasMedia,
}: {
  job: ClipData['job'];
  exp: ClipData['export'];
  clipId: string;
  title: string;
  onExport: () => void;
  hasMedia: boolean;
}) {
  const running = job?.state === 'running' || job?.state === 'queued';
  const file = `${title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || clipId}.mp4`;
  const url = exp ? `/media/exports/${clipId}.mp4?t=${encodeURIComponent(exp.renderedAt)}` : '';
  return (
    <div className="row">
      {running && <span className="muted mono">{job?.state === 'queued' ? 'queued' : `rendering ${job?.progress ?? ''}`}</span>}
      {job?.state === 'failed' && (
        <span className="warn" title={job.error ?? undefined}>
          render failed
        </span>
      )}
      {!running && exp && (
        <>
          <a href={url} target="_blank" rel="noreferrer" title={`${exp.durationS} s · rendered in ${(exp.timings.totalMs / 1000).toFixed(0)} s`}>
            ▶ watch
          </a>
          <a href={url} download={file} title={`Download ${file}`}>
            ⬇ download
          </a>
        </>
      )}
      <button className="primary" disabled={running || !hasMedia} onClick={onExport} title={hasMedia ? 'Render the MP4 (then QA checks it)' : 'Wait for the video download'}>
        {running ? 'Exporting…' : exp ? 'Re-export' : 'Export'}
      </button>
    </div>
  );
}

/** QA result of the last export: passed, or the issues on hover. */
function QaChip({ qa, job, exp }: { qa: ClipData['qa']; job: SlimJob | null; exp: ClipData['export'] }) {
  if (job && (job.state === 'queued' || job.state === 'running')) return <span className="chip">checking…</span>;
  if (!qa || !exp) return null;
  const stale = new Date(qa.checkedAt) < new Date(exp.renderedAt);
  if (stale) return null;
  const tip = qa.issues.map((i) => `${i.level === 'fail' ? '✖' : '⚠'} ${i.check}: ${i.detail}`).join('\n');
  return (
    <Chip on tone={qa.passed ? 'good' : 'bad'} title={tip || 'No issues'}>
      QA {qa.passed ? '✓' : '✖'}
      {qa.issues.length ? ` · ${qa.issues.length} note${qa.issues.length > 1 ? 's' : ''}` : ''}
    </Chip>
  );
}

/** Previous / next clip from the same video. */
function ClipNav({ clipId, siblings }: { clipId: string; siblings: ClipData['siblings'] }) {
  const i = siblings.findIndex((s) => s.id === clipId);
  if (siblings.length < 2 || i < 0) return null;
  const prev = siblings[i - 1];
  const next = siblings[i + 1];
  return (
    <span className="row gap-0">
      <button className="ghost" disabled={!prev} title={prev ? `Previous clip: ${prev.title}` : undefined} aria-label="Previous clip" onClick={() => prev && go(`#/clip/${prev.id}`)}>
        ‹
      </button>
      <span className="muted mono tiny">
        {i + 1}/{siblings.length}
      </span>
      <button className="ghost" disabled={!next} title={next ? `Next clip: ${next.title}` : undefined} aria-label="Next clip" onClick={() => next && go(`#/clip/${next.id}`)}>
        ›
      </button>
    </span>
  );
}

function ClipMenu({ onDuplicate, onDelete }: { onDuplicate: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="menu-anchor">
      <button className="ghost" title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        ⋯
      </button>
      {open && (
        <div className="menu" onMouseLeave={() => setOpen(false)}>
          <button onClick={() => (setOpen(false), onDuplicate())} title="Copy this clip to try a different edit">
            Duplicate clip
          </button>
          <button className="danger" onClick={() => (setOpen(false), onDelete())}>
            Delete clip
          </button>
        </div>
      )}
    </span>
  );
}

export { go };

/** Sound on/off for the editor's player (it has no controls of its own). Starts off. (M already drops a marker.) */
function SoundButton({ playerRef }: { playerRef: React.RefObject<PlayerRef | null> }) {
  const on = useStore(soundOn);
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    if (on) p.unmute();
    else p.mute();
  }, [on, playerRef]);
  return (
    <button type="button" className="w-sound" onClick={() => soundOn.set(!on)} title="Sound on or off. Off each time the Studio loads." aria-label={on ? 'Sound on' : 'Sound off'} aria-pressed={on}>
      {on ? '🔊' : '🔇'}
    </button>
  );
}
