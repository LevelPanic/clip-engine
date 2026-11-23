// Pull YouTube Analytics for published Shorts and turn it into an outcome score.
//
// Views count the moment playback starts, so they measure reach, not quality. The outcome score
// weights what actually predicts reach: engaged views (past the first frame), average view %,
// shares and subscribers. The Studio-only "stayed to watch" metric isn't in the public API, so
// engagedViews / views is the proxy. Analytics lags 2–3 days.
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJsonIf } from '../core/paths';
import { youtubeAccessToken, type PublishRecord } from './youtube';

const API = 'https://youtubeanalytics.googleapis.com/v2/reports';

export interface VideoAnalytics {
  videoId: string;
  clipId?: string;
  views: number;
  engagedViews: number;
  avgViewDurationS: number;
  avgViewPct: number;
  likes: number;
  comments: number;
  shares: number;
  subscribersGained: number;
  stayedProxy: number; // engagedViews / views
  outcome: number; // 0–100
  startDate: string;
  endDate: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 0–100. Engaged-view rate 40%, average view % 30%, shares 20%, subscribers 10%. */
export function outcomeScore(m: Pick<VideoAnalytics, 'views' | 'engagedViews' | 'avgViewPct' | 'shares' | 'subscribersGained'>): number {
  if (!m.views) return 0;
  const engaged = Math.min(1, m.engagedViews / m.views);
  const avg = Math.min(1, Math.max(0, m.avgViewPct / 100));
  const shares = Math.min(1, (m.shares / m.views) * 50); // 2% of views = full marks
  const subs = Math.min(1, (m.subscribersGained / m.views) * 200); // 0.5% = full marks
  return Math.round(100 * (0.4 * engaged + 0.3 * avg + 0.2 * shares + 0.1 * subs));
}

/** The report for one video; zeros when YouTube has no rows yet. */
export async function fetchVideoAnalytics(videoId: string, days = 28): Promise<VideoAnalytics> {
  const end = new Date();
  const start = new Date(end.getTime() - (Math.max(1, days) - 1) * 86_400_000);
  const token = await youtubeAccessToken();
  const params = new URLSearchParams({
    ids: 'channel==MINE',
    startDate: iso(start),
    endDate: iso(end),
    metrics: 'views,engagedViews,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained',
    dimensions: 'video',
    filters: `video==${videoId}`,
  });
  const r = await fetch(`${API}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 401 || r.status === 403) {
    const body = await r.text();
    if (/has not been used|SERVICE_DISABLED|it is disabled/i.test(body)) {
      throw new Error(
        'YouTube Analytics API is disabled for this Google Cloud project. Enable it at https://console.developers.google.com/apis/api/youtubeanalytics.googleapis.com/overview, wait a minute, then run `./clip analytics` again.',
      );
    }
    throw new Error('YouTube Analytics permission missing. Run `./clip auth youtube` again to grant the analytics scope.');
  }
  if (!r.ok) throw new Error(`YouTube Analytics refused the request (${r.status}): ${(await r.text()).slice(0, 400)}`);
  const j = (await r.json()) as { columnHeaders: { name: string }[]; rows?: unknown[][] };
  const col = (name: string) => j.columnHeaders.findIndex((h) => h.name === name);
  const row = j.rows?.[0] ?? [];
  const get = (name: string) => (col(name) >= 0 ? num(row[col(name)]) : 0);
  const views = get('views');
  const engagedViews = get('engagedViews');
  const m = {
    videoId,
    views,
    engagedViews,
    avgViewDurationS: get('averageViewDuration'),
    avgViewPct: get('averageViewPercentage'),
    likes: get('likes'),
    comments: get('comments'),
    shares: get('shares'),
    subscribersGained: get('subscribersGained'),
    stayedProxy: views ? Math.round((engagedViews / views) * 1000) / 1000 : 0,
    startDate: iso(start),
    endDate: iso(end),
  };
  return { ...m, outcome: outcomeScore(m) };
}

/** Published clips from exports/*.publish.json. */
export function publishedClips(): { clipId: string; videoId: string; title?: string }[] {
  if (!fs.existsSync(paths.exports)) return [];
  return fs
    .readdirSync(paths.exports)
    .filter((f) => f.endsWith('.publish.json'))
    .flatMap((f) => {
      const rec = readJsonIf<PublishRecord>(path.join(paths.exports, f));
      return rec?.videoId ? [{ clipId: rec.clipId, videoId: rec.videoId, title: rec.title }] : [];
    });
}

export async function fetchPublishedAnalytics(opts: { days?: number; clipId?: string } = {}): Promise<VideoAnalytics[]> {
  const clips = publishedClips().filter((c) => !opts.clipId || c.clipId === opts.clipId);
  const out: VideoAnalytics[] = [];
  for (const c of clips) {
    const m = await fetchVideoAnalytics(c.videoId, opts.days ?? 28);
    out.push({ ...m, clipId: c.clipId });
  }
  return out;
}
