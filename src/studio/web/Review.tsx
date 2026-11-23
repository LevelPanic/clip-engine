// Review queue: watch each rendered clip and decide with one key. A approve · R reject (then 1–5 for
// why, or R again for no reason) · C make changes (optional note) · E open in the editor · ↑/↓ move.
// 18+ (age-restricted on YouTube) is a check on the To review tab only, ticked or not from the 18+
// check in QA (src/qa/adult.ts), 8 toggles it; the decision carries it, and every other tab shows it.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, go, isTyping, soundOn, useDebounced, useEvents, useStore } from './api';
import { SIGNAL_COLORS } from './VideoPage';
import { REJECT_REASONS, type Candidate, type Post, type RejectReason, type Review as ReviewState } from '../../core/schemas';
import { postBody } from '../../core/post';
import { CopyButton } from './Inspector';
import { fmtTime } from '../../core/time';

interface Item {
  id: string;
  title: string;
  videoId: string;
  review: ReviewState;
  exported: boolean;
  durationMs: number;
  candidate: Candidate | null;
  markers: number;
  proposed: number;
  qa: { passed: boolean; loudnessLufs: number | null; issues: { level: string; check: string; detail: string }[]; adult?: AdultCheck } | null;
  published: { url?: string; videoId?: string; privacy?: string; publishAt?: string; ageRestricted?: boolean; ageRestriction?: 'applied' | 'not-applied'; heldPrivate?: string } | null;
  post: Post;
  /** What the upload scheduler did with an approval; `reason` is set when it refused it. */
  upload: {
    status: string | null;
    pickedAt: string | null;
    reason: string | null;
    /** Upload tries for this approval, the last one's time, and what YouTube said if it was refused. */
    attempts: number;
    lastAttemptAt: string | null;
    lastError: string | null;
  } | null;
}

type Tab = ReviewState['status'] | 'uploaded';

/** The 18+ check in QA (src/qa/adult.ts), as the page reads it. */
interface AdultCheck {
  detected: boolean;
  points: number;
  reasons: string[];
  looked: { words: number; chatters: number | null; stills: number | null; experts: boolean };
  missing: string[];
}

/** What the 18+ check found, in a line under the check. */
function adultText(i: Item): string {
  const a = i.qa?.adult;
  if (!a) return `Not checked: rendered before the 18+ check, so it starts unticked (\`clip adult ${i.id}\` checks it).`;
  const looked = `${a.looked.words} words, ${a.looked.chatters ?? 'no'} chatters, ${a.looked.stills ?? 'no'} stills${a.looked.experts ? ', the experts’ flags' : ''}`;
  const missing = a.missing.length ? ` Not read: ${a.missing.join(', ')}.` : '';
  if (a.detected) return `Sexual content found (${a.points} points): ${a.reasons.join('; ')}.${missing}`;
  if (a.reasons.length) return `Below the bar (${a.points} of 4 points): ${a.reasons.join('; ')}. Looked at ${looked}.${missing}`;
  return `Nothing sexual found in ${looked}.${missing}`;
}

