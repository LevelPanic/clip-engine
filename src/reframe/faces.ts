// Face detection for auto-reframing: Apple Vision through a small Swift CLI (tools/faces/main.swift).
// macOS only. The tool is compiled on first use into .cache/bin/faces (Node only).
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../core/paths';
import { runOrThrow } from '../core/proc';

export interface FaceBox {
  x: number; // left edge, 0–1 of the frame width
  y: number; // top edge, 0–1 of the frame height
  w: number;
  h: number;
  mouth?: number; // inner-lip gap / mouth width (0 closed, ~0.3+ wide open); missing when no lip landmarks
  confidence: number;
}

export interface FaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

export interface FaceSample {
  ms: number; // source time of the frame
  faces: FaceBox[];
  /** Rectangular overlays/panels Vision found in this frame (webcam borders, chat boxes, windows). */
  rects?: FaceRect[];
}

export interface FaceResult {
  width: number; // source pixels
  height: number;
  samples: FaceSample[];
  cuts?: number[]; // source ms of the first frame of each new shot (hard cuts), checked on every frame
}

const SOURCE = path.join(paths.root, 'tools', 'faces', 'main.swift');
const BINARY = path.join(paths.cache, 'bin', 'faces');

let building: Promise<void> | undefined;

function binaryIsFresh() {
  return fs.existsSync(BINARY) && fs.statSync(BINARY).mtimeMs >= fs.statSync(SOURCE).mtimeMs;
}

/** Compile the tool when it's missing or main.swift is newer. Checked on every call, so edits apply without a restart. */
async function facesBinary(): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('Face detection uses Apple Vision, which needs macOS');
  if (!binaryIsFresh()) {
    building ??= (async () => {
      fs.mkdirSync(path.dirname(BINARY), { recursive: true });
      // Build beside it and rename, so a concurrent run never executes a half-written binary.
      const tmp = `${BINARY}.${process.pid}.tmp`;
      try {
        await runOrThrow('swiftc', ['-O', SOURCE, '-o', tmp]);
        fs.renameSync(tmp, BINARY);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    })().finally(() => {
      building = undefined;
    });
    await building;
  }
  return BINARY;
}

/**
 * Faces in [startMs, endMs) of a video, sampled `fps` times a second (the frame nearest each sample time).
 * About 2–6 s per minute of 1080p on an M1: decoding dominates, so 60 fps sources take longest.
 */
export async function detectFaces(file: string, startMs: number, endMs: number, fps = 5): Promise<FaceResult> {
  if (!fs.existsSync(file)) throw new Error(`No such video: ${file}`);
  if (!(endMs > startMs) || !(fps > 0)) throw new Error(`Bad face-detection range ${startMs}–${endMs} ms at ${fps} fps`);
  const bin = await facesBinary();
  const r = await runOrThrow(bin, [file, (startMs / 1000).toFixed(3), ((endMs - startMs) / 1000).toFixed(3), String(fps)]);
  return JSON.parse(r.stdout) as FaceResult;
}
