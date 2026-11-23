// The curator's ledger: library/<id>/curation.json, validated.
//
// After extraction every candidate gets a niche, a fit and a decision: keep, review or drop. A drop is
// the exception and has to be argued: it needs one of the allowed grounds (a low score is not one), a
// removal weight and a reason, and it is the only decision that changes a candidate's status. The
// ledger is written here, not by hand, so its shape cannot drift and a drop can never be silent.
import { z } from 'zod';
import { paths, readJsonIf, writeJson } from '../core/paths';
import { DROP_GROUNDS, NICHES, keysOf } from '../core/vocabulary';
import { loadCandidates, saveCandidates } from '../candidates';
import { expertFlags, unsafeFlags } from '../scan/review';
import type { Candidate } from '../core/schemas';

export const CurationInputSchema = z.object({
  candidateId: z.string(),
  /** Where the clip belongs (`clip vocab niches`). "none" only on a drop. */
  niche: z.enum(keysOf(NICHES)),
  /** What it is about, in a few words: "money flex", "jumpscare", "UK guy in LA". */
  angle: z.string().max(80).optional(),
  /** 0–100: how well it serves that niche, judged from the content, not from the virality score. */
  fit: z.number().min(0).max(100),
  decision: z.enum(['keep', 'review', 'drop']),
  /** Why it is dropped (`clip vocab drops`). Needed on a drop. */
  ground: z.enum(keysOf(DROP_GROUNDS)).optional(),
  /** The stronger candidate this one repeats. Needed when the ground is "duplicate". */
  duplicateOf: z.string().optional(),
  /** 0–100: how sure you are that removing it is right. Needed on a drop. */
  removalWeight: z.number().min(0).max(100).optional(),
  reason: z.string().min(20, 'say why in a sentence that names what happens in the clip'),
  /** What the editor should fix before it is posted: "trim the 8 s of dark room at the head". */
  fixes: z.array(z.string()).default([]),
});

export interface CurationDecision {
  candidateId: string;
  niche: string;
  angle?: string;
  fit: number;
  decision: 'keep' | 'review' | 'drop';
  ground?: string;
  duplicateOf?: string;
  removalWeight: number;
  reason: string;
  fixes?: string[];
  /** Filled in by the engine from the candidate, so the numbers in the ledger are never typed by hand. */
  score?: number;
  virality?: number;
  verdict?: string;
  rank?: number;
  kind?: string;
  title?: string;
  at?: string;
}

export interface CurationFile {
  videoId: string;
  updatedAt?: string;
  decisions: CurationDecision[];
}

const file = (videoId: string) => paths.videoFile(videoId, 'curation.json');
export const loadCuration = (videoId: string): CurationFile => readJsonIf<CurationFile>(file(videoId)) ?? { videoId, decisions: [] };

/** A keep or review on a risky moment says how the cut leaves the risk out, in these words. */
export const AVOIDS = /\bavoids? (it|them|this|that|the \w+) by\b/i;

/**
 * The candidates whose moment carries a flag that keeps it off the channel (`unsafeFlags`: sexual from
 * two kinds of expert, a slur, a minor), with the flags.
 */
export function riskyCandidates(videoId: string, cands: Pick<Candidate, 'id' | 'startMs' | 'endMs' | 'queueId'>[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of cands) {
    const flags = unsafeFlags(expertFlags(videoId, c, c.queueId));
    if (flags.length) out.set(c.id, flags);
  }
  return out;
}

/** Check one decision against the candidates. Pure: returns the errors, empty when it stands. */
export function checkDecision(d: z.output<typeof CurationInputSchema>, cands: Pick<Candidate, 'id' | 'status' | 'clipId'>[], risky: Map<string, string[]> = new Map()): string[] {
  const errors: string[] = [];
  const cand = cands.find((c) => c.id === d.candidateId);
  if (!cand) return [`no candidate ${d.candidateId} (\`clip candidates list\` shows the ids)`];
  // the channel lost videos to nudity and a brawl (2026-11-21): when the nude body, the sex scene, the
  // slur or the minor is the moment, it is a drop, not a clip for someone to sign off
  const flags = risky.get(d.candidateId);
  if (flags && d.decision !== 'drop' && !AVOIDS.test(d.reason))
    errors.push(`${d.candidateId}'s moment is flagged ${flags.join('; ')}: drop it with ground "unsafe", or, if a 15–60 s cut leaves it out, say how in the reason ("the cut avoids it by …")`);
  if (d.decision === 'drop') {
    if (!d.ground) errors.push('a drop names its ground: set "ground" (`clip vocab drops`). A low score is not a ground');
    if (d.removalWeight === undefined || d.removalWeight <= 0) errors.push('a drop carries a "removalWeight" (1–100): how sure you are that removing it is right');
    if (d.ground === 'duplicate') {
      if (!d.duplicateOf) errors.push('a duplicate names the stronger candidate: set "duplicateOf"');
      else if (d.duplicateOf === d.candidateId) errors.push('a candidate cannot duplicate itself');
      else if (!cands.some((c) => c.id === d.duplicateOf)) errors.push(`duplicateOf ${d.duplicateOf} is not a candidate`);
    }
    if (d.ground === 'no-niche' && d.niche !== 'none') errors.push(`ground "no-niche" contradicts niche "${d.niche}": if it fits a niche, keep it or leave it for review`);
    if (cand.status === 'made') errors.push(`${d.candidateId} is already a clip (${cand.clipId ?? 'made'}): decide it in review, or delete the clip first`);
  } else {
    if (d.niche === 'none') errors.push('niche "none" is only for a drop: a clip that is kept or left for review belongs somewhere');
    if (d.ground) errors.push('"ground" belongs on a drop');
  }
  return errors;
}

