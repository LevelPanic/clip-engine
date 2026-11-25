// The review page's post text: the title it uploads with and the description above the credit, both editable
// in place, and Regenerate title / Regenerate description, which ask the pipeline's model for options in a
// direction you give (a `post-text` job, src/pipeline/postText.ts). The credit block and the hashtags are
// the engine's and are shown, not edited.
import React, { useEffect, useRef, useState } from 'react';
import { api, useEvents, type SlimJob } from './api';
import { Button, Field, Popover } from './ui';
import type { Post } from '../../core/schemas';

type PostField = 'title' | 'caption';
interface Saved {
  post: Post;
  warnings: string[];
}

const save = (clipId: string, body: Partial<Record<PostField, string>>) => api<Saved>(`/api/clips/${clipId}/post`, { body });

/** The title as a heading; a click (or Enter on it) turns it into a field. Enter saves, Esc puts it back. */
export function PostTitle({ clipId, title, onSaved }: { clipId: string; title: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'warn' | 'bad'; text: string }>();
  useEffect(() => {
    setValue(title);
    setEditing(false);
  }, [clipId, title]);
  useEffect(() => setMsg(undefined), [clipId]);

  const commit = async () => {
    if (value.trim() === title) return setEditing(false);
    setBusy(true);
    try {
      const r = await save(clipId, { title: value });
      setMsg(r.warnings.length ? { tone: 'warn', text: r.warnings.join(' ') } : undefined);
      setEditing(false);
      onSaved();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {editing ? (
        <div className="title-edit">
          <input
            type="text"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            value={value}
            maxLength={100}
            aria-label="Title it uploads with"
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.preventDefault(), void commit());
              if (e.key === 'Escape') (e.stopPropagation(), setValue(title), setEditing(false));
            }}
          />
          <div className="row mt-2">
            <Button variant="primary" className="small-button" disabled={busy || !value.trim()} onClick={() => void commit()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="ghost" className="small-button" onClick={() => (setValue(title), setEditing(false))}>
              Cancel
            </Button>
            <span className="grow" />
            <span className={`mono ${value.length > 60 ? 'warn' : 'muted'}`} title="Under 60 reads best on a phone; YouTube takes 100">
              {value.length}/100
            </span>
          </div>
        </div>
      ) : (
        <h2
          className="review-title editable"
          role="button"
          tabIndex={0}
          title="The title it uploads with. Click to edit."
          aria-label={`Title: ${title}. Press Enter to edit.`}
          onClick={() => setEditing(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.preventDefault(), e.stopPropagation(), setEditing(true));
          }}
        >
          {title}
        </h2>
      )}
      {msg && <div className={`small mt-2 ${msg.tone === 'warn' ? 'warn' : 'bad-text'}`}>{msg.text}</div>}
    </div>
  );
}

/** The description above the credit: shown as text, a click edits it. ⌘↵ saves; an empty one goes back to the suggestion. */
export function PostCaption({ clipId, caption, onSaved }: { clipId: string; caption: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(caption);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    setValue(caption);
    setEditing(false);
    setErr(undefined);
  }, [clipId, caption]);

  const commit = async () => {
    if (value.trim() === caption.trim()) return setEditing(false);
    setBusy(true);
    try {
      await save(clipId, { caption: value });
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!editing)
    return (
      <div
        className="review-post editable"
        role="button"
        tabIndex={0}
        title="The description above the credit. Click to edit."
        aria-label="Description. Press Enter to edit."
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.preventDefault(), e.stopPropagation(), setEditing(true));
        }}
      >
        {caption || <span className="muted">No description. Click to write one.</span>}
      </div>
    );
  return (
    <div className="mt-2">
      <textarea
        autoFocus
        rows={3}
        value={value}
        disabled={busy}
        aria-label="Description"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.preventDefault(), void commit());
          if (e.key === 'Escape') (e.stopPropagation(), setValue(caption), setEditing(false));
        }}
      />
      <div className="row mt-2">
        <Button variant="primary" className="small-button" disabled={busy} onClick={() => void commit()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" className="small-button" onClick={() => (setValue(caption), setEditing(false))}>
          Cancel
        </Button>
        <span className="muted small">⌘↵ saves · empty goes back to the suggestion</span>
      </div>
      {err && <div className="small mt-2 bad-text">{err}</div>}
    </div>
  );
}

