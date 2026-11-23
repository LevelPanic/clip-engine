// The virality funnel, separate from "is this a good moment?".
//
// A short has to stop a stranger in the first second, hold them to the payoff, and give them a reason
// to send it. Those are gates, not points: a 9/10 event behind a 3/10 opening still dies. So the five
// qualities are scored 0–10, combined, then multiplied down when the opening, context or payoff fails.
//
// The judge supplies the five scores. Convergence is computed here from the discovery signals: several
// independent signals agreeing on the same window is the best pre-post evidence we have.
// Browser-safe (no Node imports), so the Studio can show the same numbers.

export interface ViralityScores {
  /** First 1–2 s: face/action on screen and a line that creates a question, claim, threat or event. */
  stop: number;
  /** Escalation and payoff density: there is no safe place to leave before the payoff. */
  hold: number;
  /** A reason to send it: high-arousal emotion, identity, controversy, utility or a quotable line. */
  share: number;
  /** A stranger understands it with no context; names are said and inside references are absent. */
  standalone: number;
  /** A clear outcome, reveal or punchline rather than trailing off. */
  payoff: number;
  /** Does it deliver what the first seconds promised? A hook that goes nowhere feels like a cheat. */
  delivery?: number;
}

/** Older candidates only have `payoff`; treat that as the delivery promise. */
export const deliveryOf = (s: ViralityScores): number => s.delivery ?? s.payoff;

/**
 * The funnel is format-specific. A talk clip can open on a slow question because the viewer came for
 * the conversation; a gameplay clip loses them in one second. Using the stream gate everywhere made
 * the engine reject exactly the podcast clips the user rated highest.
 */
export type CandidateFormat = 'talk' | 'stream';
export const formatOfLens = (lens?: string): CandidateFormat => (lens === 'stream-moments' ? 'stream' : 'talk');

type Weights = Record<Exclude<keyof ViralityScores, 'delivery'>, number>;

/** Kept as the stream preset for callers that don't know the lens. */
export const VIRALITY_WEIGHTS: Weights = { stop: 0.35, hold: 0.25, share: 0.2, standalone: 0.1, payoff: 0.1 };

const WEIGHTS: Record<CandidateFormat, Weights> = {
  stream: VIRALITY_WEIGHTS,
  // Talk lives on the claim, the story and the share, not on the first 1.5 s.
  talk: { stop: 0.15, hold: 0.25, share: 0.25, standalone: 0.15, payoff: 0.2 },
};

/** Below any of these, the clip is capped instead of ranked as if the rest could save it. */
export const VIRALITY_GATE = { stop: 6, standalone: 6, payoff: 5 } as const;
const GATES: Record<CandidateFormat, { stop: number; standalone: number; payoff: number; delivery: number }> = {
  stream: { stop: 6, standalone: 6, payoff: 5, delivery: 6 },
  talk: { stop: 0, standalone: 5, payoff: 5, delivery: 4 },
};
const GATE_FACTOR = 0.65;

export const viralityScore = (s: ViralityScores, lens?: string): number => {
  const format = formatOfLens(lens);
  const weights = WEIGHTS[format];
  const gate = GATES[format];
  const base = (Object.keys(weights) as (keyof Weights)[]).reduce((sum, k) => sum + weights[k] * s[k], 0);
  const delivery = deliveryOf(s);
  // A big hook that pays off with little is the one thing viewers punish as clickbait: cap it hard.
  // A 10/7 is not a cheat (7 delivery clears the post bar); a 10/5 is.
  const cheat = delivery < gate.delivery && s.stop - delivery >= 3;
  const gated = s.stop < gate.stop || s.standalone < gate.standalone || s.payoff < gate.payoff || delivery < gate.delivery;
  const factor = cheat ? 0.5 : gated ? GATE_FACTOR : 1;
  return Math.max(0, Math.min(100, Math.round(base * 10 * factor)));
};

export type CandidateVerdict = 'post' | 'recut' | 'skip';

/**
 * What to do with a clip, precision first.
 * - post: clears the trust bar — a stranger stops, understands it, and gets the payoff.
 * - recut: the opening is strong but the payoff/delivery is not there; the moment may exist in a longer cut.
 * - skip: don't spend the audience's time on it.
 */
const POST_BAR: Record<CandidateFormat, { virality: number; delivery: number; payoff: number; standalone: number }> = {
  stream: { virality: 70, delivery: 7, payoff: 7, standalone: 7 },
  // Talk tolerates a quiet opening and an open-loop ending, but not a weak claim or a missing payoff.
  talk: { virality: 65, delivery: 4, payoff: 5, standalone: 6 },
};

