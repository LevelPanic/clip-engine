// Where a downloaded section really starts. A section is cut from the source without re-encoding, so
// its video can only start where the stream has a keyframe. YouTube's sections land on the asked time
// (tested), but Twitch's start at the HLS segment boundary before it: 6.6 s early on a test. Every
// render maps source time through the section's start, so it's measured: the section's audio is
// matched against audio known to be exact (an audio chunk, or a precisely decoded cut of the stream).

/** Loudness envelope: mean |sample| per `stepMs` of 16-bit mono PCM at `rate` Hz. */
export function envelope(pcm: Int16Array, rate: number, stepMs = 10): Float64Array {
  const per = Math.round((rate * stepMs) / 1000);
  const n = Math.floor(pcm.length / per);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * per; j < (i + 1) * per; j++) s += Math.abs(pcm[j]);
    out[i] = s / per;
  }
  return out;
}

/**
 * Where `probe` best matches inside `ref` (index into ref) and how well (Pearson r, −1…1).
 * Both are envelopes at the same step.
 */
export function bestLag(probe: Float64Array, ref: Float64Array): { lag: number; r: number } {
  const n = probe.length;
  if (!n || ref.length < n) return { lag: 0, r: 0 };
  let pm = 0;
  for (const x of probe) pm += x;
  pm /= n;
  let pv = 0;
  for (const x of probe) pv += (x - pm) ** 2;
  let best = { lag: 0, r: -2 };
  for (let L = 0; L + n <= ref.length; L++) {
    let sm = 0;
    for (let i = 0; i < n; i++) sm += ref[L + i];
    sm /= n;
    let c = 0;
    let sv = 0;
    for (let i = 0; i < n; i++) {
      const d = ref[L + i] - sm;
      c += (probe[i] - pm) * d;
      sv += d * d;
    }
    const r = pv && sv ? c / Math.sqrt(pv * sv) : 0;
    if (r > best.r) best = { lag: L, r };
  }
  return best;
}

export const ALIGN = { rate: 8000, stepMs: 10, probeMs: 20_000, searchMs: 15_000 };

/**
 * The real source time of a section file's first frame, given audio for [refStartMs, …] that's exact.
 * `probe` is the section's first ~20 s of audio. Returns null when the match is too weak to trust
 * (silence, music the stream muted).
 */
export function sectionStartFromAudio(probe: Int16Array, ref: Int16Array, refStartMs: number): { startMs: number; r: number } | null {
  const { lag, r } = bestLag(envelope(probe, ALIGN.rate, ALIGN.stepMs), envelope(ref, ALIGN.rate, ALIGN.stepMs));
  if (r < 0.6) return null;
  return { startMs: refStartMs + lag * ALIGN.stepMs, r };
}
