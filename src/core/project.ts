// Clip projects on disk: create, load, save and edit markers (Node only).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { paths, readJson, writeJson, listDirs, readJsonIf } from './paths';
import {
  ProjectSchema,
  type Project,
  type Marker,
  type Candidate,
  type VideoMeta,
  defaultCaptions,
  defaultFraming,
  type Preset,
  PresetSchema,
} from './schemas';
import { loadMarkerSchemas } from '../markers/registry-node';
import { fmtTime } from './time';
import { creditLine, creditLabel, suggestPost, type SourceRef } from './post';
import { doNotClipError, loadChannel, optedOut } from './channel';
import type { Post } from './schemas';

export const newMarkerId = () => 'm_' + crypto.randomBytes(4).toString('hex');

export function listClips(): string[] {
  return listDirs(paths.clips).filter((d) => fs.existsSync(paths.project(d)));
}

/** The marker type that names the creator on screen. One per clip. */
export const CREDIT = 'credit';

const sourceOf = (videoId: string, meta: VideoMeta): SourceRef => {
  // YouTube's info.json has the channel page; the fallback is the handle a viewer would search.
  const info = readJsonIf<{ uploader_url?: string; uploader_id?: string }>(paths.videoFile(videoId, 'info.json'));
  const channelUrl =
    meta.platform === 'youtube'
      ? info?.uploader_url ?? (meta.channel ? `https://www.youtube.com/@${meta.channel.replace(/\s+/g, '')}` : undefined)
      : meta.login
        ? `https://www.twitch.tv/${meta.login}`
        : undefined;
  return { platform: meta.platform, videoId, url: meta.url, channel: meta.channel, channelUrl, login: meta.login, title: meta.title, game: meta.game };
};

/** What the stream was at this second: the chapter it is in (a stream changes game; its category is only where it began). */
export function categoryAt(videoId: string, ms: number): string | undefined {
  const meta = readJsonIf<VideoMeta>(paths.videoFile(videoId, 'meta.json'));
  return meta?.chapters?.find((c) => ms >= c.startMs && ms < c.endMs)?.title ?? meta?.game;
}

/** The suggested post text for a clip, from its title, its candidate's hook and lens, and the channel. */
export function suggestedPost(p: Project): Post {
  const cand = readJsonIf<{ candidates: Candidate[] }>(paths.videoFile(p.videoId, 'candidates.json'))?.candidates.find((c) => c.id === p.candidateId);
  const meta = readJsonIf<VideoMeta>(paths.videoFile(p.videoId, 'meta.json'));
  const at = p.segments[0]?.startMs;
  // what the stream was at that point: the chapter the clip starts in (a stream changes game; its category is only where it began)
  const chapter = at !== undefined ? meta?.chapters?.find((c) => at >= c.startMs && at < c.endMs)?.title : undefined;
  const game = chapter ?? meta?.game;
  // the credit links the source at the second the clip starts
  const from = meta ? { source: { ...sourceOf(p.videoId, meta), game }, identity: loadChannel(), atMs: at } : {};
  // the one line a cold viewer must be told, as the expert who saw the moment wrote it
  const ledger = cand?.queueId ? readJsonIf<{ verdicts: { queueId: string; context?: string }[] }>(paths.videoFile(p.videoId, 'queue-review.json')) : undefined;
  const context = ledger?.verdicts.find((v) => v.queueId === cand?.queueId)?.context;
  return suggestPost({ title: p.title, hook: cand?.hook, quote: cand?.quote, reason: cand?.reason, lens: cand?.lens, channel: meta?.channel, game, context, ...from });
}

export function loadProject(clipId: string): Project {
  const file = paths.project(clipId);
  if (!fs.existsSync(file)) throw new Error(`No clip "${clipId}". Run \`clip clips\` to list them.`);
  return ProjectSchema.parse(readJson(file));
}

/** Validate and write. `baseRev` (optional) rejects the save if someone else wrote in between. */
export function saveProject(p: Project, baseRev?: number): Project {
  const file = paths.project(p.id);
  if (baseRev !== undefined && fs.existsSync(file)) {
    const cur = readJson<Project>(file);
    if (cur.rev !== baseRev) {
      const err = new Error(`Project ${p.id} changed on disk (rev ${cur.rev}, you had ${baseRev})`);
      (err as Error & { code?: string }).code = 'CONFLICT';
      throw err;
    }
  }
  const prevRev = fs.existsSync(file) ? readJson<Project>(file).rev : 0;
  const next = ProjectSchema.parse({ ...p, rev: Math.max(prevRev, p.rev) + 1, updatedAt: new Date().toISOString() });
  writeJson(file, next);
  return next;
}

