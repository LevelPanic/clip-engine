// Candidate review: the signal strip across the whole video, the ranked list, and a live 9:16 preview.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { api, go, isTyping, useDebounced, useEvents, footageLabel, type Footage, type SlimJob, type MediaRef, soundOn } from './api';
import { STYLES } from '../../edit/styles';
import { ClipComposition } from '../../composition/ClipComposition';
import { durationInFrames, WIDTH, HEIGHT, type ClipProps } from '../../composition/props';
import { defaultCaptions, defaultFraming, type Candidate, type SignalsFile, type VideoMeta, type Word, type Project } from '../../core/schemas';
import { fmtTime, parseTime, FPS } from '../../core/time';
import { SIGNAL_COLORS } from './ui/tokens';
import { Button, Callout, Chip, Nav, PageState, ShortcutLegend, rowKeys } from './ui';

interface VideoData {
  meta: VideoMeta;
  signals: SignalsFile | null;
  candidates: Candidate[];
  footage: Footage;
  jobs: SlimJob[];
  clips: Record<string, { clipId: string; review: string | null; exportedAt: string | null; render: SlimJob | null }>;
  scan: { passes: ScanPass[]; watch: { state: string; nextAt?: string; everyMs: number; login?: string } | null; watchAlive: boolean; judgeError: string | null };
}

interface ScanPass {
  n: number;
  fromMs: number;
  toMs: number;
  at: string;
  live: boolean;
  durationMs: number;
  seeds: number;
  chatMessages: number;
  viewerClips: number;
  transcribedMs: number;
  seconds: number;
  notes: string[];
}

const verdictOrder = (v: Candidate['verdict']) => (v === 'post' ? 0 : v === 'skip' ? 2 : 1);

export { SIGNAL_COLORS };

