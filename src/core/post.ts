// What goes with the video when it's posted: a title (YouTube Shorts), a caption (TikTok, Reels) and
// hashtags. Suggested from the candidate and the source video; the editor's Post fields override
// each part. Browser-safe: the Studio shows the suggestion and the renderer writes exports/<clip>.txt.
import type { Post } from './schemas';

const LENS_TAGS: Record<string, string[]> = {
  'podcast-general': ['podcast', 'funny'],
  'hot-takes': ['podcast', 'advice'],
  'stream-moments': ['gaming', 'streamer'],
};

const tag = (s: string) =>
  s
    .replace(/['’]s\b/gi, '') // "Spandau's" → "Spandau", not "Spandaus"
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+(.)?/gu, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^./, (c) => c.toUpperCase());

const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/^["“]|["”]$/g, '').trim();
const firstSentence = (s: string) => {
  const m = /^.*?[.!?](?=\s|$)/.exec(clean(s));
  return (m ? m[0] : clean(s)).slice(0, 160);
};

/** The name a clip channel would use, not the account's full handle. */
const NICKNAMES: Record<string, string> = {
  theburntpeanut: 'Peanut',
  caseoh: 'CaseOh',
  burntpeanut: 'Peanut',
  stableronaldo: 'Ron',
  hasanabi: 'Hasan',
  xqc: 'xQc',
  jynxzi: 'Jynxzi',
  cloakzy: 'Cloakzy',
  kaicenat: 'Kai',
  ishowspeed: 'Speed',
  asmongold: 'Asmon',
  ludwig: 'Ludwig',
  nickmercs: 'Nick',
  nick: 'Nick',
};
const nickOf = (channel?: string, title?: string) => {
  const key = (channel ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [k, v] of Object.entries(NICKNAMES)) if (key.includes(k)) return v;
  const before = title?.split(':')[0]?.trim();
  if (before && before.length >= 3 && before.length <= 18 && /^[A-Z]/.test(before)) return before;
  return (channel ?? 'This streamer').replace(/\s*(live|shorts|clips)$/i, '').trim() || 'This streamer';
};

