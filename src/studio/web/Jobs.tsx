// Jobs: what the worker is doing, and how long each kind of job takes (the time-per-clip numbers).
import React, { useCallback, useEffect, useState } from 'react';
import { api, useEvents, type SlimJob } from './api';

type Job = SlimJob & { createdAt: string; startedAt: string | null; finishedAt: string | null; batchId: string | null };

const secs = (j: Job) => (j.startedAt && j.finishedAt ? (Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000 : null);

export function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const load = useCallback(() => api<Job[]>('/api/jobs?limit=300').then(setJobs), []);
  useEffect(() => void load(), [load]);
  useEvents((e) => {
    if (e.type === 'job') void load();
  });

  const kinds = [...new Set(jobs.map((j) => j.kind))];
  const summary = kinds.map((k) => {
    const done = jobs.filter((j) => j.kind === k && j.state === 'done' && secs(j) !== null);
    const t = done.map((j) => secs(j)!).sort((a, b) => a - b);
    return {
      kind: k,
      done: done.length,
      failed: jobs.filter((j) => j.kind === k && j.state === 'failed').length,
      active: jobs.filter((j) => j.kind === k && (j.state === 'running' || j.state === 'queued')).length,
      median: t.length ? t[Math.floor(t.length / 2)] : null,
    };
  });

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <a href="#/">← Library</a>
      </div>
      <h1>Jobs</h1>
      <h2>Time per job (median of the last 300)</h2>
      <div className="card list">
        {summary.map((s) => (
          <div key={s.kind} className="item">
            <span style={{ width: 110, fontWeight: 600 }}>{s.kind}</span>
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
          <div key={j.id} className="item" style={{ padding: '6px 14px' }}>
            <span className="mono muted" style={{ width: 48 }}>
              #{j.id}
            </span>
            <span style={{ width: 100 }}>{j.kind}</span>
            <span style={{ width: 80, color: j.state === 'failed' ? 'var(--bad)' : j.state === 'done' ? 'var(--good)' : 'var(--warn)' }}>{j.state}</span>
            <span className="mono" style={{ width: 200 }}>
              {j.clipId ? <a href={`#/clip/${j.clipId}`}>{j.clipId}</a> : j.videoId ? <a href={`#/video/${j.videoId}`}>{j.videoId}</a> : ''}
            </span>
            <span className="grow muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {j.state === 'failed' ? j.error?.split('\n')[0] : j.progress}
            </span>
            <span className="mono muted">{secs(j) !== null ? `${secs(j)!.toFixed(1)} s` : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
