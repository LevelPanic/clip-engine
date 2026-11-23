// Accepting and rejecting proposed markers (browser-safe; the Studio and the CLI share it).
import type { Project } from './schemas';

const pick = (ids?: string[]) => (m: { id: string; proposed?: boolean }) => !!m.proposed && (!ids || !ids.length || ids.includes(m.id));

export function acceptProposals(p: Project, ids?: string[]): Project {
  const hit = pick(ids);
  const markers = p.markers.map((m) => (hit(m) ? { ...m, proposed: undefined } : m));
  const stillProposedReframe = markers.some((m) => m.proposed && m.source === 'auto-reframe');
  return { ...p, markers, prevFraming: stillProposedReframe ? p.prevFraming : undefined };
}

/** Remove proposals. If that removes the last auto-reframe proposal, the framing goes back to what it
 *  was before auto-reframe switched the clip to crop. */
export function rejectProposals(p: Project, ids?: string[]): Project {
  const hit = pick(ids);
  const markers = p.markers.filter((m) => !hit(m));
  const reframeLeft = markers.some((m) => m.source === 'auto-reframe');
  if (p.prevFraming && !reframeLeft) return { ...p, markers, framing: p.prevFraming, prevFraming: undefined };
  return { ...p, markers };
}