const VERB = /^(stole|steals|hates|hate|went|goes|ended|ends|got|gets|found|finds|tried|tries|said|says|reacted|reacts|broke|breaks|lost|loses|caught|catches|fired|banned|exposed|revealed|forgot|forgets|won|wins|made|makes|did|does|came|comes|is|was|has|had|can|could|will|would)\b/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Turn a descriptive title into a present/past-tense action phrase. */
const actionOf = (title: string, nick: string) => {
  let s = clean(title);
  // "Streamer gets jumpscared", "He has to share a bed": a title that does not say who. The name goes there.
  s = s.replace(/^(?:the\s+)?streamer\s+(?=\S)/i, '').replace(/^(?:he|she)\s+(?=(?:has|had|is|was|gets|got|thinks|finds|tries|says|loses|wins|goes)\b)/i, '');
  s = s.replace(new RegExp(`^${escapeRe(nick)}'s\\s+`, 'i'), '');
  s = s.replace(/^The\s+/i, '');
  s = s.replace(/^TheBurntPeanut's\s+/i, '');
  s = s.replace(/^[A-Z][\w’']*'s\s+/i, ''); // NICKMERCS'S, xQc's, Peanut's
  for (const [re, to] of [
    [/\bgoes wrong\b/i, 'went wrong'],
    [/\bsteals\b/i, 'stole'],
    [/\bends\b/i, 'ended'],
    [/\bgets\b/i, 'got'],
    [/\bfinds\b/i, 'found'],
    [/\btries\b/i, 'tried'],
    [/\breacts\b/i, 'reacted'],
    [/\bsays\b/i, 'said'],
    [/\bbreaks\b/i, 'broke'],
  ] as const) s = s.replace(re, to);
  s = s.replace(/\bis just\b/i, 'is literally').replace(/\bis not\b/i, "isn't");
  s = s.replace(/^(?:the )?undercover cop's name is\s+/i, 'His name is ');
  s = s.replace(/^weenie dog\b/i, 'It');
  s = s.replace(/\s+at the .+$/i, '');
  return s.trim();
};

const withName = (action: string, nick: string) => {
  if (!action) return '';
  if (/^\d/.test(action)) return action;
  if (action.toLowerCase().startsWith(nick.toLowerCase())) return action;
  // A podcast title often already names the show ("... join Trash Taste"). Do not prefix it again.
  if (action.toLowerCase().includes(nick.toLowerCase())) return action;
  if (/^(his|her|its|it's|it|i|we|you|the|they|he|she|this|that|there|someone|everyone|chat)\b/i.test(action)) return action;
  if (/^[A-Z][a-z]+\s+\S+/.test(action) && VERB.test(action.split(/\s+/)[1] ?? '')) return action;
  if (VERB.test(action)) return `${nick} ${action}`;
  return `${nick}'s ${action}`;
};

/** Uppercase one word for emphasis, the way clip channels do. */
const emphasize = (s: string) => {
  const target = /\b(literally|actually|really|instantly|caught|banned|fired|stole|wrong|hates|ended|lost|broke|cancelled|exposed|never|finally|not|isn't|isnt|can't|cant|won't|wont)\b/i.exec(s);
  if (target) return s.replace(target[0], target[0].toUpperCase());
  const words = s.split(/\s+/);
  let best = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/[^\p{L}]/gu, '');
    if (w.length >= 5 && !/^(peanut|xqc|cloakzy|hasan|jynxzi|ron|streamer)$/i.test(w) && (best < 0 || w.length > words[best].replace(/[^\p{L}]/gu, '').length)) best = i;
  }
  if (best >= 0) words[best] = words[best].toUpperCase();
  return words.join(' ');
};

const emojiFor = (text: string) => {
  const t = text.toLowerCase();
  if (/hate|angry|fired|caught|banned|fail|steal|wrong|rage/.test(t)) return '💀';
  if (/laugh|funny|joke|weenie|balloon|yacht|aura|meme|cook/.test(t)) return '😭';
  if (/insane|crazy|shock|unbelievable|no way|speechless/.test(t)) return '😱';
  if (/win|goal|clutch|hype|aura/.test(t)) return '🔥';
  return '💀';
};

const quoteTitle = (quote: string | undefined, emoji: string) => {
  const raw = clean(quote ?? '').replace(/^["“]|["”]$/g, '');
  if (!raw || raw.split(/\s+/).length < 3 || /fuck|shit|bitch|dick|pussy/i.test(raw)) return '';
  const q = raw.charAt(0).toUpperCase() + raw.slice(1);
  const short = q.length > 62 ? q.split(/\s+/).slice(0, 9).join(' ') : q;
  return `"${short.replace(/[.!?]+$/, '')}" ${emoji}`;
};

const curiosityTitle = (action: string, nick: string, emoji: string) => {
  if (!action) return '';
  const base = action.replace(/[.!?]+$/, '');
  if (base.toLowerCase().startsWith(nick.toLowerCase())) return `No way ${base} ${emoji}`;
  if (/^(his|her|it's|it|they|he|she|this|that)\b/i.test(base)) return `No way ${base.charAt(0).toLowerCase()}${base.slice(1)} ${emoji}`;
  if (/^[A-Z][a-z]+\b/.test(base) && !base.toLowerCase().startsWith(nick.toLowerCase())) return `No way ${base} ${emoji}`;
  if (/^\d/.test(base)) return `No way ${base} ${emoji}`;
  if (VERB.test(base)) return `No way ${nick} ${base} ${emoji}`;
  return `No way ${nick}'s ${base} ${emoji}`;
};

const chatTitle = (reason: string | undefined, nick: string, emoji: string) => {
  const r = clean(reason ?? '');
  if (!/chat/i.test(r)) return '';
  if (/typing 1|type 1|prove they served/i.test(r)) return `The chat had to prove they served ${emoji}`;
  if (/fired|o7/i.test(r)) return `Chat declared ${nick} FIRED ${emoji}`;
  if (/reads it|something else|not what you think/i.test(r)) return `The chat knew EXACTLY what it was ${emoji}`;
  return `The chat lost it ${emoji}`;
};

const hookTitle = (hook: string | undefined, title: string, emoji: string) => {
  const h = clean(hook ?? '').replace(/^["“]|["”]$/g, '');
  if (!h || h.split(/\s+/).length < 3 || h.length > 72 || h.toLowerCase() === title.toLowerCase()) return '';
  if (/fuck|shit|bitch|dick|pussy/i.test(h)) return '';
  return `${emphasize(h.replace(/[.!?]+$/, ''))} ${emoji}`;
};

/** Viral clip titles: a short name, a present-tense action, one emphasized word, a reaction emoji. */
export function suggestTitles(o: { title: string; hook?: string; quote?: string; reason?: string; channel?: string }): string[] {
  const title = clean(o.title).slice(0, 100);
  const nick = nickOf(o.channel, title);
  const emoji = emojiFor(`${title} ${o.hook ?? ''} ${o.reason ?? ''}`);
  const colon = /^([^:]{2,20}):\s*(.+)$/.exec(title);
  const action = colon ? clean(colon[2]) : actionOf(title, nick);
  const says = colon && action && action.length <= 72
    ? `${nick} says ${/^(she|he|it|they|we|you|i)\b/i.test(action) ? action.charAt(0).toLowerCase() + action.slice(1) : action}`
    : '';
  const named = says || withName(action, nick);
  const options = [
    named ? `${emphasize(named)} ${emoji}` : '',
    hookTitle(o.hook, title, emoji),
    quoteTitle(o.quote, emoji),
    curiosityTitle(action, nick, emoji),
    chatTitle(o.reason, nick, emoji),
    title,
  ]
    .map((x) => x.trim().slice(0, 100))
    .filter(Boolean);
  const seen = new Set<string>();
  return options.filter((x) => !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).slice(0, 5);
}

/** The video a clip was cut from. */
export interface SourceRef {
  platform?: 'youtube' | 'twitch';
  videoId: string;
  url: string;
  channel: string;
  /** The channel's page, when the ingest has it (YouTube uploader_url or Twitch login). */
  channelUrl?: string;
  /** Twitch login, e.g. "caseoh_". */
  login?: string;
  /** The stream's or video's own title. */
  title?: string;
  game?: string;
}

/** What the posting channel says about itself (`src/core/channel.ts` has the defaults). */
export interface ChannelIdentity {
  name: string;
  disclosure: string;
  removal: string;
}

const isTwitch = (src: SourceRef) => src.platform === 'twitch' || src.videoId.startsWith('tw-');

/** "1h4m12s": how Twitch and YouTube links write a start time. */
export function linkTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}h` : ''}${h || m ? `${m}m` : ''}${s % 60}s`;
}

/** The source video, opened at the moment the clip starts. */
export function sourceLink(src: SourceRef, atMs?: number): string {
  if (atMs === undefined) return src.url;
  return `${src.url}${src.url.includes('?') ? '&' : '?'}t=${isTwitch(src) ? linkTime(atMs) : `${Math.floor(atMs / 1000)}s`}`;
}

/** The on-screen credit: the shortest thing a viewer can type to find the creator. */
export const creditLine = (src: SourceRef) => {
  if (isTwitch(src) && src.login) return `twitch.tv/${src.login}`;
  if (src.channelUrl) return src.channelUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  return `youtube.com/@${(src.channel || 'creator').replace(/\s+/g, '')}`;
};

/** The platform badge that sits before the credit. */
export const creditLabel = (src: SourceRef) => (isTwitch(src) ? '🎮 Twitch' : '▶ YouTube');

/**
 * The credit under every post: the full episode at the second the clip starts, whose clip it is, what
 * it is from, and what this channel is. The link comes first because that is the action; the creator's
 * channel is the second line. The clip is someone else's stream; this is how a viewer gets to them.
 */
export function creditBlock(src: SourceRef, identity: ChannelIdentity, atMs?: number): string {
  const twitch = isTwitch(src);
  const who = src.channel || src.login || 'the creator';
  const home =
    src.channelUrl ??
    (twitch && src.login
      ? `https://www.twitch.tv/${src.login}`
      : !twitch && src.channel
        ? `https://www.youtube.com/@${src.channel.replace(/\s+/g, '')}`
        : undefined);
  const what = [src.title ? `"${clean(src.title).slice(0, 90)}"` : '', src.game ?? ''].filter(Boolean).join(' · ');
  const fill = (line: string) => line.replaceAll('{creator}', who).replaceAll('{name}', identity.name);
  return [
    twitch ? `▶ Watch the full stream from this moment: ${sourceLink(src, atMs)}` : `▶ Full episode from this moment: ${sourceLink(src, atMs)}`,
    `🎥 ${who} on ${twitch ? 'Twitch' : 'YouTube'}${home ? `: ${home}` : ''}`,
    what ? `From ${what}` : '',
    fill(identity.disclosure),
    fill(identity.removal),
  ]
    .filter(Boolean)
    .join('\n');
}

export function suggestPost(o: { title: string; hook?: string; quote?: string; reason?: string; lens?: string; channel?: string; game?: string; source?: SourceRef; identity?: ChannelIdentity; atMs?: number; context?: string }): Post {
  // names in the title ("50 Cent", "Mark Cuban") make the best tags; then the channel, the game and #shorts
  const unquoted = o.title.replace(/(^|[\s:])['‘"“].*?['’"”](?=$|[\s,.!?])/g, ' '); // a quoted line isn't a name
  const names = [...unquoted.matchAll(/(?:[A-Z0-9][\w’']*)(?:\s+[A-Z][\w’']+)+/g)].map((m) => m[0]).filter((n) => n.split(/\s+/).length <= 3);
  const tags = [
    ...names.map(tag),
    ...(o.channel ? [tag(o.channel)] : []),
    ...(o.game ? [tag(o.game)] : []),
    'shorts',
    ...(LENS_TAGS[o.lens ?? ''] ?? ['podcast']),
  ];
  const seen = new Set<string>();
  const hashtags = tags
    .filter((t) => t.length >= 2 && t.length <= 30 && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, 5)
    .map((t) => `#${t}`)
    .join(' ');
  // the line a cold viewer needs, when an expert wrote one; the candidate's reason is the extractor's own note and reads like one
  // an expert writes "the streamer"; a viewer is told who
  const named = (line: string) => line.replace(/\bthe streamer('s)?/gi, (_, s?: string) => `${nickOf(o.channel, o.title)}${s ?? ''}`);
  const context = o.context ? named(clean(o.context)) : o.reason ? firstSentence(o.reason) : '';
  const hook = o.hook && o.hook.toLowerCase() !== o.title.toLowerCase() ? clean(o.hook) : '';
  // with a source, the credit block names the creator; without one, the caption still does
  const credit = o.source && o.identity ? creditBlock(o.source, o.identity, o.atMs) : undefined;
  const caption = [context || hook, !credit && o.channel ? `🎥 ${o.channel}` : ''].filter(Boolean).join('\n');
  const titles = suggestTitles(o);
  return {
    title: titles[0] ?? o.title.slice(0, 100),
    caption,
    ...(credit ? { credit } : {}),
    hashtags,
    titles,
  };
}

/** The post with the editor's overrides applied over the suggestion. */
export const postFor = (override: Partial<Post> | undefined, suggestion: Post): Post => ({
  title: override?.title || suggestion.title,
  caption: override?.caption || suggestion.caption,
  // the credit is not something an edited caption can lose: it is its own part of the post
  ...(override?.credit || suggestion.credit ? { credit: override?.credit || suggestion.credit } : {}),
  hashtags: override?.hashtags || suggestion.hashtags,
  titles: override?.titles ?? suggestion.titles,
});

/** Paste-ready text: caption, the credit, then hashtags. */
export const postBody = (p: Post) => [p.caption, p.credit, p.hashtags].filter(Boolean).join('\n\n');
export const postFile = (p: Post) => `${p.title}\n\n${postBody(p)}\n`;
