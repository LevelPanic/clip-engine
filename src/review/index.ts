// Review decisions and the learning loop: every approve/reject is logged with what produced the clip
// (lens, judge score, signals, edits), and posted-clip performance can be imported next to it.
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJsonIf } from '../core/paths';
import { loadProject, saveProject, listClips } from '../project';
import { loadCandidates } from '../candidates';
import { REJECT_REASONS, type RejectReason, type Review, type ViralityScores } from '../core/schemas';
import { recordReview, releasePick } from './db';

/** Reason keys from a list or a comma-separated string; anything unknown is an error, not dropped. */
export function parseReasons(input: unknown): RejectReason[] | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  const list = (Array.isArray(input) ? input : String(input).split(',')).map((s) => String(s).trim()).filter(Boolean);
  const known = new Set<string>(REJECT_REASONS.map((r) => r.key));
  const bad = list.filter((r) => !known.has(r));
  if (bad.length) throw new Error(`unknown reason ${bad.join(', ')}: use ${[...known].join(', ')}`);
  return list.length ? [...new Set(list)] as RejectReason[] : undefined;
}

const FEEDBACK = () => path.join(paths.library, 'feedback.jsonl');
const PERF = () => path.join(paths.library, 'performance.jsonl');

export interface FeedbackRow {
  at: string;
  clipId: string;
  videoId: string;
  candidateId?: string;
  status: Review['status'];
  note?: string;
  /** Why it was rejected or sent back: boring, layout, cut, title, context. */
  reasons?: RejectReason[];
  /** 18+ as decided, and what the 18+ check in QA said (how often the reviewer overrules it). */
  adult?: boolean;
  adultDetected?: boolean;
  lens?: string;
  /** Which queue expert found it (meme, viral, clip), its queue, and whether it was accepted without a quote. */
  kind?: 'meme' | 'viral' | 'clip';
  queueId?: string;
  visual?: boolean;
  /** Where the curator put it, and how well it fit. */
  niche?: string;
  fit?: number;
  /** Markers the meme and expert editors proposed that the clip kept. */
  editorEdits?: number;
  score?: number; // quality
  scores?: ViralityScores; // the funnel the judge supplied
  virality?: number; // gated 0–100
  convergence?: number; // 0–1 signal agreement
  verdict?: 'post' | 'recut' | 'skip';
  hook?: string;
  title?: string;
  platform?: 'youtube' | 'twitch';
  signals?: Record<string, number>;
  durationMs: number;
  markers: Record<string, number>; // count by type
  autoEdits: number; // engine-proposed markers the clip kept
}

/**
 * Upload anyway: the reviewer lets an approval the careful period held go up (src/publish/scheduler.ts reads
 * `review.uploadAnyway`). It goes back in the upload line in its turn; the pace still applies, and the
 * never-post list and the credit still refuse whatever this says.
 */
export function uploadAnyway(clipId: string) {
  const p = loadProject(clipId);
  if (p.review?.status !== 'approved') throw new Error(`${clipId} is not approved: approve it first`);
  p.review = { ...p.review, uploadAnyway: new Date().toISOString() };
  saveProject(p);
  releasePick(clipId);
  return p.review;
}

export function setReview(clipId: string, status: Review['status'], note?: string, reasons?: RejectReason[], adult?: boolean) {
  const p = loadProject(clipId);
  // a decision's note is the reviewer's: the hand-over the clip came in with, sent back unchanged, is not
  // (the review page once prefilled it, and Make changes sent 7 hand-overs as change requests)
  if (note?.trim() && status !== 'review' && p.review?.status === 'review' && note.trim() === (p.review.note ?? '').trim()) note = undefined;
  // a reason explains a rejection or a request for changes; an approval carries none
  const why = status === 'rejected' || status === 'changes' ? reasons : undefined;
  // 18+ is decided with the clip: the reviewer's check, else the last decision's, else what the 18+
  // check in QA found. A clip sent (back) for review is decided again, from the check.
  const detected = readJsonIf<{ adult?: { detected: boolean } }>(path.join(paths.exports, `${clipId}.qa.json`))?.adult?.detected;
  const decided = status === 'review' || status === 'editing' ? undefined : (adult ?? p.review?.adult ?? detected ?? false);
  p.review = { status, note, ...(why?.length ? { reasons: why } : {}), ...(decided !== undefined ? { adult: decided } : {}), at: new Date().toISOString() };
  saveProject(p);
  recordReview({ clipId, videoId: p.videoId, title: p.title, status, note, at: p.review.at, adult: decided });
  if (status === 'approved' || status === 'rejected' || status === 'changes') {
    const cand = loadCandidates(p.videoId).candidates.find((c) => c.id === p.candidateId);
    const curated = readJsonIf<{ decisions: { candidateId: string; niche?: string; fit?: number }[] }>(paths.videoFile(p.videoId, 'curation.json'))?.decisions.find((d) => d.candidateId === p.candidateId);
    const markers: Record<string, number> = {};
    for (const m of p.markers) markers[m.type] = (markers[m.type] ?? 0) + 1;
    const row: FeedbackRow = {
      at: p.review.at,
      clipId,
      videoId: p.videoId,
      candidateId: p.candidateId,
      status,
      note,
      ...(why?.length ? { reasons: why } : {}),
      adult: decided,
      ...(detected !== undefined ? { adultDetected: detected } : {}),
      lens: cand?.lens,
      kind: cand?.kind,
      queueId: cand?.queueId,
      visual: cand?.visual,
      niche: curated?.niche,
      fit: curated?.fit,
      editorEdits: p.markers.filter((m) => (m.source ?? '').startsWith('editor:') && !m.proposed).length,
      score: cand?.score,
      scores: cand?.scores,
      virality: cand?.virality,
      convergence: cand?.convergence,
      verdict: cand?.verdict,
      hook: cand?.hook,
      title: p.title,
      platform: p.videoId.startsWith('tw-') ? 'twitch' : 'youtube',
      signals: cand?.signals,
      durationMs: p.segments[0].endMs - p.segments[0].startMs,
      markers,
      autoEdits: p.markers.filter((m) => m.source === 'autoedit' && !m.proposed).length,
    };
    fs.mkdirSync(paths.library, { recursive: true });
    fs.appendFileSync(FEEDBACK(), JSON.stringify(row) + '\n');
  }
  return p;
}

