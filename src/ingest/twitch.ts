// Twitch through its web API (gql.twitch.tv), the same endpoint yt-dlp, TwitchDownloader and
// chat-downloader use, with Twitch's public web client id. Twitch has no official API for chat replay
// on past broadcasts, so this is the only source of it. It's unofficial: Twitch can change it or
// rate-limit it, so every call retries transient errors and callers treat missing data as "signal
// unavailable", never as a crash.
import { sleep } from '../core/time';

const GQL = 'https://gql.twitch.tv/gql';
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
// persisted query the Twitch player uses for chat replay (offset or cursor paging)
const COMMENTS_HASH = 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a';

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface TwitchVideo {
  id: string;
  title: string;
  lengthMs: number;
  /** When the stream started (the VOD's 0:00). */
  createdAt: string;
  /** RECORDING while the stream is still live. */
  status: string;
  live: boolean;
  login: string;
  channel: string;
  game?: string;
  broadcastType?: string;
  viewCount?: number;
}

/** A live stream in a category, with the VOD it is recording (what a scan reads). */
export interface CategoryStream {
  login: string;
  name: string;
  viewers: number;
  title: string;
  /** `live`, or `rerun` for a replayed old broadcast. */
  type: string;
  /** The broadcast being recorded; absent when the channel keeps no VODs (nothing to scan). */
  vodId?: string;
  /** How long the recording is so far. */
  vodLengthMs?: number;
  recording: boolean;
}

/** Chat replay message: [ms into the broadcast, user, text]. Compact, since a big stream has 100k+. */
export type ChatMessage = [number, string, string];

export interface ViewerClip {
  slug: string;
  title: string;
  views: number;
  durationMs: number;
  createdAt: string;
  /** Where the clip starts in the broadcast. Exact when Twitch gives it, else estimated. */
  offsetMs: number;
  exact: boolean;
  vodId?: string;
  curator?: string;
}

export interface TwitchApi {
  video(vodId: string): Promise<TwitchVideo | null>;
  mutedSegments(vodId: string): Promise<{ startMs: number; endMs: number }[]>;
  chat(vodId: string, fromMs: number, toMs: number, onProgress?: (s: string) => void): Promise<{ messages: ChatMessage[]; disabled: boolean }>;
  clips(login: string, period: 'LAST_DAY' | 'LAST_WEEK' | 'LAST_MONTH' | 'ALL_TIME'): Promise<ViewerClip[]>;
  clip(slug: string): Promise<ViewerClip | null>;
  /** The channel's newest past broadcast (RECORDING when it's live now) and whether it's live. */
  latestBroadcast(login: string): Promise<{ vodId: string; live: boolean; title: string } | null>;
  /**
   * Every broadcast of the channel that was live at any time since `sinceMs` (newest first; a creator
   * who streams twice in a day has two), and whether the channel is live now with no VOD recorded.
   */
  recentBroadcasts(login: string, sinceMs: number): Promise<{ videos: TwitchVideo[]; liveWithoutVod: boolean }>;
  /** The most-watched live streams right now, strongest first. */
  topStreams(limit?: number): Promise<{ login: string; name: string; viewers: number; game: string; title: string }[]>;
  /** The most-watched categories right now (all languages). */
  topGames(limit?: number): Promise<{ name: string; viewers: number; channels: number }[]>;
  /** The most-watched streams in one category right now, in one broadcaster language (default English). */
  categoryStreams(category: string, opts?: { limit?: number; language?: string }): Promise<CategoryStream[]>;
}


