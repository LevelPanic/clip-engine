// Source-time ranges: what's been scanned, transcribed, downloaded or fetched. Browser-safe.

export interface Range {
  startMs: number;
  endMs: number;
}

/** Sorted, with overlapping or touching (within `gapMs`) ranges joined. Empty ranges are dropped. */
export function mergeRanges(ranges: Range[], gapMs = 0): Range[] {
  const sorted = ranges.filter((r) => r.endMs > r.startMs).map((r) => ({ ...r })).sort((a, b) => a.startMs - b.startMs);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startMs <= last.endMs + gapMs) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push(r);
  }
  return out;
}

/** The parts of `want` not covered by `have`. */
export function subtractRanges(want: Range[], have: Range[]): Range[] {
  const h = mergeRanges(have);
  const out: Range[] = [];
  for (const w of mergeRanges(want)) {
    let cur = w.startMs;
    for (const x of h) {
      if (x.endMs <= cur || x.startMs >= w.endMs) continue;
      if (x.startMs > cur) out.push({ startMs: cur, endMs: x.startMs });
      cur = Math.max(cur, x.endMs);
    }
    if (cur < w.endMs) out.push({ startMs: cur, endMs: w.endMs });
  }
  return out;
}

/** True when `have` covers all of `r` (with `slackMs` allowed at each end). */
export function covers(have: Range[], r: Range, slackMs = 0): boolean {
  return subtractRanges([{ startMs: r.startMs + slackMs, endMs: r.endMs - slackMs }], have).length === 0;
}
