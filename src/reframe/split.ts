// Detect a clip's facecam and switch it to the split layout (facecam on top, gameplay below).
// Used by `clip split`, the Studio's "Find facecam" button, and automatically for new Twitch clips
// (autoSplit in project.json). It needs the clip's footage, so it downloads the section if missing.
import { categoryAt, loadProject, saveProject } from '../project';
import { captionPositionForSplit, contentFitFor } from '../core/layout';
import { resolveMedia, SECTION_MARGIN_MS, type ResolvedMedia } from '../ingest/media';
import { downloadSections } from '../ingest/downloads';
import { detectFaces } from './faces';
import { detectFacesInsight } from './insightface';
import { detectFacesHybrid } from './hybrid';
import { findFacecam, layoutForCam } from './cam';
import { refinePanel } from './panel';
import type { SplitLayout } from '../core/schemas';
import { setting } from '../core/config';

export interface SplitReport {
  found: boolean;
  auto: boolean;
  samples: number;
  faces: number;
  split?: SplitLayout;
  reason?: string;
}

// The whole clip, not its first 30 s: a facecam that is there at the start and gone by the middle
// (a scene change, the streamer walking off, a cam that is someone else's) is not this clip's facecam.
const DETECT_MS = 90_000;
const SAMPLES = 60;

export async function detectSplit(
  clipId: string,
  opts: {
    auto?: boolean;
    log?: (s: string) => void;
    media?: ResolvedMedia;
    /** An original-format cut of this clip. When given, detection runs on that file (per clip). */
    file?: string;
    fileDurationMs?: number;
    detector?: 'hybrid' | 'insightface' | 'vision';
  } = {},
): Promise<SplitReport> {
  const log = opts.log ?? (() => {});
  let p = loadProject(clipId);
  if (opts.auto && (!p.autoSplit || p.framing.mode !== 'blur')) {
    return { found: false, auto: true, samples: 0, faces: 0, reason: 'no automatic split pending' };
  }
  const env = setting('CLIP_FACE_DETECTOR');
  const detector = opts.detector ?? (env === 'vision' || env === 'insightface' ? env : 'hybrid');
  const detect = async (file: string, startMs: number, endMs: number) => {
    // about 60 samples whatever the length: 2 a second for a 30 s clip (as before), spread thinner over a
    // longer one, so reading the whole clip costs no more than reading its first 30 s did
    const fps = Math.max(0.5, Math.min(2, SAMPLES / Math.max(1, (endMs - startMs) / 1000)));
    if (detector === 'vision') return detectFaces(file, startMs, endMs, fps);
    if (detector === 'insightface') {
      try {
        return await detectFacesInsight(file, startMs, endMs, fps);
      } catch (e) {
        log(`InsightFace unavailable (${(e as Error).message.split('\n')[0]}); using Apple Vision`);
        return detectFaces(file, startMs, endMs, fps);
      }
    }
    try {
      return await detectFacesHybrid(file, startMs, endMs, fps);
    } catch (e) {
      log(`face detector unavailable (${(e as Error).message.split('\n')[0]}); using Apple Vision`);
      return detectFaces(file, startMs, endMs, fps);
    }
  };
  const seg = p.segments[0];
  let res;
  let detectFile = '';
  let detectStart = 0;
  let detectEnd = 0;
  if (opts.file) {
    log('looking for the facecam in the clip…');
    detectFile = opts.file;
    detectStart = 0;
    detectEnd = Math.min(DETECT_MS, opts.fileDurationMs ?? DETECT_MS);
    res = await detect(detectFile, detectStart, detectEnd);
  } else {
    const endMs = Math.min(seg.endMs, seg.startMs + DETECT_MS);
    let media = opts.media ?? resolveMedia(p.videoId, seg.startMs, endMs);
    if (!media) {
      log('downloading the footage for this clip…');
      await downloadSections(p.videoId, [{ startMs: seg.startMs - SECTION_MARGIN_MS, endMs: Math.min(p.sourceDurationMs, endMs + SECTION_MARGIN_MS) }], log);
      media = resolveMedia(p.videoId, seg.startMs, endMs);
      if (!media) throw new Error(`Couldn't get footage for ${clipId}`);
    }
    log('looking for the facecam…');
    // the tool works in file time; sections start at media.offsetMs
    detectFile = media.file;
    detectStart = seg.startMs - media.offsetMs;
    detectEnd = endMs - media.offsetMs;
    res = await detect(detectFile, detectStart, detectEnd);
  }
  let split = findFacecam(res);
  if (split) {
    try {
      const refined = await refinePanel(res, detectFile, detectStart, detectEnd, split.cam);
      if (refined) {
        split = layoutForCam(res, refined); // the band follows the refined panel's shape
        log('snapped the cam panel to its borders');
      }
    } catch (e) {
      log(`panel refinement skipped (${(e as Error).message.split('\n')[0]})`);
    }
  }

  p = loadProject(clipId); // re-read: a scan or an edit may have landed while we were detecting
  if (split) {
    // a game is cropped to cover its band; a website, desktop or room is shown whole (src/core/layout.ts)
    const category = categoryAt(p.videoId, seg.startMs);
    split = { ...split, content: contentFitFor(category) };
    log(`${category ?? 'no category'}: ${split.content === 'fit' ? 'the whole frame under the cam' : 'the game cropped to fill the band'}`);
    p.framing = { ...p.framing, mode: 'split', split };
    // a new clip's captions move under a whole-frame plate; a position someone chose is left alone
    const under = captionPositionForSplit(split, res.width, res.height);
    if (opts.auto && under !== undefined) p.captions = { ...p.captions, position: under };
    delete p.autoSplit;
    saveProject(p);
    return { found: true, auto: !!opts.auto, samples: res.samples.length, faces: res.samples.filter((s) => s.faces.length).length, split };
  }
  if (p.autoSplit) {
    delete p.autoSplit; // one automatic try is enough; "Find facecam" can try again by hand
    saveProject(p);
  }
  return { found: false, auto: !!opts.auto, samples: res.samples.length, faces: res.samples.filter((s) => s.faces.length).length, reason: 'no stable facecam in the clip' };
}
