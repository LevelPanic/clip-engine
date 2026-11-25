// Review queue: watch each rendered clip and decide with one key. A approve · R reject (then 1–5 for
// why, or R again for no reason) · C make changes (optional note) · E open in the editor · ↑/↓ move.
// 18+ (age-restricted on YouTube) is a check on the To review tab only, ticked or not from the 18+
// check in QA (src/qa/adult.ts), 8 toggles it; the decision carries it, and every other tab shows it.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, go, isTyping, soundOn, useDebounced, useEvents, useStore } from './api';
import { SIGNAL_COLORS } from './ui/tokens';
import { Button, Callout, Chip, CopyButton, Field, Kbd, Nav, PageState, Popover, ShortcutLegend, Tabs, rowKeys } from './ui';
import { REJECT_REASONS, type Candidate, type Post, type RejectReason, type Review as ReviewState } from '../../core/schemas';
import { postBody } from '../../core/post';
import { PostCaption, PostTitle, Regenerate } from './PostText';
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
/**
 * Upload anyway, on an approval the careful period holds: a second click confirms (it lapses after a few
 * seconds). Only the careful period is skipped; the never-post list and the credit still refuse.
 */
function UploadAnyway({ clipId, onDone }: { clipId: string; onDone: () => void }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => (setSure(false), setErr(undefined)), [clipId]);
  useEffect(() => {
    if (!sure) return;
    const t = window.setTimeout(() => setSure(false), 6000);
    return () => window.clearTimeout(t);
  }, [sure]);
  const send = async () => {
    setBusy(true);
    try {
      await api(`/api/clips/${clipId}/upload-anyway`, { body: {} });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setSure(false);
    }
  };
  if (err) return <span className="small bad-text">{err}</span>;
  return sure ? (
    <>
      <Button className="danger primary" disabled={busy} onClick={() => void send()}>
        {busy ? 'Sending…' : 'Yes, upload it anyway'}
      </Button>
      <Button variant="ghost" onClick={() => setSure(false)}>
        Cancel
      </Button>
    </>
  ) : (
    <Button onClick={() => setSure(true)} title="Skip the careful period for this clip: it goes in the upload line in its turn">
      Upload anyway
    </Button>
  );
}

