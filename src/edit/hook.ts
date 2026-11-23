// The hook line at a clip's opening: read it, or write it (`clip intro`). It sits in the style the caption
// look gives it and just under the credit's seam (hookStyleFor, hookYFor in editors.ts).
import { loadProject, saveProject, validateMarker } from '../project';
import type { Marker, Project } from '../core/schemas';
import { hookStyleFor, hookYFor } from './editors';

export async function setIntro(clipId: string, o: { text?: string } = {}): Promise<{ project: Project; marker?: Marker; current?: string }> {
  const p = loadProject(clipId);
  const start = p.segments[0].startMs;
  // the hook line is the text at the opening, in whichever style the caption look gave it (hook,
  // street or comment): matching only style "hook" missed the editors' street/comment hooks and added
  // a second line on top of them. Action lines later in the clip are not the hook.
  const HOOK_STYLES = new Set(['hook', 'street', 'comment', 'highlight', 'outline']);
  const hook = p.markers.find((m) => m.type === 'text' && HOOK_STYLES.has(String((m.params as Record<string, unknown>).style)) && Math.abs(m.startMs - start) <= 1500);
  if (!o.text) return { project: p, marker: hook, current: hook ? String((hook.params as Record<string, unknown>).text ?? '') : undefined };
  const end = Math.min(p.segments[0].endMs, start + 2600);
  const style = hookStyleFor(p.captions.style);
  const params = hook
    ? { ...(hook.params as Record<string, unknown>), text: o.text }
    : { text: o.text, style, y: hookYFor(p.framing), fontSize: style === 'street' ? 78 : 66, animation: 'pop' };
  const marker = await validateMarker({ type: 'text', startMs: start, endMs: end, params, ...(hook ? { id: hook.id } : {}) }, p);
  const markers = [...p.markers.filter((m) => m.id !== hook?.id), { ...marker, source: hook?.source ?? 'intro' }].sort((a, b) => a.startMs - b.startMs);
  return { project: saveProject({ ...p, markers }), marker };
}
