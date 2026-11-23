// InsightFace face detection through the Python tool in tools/insightface/.
// It prints the same JSON as tools/faces (Swift/Vision), so findFacecam() doesn't care which ran.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../core/paths';
import { runOrThrow } from '../core/proc';
import type { FaceResult } from './faces';

const SCRIPT = path.join(paths.root, 'tools', 'insightface', 'main.py');
const RUN = path.join(paths.root, 'tools', 'insightface', 'run.sh');

export async function detectFacesInsight(file: string, startMs: number, endMs: number, fps = 2): Promise<FaceResult> {
  if (!fs.existsSync(file)) throw new Error(`No such video: ${file}`);
  if (!(endMs > startMs) || !(fps > 0)) throw new Error(`Bad face-detection range ${startMs}–${endMs} ms at ${fps} fps`);
  const args = [file, (startMs / 1000).toFixed(3), ((endMs - startMs) / 1000).toFixed(3), String(fps)];
  const py = process.env.CLIP_INSIGHTFACE_PY;
  const r = py ? await runOrThrow(py, [SCRIPT, ...args]) : await runOrThrow(RUN, args);
  return JSON.parse(r.stdout) as FaceResult;
}
