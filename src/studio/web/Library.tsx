import React, { useCallback, useEffect, useState } from 'react';
import { STYLES } from '../../edit/styles';
import { api, useDebounced, useEvents, footageLabel, type Footage, type SlimJob } from './api';
import { fmtTime } from '../../core/time';
import { Button, Chip, Field, Nav, PageState, Thumb } from './ui';

interface VideoRow {
  id: string;
  title: string;
  channel: string;
  durationMs: number;
  candidates: number;
  made: number;
  footage: Footage;
  jobs: SlimJob[];
}
interface ClipRow {
  id: string;
  title: string;
  videoId: string;
  segment: { startMs: number; endMs: number };
  markers: number;
  updatedAt: string;
  exported: { renderedAt: string; timings: { totalMs: number } } | null;
}

export function Library() {
  const [videos, setVideos] = useState<VideoRow[] | null>(null);
  const [clips, setClips] = useState<ClipRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    const fail = (e: Error) => setError(e.message.split('\n')[0]);
    api<VideoRow[]>('/api/videos').then((v) => (setVideos(v), setError(null)), fail);
    api<ClipRow[]>('/api/clips').then((c) => setClips(c.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))), fail);
  }, []);
  useEffect(load, [load]);
  const reload = useDebounced(load, 1500);
  useEvents((e) => {
    if (e.type === 'video' || e.type === 'project' || e.type === 'export' || (e.type === 'job' && (e.job.state === 'done' || e.job.state === 'failed'))) reload();
  });

  return (
    <div className="page">
      <Nav current="library" />
      <h1>Library</h1>
      <div className="muted">Review candidates, edit clips, export 9:16 shorts.</div>
      {error && (
        <PageState kind="error" onRetry={load}>
          Could not load the library: {error}
        </PageState>
      )}

      <NewBatch />

      <h2>Videos</h2>
      <div className="card list">
        {!videos && !error && <PageState kind="loading" />}
        {videos && !videos.length && (
          <div className="empty">
            No videos yet. In Claude Code, run the skill:
            <pre className="cmd">/clip https://www.youtube.com/watch?v=…   or   /clip https://www.twitch.tv/videos/… --from 1:00:00</pre>
            or from a terminal: <span className="mono">./clip ingest &lt;url&gt; &amp;&amp; ./clip discover &lt;id&gt;</span>
          </div>
        )}
        {videos?.map((v) => (
          <a key={v.id} className="item" href={`#/video/${v.id}`}>
            <Thumb videoId={v.id} />
            <div className="grow">
              <div className="strong">{v.title}</div>
              <div className="muted">
                {v.channel} · {fmtTime(v.durationMs, 0)} · {footageLabel(v.footage, v.jobs)}
              </div>
            </div>
            <Chip on>{v.candidates} candidates</Chip>
            <Chip>{v.made} clips</Chip>
          </a>
        ))}
      </div>

      <h2>Clips</h2>
      <div className="card list">
        {!clips && !error && <PageState kind="loading" />}
        {clips && !clips.length && <PageState kind="empty">No clips yet. Open a video and press “Make clip” on a candidate.</PageState>}
        {clips?.map((c) => (
          <a key={c.id} className="item" href={`#/clip/${c.id}`}>
            <div className="grow">
              <div className="strong">{c.title}</div>
              <div className="muted mono">
                {c.id} · {fmtTime(c.segment.startMs)}–{fmtTime(c.segment.endMs)} · {((c.segment.endMs - c.segment.startMs) / 1000).toFixed(1)} s ·{' '}
                {c.markers} markers
              </div>
            </div>
            {c.exported ? <Chip on>exported</Chip> : <Chip>not exported</Chip>}
          </a>
        ))}
      </div>
    </div>
  );
}

function NewBatch() {
  const [inputs, setInputs] = useState('');
  const [perVideo, setPerVideo] = useState(5);
  const [lens, setLens] = useState('podcast-general');
  const [lenses, setLenses] = useState<string[]>([]);
  const [reframe, setReframe] = useState(false);
  const [style, setStyle] = useState('punch');
  const [limit, setLimit] = useState(3);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void api<string[]>('/api/lenses').then(setLenses), []);
  const start = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ batchId: string; videos: string[] }>('/api/batch', { body: { inputs, limit, options: { perVideo, lens, reframe, style } } });
      setMsg(`Batch ${r.batchId}: ${r.videos.length} video${r.videos.length > 1 ? 's' : ''} queued. Clips land in the review queue as they finish.`);
      setInputs('');
    } catch (e) {
      setMsg(`✖ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2>New batch</h2>
      <div className="card pad">
        <Field label="Links">
          <textarea rows={2} value={inputs} onChange={(e) => setInputs(e.target.value)} placeholder="Paste YouTube links (one per line) or a channel/playlist URL" />
        </Field>
        <div className="row wrap">
          <label className="inline-field">
            clips per video <input type="number" min={1} max={20} value={perVideo} onChange={(e) => setPerVideo(Number(e.target.value))} style={{ width: 60 }} />
          </label>
          <label className="inline-field">
            lens
            <select value={lens} onChange={(e) => setLens(e.target.value)} style={{ width: 170 }}>
              {(lenses.length ? lenses : [lens]).map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
          <label className="inline-field" title={STYLES.find((st) => st.key === style)?.description}>
            edit style
            <select value={style} onChange={(e) => setStyle(e.target.value)} style={{ width: 150 }}>
              {STYLES.map((st) => (
                <option key={st.key} value={st.key}>
                  {st.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-field">
            videos per channel <input type="number" min={1} max={50} value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ width: 60 }} />
          </label>
          <label className="inline-field check">
            <input type="checkbox" checked={reframe} onChange={(e) => setReframe(e.target.checked)} /> face-tracking crop
          </label>
          <span className="grow" />
          <Button variant="primary" disabled={busy || !inputs.trim()} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Start batch'}
          </Button>
        </div>
        {msg && (
          <div className={`mt-2 ${msg.startsWith('✖') ? 'warn' : 'muted'}`} role="status">
            {msg}
          </div>
        )}
      </div>
    </>
  );
}
