#!/bin/zsh
# Upload clips to YouTube one at a time, one every EVERY_MIN minutes.
# Each upload is scheduled to go live LEAD_MIN minutes after that upload starts.
#
# Usage:
#   tools/youtube-drip.sh [--force] [--dry-run] <clipId...>
#
# Env:
#   EVERY_MIN=10   minutes between uploads
#   LEAD_MIN=5     minutes between an upload and its publishAt
#
# Run detached:
#   nohup tools/youtube-drip.sh --force tw-...-c01 tw-...-c02 > .cache/youtube-drip.log 2>&1 &
#
# The queue is the argument list. An upload failure stops the run and logs it; the
# already-uploaded records in exports/<clip>.publish.json make a rerun idempotent.

set -euo pipefail
cd "$(dirname "$0")/.."

EVERY_MIN=${EVERY_MIN:-10}
LEAD_MIN=${LEAD_MIN:-5}

FORCE=""
DRY=""
CLIPS=()
for arg in "$@"; do
  case "$arg" in
    --force) FORCE="--force" ;;
    --dry-run) DRY=1 ;;
    --*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) CLIPS+=("$arg") ;;
  esac
done

if (( ${#CLIPS[@]} == 0 )); then
  echo "usage: tools/youtube-drip.sh [--force] [--dry-run] <clipId...>" >&2
  exit 2
fi

iso_in() {
  python3 - "$1" <<'PY'
from datetime import datetime, timedelta, timezone
import sys
print((datetime.now(timezone.utc) + timedelta(minutes=int(sys.argv[1]))).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
}

i=0
for clip in "${CLIPS[@]}"; do
  if [[ -f "exports/$clip.publish.json" ]]; then
    echo "already published: $clip — skipping"
    i=$(( i + 1 ))
    continue
  fi

  if [[ -n "$DRY" ]]; then
    at=$(iso_in $(( LEAD_MIN + i * EVERY_MIN )))
    echo "[dry] $clip  upload at +$(( i * EVERY_MIN ))m  publishAt $at"
    i=$(( i + 1 ))
    continue
  fi

  start=$(date +%s)
  at=$(iso_in "$LEAD_MIN")
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ)  $clip  upload; publishAt $at"
  # shellcheck disable=SC2086
  ./clip publish "$clip" --publish-at "$at" $FORCE
  i=$(( i + 1 ))
  if (( i < ${#CLIPS[@]} )); then
    now=$(date +%s)
    wait=$(( EVERY_MIN * 60 - (now - start) ))
    if (( wait > 0 )); then
      echo "    next upload in $(( wait / 60 ))m $(( wait % 60 ))s"
      sleep "$wait"
    fi
  fi
done

echo "done: $i clip(s)"
