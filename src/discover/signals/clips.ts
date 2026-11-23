// Viewer clips: where viewers clipped the stream, weighted by views. Twitch's answer to YouTube's
// "Most Replayed". Clip titles are viewers' own one-line summary of the moment, so they're shown.
import type { Signal } from '../signal';
import { clipSpan, type ViewerClip } from '../../ingest/twitch';

export const clips: Signal = {
  name: 'clips',
  weight: 1.0,
  mode: 'sum',
  saturation: (max) => Math.max(2, 0.5 * max),
  compute({ viewerClips }) {
    if (!viewerClips) return { available: false, events: [] };
    return {
      available: viewerClips.length > 0,
      // a clip with a handful of views still says someone thought it worth clipping; views add from there
      // (1 view 0.55, 100 views 1.4, 10k views 2.4)
      // the offset is an anchor near the moment, not the clip's start (see clipSpan)
      events: viewerClips.map((c) => ({ ...clipSpan(c), weight: 0.4 + Math.log10(c.views + 1) / 2 })),
      extra: { clips: viewerClips },
    };
  },
  describe(r, out) {
    const hit = ((out.extra?.clips as ViewerClip[]) ?? []).filter((c) => clipSpan(c).startMs < r.endMs && clipSpan(c).endMs > r.startMs).sort((a, b) => b.views - a.views);
    if (!hit.length) return;
    const top = hit[0];
    return `viewers clipped it${hit.length > 1 ? ` ${hit.length}×` : ''}: "${top.title}" (${top.views.toLocaleString('en-US')} views${top.exact ? '' : ', position estimated'})`;
  },
};
