// Edit suggestions the engine can make on its own. They're added as *proposed* markers: dashed in
// the Studio, previewed, but never rendered until accepted.
import { paths, readJsonIf } from '../core/paths';
import type { Project, Marker, Transcript } from '../core/schemas';
import { newMarkerId } from '../project';
import { loadMarkerSchemas } from '../markers/registry-node';

interface AudioEventsFile {
  events: { ms: number; label: string; confidence: number }[];
}

/** Jump cuts on dead air: gaps between words longer than `minGapMs`, keeping `keepMs` of breath at
 *  each side. Gaps with laughter (caption tag or heard in the audio) are kept: that's the payoff. */
export async function suggestSilenceCuts(p: Project, opts: { minGapMs?: number; keepMs?: number } = {}): Promise<Marker[]> {
  const minGap = opts.minGapMs ?? 700;
  const keep = opts.keepMs ?? 120;
  const t = readJsonIf<Transcript>(paths.videoFile(p.videoId, 'transcript.json'));
  if (!t) throw new Error('No transcript for this video');
  const ae = readJsonIf<AudioEventsFile>(paths.videoFile(p.videoId, 'audio-events.json'));
  const laughs = [
    ...t.tags.filter((g) => /laugh|applause|cheer/.test(g.tag)).map((g) => g.ms),
    ...(ae?.events ?? []).filter((e) => /laugh|cheer|applause/.test(e.label) && e.confidence >= 0.5).map((e) => e.ms + 750),
  ];
  const seg = p.segments[0];
  const words = t.words.filter((w) => w.endMs > seg.startMs && w.startMs < seg.endMs);
  const existing = p.markers.filter((m) => m.type === 'cut');
  const cutDefaults = (await loadMarkerSchemas()).get('cut')!.params.parse({}) as Record<string, unknown>;
  const out: Marker[] = [];
  const consider = (gapStart: number, gapEnd: number) => {
    if (gapEnd - gapStart < minGap) return;
    const s = Math.round(gapStart + keep);
    const e = Math.round(gapEnd - keep);
    if (e - s < 200) return;
    if (laughs.some((ms) => ms >= gapStart - 500 && ms <= gapEnd + 500)) return;
    if (existing.some((m) => m.startMs < e && (m.endMs ?? m.startMs) > s)) return;
    out.push({ id: newMarkerId(), type: 'cut', startMs: s, endMs: e, params: cutDefaults, proposed: true, source: 'silence' });
  };
  // dead air at the very start/end of the clip too
  if (words.length) consider(seg.startMs - keep, words[0].startMs);
  for (let k = 0; k + 1 < words.length; k++) consider(words[k].endMs, words[k + 1].startMs);
  if (words.length) consider(words[words.length - 1].endMs, seg.endMs + keep);
  return out;
}