export interface CurationResult {
  saved: CurationDecision[];
  refused: { input: unknown; errors: string[] }[];
  /** Candidates that still have no decision: the ledger must cover every one. */
  undecided: string[];
  /** Status changes made: drops skipped, and earlier drops that were reversed. */
  skipped: string[];
  restored: string[];
}

/** Validate decisions, merge them into the ledger (the latest decision per candidate wins) and apply drops. */
export function applyCuration(videoId: string, inputs: unknown[], now = new Date().toISOString()): CurationResult {
  const f = loadCandidates(videoId);
  const ledger = loadCuration(videoId);
  const risky = riskyCandidates(videoId, f.candidates);
  const res: CurationResult = { saved: [], refused: [], undecided: [], skipped: [], restored: [] };
  const seen = new Set<string>();
  for (const raw of inputs) {
    const parsed = CurationInputSchema.safeParse(raw);
    if (!parsed.success) {
      res.refused.push({ input: raw, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'decision'}: ${i.message}`) });
      continue;
    }
    const d = parsed.data;
    const errors = checkDecision(d, f.candidates, risky);
    if (seen.has(d.candidateId)) errors.push(`${d.candidateId} appears twice in this file`);
    if (errors.length) {
      res.refused.push({ input: raw, errors });
      continue;
    }
    seen.add(d.candidateId);
    const cand = f.candidates.find((c) => c.id === d.candidateId)!;
    res.saved.push({
      candidateId: d.candidateId,
      niche: d.niche,
      ...(d.angle ? { angle: d.angle } : {}),
      fit: d.fit,
      decision: d.decision,
      ...(d.ground ? { ground: d.ground } : {}),
      ...(d.duplicateOf ? { duplicateOf: d.duplicateOf } : {}),
      removalWeight: d.decision === 'drop' ? d.removalWeight! : 0,
      reason: d.reason,
      ...(d.fixes.length ? { fixes: d.fixes } : {}),
      score: cand.score,
      virality: cand.virality,
      verdict: cand.verdict,
      rank: cand.rank,
      kind: cand.kind,
      title: cand.title,
      at: now,
    });
  }
  if (res.saved.length) {
    const before = new Map(ledger.decisions.map((d) => [d.candidateId, d]));
    for (const d of res.saved) {
      const cand = f.candidates.find((c) => c.id === d.candidateId)!;
      if (d.decision === 'drop' && cand.status === 'new') {
        cand.status = 'skipped';
        res.skipped.push(cand.id);
      } else if (d.decision !== 'drop' && cand.status === 'skipped' && before.get(d.candidateId)?.decision === 'drop') {
        cand.status = 'new'; // the curator changed its mind; a candidate the user skipped by hand is left alone
        res.restored.push(cand.id);
      }
    }
    if (res.skipped.length || res.restored.length) saveCandidates(f);
    const ids = new Set(res.saved.map((d) => d.candidateId));
    const rank = new Map(f.candidates.map((c) => [c.id, c.rank ?? 999]));
    const decisions = [...ledger.decisions.filter((d) => !ids.has(d.candidateId)), ...res.saved].sort((a, b) => (rank.get(a.candidateId) ?? 999) - (rank.get(b.candidateId) ?? 999));
    writeJson(file(videoId), { videoId, updatedAt: now, decisions } satisfies CurationFile);
  }
  res.undecided = undecidedIn(videoId);
  return res;
}

/** Candidates the ledger does not cover yet. A candidate the user skipped by hand needs no decision. */
export function undecidedIn(videoId: string): string[] {
  const decided = new Set(loadCuration(videoId).decisions.map((d) => d.candidateId));
  return loadCandidates(videoId).candidates.filter((c) => !decided.has(c.id) && c.status !== 'skipped').map((c) => c.id);
}