const readLines = <T>(file: string): T[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

export interface PerfRow {
  clipId: string;
  platform: string;
  views: number;
  /** Views past the first frame. The public metric behind "stayed to watch". */
  engagedViews?: number;
  avgViewPct?: number;
  avgViewDurationS?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  subscribersGained?: number;
  /** engagedViews / views. */
  stayedProxy?: number;
  /** 0–100: engaged 40%, avg view % 30%, shares 20%, subscribers 10%. */
  outcome?: number;
  importedAt: string;
}

/** Append rows to library/performance.jsonl. */
export function appendPerformance(rows: PerfRow[]): number {
  fs.mkdirSync(paths.library, { recursive: true });
  for (const row of rows) fs.appendFileSync(PERF(), JSON.stringify(row) + '\n');
  return rows.length;
}

/** CSV with a header: clipId,platform,views[,avgViewPct][,likes]. Export it from YouTube Studio,
 *  TikTok or Instagram insights and map each post to its clip id (the export's file name). */
export function importPerformance(csvFile: string): number {
  const [head, ...rows] = fs.readFileSync(csvFile, 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',').map((c) => c.trim().toLowerCase());
  const idx = (n: string) => cols.indexOf(n.toLowerCase());
  if (idx('clipId') < 0 || idx('views') < 0) throw new Error('CSV needs at least clipId and views columns');
  let n = 0;
  for (const r of rows) {
    const v = r.split(',').map((x) => x.trim());
    const row: PerfRow = {
      clipId: v[idx('clipId')].replace(/\.mp4$/, ''),
      platform: idx('platform') >= 0 ? v[idx('platform')] : 'unknown',
      views: Number(v[idx('views')]),
      engagedViews: idx('engagedViews') >= 0 ? Number(v[idx('engagedViews')]) : undefined,
      avgViewPct: idx('avgViewPct') >= 0 ? Number(v[idx('avgViewPct')]) : undefined,
      avgViewDurationS: idx('avgViewDurationS') >= 0 ? Number(v[idx('avgViewDurationS')]) : undefined,
      likes: idx('likes') >= 0 ? Number(v[idx('likes')]) : undefined,
      comments: idx('comments') >= 0 ? Number(v[idx('comments')]) : undefined,
      shares: idx('shares') >= 0 ? Number(v[idx('shares')]) : undefined,
      subscribersGained: idx('subscribersGained') >= 0 ? Number(v[idx('subscribersGained')]) : undefined,
      importedAt: new Date().toISOString(),
    };
    n += appendPerformance([row]);
  }
  return n;
}

/** What predicts a clip you approve (and, with imported numbers, one that performs). */
export function stats() {
  const fb = readLines<FeedbackRow>(FEEDBACK());
  const latest = new Map<string, FeedbackRow>(); // latest decision per clip
  for (const r of fb) latest.set(r.clipId, r);
  const rows = [...latest.values()];
  const perf = readLines<PerfRow>(PERF());
  const views = new Map<string, number>();
  const outcomes = new Map<string, number>();
  for (const p of perf) {
    views.set(p.clipId, (views.get(p.clipId) ?? 0) + p.views);
    if (p.outcome !== undefined) outcomes.set(p.clipId, p.outcome);
  }

  const group = (key: (r: FeedbackRow) => string | undefined) => {
    const g = new Map<string, { n: number; approved: number; views: number[]; outcomes: number[] }>();
    for (const r of rows) {
      const k = key(r);
      if (!k) continue;
      const e = g.get(k) ?? { n: 0, approved: 0, views: [], outcomes: [] };
      e.n++;
      if (r.status === 'approved') e.approved++;
      if (views.has(r.clipId)) e.views.push(views.get(r.clipId)!);
      if (outcomes.has(r.clipId)) e.outcomes.push(outcomes.get(r.clipId)!);
      g.set(k, e);
    }
    return [...g].map(([k, e]) => ({
      key: k,
      clips: e.n,
      approvalRate: Math.round((e.approved / e.n) * 100),
      medianViews: e.views.length ? e.views.sort((a, b) => a - b)[Math.floor(e.views.length / 2)] : null,
      medianOutcome: e.outcomes.length ? e.outcomes.sort((a, b) => a - b)[Math.floor(e.outcomes.length / 2)] : null,
    }));
  };
  const rank = (xs: number[]) => {
    const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(xs.length);
    order.forEach(([, i], p) => (r[i] = p + 1));
    return r;
  };
  const spearman = (a: number[], b: number[]) => {
    if (a.length < 3) return null;
    const ra = rank(a);
    const rb = rank(b);
    const ma = ra.reduce((s, x) => s + x, 0) / ra.length;
    const mb = rb.reduce((s, x) => s + x, 0) / rb.length;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < ra.length; i++) {
      num += (ra[i] - ma) * (rb[i] - mb);
      da += (ra[i] - ma) ** 2;
      db += (rb[i] - mb) ** 2;
    }
    return da && db ? Math.round((num / Math.sqrt(da * db)) * 100) / 100 : null;
  };
  const withOutcome = rows.filter((r) => outcomes.has(r.clipId) && r.virality !== undefined);
  const calibration = {
    n: withOutcome.length,
    virality: spearman(withOutcome.map((r) => r.virality!), withOutcome.map((r) => outcomes.get(r.clipId)!)),
    quality: spearman(withOutcome.map((r) => r.score ?? 0), withOutcome.map((r) => outcomes.get(r.clipId)!)),
    convergence: spearman(withOutcome.map((r) => r.convergence ?? 0), withOutcome.map((r) => outcomes.get(r.clipId)!)),
  };
  const signalNames = [...new Set(rows.flatMap((r) => Object.keys(r.signals ?? {})))];
  // why clips were turned down: one clip can have several reasons, so the shares can add up past 100%
  const turnedDown = rows.filter((r) => r.status === 'rejected' || r.status === 'changes');
  const reasonCount = new Map<string, number>();
  for (const r of turnedDown) for (const k of r.reasons?.length ? r.reasons : ['(no reason given)']) reasonCount.set(k, (reasonCount.get(k) ?? 0) + 1);
  const byReason = [...reasonCount]
    .map(([key, n]) => ({ key, label: REJECT_REASONS.find((r) => r.key === key)?.label ?? key, clips: n, share: Math.round((n / Math.max(1, turnedDown.length)) * 100) }))
    .sort((a, b) => b.clips - a.clips);
  return {
    decisions: rows.length,
    approved: rows.filter((r) => r.status === 'approved').length,
    turnedDown: turnedDown.length,
    byReason,
    byLens: group((r) => r.lens),
    byKind: group((r) => r.kind),
    byNiche: group((r) => r.niche),
    byScore: group((r) => (r.score === undefined ? undefined : r.score >= 80 ? '80+' : r.score >= 70 ? '70–79' : '<70')),
    byVirality: group((r) => (r.virality === undefined ? undefined : r.virality >= 70 ? '70+' : r.virality >= 60 ? '60–69' : '<60')),
    byVerdict: group((r) => r.verdict),
    byDelivery: group((r) => (r.scores?.delivery === undefined ? undefined : r.scores.delivery >= 7 ? '7+' : '<7')),
    byPlatform: group((r) => r.platform),
    bySignal: signalNames.flatMap((s) => group((r) => ((r.signals?.[s] ?? 0) >= 0.5 ? `${s}: strong` : `${s}: weak/none`))),
    calibration,
    notes: rows.filter((r) => r.note).map((r) => ({ clipId: r.clipId, status: r.status, note: r.note! })),
    imported: perf.length,
  };
}

export function reviewQueue() {
  return listClips()
    .map((id) => loadProject(id))
    .filter((p) => p.review)
    .map((p) => ({ id: p.id, title: p.title, videoId: p.videoId, review: p.review!, exported: !!readJsonIf(path.join(paths.exports, `${p.id}.json`)) }));
}
