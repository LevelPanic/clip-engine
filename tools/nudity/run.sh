#!/bin/bash
# Runs the NudeNet detector (MIT, model bundled in the package), installing its Python environment on first use.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VENV="$ROOT/.cache/nudity-py"
PY="${CLIP_NUDITY_PY:-$VENV/bin/python}"
if [ ! -x "$PY" ]; then
  echo "setting up NudeNet (first run)…" >&2
  export UV_CACHE_DIR="${UV_CACHE_DIR:-$ROOT/.cache/uv}"
  uv venv --python 3.12 "$VENV" >&2
  uv pip install --python "$VENV/bin/python" nudenet==3.4.2 onnxruntime opencv-python-headless >&2
  PY="$VENV/bin/python"
fi
exec "$PY" "$ROOT/tools/nudity/main.py" "$@"