function AdultMark({ i }: { i: Item }) {
  // uploaded: what YouTube has, not what was asked
  if (i.published?.url) {
    if (i.published.ageRestriction === 'applied') return <Chip on tone="bad">18+ ✓ age-restricted on YouTube</Chip>;
    if (i.published.heldPrivate) return <Chip on tone="bad">18+ ✓ private on YouTube until it is age-restricted</Chip>;
    if (i.review.adult || i.qa?.adult?.detected)
      return (
        <Chip tone="bad" title="the 18+ check found sexual content after it went up; YouTube Studio → Age restriction if it needs one">
          18+ ✗ went up without an age restriction (the 18+ check found sexual content)
        </Chip>
      );
    return <Chip>18+ ✗ not age-restricted</Chip>;
  }
  // decided before the 18+ check existed: the upload takes what the check found (src/publish/youtube.ts)
  const a = i.review.adult ?? (i.review.status === 'approved' ? i.qa?.adult?.detected : undefined);
  const before = i.review.adult === undefined;
  if (a === undefined) return <Chip title="decided before the 18+ check existed">18+ not set</Chip>;
  if (before)
    return (
      <Chip tone={a ? 'bad' : 'default'} title="approved before the 18+ check existed: the upload takes what the check found">
        {a ? '18+ ✓ age-restricted (from the 18+ check)' : '18+ ✗ not age-restricted (from the 18+ check)'}
      </Chip>
    );
  return a ? (
    <Chip on tone="bad" title="uploads age-restricted on YouTube">
      18+ ✓ age-restricted
    </Chip>
  ) : (
    <Chip title="uploads without an age restriction">18+ ✗ not age-restricted</Chip>
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
    pace?: { perDay: number; everyMin: number; cap: number; inDay: number; nextAt: string; waitsFor?: 'spacing' | 'cap' | 'window' | 'paused'; window?: { from: string; to: string; timeZone: string }; paused?: boolean };
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
  if (p.paused) return 'paused in Settings';
  const gap = p.everyMin % 60 === 0 ? `${p.everyMin / 60} hour${p.everyMin === 60 ? '' : 's'}` : `${p.everyMin} minutes`;
  return `at most ${p.cap} in 24 hours${p.cap < p.perDay ? ` (held below ${p.perDay} by YouTube's limit)` : ''}, ${gap} apart${p.window ? `, between ${p.window.from} and ${p.window.to} (${p.window.timeZone})` : ''}`;
}

/** Why the next upload waits, after its time: the day's cap, or the posting hours. */
const waitWords = (w?: string) => (w === 'cap' ? ' (the day’s cap)' : w === 'window' ? ' (the posting hours)' : '');

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
  const [showKeys, setShowKeys] = useState(false);
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
    if (e.key === '?') return setShowKeys((x) => !x);
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

  const keys: [string, string][] = [
    ['A', 'approve'],
    ...(tab === 'review' ? ([['8', '18+']] as [string, string][]) : []),
    ['R', 'reject, then 1–5 why'],
    ['C', 'changes'],
    ...(canSendBack ? ([['U', 'back to review']] as [string, string][]) : []),
    ['E', 'edit'],
    ['↑ ↓', 'move'],
    ['space', 'play'],
  ];

  // the upload line's state (Approved, Uploaded): a box above the clip's details, so the clip keeps the height
  // the upload line's state (Approved, Uploaded): one line above the clip's details; resting on it (or focusing
  // it) opens the whole of it over the details, so the clip keeps the height
  const pace = up?.status?.pace;
  const nextAt = pace && Date.parse(pace.nextAt) > Date.now() ? new Date(pace.nextAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  const deferred = (items ?? []).filter((i) => i.review.status === 'approved' && !i.published && i.upload?.status === 'deferred').length;
  const isHeld = tab === 'approved' && !!held;
  const summary =
    tab === 'approved'
      ? [
          isHeld ? 'Uploads on hold' : null,
          pace?.paused ? 'Uploads paused in Settings' : null,
          pace ? `${pace.inDay} of ${pace.cap} up in 24 h` : null,
          pace && !pace.paused ? (nextAt ? `next at ${nextAt}${waitWords(pace.waitsFor)}` : 'next can go now') : null,
          `${line.length} in line`,
          up?.careful ? `careful until ${day(up.careful.until)}${deferred ? `, ${deferred} waiting` : ''}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : `Upload log: the last ${up?.log.length ?? 0} tries`;
  const info =
    (tab === 'approved' || tab === 'uploaded') && (held || pace || up?.careful || !!up?.log.length) ? (
      <div className={`review-info${isHeld ? ' held' : ''}`} tabIndex={0} aria-label={`The upload line: ${summary}. Focus or hover for the details.`}>
        <div className="review-info-line" aria-hidden="true">
          <span className="summary">{summary}</span>
          <span className="more">Details</span>
        </div>
        <div className="review-info-more">
          <div className="review-info-line">
            <span className="summary">{summary}</span>
          </div>
          <div className="review-info-body">
            {isHeld && up && held && (
              <div className="bad-text">
                <div className="strong">Uploads are on hold.</div>
                <div>{holdText(up)}</div>
                <div className="muted mt-1">
                  The scheduler stays on {line[0]} until it goes up and tries it again {retryText(held)}
                  {held.retryEveryMin && held.nextTryAt ? ` (next at ${hhmm(held.nextTryAt)})` : ''}; the other {line.length - 1} approved clip{line.length === 2 ? '' : 's'} wait behind it,
                  oldest approval first. Nothing is lost.
                  {held.reason ? ` YouTube said: ${held.reason}` : ''}
                </div>
              </div>
            )}
            {tab === 'approved' && pace && (
              <div>
                Uploads: {paceText(pace)}. {pace.inDay} went up in the last 24 hours
                {pace.paused ? '; nothing more goes up until it is resumed in Settings' : nextAt ? `; the next can go at ${nextAt}${waitWords(pace.waitsFor)}` : '; the next can go now'}. {line.length} in line, oldest approval first.
              </div>
            )}
            {tab === 'approved' && up?.careful && (
              <div>
                Careful period until {day(up.careful.until)}: an approval with a sexual flag, an 18+ tick or an f-word in its first 3 s waits for it to end and then goes up by itself
                {deferred ? ` (${deferred} waiting)` : ''}.
              </div>
            )}
            {!!up?.log.length && (
              <div>
                <div className="section-title mb-2">
                  Upload log <span className="muted">the last {up.log.length} tries; all of them are in library/upload-log.jsonl</span>
                </div>
                <div className="upload-log">
                  <table className="small">
                    <tbody>
                      {up.log.map((t, k) => (
                        <tr key={k}>
                          <td className="muted">{new Date(t.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                          <td>
                            <button type="button" className="link" onClick={() => setSel(t.clipId)}>
                              {t.clipId}
                            </button>
                          </td>
                          <td className="muted">try {t.try}</td>
                          <td className={t.outcome === 'uploaded' ? '' : 'warn'}>{t.outcome}</td>
                          <td className="muted wide">
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
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    ) : null;

  return (
    <div className="page wide review-page">
      <Nav current="review" />
      <h1 className="visually-hidden">Review</h1>
      <div className="tabs-row">
        <Tabs
          label="Review tabs"
          tabs={TABS.map((t) => ({
            ...t,
            count: (items ?? []).filter((i) => inTab(i, t.key)).length,
          }))}
          value={tab}
          onChange={(k) => (setTab(k), setSel(null))}
        />
        <span className="grow" />
        <Popover
          label="Keyboard shortcuts"
          open={showKeys}
          onOpenChange={setShowKeys}
          trigger={
            <>
              Shortcuts <Kbd>?</Kbd>
            </>
          }
        >
          <ShortcutLegend stacked keys={[...keys, ['?', 'show or hide these']]} />
        </Popover>
      </div>
      {!cur && info}
      {items === null && (
        <div className="card">
          <PageState kind={loadError ? 'error' : 'loading'}>{loadError ? `Could not load the review list (${loadError}). Trying again…` : undefined}</PageState>
        </div>
      )}
      {items !== null && !list.length && (
        <div className="card">
          <PageState kind="empty">Nothing here. Clips land in “To review” after `clip review &lt;clip&gt; submit` or a batch run.</PageState>
        </div>
      )}
      {cur && (
        <div className="review-workspace">
          <nav className="card review-queue" aria-label="Clips in this tab">
            {list.map((i) => (
              <ReviewRow key={i.id} i={i} selected={i.id === cur.id} tab={tab} onSelect={() => setSel(i.id)} />
            ))}
          </nav>
          <div className="review-player">
            {cur.exported ? (
              <video
                ref={videoRef}
                className="review-video"
                muted={!sound}
                onVolumeChange={(e) => soundOn.set(!e.currentTarget.muted && e.currentTarget.volume > 0)}
                key={`${cur.id}-${stamp}`}
                src={`/media/exports/${cur.id}.mp4?t=${stamp}`}
                controls
                autoPlay
                loop
              />
            ) : (
              <div className="card review-video">
                <PageState kind="empty">Not rendered yet.</PageState>
              </div>
            )}
          </div>
          <div className="review-side">
            {info}
            <section className="card review-detail" aria-label="The clip and your decision">
              <div className="review-detail-body">
                <div className="panel-section">
                  <div className="row top">
                    <div className="grow">
                      <PostTitle clipId={cur.id} title={cur.post.title} onSaved={load} />
                      <div className="muted mono mt-1">
                        {cur.id} · {(cur.durationMs / 1000).toFixed(1)} s · {cur.markers} markers
                      </div>
                    </div>
                    <Button kbd="E" onClick={() => go(`#/clip/${cur.id}`)} title="Open the clip in the editor">
                      Edit clip
                    </Button>
                  </div>
                  <div className="row wrap gap-1 mt-3">
                    <Regenerate clipId={cur.id} field="title" onUsed={load} />
                    <Regenerate clipId={cur.id} field="caption" onUsed={load} />
                  </div>
                  {cur.review.status === 'approved' && !cur.published && cur.upload?.reason && (
                    <Callout tone="bad" className="mt-4">
                      <div>
                        {cur.upload.status === 'blocked-auth' || cur.upload.status === 'deferred' ? 'Waiting to upload:' : 'Not uploaded: the scheduler refused it.'} {cur.upload.reason}
                      </div>
                      {cur.upload.status !== 'blocked-auth' && (
                        <div className="row mt-3">
                          <Button
                            onClick={() =>
                              void api(`/api/clips/${cur.id}/retry-upload`, {
                                body: {},
                              }).then(load)
                            }
                            title="Put it back in the upload line; it is checked again"
                          >
                            {cur.upload.status === 'deferred' ? 'Check again' : 'Retry upload'}
                          </Button>
                          {cur.upload.status === 'deferred' && <UploadAnyway clipId={cur.id} onDone={load} />}
                        </div>
                      )}
                      {cur.upload.status !== 'blocked-auth' && (
                        <div className="muted small mt-2">
                          {cur.upload.status === 'deferred'
                            ? 'Check again after an edit and a new render that leaves it out. Upload anyway sends it in its turn, careful period or not (the pace still applies). Otherwise it waits for the end of the period.'
                            : 'Fix what it says first (edit, render), or retry if that has changed.'}
                        </div>
                      )}
                    </Callout>
                  )}
                  {cur.published?.heldPrivate && (
                    <Callout tone="bad" className="mt-4">
                      <div>Private on YouTube (18+): {cur.published.heldPrivate}.</div>
                      {cur.published.videoId && (
                        <div className="muted small mt-1">
                          <a href={`https://studio.youtube.com/video/${cur.published.videoId}/edit`} target="_blank" rel="noreferrer">
                            Open it in YouTube Studio
                          </a>
                          : Show more → Age restriction → “Yes, restrict my video to viewers over 18”, save, then Visibility → Public.
                        </div>
                      )}
                    </Callout>
                  )}
                  {cur.review.status === 'approved' && !cur.published && cur.review.uploadAnyway && (
                    <div className="muted small mt-3">
                      Upload anyway: you let it past the careful period on {new Date(cur.review.uploadAnyway).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}. It goes up in its turn.
                    </div>
                  )}
                  {cur.review.status === 'approved' && !cur.published && !cur.upload?.reason && cur.upload?.status && (
                    <div className="muted small mt-3">
                      Upload:{' '}
                      {isCurrent(cur)
                        ? `next to go up; tried ${cur.upload.attempts} time${cur.upload.attempts === 1 ? '' : 's'}${cur.upload.lastAttemptAt ? `, last at ${hhmm(cur.upload.lastAttemptAt)}` : ''}${
                            cur.upload.status === 'held'
                              ? `, held${cur.upload.lastError ? ` (${cur.upload.lastError})` : ''}; tried again ${up?.status ? retryText(up.status) : 'later'} until it goes up`
                              : ', uploading now'
                          }`
                        : cur.upload.status === 'pending'
                          ? line[0] === cur.id
                            ? `first of ${line.length} in line; the scheduler takes it next`
                            : `#${line.indexOf(cur.id) + 1} of ${line.length} in line, behind ${line[0]}${held ? ', which is held by YouTube (see above)' : ''}`
                          : cur.upload.status}
                    </div>
                  )}
                  {cur.published?.url && (
                    <div className="muted small mt-3">
                      Uploaded:{' '}
                      <a href={cur.published.url} target="_blank" rel="noreferrer">
                        {cur.published.url}
                      </a>
                      {cur.published.publishAt ? ` · live ${new Date(cur.published.publishAt).toLocaleString()}` : ''}
                      {cur.published.ageRestriction === 'applied' ? ' · age-restricted on YouTube' : ''}
                    </div>
                  )}
                </div>
                <div className="panel-section">
                  <div className="row wrap">
                    <h3 className="section-title grow">Post</h3>
                    {cur.exported && (
                      <a
                        className="chip"
                        href={`/media/exports/${cur.id}.mp4?t=${stamp}`}
                        download={`${
                          cur.post.title
                            .replace(/[^\w\s-]/g, '')
                            .trim()
                            .replace(/\s+/g, '-')
                            .slice(0, 60) || cur.id
                        }.mp4`}
                      >
                        Download MP4
                      </a>
                    )}
                    <CopyButton small text={cur.post.title} label="Copy title" />
                    <CopyButton small text={postBody(cur.post)} label="Copy description" />
                  </div>
                  <PostCaption clipId={cur.id} caption={cur.post.caption} onSaved={load} />
                  {(cur.post.credit || cur.post.hashtags) && (
                    <div className="review-post muted" title="Added under every description by the engine (the credit rule)">
                      {[cur.post.credit, cur.post.hashtags].filter(Boolean).join('\n\n')}
                    </div>
                  )}
                </div>
                {cur.qa && (
                  <div className="panel-section">
                    <div className="row">
                      <h3 className="section-title grow">Checks</h3>
                      <Chip tone={cur.qa.passed ? 'good' : 'bad'}>
                        QA {cur.qa.passed ? 'passed' : 'failed'}
                        {cur.qa.loudnessLufs !== null ? ` · ${cur.qa.loudnessLufs.toFixed(1)} LUFS` : ''}
                      </Chip>
                    </div>
                    {cur.qa.issues.length > 0 && (
                      <ul className="small">
                        {cur.qa.issues.map((q, i) => (
                          <li key={i} className={q.level === 'fail' ? 'warn' : 'muted'}>
                            {q.check}: {q.detail}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {cur.candidate && (
                  <div className="panel-section">
                    <h3 className="section-title mb-2">Why this clip</h3>
                    <div className="hook">“{cur.candidate.hook}”</div>
                    <div className="muted small mt-2">{cur.candidate.reason}</div>
                    <div className="row wrap gap-2 mt-4">
                      <Chip on>
                        quality {cur.candidate.score} · viral {cur.candidate.virality ?? '—'} · {cur.candidate.verdict ?? 'unscored'} · {cur.candidate.lens}
                      </Chip>
                      {cur.candidate.scores?.delivery !== undefined && <Chip>delivery {cur.candidate.scores.delivery}</Chip>}
                      {Object.entries(cur.candidate.signals).map(([k, v]) => (
                        <Chip key={k} on dot={SIGNAL_COLORS[k] ?? 'var(--muted)'}>
                          {k} {v.toFixed(2)}
                        </Chip>
                      ))}
                      <Chip>
                        source {fmtTime(cur.candidate.startMs)}–{fmtTime(cur.candidate.endMs)}
                      </Chip>
                    </div>
                    {cur.candidate.warnings.length > 0 && (
                      <ul className="small mt-3">
                        {cur.candidate.warnings.map((w, i) => (
                          <li key={i} className="warn">
                            {w}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {tab === 'review' && cur.review.note?.trim() && (
                  <div className="panel-section">
                    <h3 className="section-title mb-2">Hand-over</h3>
                    <div className="muted small pre-wrap">{cur.review.note.trim()}</div>
                  </div>
                )}
              </div>
              <div className="review-actions">
                <Field label="Note" aside={<span className="muted">what to change, or why; Make changes needs one</span>}>
                  <textarea ref={noteRef} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. start on the question, drop the second boom" />
                </Field>
                {tab === 'review' ? (
                  <label className="adult-check mb-3" title="Ticked: it uploads age-restricted (18+) on YouTube">
                    <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
                    <span>
                      <b>18+</b> · upload age-restricted on YouTube <kbd>8</kbd>
                      <div className="muted small mt-1">{adultText(cur)}</div>
                    </span>
                  </label>
                ) : (
                  <div className="mb-3">
                    <AdultMark i={cur} />
                  </div>
                )}
                {tab === 'review' && up?.careful && (
                  <div className="muted small mb-3" title={up.careful.why ?? undefined}>
                    <b>Careful until {day(up.careful.until)}:</b> approve clips with the creator on screen and reacting, not a cutscene. A sexual flag, 18+ or an f-word in the first 3 s waits until
                    then.
                  </div>
                )}
                <div className="row wrap">
                  <Button variant="primary" kbd="A" onClick={() => void decide('approved')}>
                    Approve
                  </Button>
                  <Button kbd="C" onClick={() => (note.trim() ? void decide('changes', note.trim()) : noteRef.current?.focus())} title="Needs a note (⌘↵ in the note box)">
                    Make changes
                  </Button>
                  <Button className={asking ? 'danger primary' : 'danger'} kbd="R" aria-expanded={asking} onClick={() => setAsking((a) => !a)}>
                    Reject
                  </Button>
                  {canSendBack && (
                    <Button
                      kbd="U"
                      onClick={() => void decide('review')}
                      title={tab === 'approved' ? 'Take the approval back: it leaves the upload line and waits in To review' : 'Undo this decision: the clip waits in To review again'}
                    >
                      Back to review
                    </Button>
                  )}
                </div>
                {asking && (
                  <div className="mt-4" role="group" aria-label="Why reject it">
                    <div className="muted small mb-2">
                      Why? One tap rejects. <kbd>R</kbd> again: no reason · <kbd>Esc</kbd> cancel
                    </div>
                    <div className="row wrap">
                      {REJECT_REASONS.map((r, i) => (
                        <Button key={r.key} variant="danger" onClick={() => void decide('rejected', undefined, [r.key])}>
                          <kbd>{i + 1}</kbd> {r.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
                {cur.review.reasons?.length ? (
                  <div className="muted small mt-3">
                    {cur.review.status === 'rejected' ? 'Rejected' : 'Sent back'}: {cur.review.reasons.map((k) => REJECT_REASONS.find((r) => r.key === k)?.label ?? k).join(', ')}
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

/** One clip in the list: a click or Enter selects it; the selected one scrolls into view (↑ ↓ move it). */
function ReviewRow({ i, selected, tab, onSelect }: { i: Item; selected: boolean; tab: Tab; onSelect: () => void }) {
  const keys = rowKeys(onSelect);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // scroll the queue, never the page (on a narrow screen the queue is under the clip)
    const el = ref.current;
    const box = el?.parentElement;
    if (!selected || !el || !box || box.scrollHeight <= box.clientHeight) return;
    if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight;
  }, [selected]);
  const adult = tab === 'review' ? i.qa?.adult?.detected : (i.review.adult ?? (i.review.status === 'approved' && !i.published && i.qa?.adult?.detected));
  const refused = i.review.status === 'approved' && !i.published && i.upload?.reason;
  return (
    <div ref={ref} className="review-row" onClick={onSelect} aria-current={selected || undefined} {...keys}>
      <span className="name" title={i.post.title}>
        {i.post.title}
      </span>
      <span className="meta">
        <span className="muted mono">{(i.durationMs / 1000).toFixed(0)} s</span>
        {refused ? (
          <Chip small tone="warn" title={`not uploaded: ${i.upload!.reason}`}>
            not uploaded
          </Chip>
        ) : null}
        {adult && (
          <Chip small tone="bad" title={tab === 'review' ? 'the 18+ check found sexual content' : 'uploads age-restricted'}>
            18+
          </Chip>
        )}
      </span>
    </div>
  );
}
