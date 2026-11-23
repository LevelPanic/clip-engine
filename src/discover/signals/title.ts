// The title promises a moment; find where its rarer words are actually said.
// Caveat from testing: a title can point at the sponsor read, which the sponsor filter removes.
import type { Signal } from '../signal';

const STOP = new Set(
  'the and with from that this what when your about have will just into they them their there were been more most than then also only over very after before because could would should which while where who why how our out its it\'s his her him she he you are was for not but all any can did does done get got has had let may new now off old one own say says said see two way yes full episode podcast interview video talks reveals explains reaction react live show part clip shorts official'.split(
    ' ',
  ),
);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']/g, '').replace(/'s$/, '');

export const title: Signal = {
  name: 'title',
  weight: 0.3,
  mode: 'max',
  saturation: 1,
  compute({ meta, transcript }) {
    if (!transcript) return { available: false, events: [] };
    // names in the title ("Linda Cardellini", "Mark Cuban", "Prof Robert Pape") and the channel are who
    // the video is about, said all through it; they don't point at a moment
    const names = new Set(
      [...meta.title.matchAll(/[A-Z][\w’']+(?:\s+[A-Z][\w’']+)+/g), ...meta.channel.matchAll(/[\w’']+/g)]
        .flatMap((m) => m[0].split(/\s+/))
        .map(norm),
    );
    const terms = [...new Set(meta.title.split(/[\s,|:;!?()"“”]+/).map(norm))].filter((t) => t.length >= 5 && !STOP.has(t) && !names.has(t));
    const at = new Map<string, number[]>();
    for (const w of transcript.words) {
      const t = norm(w.text);
      if (terms.includes(t)) at.set(t, [...(at.get(t) ?? []), w.startMs]);
    }
    const events: { startMs: number; endMs: number; weight: number; term: string }[] = [];
    for (const [term, times] of at) {
      if (times.length > 6) continue; // said all the time: not a pointer
      const weight = times.length <= 3 ? 1 : 0.6;
      for (const ms of times) events.push({ startMs: ms - 20_000, endMs: ms + 25_000, weight, term });
    }
    return { available: events.length > 0, events, extra: { terms } };
  },
  describe(r, out) {
    const terms = new Set(
      (out.events as { startMs: number; endMs: number; term?: string }[])
        .filter((e) => e.startMs + 20_000 >= r.startMs && e.startMs + 20_000 <= r.endMs)
        .map((e) => e.term),
    );
    if (terms.size) return `title words said here: ${[...terms].join(', ')}`;
  },
};
