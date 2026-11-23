// Vision + InsightFace together: Vision is conservative and supplies panel rectangles; InsightFace
// keeps finding the face when Vision misses it (small/serious webcam faces). Use Vision faces where it
// has them, fill the gaps with InsightFace, and keep Vision's rectangles for panel detection.
import { detectFaces, type FaceResult } from './faces';
import { detectFacesInsight } from './insightface';

export async function detectFacesHybrid(file: string, startMs: number, endMs: number, fps = 2): Promise<FaceResult> {
  const vision = await detectFaces(file, startMs, endMs, fps);
  let insight: FaceResult | null = null;
  try {
    insight = await detectFacesInsight(file, startMs, endMs, fps);
  } catch {
    return vision; // Python sidecar unavailable: Vision alone is still usable
  }
  if (!insight.samples.length) return vision;
  const byMs = new Map(insight.samples.map((s) => [s.ms, s.faces]));
  const samples = vision.samples.map((s) => ({
    ...s,
    faces: s.faces.length ? s.faces : (byMs.get(s.ms) ?? []),
  }));
  return { ...vision, samples };
}