export function VideoPage({ videoId }: { videoId: string }) {
  const [d, setD] = useState<VideoData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [exportStyle, setExportStyle] = useState('none');
  const load = useCallback(() => {
    api<VideoData>(`/api/videos/${videoId}`).then(setD, (e) => setErr(e.message));
  }, [videoId]);
  useEffect(load, [load]);
  // a running job reports progress every second; the page needs its result, not each tick
  const reload = useDebounced(load, 1500);
  useEvents((e) => {
    if (e.type === 'video' && e.videoId === videoId) reload();
    if (e.type === 'job' && e.job.videoId === videoId) reload();
  });

  const cands = useMemo(
    () =>
      [...(d?.candidates ?? [])].sort(
        (a, b) =>
          Number(a.status === 'skipped') - Number(b.status === 'skipped') ||
          verdictOrder(a.verdict) - verdictOrder(b.verdict) ||
          (b.rankScore ?? 0) - (a.rankScore ?? 0) ||
          b.score - a.score,
      ),
    [d],
  );
  useEffect(() => {
    if (!sel && cands.length) setSel(cands[0].id);
  }, [cands, sel]);
  const cur = cands.find((c) => c.id === sel) ?? null;

  const make = async (c: Candidate) => {
    setBusy(true);
    try {
      const { clipId } = await api<{ clipId: string }>(`/api/videos/${videoId}/candidates/${c.id}/make`, { method: 'POST' });
      go(`#/clip/${clipId}`);
    } finally {
      setBusy(false);
    }
  };
  /** Export straight away: as is, or with an edit style. Clips are QA'd and land in the review queue. */
  const exportCands = async (ids: string[], style = exportStyle) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      await api(`/api/videos/${videoId}/candidates/export`, { body: { ids, style } });
      setChecked(new Set());
      load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) =>
    setChecked((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const setStatus = async (c: Candidate, status: Candidate['status']) => {
    await api(`/api/videos/${videoId}/candidates/${c.id}/status`, { body: { status } });
    load();
  };

  // keyboard: ↑/↓ choose, Enter or E edit (make the clip first), ⇧E export, X tick, S skip
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    if (isTyping(e) || !cands.length) return;
    const i = cands.findIndex((c) => c.id === sel);
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      setSel(cands[Math.min(cands.length - 1, i + 1)].id);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      setSel(cands[Math.max(0, i - 1)].id);
    } else if (e.key === 'Enter' && cur) {
      if (cur.clipId) go(`#/clip/${cur.clipId}`);
      else void make(cur);
    } else if (e.key === 'E' && e.shiftKey && cur && cur.status !== 'skipped') {
      void exportCands([cur.id]);
    } else if (e.key === 'e' && cur && cur.status !== 'skipped') {
      // E opens the editor here as on the review page; ⇧E exports
      if (cur.clipId) go(`#/clip/${cur.clipId}`);
      else void make(cur);
    } else if ((e.key === 'x' || e.key === 'X') && cur && cur.status !== 'skipped') {
      toggle(cur.id);
    } else if ((e.key === 's' || e.key === 'S') && cur) {
      void setStatus(cur, cur.status === 'skipped' ? 'new' : 'skipped');
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  if (err)
    return (
      <div className="page wide">
        <Nav current="video" />
        <PageState kind="error">{err}</PageState>
      </div>
    );
  if (!d)
    return (
      <div className="page wide">
        <Nav current="video" />
        <PageState kind="loading" />
      </div>
    );
  const { meta, signals } = d;

  return (
    <div className="page wide">
      <Nav current="video" />
      <div className="row top">
        <div className="grow">
          <h1>{meta.title}</h1>
          <div className="muted">
            {meta.channel} · {fmtTime(meta.durationMs, 0)}
            {meta.live ? (
              <>
                {' '}
                <Chip on tone="bad">
                  ● live, growing
                </Chip>
              </>
            ) : null} ·{' '}
            <a href={meta.url} target="_blank" rel="noreferrer">
              {meta.platform === 'twitch' ? 'Twitch' : 'YouTube'}
            </a>{' '}
            · {footageLabel(d.footage, d.jobs)}
          </div>
        </div>
      </div>

      {d.footage.stillImage && (
        <Callout tone="warn" className="mt-4 warn">
          ⚠ This upload is a still image (an audio-only podcast with cover art), so shorts from it will be static art with captions. Look for the
          episode's video version, or plan an audiogram-style edit.
        </Callout>
      )}
      {(meta.platform === 'twitch' || d.scan.passes.length > 0) && <ScanPanel videoId={videoId} meta={meta} scan={d.scan} jobs={d.jobs} />}

      {signals && (
        <div className="card pad-sm mt-4">
          <div className="row wrap mb-1">
            {Object.entries(signals.available).filter(([k]) => (meta.platform === 'twitch' ? !['comments', 'heatmap', 'teaser'].includes(k) : !['chat', 'clips'].includes(k))).map(([k, on]) => (
              <span key={k} className={`chip ${on ? 'on' : ''}`} title={on ? 'signal found' : 'not available for this video'}>
                <span className="dot" style={{ background: on ? SIGNAL_COLORS[k] : 'var(--line-strong)' }} />
                {k}
              </span>
            ))}
            <span className="grow" />
            <span className="muted tiny">
              <span className="bad">■</span> sponsor/intro · boxes = candidates
            </span>
          </div>
          <SignalStrip signals={signals} meta={meta} candidates={cands} selected={sel} onSelect={setSel} scanned={meta.platform === 'twitch' ? d.scan.passes.map((p) => ({ startMs: p.fromMs, endMs: p.toMs })) : undefined} />
        </div>
      )}

      <div className="row wrap mt-5">
        <span className="muted">{checked.size ? `${checked.size} selected` : 'Tick the good ones, or use the buttons on each card'}</span>
        <button onClick={() => setChecked(new Set(cands.filter((c) => c.status !== 'skipped' && c.verdict === 'post').map((c) => c.id)))}>
          Select posts ({cands.filter((c) => c.status !== 'skipped' && c.verdict === 'post').length})
        </button>
        <button onClick={() => setChecked(new Set(cands.filter((c) => c.status !== 'skipped' && (c.virality ?? c.score) >= 70).map((c) => c.id)))}>Select score ≥ 70</button>
        {checked.size > 0 && <button onClick={() => setChecked(new Set())}>Clear</button>}
        <span className="grow" />
        <label className="inline-field">
          export
          <select value={exportStyle} onChange={(e) => setExportStyle(e.target.value)} style={{ width: 210 }}>
          <option value="none">as is (captions + framing)</option>
          {STYLES.map((st) => (
            <option key={st.key} value={st.key}>
              with style: {st.label}
            </option>
          ))}
          </select>
        </label>
        <Button variant="primary" disabled={busy || !checked.size} onClick={() => void exportCands([...checked])}>
          Export {checked.size || ''} selected
        </Button>
      </div>

      <div className="video-layout mt-3">
        <div className="card">
          {!cands.length && (
            <div className="page-state">
              {meta.platform === 'twitch' ? (
                <>
                  No candidates yet. Scan a range above (it judges the moments into candidates when the claude CLI is logged in), or run{' '}
                  <span className="mono">/clip {videoId} --from 1:00:00</span> in Claude Code.
                </>
              ) : (
                <>
                  No candidates yet. Run <span className="mono">/clip {videoId}</span> in Claude Code.
                </>
              )}
            </div>
          )}
          {cands.map((c) => (
            <div
              key={c.id}
              className={`cand ${c.id === sel ? 'sel' : ''} ${c.status === 'skipped' ? 'skipped' : ''}`}
              onClick={() => setSel(c.id)}
              aria-current={c.id === sel || undefined}
              {...rowKeys(() => (c.id === sel && c.status !== 'skipped' ? (c.clipId ? go(`#/clip/${c.clipId}`) : void make(c)) : setSel(c.id)))}
            >
              <div className="row">
                <input
                  type="checkbox"
                  checked={checked.has(c.id)}
                  disabled={c.status === 'skipped'}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggle(c.id)}
                  title="Select for bulk export"
                  aria-label={`Select ${c.title} for bulk export`}
                />
                <div
                  title={`quality ${c.score}${c.virality !== undefined ? ` · virality ${c.virality}` : ''}${c.convergence !== undefined ? ` · signal ${Math.round(c.convergence * 100)}%` : ''}`}
                  className={`score ${(c.virality ?? c.score) >= 80 ? 'good' : (c.virality ?? c.score) >= 60 ? '' : 'muted'}`}
                >
                  {c.virality ?? c.score}
                </div>
                {c.verdict && (
                  <span
                    title={
                      c.verdict === 'post'
                        ? 'Clears the trust bar: a stranger stops, understands it and gets the payoff'
                        : c.verdict === 'recut'
                          ? 'Good hook, missing payoff: find a longer cut that lands it'
                          : 'Not worth the audience’s time'
                    }
                    className={`chip ${c.verdict === 'post' ? 'good' : c.verdict === 'recut' ? 'amber' : 'muted'}`}
                  >
                    {c.verdict}
                  </span>
                )}
                <div className="grow">
                  <div className="title">{c.title}</div>
                  <div className="muted mono">
                    {c.id} · {fmtTime(c.startMs)}–{fmtTime(c.endMs)} · {((c.endMs - c.startMs) / 1000).toFixed(1)} s
                    {c.status === 'skipped' && ' · skipped'}
                  </div>
                </div>
              </div>
              <div className="row wrap mt-1">
                <ClipState info={d.clips?.[c.id]} />
                <span className="grow" />
                <button className="primary" disabled={busy || c.status === 'skipped'} onClick={(e) => (e.stopPropagation(), c.clipId ? go(`#/clip/${c.clipId}`) : void make(c))} title="Open it in the editor">
                  Edit
                </button>
                <button disabled={busy || c.status === 'skipped'} onClick={(e) => (e.stopPropagation(), void exportCands([c.id]))} title={`Render it now (${exportStyle === 'none' ? 'as is' : `style: ${exportStyle}`}); it lands in the review queue`}>
                  Export
                </button>
                {c.status !== 'made' && (
                  <button onClick={(e) => (e.stopPropagation(), void setStatus(c, c.status === 'skipped' ? 'new' : 'skipped'))}>{c.status === 'skipped' ? 'Unskip' : 'Skip'}</button>
                )}
              </div>
              <div className="hook">“{c.hook}”</div>
              <div className="reason">{c.reason}</div>
              {(c.scores || c.convergence !== undefined) && (
                <div className="row wrap mt-1">
                  {c.scores && (
                    <span className="chip" title="Virality funnel: stop · hold · share · standalone · payoff">
                      stop {c.scores.stop} · hold {c.scores.hold} · share {c.scores.share} · alone {c.scores.standalone} · payoff {c.scores.payoff}
                      {c.scores.delivery !== undefined ? ` · delivery ${c.scores.delivery}` : ''}
                    </span>
                  )}
                  {c.convergence !== undefined && (
                    <span className="chip" title="Independent discovery signals agreeing on this window">
                      signal {Math.round(c.convergence * 100)}%
                    </span>
                  )}
                </div>
              )}
              <div className="row wrap mt-1">
                {Object.entries(c.signals).map(([k, v]) => (
                  <span key={k} className="chip on">
                    <span className="dot" style={{ background: SIGNAL_COLORS[k] ?? 'var(--muted)' }} />
                    {k} {v.toFixed(2)}
                  </span>
                ))}
                {!Object.keys(c.signals).length && <span className="chip">transcript only</span>}
              </div>
              {(c.why.length > 0 || c.warnings.length > 0) && (
                <ul>
                  {c.why.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                  {c.warnings.map((w, i) => (
                    <li key={`w${i}`} className="warn">
                      ⚠ {w}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>

        <div className="preview-pane">
          {cur && <Preview key={cur.id} videoId={videoId} c={cur} meta={meta} />}
          <div className="mt-3">
            <ShortcutLegend
              keys={[
                ['↑ ↓', 'choose'],
                ['E', 'edit (or Enter)'],
                ['⇧E', 'export'],
                ['X', 'tick'],
                ['S', 'skip'],
              ]}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Preview({ videoId, c, meta }: { videoId: string; c: Candidate; meta: VideoMeta }) {
  const [words, setWords] = useState<Word[]>([]);
  const [media, setMedia] = useState<MediaRef | null>(null);
  const [job, setJob] = useState<SlimJob | null>(null);
  const [checked, setChecked] = useState(false);
  const ref = useRef<PlayerRef>(null);
  const loadMedia = useCallback(() => {
    api<{ media: MediaRef | null; job: SlimJob | null }>(`/api/videos/${videoId}/media?from=${c.startMs}&to=${c.endMs}&fetch=1`).then((r) => {
      setMedia(r.media);
      setChecked(true);
      if (r.job) setJob(r.job);
    });
  }, [videoId, c.startMs, c.endMs]);
  useEffect(() => {
    api<Word[]>(`/api/videos/${videoId}/words?from=${c.startMs - 2000}&to=${c.endMs + 2000}`).then(setWords);
    loadMedia();
  }, [videoId, c.startMs, c.endMs, loadMedia]);
  useEvents((e) => {
    if (e.type !== 'job' || e.job.videoId !== videoId || (e.job.kind !== 'sections' && e.job.kind !== 'full')) return;
    setJob(e.job);
    if (e.job.state === 'done') loadMedia();
  });
  const props = useMemo<ClipProps | null>(() => {
    if (!media) return null;
    const project: Project = {
      version: 1,
      rev: 0,
      id: 'preview',
      videoId,
      title: c.title,
      sourceDurationMs: meta.durationMs,
      fps: 30,
      segments: [{ startMs: c.startMs, endMs: c.endMs }],
      markers: [],
      captions: defaultCaptions(),
      framing: defaultFraming(),
      createdAt: '',
      updatedAt: '',
    };
    return {
      project,
      words,
      media: { src: media.url, offsetMs: media.offsetMs, width: media.width, height: media.height },
      assetBase: '/media/assets/',
    };
  }, [media, words, c, videoId, meta.durationMs]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === ' ' && !isTyping(e)) {
        e.preventDefault();
        ref.current?.toggle();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  if (!props)
    return (
      <div className="card page-state media-9x16">
        {!checked ? 'Loading…' : job?.state === 'failed' ? `Footage download failed: ${job.error?.split('\n')[0]}` : `Fetching this candidate's footage${job?.progress ? ` (${job.progress})` : '…'}`}
      </div>
    );
  return (
    <div className="media-frame">
      <Player
        ref={ref}
        component={ClipComposition}
        inputProps={props}
        durationInFrames={durationInFrames(props)}
        fps={FPS}
        compositionWidth={WIDTH}
        compositionHeight={HEIGHT}
        style={{ width: '100%', aspectRatio: '9/16' }}
        controls
        initiallyMuted={!soundOn.get()}
        acknowledgeRemotionLicense
      />
    </div>
  );
}

function SignalStrip({
  signals,
  meta,
  candidates,
  selected,
  onSelect,
  scanned,
}: {
  signals: SignalsFile;
  meta: VideoMeta;
  candidates: Candidate[];
  selected: string | null;
  onSelect: (id: string) => void;
  /** Streams: the scanned ranges (the rest is dimmed: not looked at yet). */
  scanned?: { startMs: number; endMs: number }[];
}) {
  const W = 1200;
  const rows = (['comments', 'chat', 'clips', 'laughter', 'audio', 'teaser', 'heatmap'] as const).filter((r) => signals.available[r] && signals.timeline[r]);
  const RH = 18;
  const H = rows.length * RH + 30;
  const x = (ms: number) => (ms / meta.durationMs) * W;
  const binW = x(signals.binMs);
  return (
    <svg
      className="strip"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ height: H }}
      onClick={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const ms = ((e.clientX - r.left) / r.width) * meta.durationMs;
        const hit = candidates.reduce<Candidate | null>((best, c) => {
          const d = ms < c.startMs ? c.startMs - ms : ms > c.endMs ? ms - c.endMs : 0;
          const bd = best ? (ms < best.startMs ? best.startMs - ms : ms > best.endMs ? ms - best.endMs : 0) : Infinity;
          return d < bd ? c : best;
        }, null);
        if (hit) onSelect(hit.id);
      }}
    >
      {scanned && <rect x={0} y={0} width={W} height={H} fill="var(--dim)" />}
      {scanned?.map((r, i) => (
        <rect key={`s${i}`} x={x(r.startMs)} y={0} width={Math.max(1, x(r.endMs) - x(r.startMs))} height={H} fill="var(--accent-tint-soft)">
          <title>scanned {fmtTime(r.startMs, 0)}–{fmtTime(r.endMs, 0)}</title>
        </rect>
      ))}
      {signals.excluded.map((e, i) => (
        <rect key={i} x={x(e.startMs)} y={0} width={Math.max(1, x(e.endMs) - x(e.startMs))} height={H} fill="var(--bad-tint)" />
      ))}
      {meta.chapters.map((c, i) => (
        <line key={i} x1={x(c.startMs)} x2={x(c.startMs)} y1={0} y2={H - 26} stroke="var(--line)" strokeWidth={1}>
          <title>{c.title}</title>
        </line>
      ))}
      {rows.map((r, ri) => (
        <g key={r} transform={`translate(0 ${ri * RH})`}>
          {signals.timeline[r].map((v, i) =>
            v > 0.04 ? <rect key={i} x={i * binW} y={RH - 2 - v * (RH - 4)} width={Math.max(1, binW)} height={v * (RH - 4)} fill={SIGNAL_COLORS[r]} opacity={0.85} /> : null,
          )}
        </g>
      ))}
      {signals.seeds.map((s) => (
        <rect key={s.id} x={x(s.startMs)} y={H - 26} width={x(s.endMs) - x(s.startMs)} height={22} fill="none" stroke="var(--line-strong)" strokeDasharray="3 2" />
      ))}
      {candidates.map((c) => (
        <rect
          key={c.id}
          x={x(c.startMs)}
          y={H - 25}
          width={Math.max(3, x(c.endMs) - x(c.startMs))}
          height={20}
          rx={3}
          fill={c.id === selected ? 'var(--accent)' : c.status === 'made' ? 'var(--good)' : c.status === 'skipped' ? 'var(--line-strong)' : 'var(--muted)'}
        >
          <title>
            {c.id} {fmtTime(c.startMs)} {c.title}
          </title>
        </rect>
      ))}
    </svg>
  );
}

/** Where a candidate's clip is: rendering, exported (with a link), in review. */
function ClipState({ info }: { info?: VideoData['clips'][string] }) {
  if (!info) return null;
  const r = info.render;
  const verb: Record<string, string> = { autoedit: 'editing', render: 'rendering', qa: 'checking' };
  if (r && (r.state === 'running' || r.state === 'queued'))
    return <span className="chip on">{r.state === 'queued' ? `${r.kind === 'render' ? 'export' : verb[r.kind] ?? r.kind} queued` : `${verb[r.kind] ?? r.kind}${r.progress ? ` · ${r.progress}` : '…'}`}</span>;
  if (r?.state === 'failed') return <span className="chip warn" title={r.error ?? ''}>{r.kind === 'render' ? 'export' : verb[r.kind] ?? r.kind} failed</span>;
  return (
    <span className="row gap-1">
      {info.exportedAt && (
        <a className="chip on" href={`/media/exports/${info.clipId}.mp4?t=${encodeURIComponent(info.exportedAt)}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          ▶ MP4
        </a>
      )}
      {info.review && <span className="chip">{info.review === 'review' ? 'in review' : info.review}</span>}
    </span>
  );
}

/** Streams: what's been scanned, the watcher's state, and buttons to scan the new part or a range. */
function ScanPanel({ videoId, meta, scan, jobs }: { videoId: string; meta: VideoMeta; scan: VideoData['scan']; jobs: SlimJob[] }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000); // keep "next pass in …" fresh
    return () => window.clearInterval(t);
  }, []);
  const running = jobs.find((j) => j.kind === 'scan' || (j.kind === 'judge' && j.state === 'running'));
  const merged = [...scan.passes].sort((a, b) => a.fromMs - b.fromMs).reduce<{ startMs: number; endMs: number }[]>((acc, p) => {
    const last = acc[acc.length - 1];
    if (last && p.fromMs <= last.endMs) last.endMs = Math.max(last.endMs, p.toMs);
    else acc.push({ startMs: p.fromMs, endMs: p.toMs });
    return acc;
  }, []);
  const last = scan.passes[scan.passes.length - 1];
  const ago = (iso: string) => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  };
  const start = async (body: Record<string, unknown>) => {
    setMsg(null);
    try {
      await api(`/api/videos/${videoId}/scan`, { body });
    } catch (e) {
      setMsg(`✖ ${(e as Error).message}`);
    }
  };
  const scanRange = () => {
    try {
      const body: Record<string, unknown> = {};
      if (from.trim()) body.fromMs = parseTime(from);
      if (to.trim()) body.toMs = parseTime(to);
      void start(body);
    } catch (e) {
      setMsg(`✖ ${(e as Error).message}`);
    }
  };
  const w = scan.watch;
  // a watcher mid-pass holds the scan lock; a second scan would only fail
  const busy = !!running || (!!w && scan.watchAlive && (w.state === 'scanning' || w.state === 'judging'));
  return (
    <div className="card pad-sm mt-4">
      <div className="row wrap gap-2">
        <strong>Stream scan</strong>
        <span className="muted">
          {merged.length ? `scanned ${merged.map((r) => `${fmtTime(r.startMs, 0)}–${fmtTime(r.endMs, 0)}`).join(', ')}` : 'not scanned yet'}
          {last ? ` · ${scan.passes.length} pass${scan.passes.length > 1 ? 'es' : ''}, last ${ago(last.at)}` : ''}
        </span>
        {w && scan.watchAlive && (
          <span className="chip on" title={`clip watch is following this stream (pass every ${Math.round(w.everyMs / 60_000)} min)`}>
            watching · {w.state === 'waiting' && w.nextAt ? `next pass ${Math.max(0, Math.round((Date.parse(w.nextAt) - Date.now()) / 60_000))} min` : w.state}
          </span>
        )}
        {w && !scan.watchAlive && w.state !== 'ended' && <span className="chip warn">watcher stopped</span>}
        <span className="grow" />
        {running && <span className="chip on">{running.kind === 'judge' ? 'judging…' : `scanning${running.progress ? ` · ${running.progress}` : '…'}`}</span>}
      </div>
      {last?.notes.length ? <div className="warn small mt-1">⚠ {last.notes.join(' · ')}</div> : null}
      {scan.judgeError && !running ? (
        <div className="warn small mt-1">
          ⚠ The last pass was scanned but not judged: {scan.judgeError}
        </div>
      ) : null}
      <div className="row wrap mt-3">
        <button className="primary" disabled={busy || !scan.passes.length} onClick={() => void start({ cont: true })} title="Scan from where the last pass stopped up to now (2 min overlap), then judge it into candidates">
          Scan new part
        </button>
        <span className="muted">or a range</span>
        <input type="text" placeholder="from, e.g. 1:00:00" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 130 }} />
        <input type="text" placeholder={meta.live ? 'to (default: now)' : 'to (default: end)'} value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 140 }} />
        <button disabled={busy} onClick={scanRange}>
          Scan range
        </button>
        <span className="grow" />
        {meta.login && (
          <span className="muted small" title="Scans every 15 minutes until the stream ends, judging each pass">
            follow it live: <code>./clip watch {meta.login}</code>
          </span>
        )}
      </div>
      {msg && (
        <div className="warn mt-1" role="status">
          {msg}
        </div>
      )}
    </div>
  );
}