export function projectFromCandidate(videoId: string, c: Candidate, meta: VideoMeta): Project {
  const out = optedOut(meta);
  if (out) throw doNotClipError(out);
  const now = new Date().toISOString();
  return {
    version: 1,
    rev: 0,
    id: `${videoId}-${c.id}`,
    videoId,
    title: c.title,
    candidateId: c.id,
    sourceDurationMs: meta.durationMs,
    fps: 30,
    segments: [{ startMs: c.startMs, endMs: c.endMs }],
    // the clip is someone else's stream: it names them on screen from the start (`clip credit` changes or removes it)
    markers: loadChannel().creditOnScreen ? [{ id: newMarkerId(), type: CREDIT, startMs: c.startMs, params: { text: creditLine(sourceOf(videoId, meta)), label: creditLabel(sourceOf(videoId, meta)) }, source: 'credit' }] : [],
    captions: { ...defaultCaptions(), position: captionPositionFor(meta.width, meta.height) },
    framing: defaultFraming(),
    // Twitch is 16:9 with a facecam in a corner: try the split layout (facecam top, game below).
    // The user prefers this; check the cam box, and set it by hand when the detector picks the table.
    ...(meta.platform === 'twitch' || videoId.startsWith('tw-') ? { autoSplit: true } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Blur-fit leaves a blurred band under the picture: put captions there instead of over the bottom
 *  of the picture (facecams, on-screen text), but keep them inside the safe zone (≤ 1500 px). */
export function captionPositionFor(width = 1920, height = 1080): number {
  const pictureBottom = (1920 / 2 + (1080 * (height / width)) / 2) / 1920; // 16:9 → 0.66, 1:1 → 0.78
  return Math.round(Math.min(0.74, Math.max(0.68, pictureBottom + 0.06)) * 100) / 100;
}

// ---------- markers ----------

export interface MarkerInput {
  type: string;
  startMs: number;
  endMs?: number;
  params?: Record<string, unknown>;
}

/** Check a marker against its type's schema; fills defaults. Throws with a readable message. */
export async function validateMarker(m: MarkerInput & { id?: string }, project: Project): Promise<Marker> {
  const types = await loadMarkerSchemas();
  const t = types.get(m.type);
  if (!t) throw new Error(`Unknown marker type "${m.type}". Known: ${[...types.keys()].join(', ')}`);
  const parsed = t.params.safeParse(m.params ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ');
    throw new Error(`Bad params for ${m.type}: ${issues}`);
  }
  // params marked .meta({ ui: 'sfx' }) must name a file in assets/sfx/
  const js = z.toJSONSchema(t.params) as { properties?: Record<string, { ui?: string }> };
  for (const [k, s] of Object.entries(js.properties ?? {})) {
    const v = (parsed.data as Record<string, unknown>)[k];
    if (s.ui === 'sfx' && typeof v === 'string' && !fs.existsSync(`${paths.sfx}/${v}`)) {
      const have = fs.existsSync(paths.sfx) ? fs.readdirSync(paths.sfx).filter((f) => !f.startsWith('.')) : [];
      throw new Error(`No sound "${v}" in assets/sfx/. Have: ${have.join(', ') || '(none)'}`);
    }
  }
  const dur = project.sourceDurationMs;
  if (m.startMs < 0 || m.startMs > dur) throw new Error(`Marker start ${fmtTime(m.startMs)} is outside the video`);
  let endMs: number | undefined;
  if (t.kind === 'span') {
    endMs = m.endMs ?? m.startMs + (t.defaultDurationMs ?? 1000);
    if (endMs <= m.startMs) throw new Error(`Marker end must be after its start`);
    endMs = Math.min(endMs, dur);
  } else if (m.endMs !== undefined) {
    throw new Error(`${m.type} is a point marker; it takes --at only`);
  }
  return { id: m.id ?? newMarkerId(), type: m.type, startMs: Math.round(m.startMs), endMs, params: parsed.data };
}

/** The on-screen credit: add it to a clip that has none, change what it says, or take it off. */
export async function setCredit(clipId: string, o: { text?: string; label?: string; remove?: boolean } = {}): Promise<Project> {
  const p = loadProject(clipId);
  const others = p.markers.filter((m) => m.type !== CREDIT);
  if (o.remove) return saveProject({ ...p, markers: others });
  const old = p.markers.find((m) => m.type === CREDIT);
  const meta = readJsonIf<VideoMeta>(paths.videoFile(p.videoId, 'meta.json'));
  const src = meta ? sourceOf(p.videoId, meta) : undefined;
  const text = o.text ?? (old?.params.text as string | undefined) ?? (src ? creditLine(src) : undefined);
  const label = o.label ?? (old?.params.label as string | undefined) ?? (src ? creditLabel(src) : '🎥');
  if (!text) throw new Error(`no metadata for ${p.videoId}: say what the credit is with --text`);
  const marker = await validateMarker({ type: CREDIT, startMs: p.segments[0].startMs, params: { ...(old?.params ?? {}), text, label }, ...(old ? { id: old.id } : {}) }, p);
  const markers = [...others, { ...marker, source: 'credit' }].sort((a, b) => a.startMs - b.startMs);
  return saveProject({ ...p, markers });
}

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
  const { hookStyleFor, hookYFor } = await import('../edit/editors');
  const style = hookStyleFor(p.captions.style);
  const params = hook
    ? { ...(hook.params as Record<string, unknown>), text: o.text }
    : { text: o.text, style, y: hookYFor(p.framing), fontSize: style === 'street' ? 78 : 66, animation: 'pop' };
  const marker = await validateMarker({ type: 'text', startMs: start, endMs: end, params, ...(hook ? { id: hook.id } : {}) }, p);
  const markers = [...p.markers.filter((m) => m.id !== hook?.id), { ...marker, source: hook?.source ?? 'intro' }].sort((a, b) => a.startMs - b.startMs);
  return { project: saveProject({ ...p, markers }), marker };
}

export async function addMarker(clipId: string, input: MarkerInput): Promise<{ project: Project; marker: Marker }> {
  const p = loadProject(clipId);
  const marker = await validateMarker(input, p);
  p.markers.push(marker);
  p.markers.sort((a, b) => a.startMs - b.startMs);
  return { project: saveProject(p), marker };
}

export async function updateMarker(
  clipId: string,
  markerId: string,
  patch: { startMs?: number; endMs?: number; params?: Record<string, unknown> },
): Promise<{ project: Project; marker: Marker }> {
  const p = loadProject(clipId);
  const idx = p.markers.findIndex((m) => m.id === markerId);
  if (idx < 0) throw new Error(`No marker ${markerId} in ${clipId}`);
  const cur = p.markers[idx];
  let startMs = patch.startMs ?? cur.startMs;
  let endMs = patch.endMs ?? cur.endMs;
  if (patch.startMs !== undefined && patch.endMs === undefined && cur.endMs !== undefined) {
    endMs = cur.endMs + (startMs - cur.startMs); // moving a span keeps its length
  }
  const marker = await validateMarker(
    { id: cur.id, type: cur.type, startMs, endMs, params: { ...cur.params, ...(patch.params ?? {}) } },
    p,
  );
  // editing a proposal keeps it a proposal (accept is a separate, explicit step) and keeps its source
  const kept = { ...marker, ...(cur.proposed ? { proposed: true } : {}), ...(cur.source ? { source: cur.source } : {}) };
  p.markers[idx] = kept;
  p.markers.sort((a, b) => a.startMs - b.startMs);
  return { project: saveProject(p), marker: kept };
}

export function removeMarker(clipId: string, markerId: string): Project {
  const p = loadProject(clipId);
  const before = p.markers.length;
  p.markers = p.markers.filter((m) => m.id !== markerId);
  if (p.markers.length === before) throw new Error(`No marker ${markerId} in ${clipId}`);
  return saveProject(p);
}

// ---------- presets ----------

export function listPresets(): string[] {
  if (!fs.existsSync(paths.presets)) return [];
  return fs
    .readdirSync(paths.presets)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function presetFile(name: string) {
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) throw new Error(`Preset names use letters, numbers, - and _`);
  return `${paths.presets}/${name}.json`;
}

export function loadPreset(name: string): Preset {
  const p = readJsonIf<Preset>(presetFile(name));
  if (!p) throw new Error(`No preset "${name}". Known: ${listPresets().join(', ') || '(none)'}`);
  return PresetSchema.parse(p);
}

/** Markers are stored relative to whichever clip edge they are nearer. */
export function presetFromProject(p: Project, name: string): Preset {
  const { startMs: inMs, endMs: outMs } = p.segments[0];
  const { fixes: _fixes, ...captions } = p.captions;
  return {
    name,
    createdAt: new Date().toISOString(),
    captions,
    framing: p.framing,
    markers: p.markers
      .filter((m) => m.startMs >= inMs && m.startMs <= outMs)
      .map((m) => {
        const anchor = m.startMs - inMs <= outMs - m.startMs ? 'start' : 'end';
        return {
          type: m.type,
          params: m.params,
          anchor,
          offsetMs: anchor === 'start' ? m.startMs - inMs : m.startMs - outMs,
          durationMs: m.endMs !== undefined ? m.endMs - m.startMs : undefined,
        };
      }),
  };
}

export async function applyPreset(p: Project, preset: Preset, mode: 'add' | 'replace' = 'replace'): Promise<Project> {
  const { startMs: inMs, endMs: outMs } = p.segments[0];
  const markers: Marker[] = mode === 'replace' ? [] : [...p.markers];
  for (const pm of preset.markers) {
    const startMs = Math.min(outMs, Math.max(inMs, pm.anchor === 'start' ? inMs + pm.offsetMs : outMs + pm.offsetMs));
    const endMs = pm.durationMs !== undefined ? Math.min(outMs, startMs + pm.durationMs) : undefined;
    if (endMs !== undefined && endMs <= startMs) continue;
    markers.push(await validateMarker({ type: pm.type, startMs, endMs, params: pm.params }, p));
  }
  markers.sort((a, b) => a.startMs - b.startMs);
  return {
    ...p,
    markers,
    captions: { ...preset.captions, fixes: p.captions.fixes },
    framing: preset.framing,
  };
}
