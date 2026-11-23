// Who is posting. The clips are other people's streams, so the channel says what it is (an automated
// clipper that promotes the creators it clips), and every post says whose clip it is and where it is
// from. `channel.json` next to library/ overrides the defaults; nothing in it is secret. Node only.
import path from 'node:path';
import { z } from 'zod';
import { DATA, paths, readJsonIf } from './paths';

export const ChannelSchema = z.object({
  /** The channel's own name, as it appears in the line about what the channel is. */
  name: z.string().default('Clip Engine'),
  /** What the channel is, under every post. {name} and {creator} are filled in. */
  disclosure: z.string().default('🤖 {name} finds and cuts moments from public streams and videos with software, to send viewers to the creator. Not affiliated with {creator}.'),
  /** How a creator gets a clip changed or taken down. Put a contact here if you have one. */
  removal: z.string().default('Creators: message this channel and the clip is changed or removed.'),
  /** Name the creator on screen for the whole clip. QA fails an export that does not. */
  creditOnScreen: z.boolean().default(true),
  /** Creators who asked not to be clipped: Twitch logins or channel names. Nothing of theirs is scanned, made or posted. */
  doNotClip: z.array(z.string()).default([]),
  /**
   * A careful period: until this date the upload scheduler posts only the cleanest approvals and holds
   * the rest until it ends (`carefulReasons`, src/qa/unsafe.ts). Set after YouTube removed two videos
   * (docs/research/censorship-review-2026-11-22.md, C5). Remove it, or move the date, to end it sooner or later.
   */
  careful: z.object({ until: z.string(), why: z.string().optional() }).optional(),
});
export type Channel = z.infer<typeof ChannelSchema>;

export const channelFile = () => path.join(DATA, 'channel.json');
export const loadChannel = (): Channel => ChannelSchema.parse(readJsonIf(channelFile()) ?? {});

/** The careful period's end while it is on (an ISO date or time), else undefined. */
export function carefulUntil(channel: Channel = loadChannel(), now = Date.now()): string | undefined {
  const until = channel.careful?.until;
  return until && Date.parse(until) > now ? until : undefined;
}

const plain = (name: string) => name.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '');

/** The entry on the do-not-clip list that this creator matches, if any. */
export function optedOut(meta: { login?: string; channel?: string } | undefined, channel: Channel = loadChannel()): string | undefined {
  if (!meta || !channel.doNotClip.length) return undefined;
  const names = [meta.login, meta.channel].filter((x): x is string => !!x).map(plain);
  return channel.doNotClip.find((x) => names.includes(plain(x)));
}

export const optedOutVideo = (videoId: string) => optedOut(readJsonIf<{ login?: string; channel?: string }>(paths.videoFile(videoId, 'meta.json')));

/**
 * Why this export may not be posted as it is, or undefined. An export goes out only if it was rendered
 * with the creator's name on screen (the render report says so). A QA report from before the rule
 * existed cannot wave it through, and neither can --force: the way to post without a credit is to turn
 * `creditOnScreen` off in channel.json, on purpose.
 */
export function uncredited(clipId: string, channel: Channel = loadChannel()): string | undefined {
  if (!channel.creditOnScreen) return undefined;
  const rendered = readJsonIf<{ credit?: boolean }>(path.join(paths.exports, `${clipId}.json`));
  return rendered?.credit ? undefined : `${clipId} was rendered without the creator's name on screen: \`clip credit ${clipId}\`, then \`clip render ${clipId}\``;
}

/** A promoter that keeps clipping someone who said no is not one. This is not overridable with --force. */
export const doNotClipError = (who: string) => new Error(`${who} asked not to be clipped (channel.json → doNotClip): nothing of theirs is scanned, made into a clip or posted`);

