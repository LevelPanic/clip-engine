// [laughter] / [applause] tags that YouTube's auto-captions insert.
import type { Signal } from '../signal';

const REACTION = /laugh|applause|cheer|chuckl/;

const reactionTimes = (tags: { ms: number; tag: string }[] = []) => tags.filter((t) => REACTION.test(t.tag)).map((t) => t.ms);

export const laughter: Signal = {
  name: 'laughter',
  weight: 0.7,
  mode: 'sum',
  saturation: (max) => Math.max(4, 0.6 * max), // relative to this video's funniest stretch
  compute({ transcript }) {
    const times = reactionTimes(transcript?.tags);
    return {
      available: times.length > 0,
      // Laughter marks the payoff; the setup comes before it.
      events: times.map((ms) => ({ startMs: ms - 25_000, endMs: ms + 3_000, weight: 1 })),
      extra: { times },
    };
  },
  describe(r, out) {
    const n = ((out.extra?.times as number[]) ?? []).filter((ms) => ms >= r.startMs && ms <= r.endMs).length;
    if (n) return `${n} laugh/applause tag${n > 1 ? 's' : ''}`;
  },
};
