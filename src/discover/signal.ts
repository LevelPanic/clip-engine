// The contract for a discovery signal. Each signal is one file in ./signals/ that turns
// the data we already fetched into scored time ranges. Adding one never touches the others.
import type { VideoMeta, Transcript, SponsorSegment, SignalName } from '../core/schemas';
import type { ChatFile } from '../ingest/chat';
import type { ViewerClip } from '../ingest/twitch';

export interface SignalContext {
  meta: VideoMeta;
  transcript?: Transcript;
  info: {
    comments?: { text?: string; like_count?: number; parent?: string }[];
  };
  sponsors: SponsorSegment[];
  /** Stream chat replay (Twitch), for the ranges fetched so far. */
  chat?: ChatFile;
  /** Clips viewers made from this broadcast (Twitch). */
  viewerClips?: ViewerClip[];
}

export interface SignalEvent {
  startMs: number;
  endMs: number;
  weight: number;
}

export interface SignalOutput {
  available: boolean;
  events: SignalEvent[];
  /** Anything worth keeping in signals.json (e.g. the comment hits). */
  extra?: Record<string, unknown>;
}

export interface Signal {
  name: SignalName;
  /** How much this signal counts in the combined score. */
  weight: number;
  /** sum: overlapping events add up (comments, laughs); max: take the strongest (heatmap, teaser). */
  mode: 'sum' | 'max';
  /** Raw value that counts as full strength (1.0); values above are capped. A function gets the
   *  video's highest raw value, so strength can be relative to this video's top moment. */
  saturation: number | ((maxRaw: number) => number);
  compute(ctx: SignalContext): SignalOutput;
  /** One line for a seed or candidate, e.g. "4 timestamped comments (top 174 likes at 14:50)". */
  describe(range: { startMs: number; endMs: number }, out: SignalOutput): string | undefined;
}
