// SponsorBlock: community-marked sponsor reads, intros, teasers and highlights.
import type { SponsorSegment } from '../core/schemas';

const CATEGORIES = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'preview', 'filler', 'poi_highlight'];

/** Categories no clip should overlap. ("filler" is often the funny tangent, so it stays clippable.) */
// 'muted' is a Twitch stretch silenced for copyrighted music: no sound, so never a clip
export const EXCLUDED_CATEGORIES = new Set(['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'preview', 'muted']);

export async function fetchSponsorBlock(videoId: string): Promise<SponsorSegment[]> {
  const url =
    `https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(videoId)}` +
    `&categories=${encodeURIComponent(JSON.stringify(CATEGORIES))}` +
    `&actionTypes=${encodeURIComponent(JSON.stringify(['skip', 'mute', 'poi', 'full']))}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as { segment: [number, number]; category: string }[];
    return rows
      .map((r) => ({
        startMs: Math.round(r.segment[0] * 1000),
        endMs: Math.round(r.segment[1] * 1000),
        category: r.category,
      }))
      .sort((a, b) => a.startMs - b.startMs);
  } catch (e) {
    console.warn(`SponsorBlock unavailable (${(e as Error).message}); continuing without it`);
    return [];
  }
}
