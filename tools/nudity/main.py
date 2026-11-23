# NudeNet over stills of an export, for the 18+ check (src/qa/adult.ts).
# Usage: main.py <image>...
# Prints JSON: { images: [{ file, detections: [{ label, score, half }] }] }.
# A 9:16 still is read as its top and bottom halves (each close to square): the bundled model reads
# 320 px, and a whole 1080x1920 frame squeezed into that loses the camera band.
import json
import os
import sys
import warnings

os.environ.setdefault("ORT_LOGGING_LEVEL", "3")
warnings.filterwarnings("ignore")

import cv2  # noqa: E402
from nudenet import NudeDetector  # noqa: E402


def main() -> None:
    files = sys.argv[1:]
    if not files:
        print("usage: main.py <image>...", file=sys.stderr)
        sys.exit(2)
    det = NudeDetector()
    out = []
    for f in files:
        img = cv2.imread(f)
        if img is None:
            out.append({"file": f, "error": "unreadable"})
            continue
        h, w = img.shape[:2]
        parts = [("top", img[: h // 2]), ("bottom", img[h // 2 :])] if h > w * 1.3 else [("whole", img)]
        found = []
        for name, part in parts:
            for d in det.detect(part):
                found.append({"label": d["class"], "score": round(float(d["score"]), 3), "half": name})
        out.append({"file": f, "detections": found})
    json.dump({"images": out}, sys.stdout)


if __name__ == "__main__":
    main()