type Run = { state: 'idle' } | { state: 'running'; jobId: number; since: number } | { state: 'done'; options: string[]; dropped: string[] } | { state: 'failed'; error: string };

/**
 * Regenerate title / Regenerate description: a popup with an optional direction ("funnier", "name the game"),
 * Generate, and the options to pick from. The run keeps going if the popup closes; reopening shows it.
 */
export function Regenerate({ clipId, field, onUsed }: { clipId: string; field: PostField; onUsed: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [run, setRun] = useState<Run>({ state: 'idle' });
  const [using, setUsing] = useState<string>();
  const [, tick] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;
  const what = field === 'title' ? 'title' : 'description';

  useEffect(() => {
    setRun({ state: 'idle' });
    setNote('');
    setOpen(false);
  }, [clipId]);

  const finish = (j: SlimJob) => {
    const r = runRef.current;
    if (r.state !== 'running' || j.id !== r.jobId) return;
    if (j.state === 'done') {
      const res = (j.result ?? {}) as { options?: string[]; dropped?: string[] };
      setRun({ state: 'done', options: res.options ?? [], dropped: res.dropped ?? [] });
    } else if (j.state === 'failed' || j.state === 'cancelled') setRun({ state: 'failed', error: j.error?.split('\n')[0] ?? 'the run stopped' });
  };
  useEvents((e) => {
    if (e.type === 'job') finish(e.job);
  });
  // the live events are the fast path; this catches an event missed while the page reconnected, and ticks the clock
  useEffect(() => {
    if (run.state !== 'running') return;
    const t = window.setInterval(() => {
      tick((x) => x + 1);
      void api<SlimJob>(`/api/jobs/${run.jobId}`).then(finish, () => undefined);
    }, 3000);
    return () => window.clearInterval(t);
  }, [run]);

  const generate = async () => {
    try {
      const j = await api<SlimJob>(`/api/clips/${clipId}/post-text`, { body: { field, note } });
      setRun({ state: 'running', jobId: j.id, since: Date.now() });
    } catch (e) {
      setRun({ state: 'failed', error: (e as Error).message });
    }
  };
  const use = async (text: string) => {
    setUsing(text);
    try {
      await save(clipId, { [field]: text });
      setOpen(false);
      setRun({ state: 'idle' });
      onUsed();
    } catch (e) {
      setRun({ state: 'failed', error: (e as Error).message });
    } finally {
      setUsing(undefined);
    }
  };

  return (
    <Popover small align="left" label={`Regenerate the ${what}`} open={open} onOpenChange={setOpen} trigger={`Regenerate ${what}`}>
      <div className="regenerate">
        <Field label="Direction" hint={field === 'title' ? 'Optional. e.g. “funnier”, “lead with the chat’s reaction”, “name the game”, “no emoji”.' : 'Optional. e.g. “say who the other streamer is”, “one sentence”, “explain the bet first”.'}>
          <textarea
            autoFocus
            rows={2}
            value={note}
            placeholder={field === 'title' ? 'What kind of title?' : 'What should it say?'}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && run.state !== 'running') (e.preventDefault(), void generate());
            }}
          />
        </Field>
        <div className="row">
          <Button variant="primary" className="small-button" disabled={run.state === 'running'} onClick={() => void generate()}>
            {run.state === 'running' ? 'Writing…' : run.state === 'done' ? 'Try again' : 'Generate'}
          </Button>
          {run.state === 'running' && <span className="muted small">{Math.round((Date.now() - run.since) / 1000)} s · usually under a minute</span>}
        </div>
        {run.state === 'failed' && <div className="small bad-text mt-3">Could not write one: {run.error}</div>}
        {run.state === 'done' && (
          <div className="options mt-4" aria-label={`New ${what}s`}>
            {run.options.map((o) => (
              <button key={o} type="button" className="option" disabled={!!using} onClick={() => void use(o)} title={`Use this ${what}`}>
                <span className="text">{o}</span>
                <span className="use">{using === o ? 'Saving…' : 'Use'}</span>
              </button>
            ))}
            {run.dropped.length > 0 && <div className="muted small">Left out: {run.dropped.join('; ')}</div>}
          </div>
        )}
      </div>
    </Popover>
  );
}
