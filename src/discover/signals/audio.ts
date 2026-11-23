// Laughs, cheers and shouts heard in the audio itself (Apple's SoundAnalysis classifier, saved to
// audio-events.json by `analyzeAudioEvents`). Unlike caption [laughter] tags, it works on every video.
import type { Signal } from '../signal';
import { paths, readJsonIf } from '../../core/paths';
import type { AudioEventsFile } from '../../ingest/audioEvents';

export type ReactionKind = 'laugh' | 'cheer' | 'shout';
type Kind = ReactionKind;

// Tuned on a 2 h comedy podcast (158 caption [laughter] tags) and a 2 h gaming livestream (none):
// - laugh ≥ 0.5: 82% of caption laughs have a detection within ±5 s (21% by chance), 7% of
//   detections have no caption laugh nearby, per-minute correlation with the captions 0.87.
//   0.4 gains 3 points of recall for 50% more unmatched detections. The sub-labels never fired
//   without `laughter` itself; they stay in case a later classifier version splits them.
// - shout ≥ 0.6: on the livestream 33% of timestamped comments have a shout/scream from 30 s
//   before to 10 s after (16% by chance); on the podcast only 4 stray hits. battle_cry was noise.
// - cheer ≥ 0.6: neither video has an audience, so this is unvalidated; it stayed quiet on both.
// - gasp and booing fired on breaths and low voices, unrelated to captions or comments: left out.
// Shouts weigh less because they're half as specific as laughs (2× vs 3.4× over chance).
export const REACTION_KINDS: Record<Kind, { labels: string[]; threshold: number; weight: number }> = {
  laugh: { labels: ['laughter', 'belly_laugh', 'giggling', 'chuckle_chortle', 'snicker'], threshold: 0.5, weight: 1 },
  cheer: { labels: ['applause', 'cheering', 'clapping', 'crowd'], threshold: 0.6, weight: 1 },
  shout: { labels: ['screaming', 'shout', 'yell', 'children_shouting'], threshold: 0.6, weight: 0.6 },
};
// A single window (0.75 s hop) below this confidence counts half: on the podcast 20% of those had
// no caption laugh nearby, against 1% of longer or stronger detections.
export const LONE_STRONG = 0.8;

export interface AudioDetection {
  kind: Kind;
  startMs: number;
  endMs: number;
  peak: number;
  windows: number;
}

/**
 * One detection per run of consecutive windows, so a long laugh counts once. This is the only place raw
 * classifier events become reactions: everything that asks "did someone laugh or shout here?" (queues,
 * extraction windows, editors, subtitles) goes through it, so they all use the tuned thresholds above
 * and none of them counts the labels left out as noise (gasp, booing, battle_cry).
 */
export function detectReactions(data: Pick<AudioEventsFile, 'events' | 'windowMs' | 'hopMs'>): AudioDetection[] {
  const out: AudioDetection[] = [];
  for (const [kind, { labels, threshold }] of Object.entries(REACTION_KINDS) as [Kind, (typeof REACTION_KINDS)[Kind]][]) {
    const best = new Map<number, number>(); // window start → strongest label of this kind
    for (const e of data.events)
      if (e.confidence >= threshold && labels.includes(e.label)) best.set(e.ms, Math.max(best.get(e.ms) ?? 0, e.confidence));
    let cur: AudioDetection | undefined;
    for (const ms of [...best.keys()].sort((a, b) => a - b)) {
      // allow one missed window inside a laugh
      if (cur && ms - (cur.endMs - data.windowMs) <= 2 * data.hopMs) {
        cur.endMs = ms + data.windowMs;
        cur.peak = Math.max(cur.peak, best.get(ms)!);
        cur.windows++;
      } else out.push((cur = { kind, startMs: ms, endMs: ms + data.windowMs, peak: best.get(ms)!, windows: 1 }));
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** A single weak window is half a witness; anything longer or stronger is a full one. */
export const reactionWeight = (d: Pick<AudioDetection, 'windows' | 'peak'>) => (d.windows === 1 && d.peak < LONE_STRONG ? 0.5 : 1);

/** The reactions in library/<id>/audio-events.json, or none when the audio hasn't been analysed. */
export function loadReactions(videoId: string): { detections: AudioDetection[]; covered?: { startMs: number; endMs: number }[]; analysed: boolean } {
  const data = readJsonIf<AudioEventsFile>(paths.videoFile(videoId, 'audio-events.json'));
  if (!data) return { detections: [], analysed: false };
  return { detections: detectReactions(data), covered: data.covered, analysed: true };
}

const NOUN: Record<Kind, [string, string]> = { laugh: ['laugh', 'laughs'], cheer: ['cheer', 'cheers'], shout: ['shout', 'shouts'] };

export const audio: Signal = {
  name: 'audio',
  weight: 0.6,
  mode: 'sum',
  saturation: (max) => Math.max(4, 0.6 * max), // relative to this video's liveliest stretch, like laughter
  compute({ meta }) {
    const data = readJsonIf<AudioEventsFile>(paths.videoFile(meta.id, 'audio-events.json'));
    if (!data) return { available: false, events: [] };
    const detections = detectReactions(data);
    return {
      available: true,
      // A reaction marks the payoff; the setup comes before it.
      events: detections.map((d) => ({
        startMs: d.startMs - 25_000,
        endMs: d.endMs + 3_000,
        weight: REACTION_KINDS[d.kind].weight * reactionWeight(d),
      })),
      extra: { detections },
    };
  },
  describe(r, out) {
    const ds = ((out.extra?.detections as AudioDetection[]) ?? []).filter((d) => d.endMs >= r.startMs && d.startMs <= r.endMs);
    const parts = (Object.keys(NOUN) as Kind[])
      .map((k) => [k, ds.filter((d) => d.kind === k).length] as const)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${NOUN[k][n > 1 ? 1 : 0]}`);
    if (!parts.length) return;
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
    return `${list} heard in the audio`;
  },
};
