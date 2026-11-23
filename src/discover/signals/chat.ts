// Stream chat: where chat spikes above the channel's normal level, and what kind of reaction it was.
// The strongest signal on Twitch (what Eklipse, Powder and Twitch's own auto clips lean on). Chat
// reacts late, so the event covers the 25 s before the spike.
import type { Signal } from '../signal';
import { findChatSpikes, LEAD_MS, type ChatSpike } from '../chatAnalysis';

export const chat: Signal = {
  name: 'chat',
  weight: 1.2,
  mode: 'max',
  saturation: (max) => Math.max(1.5, 0.7 * max), // relative to this stream's biggest spike
  compute({ meta, chat }) {
    if (!chat || chat.disabled || !chat.fetched.length) return { available: false, events: [] };
    const spikes = findChatSpikes(chat.messages, chat.fetched, meta.durationMs);
    return {
      available: true,
      events: spikes.map((s) => ({
        startMs: s.startMs - LEAD_MS,
        endMs: s.endMs + 3_000,
        // log2 of how far above normal (2.2× → 1.1, 8× → 3), a bit more when people ask for a clip
        // a raid makes chat busy without a moment on stream: it barely counts
        weight: Math.min(4, Math.log2(s.ratio)) * (s.clipRequests >= 3 ? 1.3 : 1) * (s.raid ? 0.15 : 1),
      })),
      extra: { spikes },
    };
  },
  describe(r, out) {
    const spikes = ((out.extra?.spikes as ChatSpike[]) ?? []).filter((s) => s.startMs - LEAD_MS <= r.endMs && s.endMs >= r.startMs);
    if (!spikes.length) return;
    const s = spikes.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    const bits = [`chat ${s.ratio.toFixed(1)}× normal (${s.chatters} chatters in 10 s)`];
    if (s.raid) bits.push('a raid (another channel arriving), probably not a moment');
    else if (s.reaction) bits.push(`mostly ${s.reaction}`);
    const short = (t: string) => (t.length > 32 ? `${t.slice(0, 30)}…` : t);
    if (s.top.length) bits.push(s.top.slice(0, 3).map((t) => `"${short(t.text)}" ×${t.count}`).join(', '));
    if (s.clipRequests >= 2) bits.push(`${s.clipRequests} asked to clip it`);
    return bits.join(' · ');
  },
};
