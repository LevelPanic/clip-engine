// Topics: besides the creators in channels.json, the watchlist follows games and categories that are
// trending (topics.json: GTA 6, Fortnite, League of Legends…). Every check reads every topic's
// most-watched English streams in its Twitch category and takes each topic's top 3 eligible streams
// into the tracker (docs/research/stream-pipeline-spec-2026-11-19.md, section 4.2). The tracker decides what
// is clipped, moment by moment, after the listed creators.
//
// Nothing is done twice:
//   - a streamer in channels.json does not take a topic's place: the creator check already has them;
//   - a stream already tracked still counts toward its topic's 3, and taking it again is a no-op (the
//     tracker keys streams by broadcast id and adds the topic to its sources);
//   - one channel found under two topics counts once, under the topic where it has more viewers.
//
// YouTube is used for trend research (`clip topics --suggest --youtube`), not for scans: a YouTube
// live stream can only be ingested whole, and the stream pipeline reads ranges.
import path from 'node:path';
import { z } from 'zod';
import { paths, readJsonIf } from '../core/paths';
import { run, YTDLP } from '../core/proc';
import type { CategoryStream } from '../ingest/twitch';
import { setting } from '../core/config';

export const TopicSchema = z.object({
  /** What the topic is called here and in the logs. */
  name: z.string().min(1),
  /** The Twitch category, exactly as Twitch names it ("Grand Theft Auto VI"). */
  twitch: z.string().min(1),
  /** What to search on YouTube for this topic (research only). */
  youtube: z.string().optional(),
  /** A stream with fewer viewers is not read: a small chat makes the moment detection guess. */
  minViewers: z.number().int().min(0).default(2000),
  /** Weight against the other topics when choosing the one stream to scan (1 = normal). */
  priority: z.number().min(0).default(1),
  enabled: z.boolean().default(true),
  /** Twitch logins never to take from this topic (official broadcasts, restreams). */
  skip: z.array(z.string()).default([]),
});
export type Topic = z.infer<typeof TopicSchema>;

export const topicsFile = () => path.join(paths.root, 'topics.json');
/** The topics in topics.json (none when the file is missing). */
export function loadTopics(file = topicsFile()): Topic[] {
  const raw = readJsonIf<unknown[]>(file) ?? [];
  return raw.map((t) => TopicSchema.parse(t));
}

/** Categories that are not one game: their streams are anything at all, and the creator list covers them. Gambling is never clipped. */
export const NOT_A_TOPIC = new Set(
  ['Just Chatting', 'IRL', 'Special Events', 'Music', 'ASMR', 'Art', 'Pools, Hot Tubs, and Beaches', 'Talk Shows & Podcasts', 'Slots', 'Virtual Casino', 'Poker', 'Sports', 'Travel & Outdoors', 'Watch Party'].map((s) =>
    s.toLowerCase(),
  ),
);

/** Restream and VOD channels replay old broadcasts: not a live moment, and not the creator's own channel. */
const REPLAY_LOGIN = /(^|_)(vods?|reruns?|replays?|clips|archive)$/i;

export interface TopicCandidate extends CategoryStream {
  topic: string;
}

export interface TopicSkip {
  topic: string;
  login: string;
  viewers: number;
  why: string;
}

/** How many streams each topic takes into the tracker per check. */
export const TOPIC_TOP = setting('TOPIC_TOP');

/**
 * Each topic's top `perTopic` eligible streams right now, and why every other one was passed over. Pure.
 *   watched   — Twitch logins in channels.json: in through the creator check, so they never take a
 *               topic's place (the topic's 3 are what topics add on top)
 *   optedOut  — logins that asked not to be clipped (channel.json → doNotClip)
 *   unusable  — broadcasts the tracker skipped (subscriber-only, gone…), with why: the next stream
 *               takes the place
 */
export function topicPicks(
  topics: Topic[],
  found: TopicCandidate[],
  ctx: { watched: Set<string>; optedOut: (login: string) => boolean; unusable?: Map<string, string> },
  perTopic = TOPIC_TOP,
): { picks: TopicCandidate[]; skipped: TopicSkip[] } {
  const byName = new Map(topics.map((t) => [t.name, t]));
  const skipped: TopicSkip[] = [];
  const picks: TopicCandidate[] = [];
  const taken = new Map<string, number>();
  const seenLogin = new Set<string>();
  // most-watched first, so a channel listed under two topics is judged once, under its bigger one
  for (const s of [...found].sort((a, b) => b.viewers - a.viewers)) {
    const t = byName.get(s.topic);
    const login = s.login.toLowerCase();
    if (!t || !t.enabled) continue;
    const skip = (why: string) => skipped.push({ topic: s.topic, login: s.login, viewers: s.viewers, why });
    if (seenLogin.has(login)) {
      skip('already a candidate under another topic');
      continue;
    }
    seenLogin.add(login);
    const gone = s.vodId ? ctx.unusable?.get(`tw-${s.vodId}`) : undefined;
    if (s.viewers < t.minViewers) skip(`${s.viewers} viewers, under ${t.minViewers}`);
    else if (ctx.watched.has(login)) skip('a listed creator (channels.json): in through the creator check, not one of the topic\'s places');
    else if (t.skip.some((x) => x.toLowerCase() === login)) skip(`on the ${t.name} skip list`);
    else if (ctx.optedOut(login)) skip('asked not to be clipped (doNotClip)');
    else if (s.type !== 'live' || REPLAY_LOGIN.test(login)) skip('a rerun or replay channel');
    else if (!s.vodId || !s.recording) skip('no VOD being recorded: nothing to scan');
    else if (gone) skip(`skipped before: ${gone}`);
    else if ((taken.get(t.name) ?? 0) >= perTopic) skip(`not in ${t.name}'s top ${perTopic}`);
    else {
      taken.set(t.name, (taken.get(t.name) ?? 0) + 1);
      picks.push(s);
    }
  }
  return { picks, skipped };
}

/** Live YouTube streams for a search, most-watched first (research: where a topic is big on YouTube). */
export async function youtubeLive(search: string, limit = 10): Promise<{ id: string; title: string; channel: string; viewers: number; verified: boolean }[]> {
  const [cmd, base] = YTDLP;
  // sp=EgJAAQ== is YouTube's "Live" search filter
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(search)}&sp=EgJAAQ%253D%253D`;
  const r = await run(cmd, [...base, '--flat-playlist', '--playlist-end', String(limit), '--print', '%(id)s\t%(concurrent_view_count)s\t%(channel_is_verified)s\t%(channel)s\t%(title)s', url]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').pop() ?? `yt-dlp exit ${r.code}`);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [id, v, verified, channel, ...t] = l.split('\t');
      return { id, viewers: Number(v) || 0, verified: verified === 'True', channel, title: t.join('\t') };
    })
    .filter((x) => /^[\w-]{11}$/.test(x.id))
    .sort((a, b) => b.viewers - a.viewers);
}