/** The numbers behind each format, in one place, so the lens files can be checked against them (test/lenses.test.ts). */
export const FORMAT_RULES: Record<CandidateFormat, { weights: Weights; gate: (typeof GATES)[CandidateFormat]; post: (typeof POST_BAR)[CandidateFormat] }> = {
  stream: { weights: WEIGHTS.stream, gate: GATES.stream, post: POST_BAR.stream },
  talk: { weights: WEIGHTS.talk, gate: GATES.talk, post: POST_BAR.talk },
};

/** Under this quality score a candidate is not worth a clip, whatever its funnel says. */
export const QUALITY_SKIP = 60;
/** At or over this, a candidate that misses the post bar is worth another cut. */
export const QUALITY_RECUT = 70;

export function verdictOf(s: ViralityScores | undefined, virality: number | undefined, quality: number, lens?: string): CandidateVerdict | undefined {
  if (!s || virality === undefined) return undefined; // not judged yet
  const bar = POST_BAR[formatOfLens(lens)];
  const delivery = deliveryOf(s);
  if (quality < QUALITY_SKIP) return 'skip';
  if (virality >= bar.virality && delivery >= bar.delivery && s.payoff >= bar.payoff && s.standalone >= bar.standalone) return 'post';
  if (quality >= QUALITY_RECUT) return 'recut'; // a real moment, but the cut or the packaging needs work
  return 'skip';
}

/** Signals that count as independent evidence. `speech` is fast talking, not a moment; `title` is a prior. */
const EVIDENCE_SIGNALS = new Set(['chat', 'clips', 'audio', 'laughter', 'comments', 'heatmap', 'teaser']);

/**
 * 0–1: how much independent evidence agrees on this window.
 * One strong signal scores about 0.3; three or more strong signals approach 1.
 */
export function convergenceScore(signals: Record<string, number> = {}): number {
  const evidence: Record<string, number> = {};
  for (const [k, v] of Object.entries(signals)) if (EVIDENCE_SIGNALS.has(k)) evidence[k] = v;
  // Caption laughter and the audio laugh classifier fire on the same laugh. Count them once, or a
  // single joke looks like two independent witnesses (the seed score already does this).
  const reaction = Math.max(evidence.laughter ?? 0, evidence.audio ?? 0);
  delete evidence.laughter;
  delete evidence.audio;
  if (reaction > 0) evidence.reaction = reaction;
  const strong = Object.values(evidence)
    .filter((v) => v >= 0.35)
    .map((v) => Math.min(1, v));
  if (!strong.length) return 0;
  const avg = strong.reduce((a, b) => a + b, 0) / strong.length;
  return Math.round(Math.min(1, strong.length / 3) * (0.6 + 0.4 * avg) * 1000) / 1000;
}

/** 0–1: virality carries 60%, independent signal agreement 40%. Falls back to the quality score. */
export function rankScore(virality: number | undefined, convergence: number, quality: number): number {
  const v = Math.max(0, Math.min(100, virality ?? quality));
  return Math.round((0.6 * (v / 100) + 0.4 * convergence) * 1000) / 1000;
}

export interface RankableCandidate {
  score: number;
  signals: Record<string, number>;
  scores?: ViralityScores;
  virality?: number;
  verdict?: CandidateVerdict;
  lens?: string;
}

/** Post before recut before skip; unjudged candidates sit in the middle. */
const verdictOrder = (v: CandidateVerdict | undefined) => (v === 'post' ? 0 : v === 'skip' ? 2 : 1);

/**
 * Recompute convergence, verdict and the combined order for a candidate list.
 * A judge-supplied `scores` object always wins over a stale `virality` field.
 * Postable clips come first even if a hookier-but-empty clip has a higher raw rank.
 */
export function rankCandidates<T extends RankableCandidate>(
  list: T[],
): (T & { convergence: number; virality?: number; rankScore: number; verdict?: CandidateVerdict; rank: number })[] {
  return list
    .map((c) => {
      const convergence = convergenceScore(c.signals ?? {});
      const virality = c.scores ? viralityScore(c.scores, c.lens) : c.virality;
      const verdict = c.scores ? verdictOf(c.scores, virality, c.score, c.lens) : c.verdict;
      return { ...c, convergence, virality, verdict, rankScore: rankScore(virality, convergence, c.score) };
    })
    .sort((a, b) => verdictOrder(a.verdict) - verdictOrder(b.verdict) || b.rankScore - a.rankScore || b.score - a.score)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}

/** A short label for the Studio and the CLI. */
export function rankLabel(virality: number | undefined, convergence: number, quality: number): string {
  const v = virality ?? quality;
  return `viral ${v} · signal ${Math.round(convergence * 100)}%`;
}
