# InsightFace face detector for clip footage.
# Usage: main.py <video> <startSec> <durationSec> <fps>
# Prints the same JSON shape as tools/faces/main.swift: { width, height, samples: [{ ms, faces: [...] }] }.
# Boxes are normalised 0-1 with the origin at the top left; ms is source-file time.
import json
import os
import sys
import warnings

os.environ.setdefault("ORT_LOGGING_LEVEL", "3")
os.environ.setdefault("GLOG_minloglevel", "2")
warnings.filterwarnings("ignore")

import cv2  # noqa: E402
from insightface.app import FaceAnalysis  # noqa: E402


def main() -> None:
    if len(sys.argv) != 5:
        print("usage: main.py <video> <startSec> <durationSec> <fps>", file=sys.stderr)
        sys.exit(2)
    file, start, dur, sample_fps = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
    if start < 0 or dur <= 0 or sample_fps <= 0:
        print("bad range or fps", file=sys.stderr)
        sys.exit(2)

    cap = cv2.VideoCapture(file)
    if not cap.isOpened():
        print(f"cannot open {file}", file=sys.stderr)
        sys.exit(1)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    source_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000.0)
    step = max(1, round(source_fps / sample_fps))

    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(640, 640))

    samples = []
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = start + idx / source_fps
        if t >= start + dur:
            break
        if idx % step == 0:
            faces = []
            for f in app.get(frame):
                score = float(f.det_score)
                if score < 0.3:
                    continue
                x1, y1, x2, y2 = [float(v) for v in f.bbox]
                faces.append(
                    {
                        "x": round(x1 / width, 4),
                        "y": round(y1 / height, 4),
                        "w": round((x2 - x1) / width, 4),
                        "h": round((y2 - y1) / height, 4),
                        "confidence": round(score, 4),
                    }
                )
            samples.append({"ms": round(t * 1000), "faces": faces})
        idx += 1
    cap.release()
    print(json.dumps({"width": width, "height": height, "samples": samples, "cuts": []}))


if __name__ == "__main__":
    main()