/** The decision as it stands, on every tab but To review (where it is the check itself). */
function AdultMark({ i }: { i: Item }) {
  // uploaded: what YouTube has, not what was asked
  if (i.published?.url) {
    if (i.published.ageRestriction === 'applied')
      return (
        <span className="chip on" style={{ borderColor: 'var(--bad)' }}>
          18+ ✓ age-restricted on YouTube
        </span>
      );
    if (i.published.heldPrivate)
      return (
        <span className="chip on" style={{ borderColor: 'var(--bad)' }}>
          18+ ✓ private on YouTube until it is age-restricted
        </span>
      );
    if (i.review.adult || i.qa?.adult?.detected)
      return (
        <span className="chip warn" style={{ borderColor: 'var(--bad)' }} title="the 18+ check found sexual content after it went up; YouTube Studio → Age restriction if it needs one">
          18+ ✗ went up without an age restriction (the 18+ check found sexual content)
        </span>
      );
    return <span className="chip">18+ ✗ not age-restricted</span>;
  }
  // decided before the 18+ check existed: the upload takes what the check found (src/publish/youtube.ts)
  const a = i.review.adult ?? (i.review.status === 'approved' ? i.qa?.adult?.detected : undefined);
  const before = i.review.adult === undefined;
  if (a === undefined) return <span className="chip" title="decided before the 18+ check existed">18+ not set</span>;
  if (before)
    return (
      <span className="chip" style={a ? { borderColor: 'var(--bad)' } : undefined} title="approved before the 18+ check existed: the upload takes what the check found">
        {a ? '18+ ✓ age-restricted (from the 18+ check)' : '18+ ✗ not age-restricted (from the 18+ check)'}
      </span>
    );
  return a ? (
    <span className="chip on" style={{ borderColor: 'var(--bad)' }} title="uploads age-restricted on YouTube">
      18+ ✓ age-restricted
    </span>
  ) : (
    <span className="chip" title="uploads without an age restriction">
      18+ ✗ not age-restricted
    </span>
  );
}

/** The upload scheduler's state (library/upload-status.json) and how many went up in the last 24 hours. */
interface UploadInfo {
  status: {
    state: 'ok' | 'upload-limit' | 'api-quota' | 'error' | 'auth';
    since: string;
    at: string;
    reason?: string;
    nextTryAt?: string;
    /** Set only for a passing error; a YouTube limit is waited out to when it lifts. */
    retryEveryMin?: number;
    /** The posting pace (src/publish/pace.ts). */
    pace?: { perDay: number; everyMin: number; cap: number; inDay: number; nextAt: string; waitsFor?: 'spacing' | 'cap' };
  } | null;
  uploads24h: number;
  firstIn24h: string | null;
  lastUpload: string | null;
  /** The last tries, newest first (library/upload-log.jsonl). */
  log: { at: string; clipId: string; try: number; outcome: 'uploaded' | 'held' | 'failed' | 'deferred'; hold?: string; reason?: string; url?: string }[];
  /** The careful period (channel.json → careful) while it is on. */
  careful: { until: string; why: string | null } | null;
}

/** "Dec 6": a careful period's end, as a reviewer reads it. */
const day = (d: string) => new Date(/^\d{4}-\d\d-\d\d$/.test(d) ? `${d}T00:00:00` : d).toLocaleDateString([], { month: 'short', day: 'numeric' });

