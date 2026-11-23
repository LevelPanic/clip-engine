#!/bin/bash
# Runs the InsightFace detector, installing its Python environment on first use.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VENV="$ROOT/.cache/face-py"
PY="${CLIP_INSIGHTFACE_PY:-$VENV/bin/python}"
if [ ! -x "$PY" ]; then
  echo "setting up InsightFace (first run)…" >&2
  uv venv --python 3.12 "$VENV" >&2
  uv pip install --python "$VENV/bin/python" insightface onnxruntime opencv-python-headless >&2
  PY="$VENV/bin/python"
fi
exec "$PY" "$ROOT/tools/insightface/main.py" "$@"
