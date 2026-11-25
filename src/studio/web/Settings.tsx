// Settings → Uploads: the schedule the uploader follows (src/publish/schedule.ts): how many in any 24 hours,
// how far apart, the hours uploads may go in, how long until a Short goes live, and a pause. A draft is
// previewed as you type (what it would allow, when the next one could go); Save writes it, and the
// uploader picks it up within a minute, no restart.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, useEvents } from './api';
import { Button, Callout, Field, Page, PageHead, PageState } from './ui';

interface Schedule {
  perDay: number;
  everyMin: number;
  leadMin: number;
  window?: { from: string; to: string; timeZone: string };
  paused?: boolean;
}
interface View {
  schedule: Schedule;
  saved: boolean;
  defaults: Schedule;
  bounds: Record<'perDay' | 'everyMin' | 'leadMin', [number, number]>;
  timeZone: string;
  words: string;
  warnings: string[];
  dailyMost: number;
  now: { inDay: number; cap: number; nextAt: string; waitsFor: 'spacing' | 'cap' | 'window' | 'paused' | null };
}

const ZONES = ['UTC', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'];
const same = (a?: Schedule, b?: Schedule) => JSON.stringify(a) === JSON.stringify(b);
const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function Settings() {
  const [view, setView] = useState<View>();
  const [draft, setDraft] = useState<Schedule>();
  const [preview, setPreview] = useState<View>();
  const [problem, setProblem] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const dirty = !!view && !!draft && !same(draft, view.schedule);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const take = (v: View) => (setView(v), setDraft(v.schedule), setPreview(v), setProblem(undefined));
  const load = useCallback(() => api<View>('/api/upload-schedule').then(take, (e: Error) => setLoadError(e.message)), []);
  useEffect(() => void load(), [load]);
  // the uploader's state moves (an upload, a new slot): refresh what is shown unless you are mid-edit
  useEvents((e) => {
    if (e.type === 'upload-status' && !dirtyRef.current) void load();
  });

  // preview the draft as it changes (a moment after the last keystroke)
  useEffect(() => {
    if (!draft || !dirty) return;
    const t = window.setTimeout(() => {
      api<View>('/api/upload-schedule', { body: { schedule: draft, save: false } }).then(
        (v) => (setPreview(v), setProblem(undefined)),
        (e: Error) => setProblem(e.message),
      );
    }, 300);
    return () => window.clearTimeout(t);
  }, [draft, dirty]);

  const send = async (body: object, done: string) => {
    setBusy(true);
    try {
      take(await api<View>('/api/upload-schedule', { body }));
      setNote(done);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <Page width="medium" nav="settings"><PageState kind="error" onRetry={() => void load()}>Could not load the settings: {loadError}</PageState></Page>;
  if (!view || !draft || !preview) return <Page width="medium" nav="settings"><PageState kind="loading" /></Page>;

  const set = (patch: Partial<Schedule>) => (setDraft({ ...draft, ...patch }), setNote(undefined));
  const intIn = (v: string) => (v.trim() === '' ? NaN : Number(v));
  const zones = [...new Set([view.timeZone, draft.window?.timeZone ?? view.timeZone, ...ZONES])];
  const p = preview;

  return (
    <Page width="medium" nav="settings">
      <PageHead title="Settings" description="How the channel uploads. A saved change reaches the uploader within a minute; it does not need a restart." />
      <h2>Uploads</h2>
      <div className="card settings-card">
        <label className="check settings-pause">
          <input type="checkbox" aria-label="Pause uploads" checked={!!draft.paused} onChange={(e) => set({ paused: e.target.checked || undefined })} />
          <span>
            <span className="strong">Pause uploads</span>
            <span className="muted small block">Nothing goes up until you turn this off. Approvals keep their place in line.</span>
          </span>
        </label>

        <div className="settings-grid">
          <Field label="Uploads per day" hint={`In any 24 hours, ${view.bounds.perDay[0]}–${view.bounds.perDay[1]}. YouTube held this channel at 10 a day.`}>
            <input type="number" min={view.bounds.perDay[0]} max={view.bounds.perDay[1]} value={Number.isNaN(draft.perDay) ? '' : draft.perDay} onChange={(e) => set({ perDay: intIn(e.target.value) })} />
          </Field>
          <Field label="Hours between uploads" hint="At least this long after the last one. 0.5 is half an hour.">
            <input
              type="number"
              min={0}
              max={24}
              step={0.25}
              value={Number.isNaN(draft.everyMin) ? '' : +(draft.everyMin / 60).toFixed(2)}
              onChange={(e) => set({ everyMin: e.target.value.trim() === '' ? NaN : Math.round(Number(e.target.value) * 60) })}
            />
          </Field>
          <Field label="Goes live after (minutes)" hint="A Short is scheduled this long after its upload finishes.">
            <input type="number" min={view.bounds.leadMin[0]} max={view.bounds.leadMin[1]} value={Number.isNaN(draft.leadMin) ? '' : draft.leadMin} onChange={(e) => set({ leadMin: intIn(e.target.value) })} />
          </Field>
        </div>

        <div className="settings-window">
          <label className="check">
            <input type="checkbox" aria-label="Only upload between set hours" checked={!!draft.window} onChange={(e) => set({ window: e.target.checked ? { from: '09:00', to: '23:00', timeZone: view.timeZone } : undefined })} />
            <span className="strong">Only upload between set hours</span>
          </label>
          {draft.window && (
            <div className="settings-grid mt-3">
              <Field label="From">
                <input type="time" value={draft.window.from} onChange={(e) => set({ window: { ...draft.window!, from: e.target.value } })} />
              </Field>
              <Field label="To" hint="Before the From time means overnight (22:00 to 02:00).">
                <input type="time" value={draft.window.to} onChange={(e) => set({ window: { ...draft.window!, to: e.target.value } })} />
              </Field>
              <Field label="Time zone">
                <select value={draft.window.timeZone} onChange={(e) => set({ window: { ...draft.window!, timeZone: e.target.value } })}>
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                      {z === view.timeZone ? ' (this computer)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
        </div>

        <div className="settings-preview" role="status">
          {problem ? (
            <Callout tone="bad">{problem}</Callout>
          ) : (
            <>
              <div>
                <span className="strong">{dirty ? 'With these changes: ' : 'Now: '}</span>
                {p.words}.
              </div>
              <div className="muted small mt-1">
                {p.now.waitsFor === 'paused'
                  ? `${p.now.inDay} went up in the last 24 hours; nothing more goes up while paused.`
                  : `${p.now.inDay} went up in the last 24 hours (up to ${p.dailyMost} a day under this schedule); the next can go ${Date.parse(p.now.nextAt) > Date.now() ? `at ${when(p.now.nextAt)}${p.now.waitsFor === 'window' ? ', when the posting hours open' : p.now.waitsFor === 'cap' ? ", the day's cap" : ''}` : 'now'}.`}
              </div>
              {p.warnings.length > 0 && (
                <Callout tone="warn" className="mt-3">
                  {p.warnings.map((w) => (
                    <div key={w}>{w}</div>
                  ))}
                </Callout>
              )}
            </>
          )}
        </div>

        <div className="row wrap settings-actions">
          <Button variant="primary" disabled={busy || !dirty || !!problem} onClick={() => void send({ schedule: draft, save: true }, 'Saved. The uploader follows it within a minute.')}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => (setDraft(view.schedule), setPreview(view), setProblem(undefined))}>
              Discard changes
            </Button>
          )}
          <span className="grow" />
          {note && <span className="muted small">{note}</span>}
          {view.saved && !dirty && (
            <Button variant="ghost" disabled={busy} onClick={() => void send({ reset: true }, 'Back to the defaults.')} title={`The defaults (UPLOADS_PER_DAY, UPLOAD_MIN, LEAD_MIN): ${view.defaults.perDay} a day, ${view.defaults.everyMin / 60} hours apart, live after ${view.defaults.leadMin} min`}>
              Reset to defaults
            </Button>
          )}
        </div>
      </div>
    </Page>
  );
}