export function twitchApi(fetchImpl: Fetch = fetch as unknown as Fetch): TwitchApi {
  async function gql<T>(body: unknown, attempt = 1): Promise<T> {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await fetchImpl(GQL, {
        method: 'POST',
        headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      if (attempt < 4) return (await sleep(1000 * 2 ** attempt), gql<T>(body, attempt + 1));
      throw new Error(`Twitch API unreachable: ${(e as Error).message}`);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 5) return (await sleep(1500 * 2 ** attempt), gql<T>(body, attempt + 1));
      throw new Error(`Twitch API kept failing (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`Twitch API refused the request (HTTP ${res.status})`);
    const json = (await res.json()) as T;
    const errs = (Array.isArray(json) ? json : [json]).flatMap((x) => ((x as { errors?: { message: string }[] }).errors ?? []).map((e) => e.message));
    if (errs.length && !(Array.isArray(json) ? json : [json]).some((x) => (x as { data?: unknown }).data)) throw new Error(`Twitch API: ${errs.join('; ')}`);
    return json;
  }

  const query = <T>(q: string) => gql<{ data: T; errors?: { message: string }[] }>({ query: q }).then((r) => r.data);

  const toClip = (n: GqlClip, createdAtFallback?: string): ViewerClip => ({
    slug: n.slug,
    title: n.title,
    views: n.viewCount ?? 0,
    durationMs: Math.round((n.durationSeconds ?? 30) * 1000),
    createdAt: n.createdAt ?? createdAtFallback ?? '',
    offsetMs: Math.round((n.videoOffsetSeconds ?? 0) * 1000),
    exact: n.videoOffsetSeconds !== null && n.videoOffsetSeconds !== undefined && !!n.video?.id,
    vodId: n.video?.id ?? undefined,
    curator: n.curator?.login,
  });

  return {
    async video(vodId) {
      const d = await query<{ video: GqlVideo | null }>(
        `{ video(id: "${vodId}") { id title lengthSeconds createdAt status broadcastType viewCount owner { login displayName } game { name } } }`,
      );
      const v = d?.video;
      if (!v) return null;
      return {
        id: v.id,
        title: v.title ?? '',
        lengthMs: Math.round((v.lengthSeconds ?? 0) * 1000),
        createdAt: v.createdAt,
        status: v.status ?? 'RECORDED',
        live: v.status === 'RECORDING',
        login: v.owner?.login ?? '',
        channel: v.owner?.displayName ?? v.owner?.login ?? '',
        game: v.game?.name,
        broadcastType: v.broadcastType,
        viewCount: v.viewCount,
      };
    },

    async mutedSegments(vodId) {
      // Twitch mutes stretches with copyrighted music; those have no sound in the broadcast
      try {
        const d = await query<{ video: { muteInfo?: { mutedSegmentConnection?: { nodes: { offset: number; duration: number }[] } } } | null }>(
          `{ video(id: "${vodId}") { muteInfo { mutedSegmentConnection { nodes { offset duration } } } } }`,
        );
        return (d?.video?.muteInfo?.mutedSegmentConnection?.nodes ?? []).map((n) => ({ startMs: n.offset * 1000, endMs: (n.offset + n.duration) * 1000 }));
      } catch {
        return []; // field missing or renamed: treat as nothing muted
      }
    },

    async chat(vodId, fromMs, toMs, onProgress) {
      // Paged by time offset: each request returns the ~50–60 messages from about that second on.
      // (Cursor paging needs a browser integrity token, so Twitch refuses it from here.) The range is
      // split into slices fetched side by side.
      const SLICE_MS = 5 * 60_000;
      const slices: { a: number; b: number }[] = [];
      for (let a = Math.max(0, fromMs); a < toMs; a += SLICE_MS) slices.push({ a, b: Math.min(toMs, a + SLICE_MS) });
      const out = new Map<string, ChatMessage>();
      let disabled = false;
      let done = 0;
      const one = async (s: { a: number; b: number }) => {
        let sec = Math.floor(s.a / 1000);
        for (let page = 0; page < 20_000 && sec * 1000 < s.b; page++) {
          const [r] = await gql<{ data?: { video: { comments: GqlComments | null } | null }; errors?: { message: string }[] }[]>([
            { operationName: 'VideoCommentsByOffsetOrCursor', variables: { videoID: vodId, contentOffsetSeconds: sec }, extensions: { persistedQuery: { version: 1, sha256Hash: COMMENTS_HASH } } },
          ]);
          if (!r?.data?.video) throw new Error(`Twitch has no broadcast ${vodId} (deleted, expired or subscriber-only)`);
          const comments = r.data.video.comments;
          if (!comments) {
            if (r.errors?.length) throw new Error(`Twitch refused the chat replay: ${r.errors.map((e) => e.message).join('; ')}`);
            disabled = true; // chat replay turned off for this broadcast
            return;
          }
          let last = -1;
          for (const e of comments.edges) {
            const n = e.node;
            const ms = Math.round(n.contentOffsetSeconds * 1000);
            last = Math.max(last, ms);
            if (ms < s.a || ms >= s.b) continue;
            out.set(n.id, [ms, n.commenter?.login ?? '', n.message?.fragments?.map((f) => f.text).join('') ?? '']);
          }
          if (!comments.edges.length || last < 0) return; // nothing after this point
          // next page starts at the last message's second; if a whole page fell in one second, move
          // on (that second had more messages than a page holds, and the rest are skipped)
          const lastSec = Math.floor(last / 1000);
          sec = lastSec > sec ? lastSec : sec + 1;
          if (page % 25 === 24) onProgress?.(`chat: ${out.size.toLocaleString('en-US')} messages`);
        }
      };
      const queue = [...slices];
      await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (let s = queue.shift(); s; s = queue.shift()) {
            await one(s);
            done++;
            onProgress?.(`chat: ${done}/${slices.length} slices, ${out.size.toLocaleString('en-US')} messages`);
          }
        }),
      );
      return { messages: [...out.values()].sort((x, y) => x[0] - y[0]), disabled };
    },

    async clips(login, period) {
      const all: ViewerClip[] = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page++) {
        const d: { user: { clips: { pageInfo: { hasNextPage: boolean }; edges: { cursor: string; node: GqlClip }[] } | null } | null } = await query(
          `{ user(login: "${login}") { clips(first: 100${after ? `, after: "${after}"` : ''}, criteria: { period: ${period}, sort: VIEWS_DESC }) { pageInfo { hasNextPage } edges { cursor node { slug title viewCount durationSeconds createdAt videoOffsetSeconds video { id } curator { login } } } } } }`,
        );
        const c = d?.user?.clips;
        if (!c) break;
        all.push(...c.edges.map((e) => toClip(e.node)));
        if (!c.pageInfo.hasNextPage || !c.edges.length) break;
        after = c.edges[c.edges.length - 1].cursor;
      }
      return all;
    },

    async clip(slug) {
      const d = await query<{ clip: GqlClip | null }>(
        `{ clip(slug: "${slug}") { slug title viewCount durationSeconds createdAt videoOffsetSeconds video { id } curator { login } } }`,
      );
      return d?.clip ? toClip(d.clip) : null;
    },

    async latestBroadcast(login) {
      const d = await query<{ user: { stream: { id: string } | null; videos: { edges: { node: { id: string; status: string; title: string } }[] } | null } | null }>(
        `{ user(login: "${login}") { stream { id } videos(first: 1, type: ARCHIVE, sort: TIME) { edges { node { id status title } } } } }`,
      );
      if (!d?.user) throw new Error(`No Twitch channel "${login}"`);
      const v = d.user.videos?.edges[0]?.node;
      if (!v) return null;
      return { vodId: v.id, live: !!d.user.stream && v.status === 'RECORDING', title: v.title };
    },

    async recentBroadcasts(login, sinceMs) {
      const d = await query<{ user: { stream: { id: string } | null; videos: { edges: { node: GqlVideo }[] } | null } | null }>(
        `{ user(login: "${login}") { stream { id } videos(first: 10, type: ARCHIVE, sort: TIME) { edges { node { id title lengthSeconds createdAt status broadcastType viewCount owner { login displayName } game { name } } } } } }`,
      );
      if (!d?.user) throw new Error(`No Twitch channel "${login}"`);
      const videos = (d.user.videos?.edges ?? [])
        .map(({ node: v }) => ({
          id: v.id,
          title: v.title ?? '',
          lengthMs: Math.round((v.lengthSeconds ?? 0) * 1000),
          createdAt: v.createdAt,
          status: v.status ?? 'RECORDED',
          live: v.status === 'RECORDING' && !!d.user!.stream,
          login: v.owner?.login ?? login,
          channel: v.owner?.displayName ?? v.owner?.login ?? login,
          game: v.game?.name,
          broadcastType: v.broadcastType,
          viewCount: v.viewCount,
        }))
        .filter((v) => v.live || Date.parse(v.createdAt) + v.lengthMs >= sinceMs);
      return { videos, liveWithoutVod: !!d.user.stream && !videos.some((v) => v.live) };
    },

    async topStreams(limit = 20) {
      const n = Math.max(1, Math.min(100, Math.round(limit)));
      const d = await query<{
        streams: { edges: { node: { title: string; viewersCount: number; game: { name: string } | null; broadcaster: { login: string; displayName: string } } }[] } | null;
      }>(`{ streams(first: ${n}) { edges { node { title viewersCount game { name } broadcaster { login displayName } } } } }`);
      return (d?.streams?.edges ?? []).map((e) => ({
        login: e.node.broadcaster.login,
        name: e.node.broadcaster.displayName,
        viewers: e.node.viewersCount,
        game: e.node.game?.name ?? '',
        title: e.node.title,
      }));
    },

    async topGames(limit = 30) {
      const n = Math.max(1, Math.min(100, Math.round(limit)));
      const d = await query<{ games: { edges: { node: { name: string; viewersCount: number; broadcastersCount: number } }[] } | null }>(
        `{ games(first: ${n}, options: { sort: VIEWER_COUNT }) { edges { node { name viewersCount broadcastersCount } } } }`,
      );
      return (d?.games?.edges ?? []).map((e) => ({ name: e.node.name, viewers: e.node.viewersCount, channels: e.node.broadcastersCount }));
    },

    async categoryStreams(category, opts = {}) {
      const n = Math.max(1, Math.min(100, Math.round(opts.limit ?? 20)));
      const lang = (opts.language ?? 'EN').toUpperCase().replace(/[^A-Z_]/g, '');
      const d = await query<{
        game: {
          streams: {
            edges: { node: { type: string; title: string; viewersCount: number; broadcaster: { login: string; displayName: string }; archiveVideo: { id: string; status: string; lengthSeconds: number } | null } }[];
          } | null;
        } | null;
      }>(
        `{ game(name: ${JSON.stringify(category)}) { streams(first: ${n}, options: { sort: VIEWER_COUNT, broadcasterLanguages: [${lang}] }) { edges { node { type title viewersCount broadcaster { login displayName } archiveVideo { id status lengthSeconds } } } } } }`,
      );
      if (!d?.game) throw new Error(`No Twitch category "${category}"`);
      return (d.game.streams?.edges ?? []).map((e) => ({
        login: e.node.broadcaster.login,
        name: e.node.broadcaster.displayName,
        viewers: e.node.viewersCount,
        title: e.node.title,
        type: e.node.type,
        vodId: e.node.archiveVideo?.id,
        vodLengthMs: e.node.archiveVideo ? e.node.archiveVideo.lengthSeconds * 1000 : undefined,
        recording: e.node.archiveVideo?.status === 'RECORDING',
      }));
    },
  };
}

interface GqlVideo {
  id: string;
  title?: string;
  lengthSeconds?: number;
  createdAt: string;
  status?: string;
  broadcastType?: string;
  viewCount?: number;
  owner?: { login: string; displayName?: string };
  game?: { name: string } | null;
}

interface GqlComments {
  edges: { node: { id: string; contentOffsetSeconds: number; commenter?: { login: string } | null; message?: { fragments?: { text: string }[] } } }[];
}

interface GqlClip {
  slug: string;
  title: string;
  viewCount?: number;
  durationSeconds?: number;
  createdAt?: string;
  videoOffsetSeconds?: number | null;
  video?: { id: string } | null;
  curator?: { login: string } | null;
}

/**
 * Where a viewer clip sits in a broadcast when Twitch doesn't say: clips are made right after the
 * moment and end at the moment they're created, so offset ≈ created − stream start − duration.
 */
export function estimateClipOffset(clip: { createdAt: string; durationMs: number }, streamStart: string): number {
  return Math.max(0, Date.parse(clip.createdAt) - Date.parse(streamStart) - clip.durationMs);
}

/**
 * Where a viewer clip's content probably sits in the broadcast. Twitch's offset is an anchor near the
 * moment, not a dependable start or end: across 291 clips of 9 broadcasts (2026-11-12), 42% were created
 * sooner after the offset than their own length (so it can't be their start), and words from the clip
 * title were said before the offset about as often as after it. So the content is taken to lie within
 * one clip length either side of the offset; look at frames before trusting either edge.
 */
export const clipSpan = (c: { offsetMs: number; durationMs: number }): { startMs: number; endMs: number } => ({
  startMs: Math.max(0, c.offsetMs - c.durationMs),
  endMs: c.offsetMs + c.durationMs,
});

/** 1 near the offset, falling to 0 one clip length away: how much a viewer clip says about time `ms`. */
export function clipNearness(c: { offsetMs: number; durationMs: number }, ms: number): number {
  const d = Math.abs(ms - c.offsetMs);
  const flat = Math.min(15_000, c.durationMs);
  if (d <= flat) return 1;
  if (d >= c.durationMs) return 0;
  return 1 - (d - flat) / (c.durationMs - flat);
}

/** Clips made by auto-clipping bots, not people: tell-tale titles, or one account clipping constantly for nobody. */
export function botClips(clips: ViewerClip[]): Set<string> {
  const BOT_TITLE = /chat (burst|spike)|viewer signal|auto[- ]?clip|highlight #?\d+|\bclip(ped)? by\b.*bot/i;
  const byCurator = new Map<string, ViewerClip[]>();
  for (const c of clips) if (c.curator) byCurator.set(c.curator, [...(byCurator.get(c.curator) ?? []), c]);
  const out = new Set<string>();
  for (const c of clips) {
    const mine = c.curator ? byCurator.get(c.curator)! : [];
    const views = mine.map((x) => x.views).sort((a, b) => a - b);
    const lowViews = views.length ? views[views.length >> 1] < 5 : false;
    if (BOT_TITLE.test(c.title) || /bot$/i.test(c.curator ?? '') || (mine.length >= 8 && lowViews)) out.add(c.slug);
  }
  return out;
}

/** The viewer clips that belong to this broadcast, with offsets (exact when Twitch gives them). Bot clips are dropped. */
export function clipsForBroadcast(clips: ViewerClip[], vod: { id: string; createdAt: string; lengthMs: number }): ViewerClip[] {
  const start = Date.parse(vod.createdAt);
  const bots = botClips(clips);
  return clips
    .filter((c) => !bots.has(c.slug))
    .filter((c) => (c.vodId ? c.vodId === vod.id : Date.parse(c.createdAt) >= start && Date.parse(c.createdAt) <= start + vod.lengthMs + 10 * 60_000))
    .map((c) => (c.exact ? c : { ...c, offsetMs: estimateClipOffset(c, vod.createdAt) }))
    .filter((c) => c.offsetMs <= vod.lengthMs);
}
