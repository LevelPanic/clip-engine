// Ranking a tracked Twitch stream's moments (src/scan/moments.ts) from what is on disk and what Twitch
// says now: shared by `clip moments`, `clip track` and the observer (tools/observer.ts), so all three
// rank the same way.
import fs from 'node:fs';
import { paths } from '../core/paths';
import { fmtTime } from '../core/time';
import { categoryAt } from '../project';
import { skipNeverClip, upsertMoments, upsertStream, type StreamRow } from './db';
import { CHAT_LAG_MS, laughLevels, momentWindow, rankMoments } from '../scan/moments';
import { lewdChat, sexualMoment } from '../qa/adult';
import { loadScan, scannedRanges } from '../scan';

const SUBSCRIBER_ONLY = /subscriber-only|subscriber only|requires an account|requires.*logged/i;
/**
 * Why a broadcast cannot be read, if that is what this output says. Twitch's own API gives one message
 * for deleted, expired and subscriber-only ("has no broadcast … (deleted, expired or subscriber-only)");
 * yt-dlp says plainly when it is subscriber-only. Read the generic one first so a deleted broadcast is
 * not filed as subscriber-only.
 */
export function unreadable(out: string): string | undefined {
  if (/has no broadcast|no broadcast \d+/i.test(out)) return 'the broadcast is gone (deleted, expired or subscriber-only)';
  if (SUBSCRIBER_ONLY.test(out)) return 'subscriber-only';
  return undefined;
}
export const isSubscriberOnly = (msg: string) => SUBSCRIBER_ONLY.test(msg);

/**
 * A Twitch broadcast's moments over the bar, best first, with both rankings. `chatHours` > 0 also
 * fetches the chat of the last that many hours first (what is not on disk yet); 0 ranks from the chat
 * already read (the observer reads chat itself, range by range).
 */
export async function rankStream(link: string, chatHours: number, say: (s: string) => void = () => {}) {
  const { twitchApi } = await import('../ingest/twitch');
  const { resolveInput } = await import('../scan/resolve');
  const api = twitchApi();
  const r = await resolveInput(link, api);
  if (!r.id.startsWith('tw-')) throw new Error('moments reads Twitch broadcasts (viewer clips and chat replay)');
  if (!fs.existsSync(paths.videoFile(r.id, 'meta.json'))) {
    const { ingest } = await import('../ingest/ingest');
    await ingest(r.id, { audio: false, full: false, refresh: false, wait: false });
  }
  const { refreshTwitchMeta } = await import('../ingest/ingest');
  const meta = await refreshTwitchMeta(r.id, api);
  const { optedOut, doNotClipError } = await import('../core/channel');
  const out = optedOut(meta);
  if (out) throw doNotClipError(out);
  const { fetchViewerClips, fetchChat, loadChat } = await import('../ingest/chat');
  const clips = await fetchViewerClips(r.id, api, { login: meta.login ?? '', startedAt: meta.startedAt ?? new Date().toISOString(), durationMs: meta.durationMs });
  const edge = meta.live ? Math.max(0, meta.durationMs - 3 * 60_000) : meta.durationMs;
  const chatFrom = Math.max(0, edge - chatHours * 3_600_000);
  if (chatHours > 0 && edge > chatFrom) {
    say(`reading chat ${fmtTime(chatFrom, 0)}–${fmtTime(edge, 0)} (only what is not fetched yet)…`);
    await fetchChat(r.id, [{ startMs: chatFrom, endMs: edge }], api, (t) => say(`  ${t}`));
  }
  const chat = loadChat(r.id);
  const laughs = chat && !chat.disabled ? laughLevels(chat.messages, chat.fetched, meta.durationMs) : undefined;
  // Scanned minutes are not left out (the second audit: that hid 107 regions whose evidence came later).
  // The tracker knows what was worked, by moment (planMoments: the same moment, or inside a worked
  // window, is never queued twice); `scanned` only says a region's data was read before.
  const scanned = scannedRanges(loadScan(r.id));
  const half = (m: { fromMs: number; toMs: number }) => scanned.reduce((n, x) => n + Math.max(0, Math.min(x.endMs, m.toMs) - Math.max(x.startMs, m.fromMs)), 0) >= 0.5 * (m.toMs - m.fromMs);
  const ranked = rankMoments({ clips, laughs, durationMs: meta.durationMs, liveEdgeMs: edge }).map((m) => ({ ...m, scanned: half(m) }));
  return { r, meta, clips, chat, edge, ranked };
}

/**
 * Moments the community marked as sexual (`sexualMoment`: a viewer clip titled for sex, or lewd chat over
 * it) are skipped with why. The viewer clips with the most views on GTA 6 streams were the nude shower,
 * the strip club and the bed scene, so ranking by views alone sent the watchlist to the clips YouTube
 * removed (docs/research/censorship-review-2026-11-22.md). Pure over the chat it is given.
 */
export function skipSexual<T extends { titles: string[]; fromMs: number; toMs: number; skip?: string }>(moments: T[], chat?: { messages: [number, string, string][]; disabled?: boolean }): T[] {
  return moments.map((m) => {
    if (m.skip) return m;
    const lewd = chat && !chat.disabled ? lewdChat(chat.messages, m.fromMs, m.toMs + CHAT_LAG_MS) : undefined;
    const why = sexualMoment(m, lewd);
    return why ? { ...m, skip: `a sexual moment: never clipped (${why})` } : m;
  });
}

/**
 * Rank a tracked stream and store it: its live state and length, and its moments in either ranking's
 * top `top` (a moment in a gambling chapter, or a sexual one, recorded skipped). Returns the stored moments.
 */
export async function rankAndStore(st: Pick<StreamRow, 'videoId' | 'platform' | 'creator' | 'login' | 'title' | 'game' | 'source' | 'startedAt'>, o: { chatHours?: number; top?: number; say?: (s: string) => void } = {}) {
  const top = o.top ?? 12;
  const r = await rankStream(st.videoId, o.chatHours ?? 0, o.say);
  const inTop = (m: { rank?: number; altRank?: number }) => (m.rank ?? 1e9) <= top || (m.altRank ?? 1e9) <= top;
  const withWindow = <M extends (typeof r.ranked)[number]>(m: M) => ({ ...m, window: momentWindow(m, r.edge), skip: undefined as string | undefined });
  const ms = [
    ...skipSexual(skipNeverClip(r.ranked.filter(inTop).map(withWindow), (t) => categoryAt(st.videoId, t)), r.chat ?? undefined),
    // a sexual moment below the top is stored skipped too: its row may still carry a rank from an earlier,
    // better showing, and the job picker reads the stored rank
    ...skipSexual(r.ranked.filter((m) => !inTop(m)).map(withWindow), r.chat ?? undefined).filter((m) => m.skip),
  ];
  // the stream first (live state, length, start), then its moments (which also set its clip count)
  upsertStream({ videoId: st.videoId, platform: st.platform, creator: st.creator, login: st.login, title: r.meta.title ?? st.title, game: st.game, source: st.source, live: !!r.meta.live, startedAt: r.meta.startedAt ?? st.startedAt, durationMs: r.meta.durationMs });
  upsertMoments(st.videoId, ms, r.clips.length);
  return { ...r, stored: ms };
}
