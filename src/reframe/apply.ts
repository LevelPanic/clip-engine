// Auto-reframe: track faces and add reframe markers so the 9:16 crop follows the subject, for the
// whole clip or just a range (e.g. the stretch where the facecam matters). Inside the range the clip
// is cropped to the face (cuts on source cuts and speaker switches, short pans otherwise); at the end
// of the range it returns to whatever framing was there before. Base framing is never changed, so
// rejecting the proposals undoes it completely.
import { loadProject, saveProject, newMarkerId } from '../core/project';
import { resolveMedia, SECTION_MARGIN_MS } from '../ingest/media';
import { downloadSections } from '../jobs/downloads';
import { detectFaces } from './faces';
import { planReframe, PAN_MS } from './auto';
import { framingKeys, framingAt } from '../markers/define';
import { loadMarkerSchemas } from '../markers/registry-node';
import type { Marker } from '../core/schemas';

export async function autoReframe(clipId: string, opts: { accept?: boolean; range?: { startMs: number; endMs: number }; log?: (s: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const p = loadProject(clipId);
  const seg = p.segments[0];
  const range = {
    startMs: Math.max(seg.startMs, Math.round(opts.range?.startMs ?? seg.startMs)),
    endMs: Math.min(seg.endMs, Math.round(opts.range?.endMs ?? seg.endMs)),
  };
  if (range.endMs - range.startMs < 500) throw new Error('select at least half a second to reframe');

  // Twitch whole-clip reframes prefer the split layout: a facecam is a corner box, not a subject to
  // follow with a crop. Select a span to get the crop-follows-speaker behaviour inside it.
  if (opts.range === undefined && p.videoId.startsWith('tw-')) {
    if (p.framing.mode === 'split') return { keyframes: 0, cuts: 0, faces: 0, samples: 0, range, split: true };
    const { detectSplit } = await import('./split');
    const r = await detectSplit(clipId, { log });
    if (r.found) return { keyframes: 0, cuts: 0, faces: r.faces, samples: r.samples, range, split: true };
  }

  let media = resolveMedia(p.videoId, range.startMs, range.endMs);
  if (!media) {
    log('downloading the footage for this clip…');
    await downloadSections(p.videoId, [{ startMs: seg.startMs - SECTION_MARGIN_MS, endMs: seg.endMs + SECTION_MARGIN_MS }], log);
    media = resolveMedia(p.videoId, range.startMs, range.endMs);
    if (!media) throw new Error('no footage for this clip');
  }
  log('tracking faces…');
  // the tool works in file time; sections start at media.offsetMs
  const res = await detectFaces(media.file, range.startMs - media.offsetMs, range.endMs - media.offsetMs, 5);
  const shifted = {
    ...res,
    samples: res.samples.map((s) => ({ ...s, ms: s.ms + media!.offsetMs })),
    cuts: res.cuts?.map((c) => c + media!.offsetMs),
  };
  const keys = planReframe(shifted, { zoom: p.framing.zoom });
  if (!keys.length) throw new Error('no faces found in this range');

  // drop earlier auto-reframes inside the range (hand-placed reframes stay)
  const inRange = (m: Marker) => m.type === 'reframe' && m.source === 'auto-reframe' && m.startMs >= range.startMs && m.startMs <= range.endMs;
  const others = p.markers.filter((m) => !inRange(m));

  // what the framing is just after the range, so the clip can go back to it
  const types = await loadMarkerSchemas();
  const after = framingAt(framingKeys(others, (t) => types.get(t)), p.framing, range.endMs);

  const mk = (atMs: number, params: Record<string, unknown>): Marker => ({
    id: newMarkerId(),
    type: 'reframe',
    startMs: Math.round(atMs),
    params,
    ...(opts.accept ? {} : { proposed: true }),
    source: 'auto-reframe',
  });
  const reframes: Marker[] = keys.map((k, i) =>
    mk(i === 0 ? range.startMs : k.atMs, { mode: 'crop', cropX: Math.round(k.cropX * 1000) / 1000, easeMs: k.cut || i === 0 ? 0 : PAN_MS }),
  );
  if (range.endMs < seg.endMs - 100) reframes.push(mk(range.endMs, { mode: after.mode === 'cam' || after.mode === 'game' ? 'split' : after.mode, cropX: Math.round(after.cropX * 1000) / 1000, easeMs: 0 }));

  p.markers = [...others, ...reframes].sort((a, b) => a.startMs - b.startMs);
  saveProject(p);
  return { keyframes: reframes.length, cuts: keys.filter((k) => k.cut).length, faces: res.samples.filter((s) => s.faces.length).length, samples: res.samples.length, range };
}
