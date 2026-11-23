// Stream chat and viewer clips on disk: library/<id>/chat.json (grows range by range as passes scan
// the broadcast) and viewer-clips.json (refreshed each pass; new clips appear while it's live).
import { paths, readJsonIf, writeJson } from '../core/paths';
import { withVideoLock } from '../core/lock';
import { mergeRanges, subtractRanges, type Range } from '../core/ranges';
import { fmtTime } from '../core/time';
import { sourceOf } from './source';
import { clipsForBroadcast, type ChatMessage, type TwitchApi, type ViewerClip } from './twitch';

export interface ChatFile {
  videoId: string;
  /** Ranges whose chat has been fetched (messages outside them are unknown, not absent). */
  fetched: Range[];
  /** Chat replay is turned off for this broadcast. */
  disabled?: boolean;
  messages: ChatMessage[];
}

export interface ViewerClipsFile {
  videoId: string;
  fetchedAt: string;
  clips: ViewerClip[];
  /**
   * Every refresh: when, and how many of this broadcast's clips came back. A refresh that returns fewer
   * than are known did not remove any (see mergeViewerClips); this says how complete each one was.
   */
  fetches?: { at: string; returned: number }[];
}

export const loadChat = (videoId: string) => readJsonIf<ChatFile>(paths.videoFile(videoId, 'chat.json'));
export const loadViewerClips = (videoId: string) => readJsonIf<ViewerClipsFile>(paths.videoFile(videoId, 'viewer-clips.json'));

/** Replace a range's messages with freshly fetched ones. Pure. */
export function mergeChat(videoId: string, old: ChatFile | undefined, add: ChatMessage[], range: Range, disabled = false): ChatFile {
  const inside = (ms: number) => ms >= range.startMs && ms < range.endMs;
  return {
    videoId,
    fetched: mergeRanges([...(old?.fetched ?? []), range]),
    ...(disabled || old?.disabled ? { disabled: true } : {}),
    messages: [...(old?.messages ?? []).filter((m) => !inside(m[0])), ...add.filter((m) => inside(m[0]))].sort((a, b) => a[0] - b[0]),
  };
}

/** Fetch chat for whatever part of these ranges isn't on disk yet. */
export async function fetchChat(videoId: string, ranges: Range[], api: TwitchApi, log: (s: string) => void = () => {}) {
  if (!subtractRanges(ranges, loadChat(videoId)?.fetched ?? []).some((r) => r.endMs - r.startMs >= 1000)) return { fetched: [] as Range[], added: 0, disabled: !!loadChat(videoId)?.disabled };
  // one fetcher at a time per video (a scan pass, `clip chat`, several agents reading the same segment)
  return withVideoLock(videoId, 'chat', () => fetchMissingChat(videoId, ranges, api, log));
}

async function fetchMissingChat(videoId: string, ranges: Range[], api: TwitchApi, log: (s: string) => void) {
  const file = paths.videoFile(videoId, 'chat.json');
  const todo = subtractRanges(ranges, loadChat(videoId)?.fetched ?? []);
  let added = 0;
  for (const r of todo) {
    if (r.endMs - r.startMs < 1000) continue;
    log(`chat ${fmtTime(r.startMs, 0)}–${fmtTime(r.endMs, 0)}`);
    const got = await api.chat(sourceOf(videoId).nativeId, r.startMs, r.endMs, log);
    writeJson(file, mergeChat(videoId, loadChat(videoId), got.messages, r, got.disabled));
    added += got.messages.length;
    if (got.disabled) break;
  }
  return { fetched: todo, added, disabled: !!loadChat(videoId)?.disabled };
}

/**
 * Fresh clips merged into the ones already known, by slug. A clip seen once stays; its views only go up;
 * an exact offset is kept over an estimated one. A refresh is a page of the channel's top clips over a
 * period, filtered to this broadcast, so a newer broadcast's clips can push this one's off the page: an
 * empty or short refresh must not erase what was seen (ohnePixel's 291k-view moment lost its clips that
 * way, 2026-11-19). Pure.
 */
export function mergeViewerClips(known: ViewerClip[], fresh: ViewerClip[]): ViewerClip[] {
  const by = new Map(known.map((c) => [c.slug, c]));
  for (const c of fresh) {
    const o = by.get(c.slug);
    if (!o) by.set(c.slug, c);
    else {
      const offset = c.exact || !o.exact ? { offsetMs: c.offsetMs, exact: c.exact } : { offsetMs: o.offsetMs, exact: o.exact };
      by.set(c.slug, { ...o, ...c, ...offset, views: Math.max(o.views, c.views) });
    }
  }
  return [...by.values()].sort((a, b) => b.views - a.views);
}

/** Refresh the viewer clips made from this broadcast (exact offsets from Twitch, else estimated). */
export async function fetchViewerClips(videoId: string, api: TwitchApi, vod: { login: string; startedAt: string; durationMs: number }) {
  const ageDays = (Date.now() - Date.parse(vod.startedAt)) / 86_400_000;
  const period = ageDays < 0.9 ? 'LAST_DAY' : ageDays < 6.5 ? 'LAST_WEEK' : ageDays < 29 ? 'LAST_MONTH' : 'ALL_TIME';
  const all = await api.clips(vod.login, period);
  const fresh = clipsForBroadcast(all, { id: sourceOf(videoId).nativeId, createdAt: vod.startedAt, lengthMs: vod.durationMs });
  // one writer at a time: a scan, the watchlist's ranking and `clip moments` can refresh together
  return withVideoLock(videoId, 'viewer-clips', async () => {
    const old = loadViewerClips(videoId);
    const at = new Date().toISOString();
    const clips = mergeViewerClips(old?.clips ?? [], fresh);
    const fetches = [...(old?.fetches ?? []), { at, returned: fresh.length }].slice(-50);
    writeJson(paths.videoFile(videoId, 'viewer-clips.json'), { videoId, fetchedAt: at, clips, fetches } satisfies ViewerClipsFile);
    return clips;
  });
}
