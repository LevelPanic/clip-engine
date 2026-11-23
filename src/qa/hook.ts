// The first 1.5 s decide most of a Short's fate. These are the cheap, deterministic checks QA can make:
// does the export open on silence, a black frame, a long wait, or a filler word? The rest (is the face
// interesting, is the line a hook) needs a person or the judge.
//
// Pure (no Node imports), so it is unit-tested on fixed evidence.

export const OPENING_FILLERS = new Set(['so', 'yeah', 'um', 'uh', 'like', 'well', 'okay', 'right', 'and', 'but', 'alright']);

export interface HookEvidence {
  /** Silence covering the start, in seconds. */
  silenceAtStartS?: number;
  /** Start of a black frame at the very beginning, in seconds. */
  blackAtStartS?: number;
  /** How long after the clip's in-point the first word starts. */
  firstWordOffsetMs?: number;
  firstWord?: string;
}

/** Warnings worth showing next to an export. Empty means the opening passes the cheap checks. */
export function hookWarnings(e: HookEvidence): string[] {
  const out: string[] = [];
  if ((e.silenceAtStartS ?? 0) >= 0.8) out.push(`opens with ${e.silenceAtStartS!.toFixed(1)} s of silence`);
  if (e.blackAtStartS !== undefined && e.blackAtStartS < 0.5) out.push('opens on a black frame');
  if (e.firstWordOffsetMs !== undefined && e.firstWordOffsetMs > 1500) out.push(`first word at ${(e.firstWordOffsetMs / 1000).toFixed(1)} s`);
  const word = e.firstWord?.toLowerCase().replace(/[^a-z]/g, '');
  if (word && (e.firstWordOffsetMs ?? 0) <= 1500 && OPENING_FILLERS.has(word)) out.push(`opens on filler "${e.firstWord}"`);
  return out;
}

/**
 * The other half of trust: did the clip end on the payoff, or on a question/transition that makes the
 * viewer feel cheated? The judge scores `delivery`; this is the cheap transcript check.
 */
export function endingWarnings(e: { lastLine?: string }): string[] {
  const line = e.lastLine?.trim();
  if (!line) return [];
  if (/\b(we'?ll be right back|let'?s move on|what'?d you mean|what do you mean|to be continued)\b/i.test(line))
    return ['ends on an unfinished line or transition'];
  if (line.endsWith('?')) return ['ends on a question; the payoff may be outside the cut'];
  if (OPENING_FILLERS.has(line.toLowerCase().replace(/[^a-z]/g, ''))) return ['ends on a filler'];
  return [];
}
