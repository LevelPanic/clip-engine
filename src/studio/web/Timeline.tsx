// Timeline: ruler with in/out handles, waveform, caption words, and one lane per marker type.
// Everything is positioned in source-video time; dragging snaps to the export's frame grid.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Project, Word, Marker } from '../../core/schemas';
import { FRAME_MS, fmtTime, clamp } from '../../core/time';
import { markerRenderMs } from '../../markers/define';
import { useStore, type Store } from './api';
import { TYPES, TYPE_MAP, markerLabel, patchMarker } from './types';
import { captionText } from '../../composition/Captions';
import { WAVE_COLOR } from './ui/tokens';

export type Selection = { kind: 'marker'; id: string } | { kind: 'word'; i: number } | null;

interface Props {
  project: Project;
  view: { startMs: number; endMs: number };
  words: Word[];
  tags: { ms: number; tag: string }[];
  wave: { fromMs: number; stepMs: number; peaks: number[] } | null;
  playhead: Store<number>;
  seek: (ms: number) => void;
  sel: Selection;
  setSel: (s: Selection) => void;
  paletteType: string;
  update: (fn: (p: Project) => Project, key?: string) => void;
  onTrimEnd: () => void;
  /** A selected span of source time (shift+drag on the ruler, or [ and ] at the playhead). */
  range: { startMs: number; endMs: number } | null;
  setRange: (r: { startMs: number; endMs: number } | null) => void;
  onRangeAction: (kind: RangeAction) => void;
}

export type RangeAction = 'cut' | 'speed' | 'zoom' | 'text' | 'reframe' | 'crop' | 'blur';
const RANGE_ACTIONS: { kind: RangeAction; label: string; title: string }[] = [
  { kind: 'cut', label: 'Cut out', title: 'Remove this span (jump cut)' },
  { kind: 'speed', label: 'Speed 1.5×', title: 'Play this span faster' },
  { kind: 'zoom', label: 'Zoom', title: 'Smooth push-in over this span' },
  { kind: 'text', label: 'Text', title: 'On-screen text for this span' },
  { kind: 'reframe', label: 'Auto-reframe', title: 'Track faces in this span and crop to the subject' },
  { kind: 'crop', label: 'Crop here', title: 'Fill the frame (crop) for this span' },
  { kind: 'blur', label: 'Blur-fit here', title: 'Show the whole picture (blur-fit) for this span' },
];

const LABEL_W = 92;

