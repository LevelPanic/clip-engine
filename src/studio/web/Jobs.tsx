// Jobs: what the worker is doing, and how long each kind of job takes (the time-per-clip numbers).
import React, { useCallback, useEffect, useState } from 'react';
import { api, useEvents, type SlimJob } from './api';
import { Page, PageState } from './ui';

type Job = SlimJob & { createdAt: string; startedAt: string | null; finishedAt: string | null; batchId: string | null };

const secs = (j: Job) => (j.startedAt && j.finishedAt ? (Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000 : null);
const stateClass = (s: Job['state']) => (s === 'failed' ? 'bad' : s === 'done' ? 'good' : 'warn');

export function Jobs() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api<Job[]>('/api/jobs?limit=300').then(
        (j) => (setJobs(j), setError(null)),
        (e: Error) => setError(e.message.split('\n')[0]),
      ),
    [],
  );
  useEffect(() => void load(), [load]);
  useEvents((e) => {
    if (e.type === 'job') void load();
  });

  const list = jobs ?? [];
  const kinds = [...new Set(list.map((j) => j.kind))];
  const summary = kinds.map((k) => {
    const done = list.filter((j) => j.kind === k && j.state === 'done' && secs(j) !== null);
    const t = done.map((j) => secs(j)!).sort((a, b) => a - b);
    return {
      kind: k,
      done: done.length,
      failed: list.filter((j) => j.kind === k && j.state === 'failed').length,
      active: list.filter((j) => j.kind === k && (j.state === 'running' || j.state === 'queued')).length,
      median: t.length ? t[Math.floor(t.length / 2)] : null,
    };
  });

  return (
    <Page width="medium" nav="jobs">
      <h1>Jobs</h1>
      {error && <PageState kind="error" onRetry={() => void load()}>Could not load the jobs: {error}</PageState>}
      {!jobs && !error && <PageState kind="loading" />}
      {jobs && !jobs.length && <PageState kind="empty">No jobs yet. Renders, downloads and batches show up here while they run.</PageState>}
      {jobs && jobs.length > 0 && (
        <>
          <h2>Time per job (median of the last 300)</h2>
          <div className="card list">
            {summary.map((s) => (
              <div key={s.kind} className="item">
                <span className="strong" style={{ width: 110 }}>
                  {s.kind}
                </span>
                <span className="grow muted">
                  {s.done} done{s.failed ? ` · ${s.failed} failed` : ''}
                  {s.active ? ` · ${s.active} active` : ''}
                </span>
                <span className="mono">{s.median !== null ? `${s.median.toFixed(1)} s` : '—'}</span>
              </div>
            ))}
          </div>
          <h2>Recent</h2>
          <div className="card list">
            {jobs.map((j) => (
              <div key={j.id} className="item compact">
                <span className="mono muted" style={{ width: 48 }}>
                  #{j.id}
                </span>
                <span style={{ width: 100 }}>{j.kind}</span>
                <span className={stateClass(j.state)} style={{ width: 80 }}>
                  {j.state}
                </span>
                <span className="mono" style={{ width: 200 }}>
                  {j.clipId ? <a href={`#/clip/${j.clipId}`}>{j.clipId}</a> : j.videoId ? <a href={`#/video/${j.videoId}`}>{j.videoId}</a> : ''}
                </span>
                <span className="grow muted ellipsis">{j.state === 'failed' ? j.error?.split('\n')[0] : j.progress}</span>
                <span className="mono muted">{secs(j) !== null ? `${secs(j)!.toFixed(1)} s` : ''}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Page>
  );
}
