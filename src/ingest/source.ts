// Where a video comes from. Library ids are YouTube ids as they are (11 characters) and Twitch past
// broadcasts as `tw-<vod id>`. Everything that builds a URL or branches on the platform goes through
// here. Browser-safe (no Node imports).

export type Platform = 'youtube' | 'twitch';

export interface SourceRef {
  platform: Platform;
  /** Library id: library/<id>/, clip ids, routes. */
  id: string;
  /** The platform's own id (YouTube video id, Twitch VOD number). */
  nativeId: string;
  /** Canonical page URL, what yt-dlp is given. */
  url: string;
  /** A start time in the link (?t=1h2m3s, &t=754), if any. */
  atMs?: number;
}

/** What a pasted link points at. Channels and clips need a lookup before they become a video. */
export type ParsedInput =
  | { kind: 'video'; ref: SourceRef }
  | { kind: 'twitch-channel'; login: string }
  | { kind: 'twitch-clip'; slug: string };

const TWITCH_RESERVED = new Set(['videos', 'directory', 'downloads', 'jobs', 'p', 'settings', 'subscriptions', 'inventory', 'wallet', 'search', 'friends', 'messages', 'drops', 'turbo', 'prime', 'store']);

const youtube = (id: string, atMs?: number): SourceRef => ({ platform: 'youtube', id, nativeId: id, url: `https://www.youtube.com/watch?v=${id}`, ...(atMs !== undefined ? { atMs } : {}) });
const twitch = (vod: string, atMs?: number): SourceRef => ({ platform: 'twitch', id: `tw-${vod}`, nativeId: vod, url: `https://www.twitch.tv/videos/${vod}`, ...(atMs !== undefined ? { atMs } : {}) });

/** "1h2m3s", "754s", "754" → ms. */
export function parseLinkTime(t: string | null): number | undefined {
  if (!t) return undefined;
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m || !(m[1] || m[2] || m[3])) return undefined;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}

export function parseInput(input: string): ParsedInput {
  const s = input.trim();
  // Twitch VOD ids first: "v2921546465" is 11 characters, like a YouTube id
  const tw = /^(?:tw-|v)(\d{6,})$/.exec(s);
  if (tw) return { kind: 'video', ref: twitch(tw[1]) };
  if (/^[\w-]{11}$/.test(s)) return { kind: 'video', ref: youtube(s) };
  // a bare name is a Twitch channel ("xqc", "@xqc"); an 11-character name needs the @ or a link
  const login = /^@?([A-Za-z0-9_]{3,25})$/.exec(s);
  if (login && !s.includes('.')) return { kind: 'twitch-channel', login: login[1].toLowerCase() };
  let u: URL;
  try {
    u = new URL(s.includes('://') ? s : `https://${s}`);
  } catch {
    throw new Error(`"${input}" is not a YouTube or Twitch link, or a video id`);
  }
  const host = u.hostname.replace(/^(www|m)\./, '');
  const at = parseLinkTime(u.searchParams.get('t'));

  if (host === 'youtu.be') {
    const id = u.pathname.slice(1, 12);
    if (/^[\w-]{11}$/.test(id)) return { kind: 'video', ref: youtube(id, at) };
  }
  if (host.endsWith('youtube.com')) {
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return { kind: 'video', ref: youtube(v, at) };
    const m = /\/(?:shorts|live|embed|v)\/([\w-]{11})/.exec(u.pathname);
    if (m) return { kind: 'video', ref: youtube(m[1], at) };
    throw new Error(`Can't find a video id in "${input}"`);
  }
  if (host === 'clips.twitch.tv') {
    const slug = u.pathname.split('/').filter(Boolean)[0];
    if (slug) return { kind: 'twitch-clip', slug };
  }
  if (host === 'twitch.tv') {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'videos' && /^\d+$/.test(parts[1] ?? '')) return { kind: 'video', ref: twitch(parts[1], at) };
    if (parts[1] === 'v' && /^\d+$/.test(parts[2] ?? '')) return { kind: 'video', ref: twitch(parts[2], at) };
    if (parts[1] === 'clip' && parts[2]) return { kind: 'twitch-clip', slug: parts[2] };
    if (parts[1] === 'video' && /^\d+$/.test(parts[2] ?? '')) return { kind: 'video', ref: twitch(parts[2], at) };
    if (parts.length >= 1 && /^\w{3,25}$/.test(parts[0]) && !TWITCH_RESERVED.has(parts[0].toLowerCase())) return { kind: 'twitch-channel', login: parts[0].toLowerCase() };
    throw new Error(`Can't find a Twitch broadcast in "${input}". Use a past-broadcast link (twitch.tv/videos/…) or a channel (twitch.tv/<name>).`);
  }
  throw new Error(`"${input}" is not a YouTube or Twitch link`);
}

/** A link or id that must name one video (not a channel or clip). */
export function parseSource(input: string): SourceRef {
  const p = parseInput(input);
  if (p.kind === 'video') return p.ref;
  if (p.kind === 'twitch-channel') throw new Error(`"${input}" is a Twitch channel. Use \`clip watch ${p.login}\` to follow its stream, or give one past broadcast (twitch.tv/videos/…).`);
  throw new Error(`"${input}" is a Twitch clip. Use \`clip scan\` with the clip link (it finds the broadcast and scans around the clip), or give the broadcast link.`);
}

/** The source of a library id. */
export function sourceOf(id: string): SourceRef {
  const tw = /^tw-(\d+)$/.exec(id);
  if (tw) return twitch(tw[1]);
  return youtube(id);
}