export function Timeline(props: Props) {
  const { project, view, words, tags, wave, playhead, seek, sel, setSel, paletteType, update, onTrimEnd, range, setRange, onRangeAction } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(900);
  const [zoom, setZoom] = useState(1);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const W = Math.max(200, boxW * zoom);
  const span = view.endMs - view.startMs;
  const x = (ms: number) => ((ms - view.startMs) / span) * W;
  const seg = project.segments[0];
  const dur = project.sourceDurationMs;
  // snap to the export's frame grid (frames counted from the in-point)
  const snap = (ms: number) => Math.round(seg.startMs + Math.round((ms - seg.startMs) / FRAME_MS) * FRAME_MS);

  /** Drag helper: reports the pointer's movement in ms. */
  const drag = (e: React.PointerEvent, onMove: (dMs: number) => void, onEnd?: () => void) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const move = (ev: PointerEvent) => onMove(((ev.clientX - x0) / W) * span);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      onEnd?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const msAt = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).closest('.tl-content')!.getBoundingClientRect();
    return view.startMs + ((e.clientX - r.left) / W) * span;
  };

  /** shift+drag on the ruler selects a span instead of scrubbing */
  const selectRange = (e: React.PointerEvent) => {
    const ms0 = snap(clamp(msAt(e), seg.startMs, seg.endMs));
    setRange(null);
    drag(e, (d) => {
      const ms1 = snap(clamp(ms0 + d, seg.startMs, seg.endMs));
      if (Math.abs(ms1 - ms0) >= FRAME_MS) setRange({ startMs: Math.min(ms0, ms1), endMs: Math.max(ms0, ms1) });
    });
  };

  const scrub = (e: React.PointerEvent) => {
    if (e.shiftKey) return selectRange(e);
    const ms0 = msAt(e);
    seek(ms0);
    drag(e, (d) => seek(clamp(ms0 + d, view.startMs, view.endMs)));
  };

  const trim = (edge: 'in' | 'out') => (e: React.PointerEvent) => {
    const key = `trim:${edge}:${Date.now()}`;
    const orig = { ...seg };
    drag(
      e,
      (d) => {
        update((p) => {
          const s = { ...p.segments[0] };
          if (edge === 'in') s.startMs = clamp(Math.round(orig.startMs + d), 0, orig.endMs - 1000);
          else s.endMs = clamp(Math.round(orig.endMs + d), orig.startMs + 1000, dur);
          return { ...p, segments: [s] };
        }, key);
        seek(edge === 'in' ? orig.startMs + d : orig.endMs + d);
      },
      onTrimEnd,
    );
  };

  const moveMarker = (m: Marker, part: 'body' | 'l' | 'r') => (e: React.PointerEvent) => {
    setSel({ kind: 'marker', id: m.id });
    const key = `drag:${m.id}:${Date.now()}`;
    const o = { ...m };
    drag(e, (d) => {
      update((p) => {
        if (part === 'body') {
          const len = o.endMs !== undefined ? o.endMs - o.startMs : 0;
          const startMs = clamp(snap(o.startMs + d), 0, dur - len);
          return patchMarker(p, m.id, { startMs, endMs: o.endMs !== undefined ? startMs + len : undefined });
        }
        if (part === 'l') return patchMarker(p, m.id, { startMs: clamp(snap(o.startMs + d), 0, o.endMs! - 3 * FRAME_MS) });
        return patchMarker(p, m.id, { endMs: clamp(snap(o.endMs! + d), o.startMs + 3 * FRAME_MS, dur) });
      }, key);
    });
  };

  // ruler ticks
  const ticks = useMemo(() => {
    const pxPerSec = (W / span) * 1000;
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * pxPerSec >= 70) ?? 60;
    const out: number[] = [];
    for (let t = Math.ceil(view.startMs / 1000 / step) * step; t * 1000 <= view.endMs; t += step) out.push(t * 1000);
    return { out, step };
  }, [W, span, view.startMs, view.endMs]);

  // waveform
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(W * dpr);
    c.height = Math.round(26 * dpr);
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    if (!wave?.peaks.length) return;
    g.fillStyle = WAVE_COLOR;
    const mid = c.height / 2;
    for (let px = 0; px < c.width; px++) {
      const a = view.startMs + ((px / dpr) / W) * span;
      const b = view.startMs + (((px + 1) / dpr) / W) * span;
      let m = 0;
      for (let i = Math.floor((a - wave.fromMs) / wave.stepMs); i <= Math.floor((b - wave.fromMs) / wave.stepMs); i++) m = Math.max(m, wave.peaks[i] ?? 0);
      const h = Math.max(1, (m / 100) * c.height * 0.95);
      g.fillRect(px, mid - h / 2, 1, h);
    }
  }, [wave, W, span, view.startMs]);

  const inView = (s: number, e: number) => e >= view.startMs && s <= view.endMs;
  const visibleWords = words.filter((w) => inView(w.startMs, w.endMs));

  return (
    <div className="timeline">
      <div className="tl-bar">
        {range ? (
          <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="mono" style={{ color: 'var(--accent2)' }}>
              {fmtTime(range.startMs)}–{fmtTime(range.endMs)} ({((range.endMs - range.startMs) / 1000).toFixed(1)} s)
            </span>
            {RANGE_ACTIONS.map((a) => (
              <button key={a.kind} title={a.title} onClick={() => onRangeAction(a.kind)}>
                {a.label}
              </button>
            ))}
            <button className="ghost" title="Clear selection (esc)" onClick={() => setRange(null)}>
              ✕
            </button>
          </span>
        ) : (
          <span className="muted">
            Timeline · drag markers, edges and the purple in/out handles · <kbd>⇧</kbd>+drag the ruler (or <kbd>[</kbd> <kbd>]</kbd>) to select a span · <kbd>I</kbd>/
            <kbd>O</kbd> in/out · <kbd>M</kbd> drop · <kbd>←</kbd>
            <kbd>→</kbd> nudge
          </span>
        )}
        <span className="grow" />
        <span className="muted">zoom</span>
        <button onClick={() => setZoom((z) => Math.max(1, z / 1.6))}>−</button>
        <button onClick={() => setZoom(1)}>fit</button>
        <button onClick={() => setZoom((z) => Math.min(30, z * 1.6))}>+</button>
      </div>
      <div className="tl-body">
        <div className="tl-labels">
          <div className="tl-label" style={{ background: 'var(--panel2)' }}>time</div>
          <div className="tl-label">audio</div>
          <div className="tl-label">captions</div>
          {TYPES.map((t, i) => (
            <div key={t.type} className="tl-label" style={t.type === paletteType ? { color: 'var(--text)' } : undefined}>
              <span className="swatch" style={{ background: t.color }} />
              {i < 9 ? <kbd>{i + 1}</kbd> : null} {t.label}
            </div>
          ))}
        </div>
        <div
          className="tl-scroll"
          ref={scrollRef}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              setZoom((z) => clamp(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 30));
            }
          }}
        >
          <div className="tl-content" style={{ width: W }}>
            {/* dim outside in/out across all rows */}
            {/* cut spans: removed from the edit, hatched across every lane */}
            {project.markers
              .filter((m) => TYPE_MAP.get(m.type)?.time && m.endMs !== undefined)
              .map((m) => {
                const t = TYPE_MAP.get(m.type)!;
                const eff = t.time!(t.params.safeParse(m.params).data as never).effect;
                if (eff.kind !== 'remove') return null;
                return <div key={`cz-${m.id}`} className={`tl-cutzone ${m.proposed ? 'proposed' : ''}`} style={{ left: x(m.startMs), width: Math.max(1, x(m.endMs!) - x(m.startMs)) }} />;
              })}
            {range && <div className="tl-range" style={{ left: x(range.startMs), width: Math.max(2, x(range.endMs) - x(range.startMs)) }} />}
            <div className="tl-out" style={{ left: 0, width: Math.max(0, x(seg.startMs)) }} />
            <div className="tl-out" style={{ left: x(seg.endMs), width: Math.max(0, W - x(seg.endMs)) }} />
            <Playhead store={playhead} x={x} />

            <div className="tl-row ruler" onPointerDown={scrub}>
              {ticks.out.map((t) => (
                <div key={t} className="tl-tick" style={{ left: x(t) }}>
                  {fmtTime(t, ticks.step < 1 ? 1 : 0)}
                </div>
              ))}
              <div className="tl-handle" style={{ left: x(seg.startMs) - 5 }} onPointerDown={trim('in')} title={`in ${fmtTime(seg.startMs)}`} />
              <div className="tl-handle" style={{ left: x(seg.endMs) - 5 }} onPointerDown={trim('out')} title={`out ${fmtTime(seg.endMs)}`} />
            </div>

            <div className="tl-row" onPointerDown={scrub}>
              <canvas ref={canvasRef} className="wave" />
              {!wave?.peaks.length && <span className="muted" style={{ fontSize: 10, padding: 6 }}>waveform appears when the video has downloaded</span>}
            </div>

            <div className="tl-row" onPointerDown={scrub}>
              {visibleWords.map((w) => {
                const fix = project.captions.fixes[String(w.i)];
                const shown = captionText(w, project.captions.fixes, project.captions.censor !== false);
                const width = Math.max(2, x(w.endMs) - x(w.startMs) - 1);
                return (
                  <div
                    key={w.i}
                    className={`tl-word ${fix !== undefined ? 'fixed' : ''} ${shown === null ? 'hidden' : ''} ${sel?.kind === 'word' && sel.i === w.i ? 'sel' : ''}`}
                    style={{ left: x(w.startMs), width }}
                    title={`${w.text}${fix !== undefined ? ` → ${fix || '(hidden)'}` : ''} · click to fix`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSel({ kind: 'word', i: w.i });
                      seek(w.startMs);
                    }}
                  >
                    {width > 16 ? (fix !== undefined ? fix || '—' : w.text) : ''}
                  </div>
                );
              })}
              {tags
                .filter((g) => /laugh|applause|cheer/.test(g.tag) && inView(g.ms, g.ms))
                .map((g, i) => (
                  <span key={i} className="tl-tag" style={{ left: x(g.ms) - 8 }} title={g.tag}>
                    😂
                  </span>
                ))}
            </div>

            {TYPES.map((t) => (
              <div
                key={t.type}
                className="tl-row"
                onPointerDown={(e) => {
                  setSel(null);
                  scrub(e);
                }}
              >
                {project.markers
                  .filter((m) => m.type === t.type)
                  .map((m) => {
                    const selected = sel?.kind === 'marker' && sel.id === m.id;
                    if (t.kind === 'point') {
                      const tail = markerRenderMs(t, m.params);
                      return (
                        <React.Fragment key={m.id}>
                          <div className="tl-tail" style={{ left: x(m.startMs), width: Math.max(0, x(m.startMs + Math.min(tail, 1500)) - x(m.startMs)), background: t.color }} />
                          <div
                            className={`tl-marker point ${selected ? 'sel' : ''} ${m.proposed ? 'proposed' : ''}`}
                            style={{ left: x(m.startMs), background: t.color }}
                            title={`${t.label} ${fmtTime(m.startMs)} · ${markerLabel(m)}`}
                            onPointerDown={moveMarker(m, 'body')}
                          />
                        </React.Fragment>
                      );
                    }
                    return (
                      <div
                        key={m.id}
                        className={`tl-marker ${selected ? 'sel' : ''} ${m.proposed ? 'proposed' : ''}`}
                        style={{ left: x(m.startMs), width: Math.max(6, x(m.endMs!) - x(m.startMs)), background: t.color }}
                        title={`${t.label} ${fmtTime(m.startMs)}–${fmtTime(m.endMs!)}`}
                        onPointerDown={moveMarker(m, 'body')}
                      >
                        <span className="edge l" onPointerDown={moveMarker(m, 'l')} />
                        {markerLabel(m)}
                        <span className="edge r" onPointerDown={moveMarker(m, 'r')} />
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Playhead({ store, x }: { store: Store<number>; x: (ms: number) => number }) {
  const ms = useStore(store);
  return <div className="tl-playhead" style={{ left: x(ms) }} />;
}

export { LABEL_W };
