// Jobs: what the worker is doing, and how long each kind of job takes (the time-per-clip numbers).
import React, { useCallback, useEffect, useState } from 'react';
import { api, useEvents, type SlimJob } from './api';
import { Chip, Page, PageHead, PageState } from './ui';

type Job = SlimJob & { createdAt: string; startedAt: string | null; finishedAt: string | null; batchId: string | null };

const secs = (j: Job) => (j.startedAt && j.finishedAt ? (Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000 : null);

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
      <PageHead title="Jobs" description="Renders, downloads and other Studio work, newest first. The watchlist's clip jobs are on its own status page." />
      {error && <PageState kind="error" onRetry={() => void load()}>Could not load the jobs: {error}</PageState>}
      {!jobs && !error && <PageState kind="loading" />}
      {jobs && !jobs.length && <PageState kind="empty">No jobs yet. Renders, downloads and batches show up here while they run.</PageState>}
      {jobs && jobs.length > 0 && (
        <>
          <h2>Time per job <span className="muted">median of the last 300</span></h2>
          <div className="card list">
            <table className="table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Runs</th>
                  <th className="num">Median</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((s) => (
                  <tr key={s.kind}>
                    <td className="strong">{s.kind}</td>
                    <td className="muted">
                      {s.done} done{s.failed ? ` · ${s.failed} failed` : ''}
                      {s.active ? ` · ${s.active} active` : ''}
                    </td>
                    <td className="num">{s.median !== null ? `${s.median.toFixed(1)} s` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>Recent</h2>
          <div className="card list">
            <table className="table">
              <thead>
                <tr>
                  <th className="num">Job</th>
                  <th>Kind</th>
                  <th>State</th>
                  <th>Clip or video</th>
                  <th>Progress</th>
                  <th className="num">Took</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="num muted">#{j.id}</td>
                    <td>{j.kind}</td>
                    <td>
                      <Chip small tone={j.state === 'done' ? 'good' : j.state === 'failed' ? 'bad' : j.state === 'running' ? 'accent' : 'default'}>
                        {j.state}
                      </Chip>
                    </td>
                    <td className="mono">{j.clipId ? <a href={`#/clip/${j.clipId}`}>{j.clipId}</a> : j.videoId ? <a href={`#/video/${j.videoId}`}>{j.videoId}</a> : ''}</td>
                    <td className="muted clip">
                      <div className="ellipsis">{j.state === 'failed' ? j.error?.split('\n')[0] : j.progress}</div>
                    </td>
                    <td className="num muted">{secs(j) !== null ? `${secs(j)!.toFixed(1)} s` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Page>
  );
}