/** The pace in words: "at most 8 in 24 hours, 3 hours apart". */
function paceText(p: NonNullable<NonNullable<UploadInfo['status']>['pace']>): string {
  const gap = p.everyMin % 60 === 0 ? `${p.everyMin / 60} hour${p.everyMin === 60 ? '' : 's'}` : `${p.everyMin} minutes`;
  return `at most ${p.cap} in 24 hours${p.cap < p.perDay ? ` (held below ${p.perDay} by YouTube's limit)` : ''}, ${gap} apart`;
}

/** When a held clip is tried again: at a time (a limit), or every so often (a passing error). */
const retryText = (s: NonNullable<UploadInfo['status']>) =>
  s.retryEveryMin ? `every ${everyMin(s.retryEveryMin)}` : s.nextTryAt ? `at ${new Date(s.nextTryAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'later';

/** The clip the scheduler is on: it stays on it until it uploads. */
const isCurrent = (i: Item) => i.upload?.status === 'uploading' || i.upload?.status === 'held';

/** How often the scheduler tries a held clip again (HOLD_RETRY_MIN, 60 by default). */
const everyMin = (m = 60) => (m === 60 ? 'hour' : m % 60 === 0 ? `${m / 60} hours` : `${m} minutes`);

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Why uploads are held, in a sentence the reviewer can act on (or wait out). */
function holdText(u: UploadInfo): string {
  const s = u.status!;
  if (s.state === 'upload-limit') {
    const lift = u.firstIn24h ? `, around ${hhmm(new Date(Date.parse(u.firstIn24h) + 24 * 3_600_000).toISOString())}` : '';
    return `YouTube says this channel has reached its upload limit: ${u.uploads24h} went up in the last 24 hours${u.firstIn24h ? ` (the first at ${hhmm(u.firstIn24h)})` : ''}. It lifts by itself, about a day after the first of them${lift}.`;
  }
  if (s.state === 'api-quota')
    return "The Google Cloud project's daily YouTube quota is used up (its daily uploads count refused tries too). It resets at midnight Pacific time.";
  if (s.state === 'error') return 'The last try failed on the network or on YouTube’s side; the same clip is tried again.';
  return 'The YouTube login expired or was revoked. Run ./clip auth youtube; the held clips go back in line by themselves.';
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'review', label: 'To review' },
  { key: 'changes', label: 'Changes asked' },
  { key: 'approved', label: 'Approved' },
  { key: 'uploaded', label: 'Uploaded' },
  { key: 'rejected', label: 'Rejected' },
];

/** Approved clips move from Approved to Uploaded once the scheduler writes their publish record. */
const inTab = (i: Item, tab: Tab) =>
  tab === 'uploaded' ? i.review.status === 'approved' && !!i.published : i.review.status === tab && !(tab === 'approved' && i.published);

/** `clipId` opens the page on that clip, on whichever tab it is in (#/review/<clipId>, the editor's Review button). */
export function Review({ clipId }: { clipId?: string } = {}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [tab, setTab] = useState<Tab>('review');
  const [sel, setSel] = useState<string | null>(null);
  const [note, setNote] = useState('');
  /** Reject was pressed: the reasons are showing and 1–5 picks one. */
  const [asking, setAsking] = useState(false);
  const [stamp, setStamp] = useState(Date.now());
  /** The 18+ check on the To review tab, for the clip on screen. */
  const [adult, setAdult] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sound = useStore(soundOn);
  // React sets `muted` as a property only after the first render; set it before autoplay starts
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = !sound;
  });

  const [loadError, setLoadError] = useState<string | null>(null);
  const retry = useRef<number | undefined>(undefined);
  const load = useCallback(
    () =>
      api<Item[]>('/api/review').then(
        (x) => (setItems(x), setLoadError(null)),
        // a failed fetch (the server restarting, a clip it cannot read) must not leave "Loading…" forever
        (e: Error) => {
          setLoadError(e.message.split('\n')[0].slice(0, 200));
          window.clearTimeout(retry.current);
          retry.current = window.setTimeout(() => void load(), 5000);
        },
      ),
    [],
  );
  useEffect(() => {
    void load();
    return () => window.clearTimeout(retry.current);
  }, [load]);
  const reload = useDebounced(() => void load(), 1500);
  const [up, setUp] = useState<UploadInfo | null>(null);
  const loadUp = useCallback(() => api<UploadInfo>('/api/upload-status').then(setUp, () => undefined), []);
  useEffect(() => void loadUp(), [loadUp]);
  /** Approved clips waiting for the scheduler, in the order it takes them (approval time). */
  const line = useMemo(
    () =>
      (items ?? [])
        .filter((i) => i.review.status === 'approved' && !i.published && (i.upload?.status === 'pending' || isCurrent(i)))
        // the scheduler's current clip first (it stays on it until it uploads), then oldest approval first
        .sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)) || (a.review.at < b.review.at ? -1 : 1))
        .map((i) => i.id),
    [items],
  );
  const held = up?.status && up.status.state !== 'ok' && line.length ? up.status : null;

  const list = useMemo(() => (items ?? []).filter((i) => inTab(i, tab)).sort((a, b) => (a.review.at < b.review.at ? -1 : 1)), [items, tab]);
  const cur = list.find((i) => i.id === sel) ?? list[0] ?? null;
  // opened on a clip: go to its tab and select it, once the list is in
  const opened = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!items || !clipId || opened.current === clipId) return;
    opened.current = clipId;
    const it = items.find((i) => i.id === clipId);
    const t = it && TABS.find((x) => inTab(it, x.key));
    if (t) (setTab(t.key), setSel(clipId));
  }, [items, clipId]);
  // the address follows the clip on screen, so the browser's back button from the editor lands here too
  useEffect(() => {
    if (cur) window.history.replaceState(null, '', `#/review/${cur.id}`);
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvents((e) => {
    // the list follows every clip; the video restarts only when the clip on screen was rendered again
    if (e.type === 'project' || e.type === 'export' || (e.type === 'job' && e.job.kind === 'render' && e.job.state === 'done')) reload();
    if (e.type === 'upload-status' || e.type === 'export') void loadUp();
    const mine = cur && ((e.type === 'export' && e.clipId === cur.id) || (e.type === 'job' && e.job.kind === 'render' && e.job.state === 'done' && e.job.clipId === cur.id));
    if (mine) setStamp(Date.now());
  });
  // On To review the clip's note is the editor's hand-over, not yours: it is shown above the box, and the
  // box starts empty (a prefilled box sent hand-overs as change requests). Elsewhere the note is your own.
  useEffect(() => (setNote(tab === 'review' ? '' : (cur?.review.note ?? '')), setAsking(false)), [cur?.id, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  // the check starts where the 18+ check left it, for each clip (and again when it is checked again)
  const detected = cur?.qa?.adult?.detected ?? false;
  useEffect(() => setAdult(detected), [cur?.id, detected]);

  const decide = async (status: ReviewState['status'], withNote?: string, reasons?: RejectReason[]) => {
    if (!cur) return;
    const idx = list.findIndex((i) => i.id === cur.id);
    // the check only exists on To review; elsewhere the decision keeps the 18+ it was made with
    const adultNow = tab === 'review' ? adult : cur.review.adult;
    await api(`/api/clips/${cur.id}/review`, { body: { status, note: withNote ?? (note || undefined), reasons, adult: adultNow } });
    const next = list[idx + 1] ?? list[idx - 1];
    setSel(next?.id ?? null);
    setNote('');
    setAsking(false);
    void load();
  };

  /** A decided clip can go back to To review and be decided again (an uploaded one is on YouTube already). */
  const canSendBack = !!cur && tab !== 'review' && tab !== 'uploaded';

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    if (isTyping(e)) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && note.trim()) void decide('changes', note.trim());
      if (e.key === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    const idx = list.findIndex((i) => i.id === cur?.id);
    if (asking) {
      // the reason picker is open: a number rejects with that reason, R again rejects without one
      const n = Number(e.key);
      if (n >= 1 && n <= REJECT_REASONS.length) return void decide('rejected', undefined, [REJECT_REASONS[n - 1].key]);
      if (e.key === 'r' || e.key === 'R') return void decide('rejected');
      if (e.key === 'Escape') return setAsking(false);
    }
    if (e.key === 'ArrowDown' || e.key === 'j') setSel(list[Math.min(list.length - 1, idx + 1)]?.id ?? null);
    else if (e.key === 'ArrowUp' || e.key === 'k') setSel(list[Math.max(0, idx - 1)]?.id ?? null);
    else if (e.key === 'a' || e.key === 'A') void decide('approved');
    else if ((e.key === 'u' || e.key === 'U') && canSendBack) void decide('review');
    else if (e.key === '8' && tab === 'review' && cur) setAdult((x) => !x);
    else if (e.key === 'r' || e.key === 'R') setAsking(true);
    else if (e.key === 'c' || e.key === 'C') (e.preventDefault(), noteRef.current?.focus());
    else if ((e.key === 'e' || e.key === 'E') && cur) go(`#/clip/${cur.id}`);
    else if (e.key === ' ') {
      e.preventDefault();
      const v = videoRef.current;
      if (v) v.paused ? void v.play() : v.pause();
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <a href="#/">← Library</a>
      </div>
      <h1>Review</h1>
      <div className="row" style={{ margin: '10px 0 14px', flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'primary' : ''} onClick={() => (setTab(t.key), setSel(null))}>
            {t.label} ({(items ?? []).filter((i) => inTab(i, t.key)).length})
          </button>
        ))}
        <span className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>
          <kbd>A</kbd> approve{tab === 'review' ? <> · <kbd>8</kbd> 18+</> : null} · <kbd>R</kbd> reject, then <kbd>1</kbd>–<kbd>5</kbd> why · <kbd>C</kbd> changes · <kbd>E</kbd> edit · <kbd>↑</kbd>
          <kbd>↓</kbd> move · <kbd>space</kbd> play
        </span>
      </div>
      {tab === 'approved' && held && up && (
        <div className="card" style={{ marginBottom: 12, padding: 10, borderColor: 'var(--bad)' }}>
          <div className="warn">
            <b>Uploads are on hold.</b> {holdText(up)}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            The scheduler stays on {line[0]} until it goes up and tries it again {retryText(held)}
            {held.retryEveryMin && held.nextTryAt ? ` (next at ${hhmm(held.nextTryAt)})` : ''}; the other {line.length - 1} approved clip{line.length === 2 ? '' : 's'} wait behind it, oldest approval first. Nothing is lost.
            {held.reason ? ` YouTube said: ${held.reason}` : ''}
          </div>
        </div>
      )}
      {tab === 'approved' && (up?.status?.pace || up?.careful) && (
        <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>
          {up.status?.pace && (
            <div>
              Uploads: {paceText(up.status.pace)}. {up.status.pace.inDay} went up in the last 24 hours
              {Date.parse(up.status.pace.nextAt) > Date.now()
                ? `; the next can go at ${new Date(up.status.pace.nextAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${up.status.pace.waitsFor === 'cap' ? ' (the day’s cap)' : ''}`
                : '; the next can go now'}
              . {line.length} in line, oldest approval first.
            </div>
          )}
          {up.careful && (
            <div>
              Careful period until {day(up.careful.until)}: an approval with a sexual flag, an 18+ tick or an f-word in its first 3 s waits for it to end and then goes up by itself
              {(() => {
                const n = (items ?? []).filter((i) => i.review.status === 'approved' && !i.published && i.upload?.status === 'deferred').length;
                return n ? ` (${n} waiting)` : '';
              })()}
              .
            </div>
          )}
        </div>
      )}
      {(tab === 'approved' || tab === 'uploaded') && !!up?.log.length && (
        <details className="card" style={{ marginBottom: 12, padding: '6px 10px' }}>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
            Upload log: the last {up.log.length} tries (all of them are kept in library/upload-log.jsonl)
          </summary>
          <table style={{ fontSize: 12, marginTop: 6, width: '100%' }}>
            <tbody>
              {up.log.map((t, k) => (
                <tr key={k}>
                  <td className="muted" style={{ whiteSpace: 'nowrap', paddingRight: 8 }}>{new Date(t.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td style={{ whiteSpace: 'nowrap', paddingRight: 8 }}>
                    <a onClick={() => setSel(t.clipId)} style={{ cursor: 'pointer' }}>{t.clipId}</a>
                  </td>
                  <td className="muted" style={{ whiteSpace: 'nowrap', paddingRight: 8 }}>try {t.try}</td>
                  <td className={t.outcome === 'uploaded' ? '' : 'warn'} style={{ whiteSpace: 'nowrap', paddingRight: 8 }}>{t.outcome}</td>
                  <td className="muted">
                    {t.url ? (
                      <a href={t.url} target="_blank" rel="noreferrer">
                        {t.url}
                      </a>
                    ) : (
                      t.reason
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {items === null && <div className="card empty">{loadError ? `Could not load the review list (${loadError}). Trying again…` : 'Loading…'}</div>}
      {items !== null && !list.length && <div className="card empty">Nothing here. Clips land in “To review” after `clip review &lt;clip&gt; submit` or a batch run.</div>}
      {cur && (
        <div className="video-layout" style={{ gridTemplateColumns: '380px minmax(0, 1fr)' }}>
          <div>
            {cur.exported ? (
              <video
                ref={videoRef}
                muted={!sound}
                onVolumeChange={(e) => soundOn.set(!e.currentTarget.muted && e.currentTarget.volume > 0)}
                key={`${cur.id}-${stamp}`}
                src={`/media/exports/${cur.id}.mp4?t=${stamp}`}
                controls
                autoPlay
                loop
                style={{ width: '100%', aspectRatio: '9/16', background: '#000', borderRadius: 10 }}
              />
            ) : (
              <div className="card empty" style={{ aspectRatio: '9/16' }}>
                Not rendered yet.
              </div>
            )}
          </div>
          <div>
            <div className="card" style={{ padding: 16 }}>
              <div className="row">
                <div className="grow">
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{cur.title}</div>
                  <div className="muted mono">
                    {cur.id} · {(cur.durationMs / 1000).toFixed(1)} s · {cur.markers} markers
                  </div>
                </div>
                <button onClick={() => go(`#/clip/${cur.id}`)}>
                  Edit <kbd>E</kbd>
                </button>
              </div>
              <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                {cur.exported && (
                  <a className="chip on" href={`/media/exports/${cur.id}.mp4?t=${stamp}`} download={`${cur.post.title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || cur.id}.mp4`}>
                    ⬇ download MP4
                  </a>
                )}
                <CopyButton text={cur.post.title} label="copy title" />
                <CopyButton text={postBody(cur.post)} label="copy caption + hashtags" />
              </div>
              <div className="muted" style={{ marginTop: 6, whiteSpace: 'pre-wrap', fontSize: 12 }}>
                {postBody(cur.post)}
              </div>
              {cur.qa && (
                <div style={{ marginTop: 10 }}>
                  <span className="chip on" style={{ borderColor: cur.qa.passed ? 'var(--good)' : 'var(--bad)' }}>
                    QA {cur.qa.passed ? 'passed' : 'failed'}
                    {cur.qa.loudnessLufs !== null ? ` · ${cur.qa.loudnessLufs.toFixed(1)} LUFS` : ''}
                  </span>
                  <ul style={{ marginTop: 6 }}>
                    {cur.qa.issues.map((q, i) => (
                      <li key={i} className={q.level === 'fail' ? 'warn' : 'muted'}>
                        {q.check}: {q.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {cur.review.status === 'approved' && !cur.published && cur.upload?.reason && (
                <div className="card" style={{ marginTop: 10, padding: 10, borderColor: 'var(--bad)' }}>
                  <div className="warn">
                    {cur.upload.status === 'blocked-auth' || cur.upload.status === 'deferred' ? 'Waiting to upload:' : 'Not uploaded: the scheduler refused it.'} {cur.upload.reason}
                  </div>
                  <div className="row" style={{ marginTop: 6, display: cur.upload.status === 'blocked-auth' ? 'none' : undefined }}>
                    <button onClick={() => void api(`/api/clips/${cur.id}/retry-upload`, { body: {} }).then(load)} title="Put it back in the upload line; it is checked again">
                      {cur.upload.status === 'deferred' ? 'Check again' : 'Retry upload'}
                    </button>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {cur.upload.status === 'deferred' ? 'After an edit and a new render that leaves it out; otherwise it waits for the end of the careful period.' : 'Fix what it says first (edit, render), or retry if that has changed.'}
                    </span>
                  </div>
                </div>
              )}
              {cur.review.status === 'approved' && !cur.published && !cur.upload?.reason && cur.upload?.status && (
                <div className="muted" style={{ marginTop: 8 }}>
                  Upload:{' '}
                  {isCurrent(cur)
                    ? `next to go up; tried ${cur.upload.attempts} time${cur.upload.attempts === 1 ? '' : 's'}${cur.upload.lastAttemptAt ? `, last at ${hhmm(cur.upload.lastAttemptAt)}` : ''}${
                        cur.upload.status === 'held' ? `, held${cur.upload.lastError ? ` (${cur.upload.lastError})` : ''}; tried again ${up?.status ? retryText(up.status) : 'later'} until it goes up` : ', uploading now'
                      }`
                    : cur.upload.status === 'pending'
                      ? line[0] === cur.id
                        ? `first of ${line.length} in line; the scheduler takes it next`
                        : `#${line.indexOf(cur.id) + 1} of ${line.length} in line, behind ${line[0]}${held ? ', which is held by YouTube (see above)' : ''}`
                      : cur.upload.status}
                </div>
              )}
              {cur.published?.url && (
                <div className="muted" style={{ marginTop: 8 }}>
                  Uploaded:{' '}
                  <a href={cur.published.url} target="_blank" rel="noreferrer">
                    {cur.published.url}
                  </a>
                  {cur.published.publishAt ? ` · live ${new Date(cur.published.publishAt).toLocaleString()}` : ''}
                  {cur.published.ageRestriction === 'applied' ? ' · age-restricted on YouTube' : ''}
                </div>
              )}
              {cur.published?.heldPrivate && (
                <div className="card" style={{ marginTop: 10, padding: 10, borderColor: 'var(--bad)' }}>
                  <div className="warn">Private on YouTube (18+): {cur.published.heldPrivate}.</div>
                  {cur.published.videoId && (
                    <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                      <a href={`https://studio.youtube.com/video/${cur.published.videoId}/edit`} target="_blank" rel="noreferrer">
                        Open it in YouTube Studio
                      </a>
                      : Show more → Age restriction → “Yes, restrict my video to viewers over 18”, save, then Visibility → Public.
                    </div>
                  )}
                </div>
              )}
              {cur.candidate && (
                <>
                  <div className="hook" style={{ marginTop: 10, fontStyle: 'italic' }}>
                    “{cur.candidate.hook}”
                  </div>
                  <div className="muted" style={{ marginTop: 4 }}>
                    {cur.candidate.reason}
                  </div>
                  <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                    <span className="chip on">
                      quality {cur.candidate.score} · viral {cur.candidate.virality ?? '—'} · {cur.candidate.verdict ?? 'unscored'} · {cur.candidate.lens}
                    </span>
                    {cur.candidate.scores?.delivery !== undefined && <span className="chip">delivery {cur.candidate.scores.delivery}</span>}
                    {Object.entries(cur.candidate.signals).map(([k, v]) => (
                      <span key={k} className="chip on">
                        <span className="dot" style={{ background: SIGNAL_COLORS[k] ?? '#888' }} />
                        {k} {v.toFixed(2)}
                      </span>
                    ))}
                    <span className="chip">
                      source {fmtTime(cur.candidate.startMs)}–{fmtTime(cur.candidate.endMs)}
                    </span>
                  </div>
                  {cur.candidate.warnings.length > 0 && (
                    <ul style={{ marginTop: 8 }}>
                      {cur.candidate.warnings.map((w, i) => (
                        <li key={i} className="warn">
                          {w}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {tab === 'review' && cur.review.note?.trim() && (
                <div className="field" style={{ marginTop: 14 }}>
                  <label>Hand-over</label>
                  <div className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>
                    {cur.review.note.trim()}
                  </div>
                </div>
              )}
              <div className="field" style={{ marginTop: 14 }}>
                <label>Note (what to change, or why; Make changes needs one)</label>
                <textarea ref={noteRef} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. start on the question, drop the second boom" />
              </div>
              {tab === 'review' ? (
                <label className="row" style={{ alignItems: 'flex-start', gap: 8, margin: '0 0 10px', cursor: 'pointer' }} title="Ticked: it uploads age-restricted (18+) on YouTube">
                  <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} style={{ marginTop: 3 }} />
                  <span>
                    <b>18+</b> · upload age-restricted on YouTube <kbd>8</kbd>
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      {adultText(cur)}
                    </div>
                  </span>
                </label>
              ) : (
                <div style={{ margin: '0 0 10px' }}>
                  <AdultMark i={cur} />
                </div>
              )}
              {tab === 'review' && up?.careful && (
                <div className="muted" style={{ fontSize: 12, margin: '0 0 8px' }} title={up.careful.why ?? undefined}>
                  <b>Careful until {day(up.careful.until)}:</b> approve clips with the creator on screen and reacting, not a cutscene. A sexual flag, 18+ or an f-word in the first 3 s waits until then.
                </div>
              )}
              <div className="row">
                <button className="primary" onClick={() => void decide('approved')}>
                  Approve <kbd>A</kbd>
                </button>
                <button onClick={() => (note.trim() ? void decide('changes', note.trim()) : noteRef.current?.focus())} title="Needs a note (⌘↵ in the note box)">
                  Make changes <kbd>C</kbd>
                </button>
                <button className={asking ? 'danger primary' : 'danger'} onClick={() => setAsking((a) => !a)}>
                  Reject <kbd>R</kbd>
                </button>
                {canSendBack && (
                  <button
                    onClick={() => void decide('review')}
                    title={tab === 'approved' ? 'Take the approval back: it leaves the upload line and waits in To review' : 'Undo this decision: the clip waits in To review again'}
                  >
                    ↩ Back to review <kbd>U</kbd>
                  </button>
                )}
              </div>
              {asking && (
                <div className="reject-why" style={{ marginTop: 10 }}>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                    Why? One tap rejects. <kbd>R</kbd> again: no reason · <kbd>Esc</kbd> cancel
                  </div>
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    {REJECT_REASONS.map((r, i) => (
                      <button key={r.key} className="danger" onClick={() => void decide('rejected', undefined, [r.key])}>
                        <kbd>{i + 1}</kbd> {r.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {cur.review.reasons?.length ? (
                <div className="muted" style={{ marginTop: 8 }}>
                  {cur.review.status === 'rejected' ? 'Rejected' : 'Sent back'}: {cur.review.reasons.map((k) => REJECT_REASONS.find((r) => r.key === k)?.label ?? k).join(', ')}
                </div>
              ) : null}
            </div>
            <div className="card list" style={{ marginTop: 14 }}>
              {list.map((i) => (
                <div key={i.id} className={`cand ${i.id === cur.id ? 'sel' : ''}`} onClick={() => setSel(i.id)} style={{ padding: '8px 12px' }}>
                  <div className="row">
                    <span className="grow">
                      {i.review.status === 'approved' && !i.published && i.upload?.reason ? <span className="warn" title={`not uploaded: ${i.upload.reason}`}>⚠ </span> : null}
                      {i.title}
                    </span>
                    {(tab === 'review' ? i.qa?.adult?.detected : (i.review.adult ?? (i.review.status === 'approved' && !i.published && i.qa?.adult?.detected))) && (
                      <span className="chip" style={{ borderColor: 'var(--bad)', padding: '0 5px', fontSize: 11 }} title={tab === 'review' ? 'the 18+ check found sexual content' : 'uploads age-restricted'}>
                        18+
                      </span>
                    )}
                    <span className="muted mono">{(i.durationMs / 1000).toFixed(0)} s</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
