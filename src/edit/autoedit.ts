// A first-pass edit the engine makes on its own, in an edit style (see styles.ts), as proposed markers
// the reviewer (or the agent) accepts, tweaks or rejects. It finds the moments:
//   punchlines (the content word just before a laugh) · the payoff (the last laugh) · SHOUTED words ·
//   shouts heard in the audio · sentence starts · dead air
// and the style decides what lands there: zooms, random booms, flashes, shakes, emoji pops, a riser,
// punch-ins on every other sentence, jump cuts with transitions. Plus hook text, the caption look and
// the caption mishearings the comments revealed. Re-running with another style replaces its markers.
import fs from 'node:fs';
import { paths, readJsonIf } from '../core/paths';
import type { Marker, Project, Transcript, Candidate, Word } from '../core/schemas';
import { loadProject, saveProject, newMarkerId, listPresets, loadPreset, applyPreset } from '../core/project';
import { loadCandidates } from '../candidates';
import { loadMarkerSchemas } from '../markers/registry-node';
import { suggestSilenceCuts } from './suggest';
import { styleByKey, type EditStyle } from './styles';
import { endsSentence } from '../ingest/transcript';
import { fmtTime } from '../core/time';

interface AudioEventsFile {
  events: { ms: number; label: string; confidence: number }[];
}

export interface AutoEditOptions {
  accept?: boolean; // add as accepted instead of proposed
  reframe?: boolean; // also track faces and crop to the subject
  cuts?: boolean; // dead-air jump cuts (default: the style decides)
  preset?: string; // apply this preset first (default: "default" if it exists)
  style?: string; // clean | punch | hype | story (default punch)
}

export interface AutoEditReport {
  clipId: string;
  style: string;
  added: { type: string; at: string; why: string }[];
  captionFixes: { i: number; from: string; to: string }[];
  notes: string[];
}

const ENGINE_SOURCES = new Set(['autoedit', 'silence']);

/** Laughs inside the clip: caption tags plus confident audio detections, merged within 2 s. */
function laughsIn(ae: AudioEventsFile | undefined, t: Transcript, s: number, e: number): number[] {
  const times = [
    ...t.tags.filter((g) => /laugh|applause|cheer/.test(g.tag)).map((g) => g.ms),
    ...(ae?.events ?? []).filter((x) => /laugh|cheer|applause/.test(x.label) && x.confidence >= 0.6).map((x) => x.ms + 400),
  ]
    .filter((ms) => ms >= s && ms <= e)
    .sort((a, b) => a - b);
  const merged: number[] = [];
  for (const ms of times) if (!merged.length || ms - merged[merged.length - 1] > 2000) merged.push(ms);
  return merged;
}

/** A stable "random" pick, so re-running the same style on the same clip gives the same edit. */
function picker(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return <T>(list: T[], k: number): T => list[Math.abs((h + k * 2654435761) | 0) % list.length];
}

const FILLER = /^(that|this|with|have|like|just|they|what|your|then|there|about|really|yeah|know|kind|sort|mean|gonna|going|think|okay|well|because|right|thing|stuff|guys|were|when|them|been|some|it's|that's|don't|i'm|you're)$/i;
const isContent = (w: Word) => w.text.replace(/[^A-Za-z']/g, '').length >= 4 && !FILLER.test(w.text.replace(/[^A-Za-z']/g, ''));

/** Sentences inside the clip: split on sentence ends, speaker changes and pauses. */
function sentences(words: Word[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let cur: { start: number; end: number } | null = null;
  words.forEach((w, k) => {
    const prev = words[k - 1];
    if (!cur || w.speakerChange || (prev && (endsSentence(prev) || w.startMs - prev.endMs > 600))) {
      if (cur) out.push(cur);
      cur = { start: w.startMs, end: w.endMs };
    } else cur.end = w.endMs;
  });
  if (cur) out.push(cur);
  return out;
}

export async function autoEdit(clipId: string, opts: AutoEditOptions = {}): Promise<AutoEditReport> {
  let p: Project = loadProject(clipId);
  const style: EditStyle = styleByKey(opts.style);
  const report: AutoEditReport = { clipId, style: style.key, added: [], captionFixes: [], notes: [] };
  const types = await loadMarkerSchemas();
  const defaults = (type: string) => types.get(type)!.params.parse({}) as Record<string, unknown>;
  const seg = p.segments[0];
  const t = readJsonIf<Transcript>(paths.videoFile(p.videoId, 'transcript.json'));
  if (!t) throw new Error('no transcript');
  const ae = readJsonIf<AudioEventsFile>(paths.videoFile(p.videoId, 'audio-events.json'));
  const cand: Candidate | undefined = loadCandidates(p.videoId).candidates.find((c) => c.id === p.candidateId);
  const pick = picker(`${clipId}:${style.key}`);
  const haveSfx = new Set(fs.existsSync(paths.sfx) ? fs.readdirSync(paths.sfx) : []);
  const sounds = (list?: string[]) => (list ?? []).filter((s) => haveSfx.has(s));

  // re-styling replaces what the engine added before (hand-placed markers stay)
  const before = p.markers.length;
  p.markers = p.markers.filter((m) => !ENGINE_SOURCES.has(m.source ?? ''));
  if (p.markers.length < before) report.notes.push(`replaced ${before - p.markers.length} earlier engine edits`);

  // the house style, if one is saved as the "default" preset
  const presetName = opts.preset ?? (listPresets().includes('default') ? 'default' : undefined);
  if (presetName && !p.markers.length) {
    p = await applyPreset(p, loadPreset(presetName), 'add');
    report.notes.push(`applied preset ${presetName}`);
  }

  // caption look (position and fixes stay)
  if (style.captions) p.captions = { ...p.captions, ...style.captions };

  const mark = (m: Omit<Marker, 'id' | 'proposed' | 'source'>, why: string) => {
    if (!types.has(m.type)) return;
    p.markers.push({ ...m, id: newMarkerId(), ...(opts.accept ? {} : { proposed: true }), source: 'autoedit' });
    report.added.push({ type: m.type, at: fmtTime(m.startMs), why });
  };
  const busy = (type: string, s: number, e: number) => p.markers.some((m) => m.type === type && m.startMs < e && (m.endMs ?? m.startMs + 1) > s);
  const words = t.words.filter((w) => w.startMs >= seg.startMs && w.endMs <= seg.endMs);

  // 1. hook text over the opening
  const hook = cand?.hook?.trim();
  if (style.hook && hook && !p.markers.some((m) => m.type === 'text' && m.startMs <= seg.startMs + 1000)) {
    const text = hook.split(/\s+/).length <= 9 ? hook : hook.split(/\s+/).slice(0, 8).join(' ') + '…';
    mark({ type: 'text', startMs: seg.startMs, endMs: Math.min(seg.endMs, seg.startMs + 3200), params: { ...defaults('text'), text, style: style.hook.style } }, 'hook from the candidate');
  }

  // 2. punchlines: the content word just before each laugh; the last laugh is the payoff
  const laughs = laughsIn(ae, t, seg.startMs + 1500, seg.endMs);
  const picked = laughs.length <= 3 ? laughs : [laughs[0], laughs[Math.floor(laughs.length / 2)], laughs[laughs.length - 1]];
  let n = 0;
  if (style.punch) {
    const P = style.punch;
    for (const [k, laugh] of picked.entries()) {
      const near = words.filter((w) => w.startMs <= laugh + 300 && w.endMs >= laugh - 3500);
      const punch = [...near].reverse().find(isContent) ?? near[near.length - 1];
      if (!punch || busy('zoom', punch.startMs, punch.startMs + 1)) continue;
      const at = punch.startMs;
      const last = k === picked.length - 1;
      if (P.zoom) mark({ type: 'zoom', startMs: at, endMs: Math.min(seg.endMs, at + 1800), params: { ...defaults('zoom'), scale: P.zoom.scale, easing: P.zoom.easing, rampMs: P.zoom.easing === 'smooth' ? 500 : 300 } }, `punchline "${punch.text}" before a laugh`);
      const sfx = sounds(P.sfx);
      if (sfx.length && (P.sfxOn === 'all' || k === 0 || last)) mark({ type: 'sfx', startMs: at, params: { ...defaults('sfx'), sound: pick(sfx, k), volume: 0.8 } }, 'sound on the punchline');
      if (P.flash && n === 0) mark({ type: 'flash', startMs: at, params: { ...defaults('flash'), opacity: 0.6 } }, 'flash on the first punchline');
      if (P.shake && last) mark({ type: 'shake', startMs: at, endMs: Math.min(seg.endMs, at + 600), params: { ...defaults('shake'), intensity: 0.45 } }, 'shake on the payoff');
      if (P.emoji?.length) mark({ type: 'emoji', startMs: Math.min(seg.endMs - 300, laugh + 150), params: { ...defaults('emoji'), emoji: pick(P.emoji, k), x: k % 2 ? 0.24 : 0.76 } }, 'emoji on the laugh');
      if (P.riser && last && sounds(['riser.wav']).length && at - 1400 > seg.startMs + 500) mark({ type: 'sfx', startMs: at - 1400, params: { ...defaults('sfx'), sound: 'riser.wav', volume: 0.5 } }, 'riser into the payoff');
      n++;
    }
  }

  // 3. no laughs: a slow push-in on the quoted line keeps the energy up
  if (!n && style.pushIn && cand?.quote) {
    const q = cand.quote.toLowerCase().replace(/[^a-z0-9' ]/g, '').split(/\s+/).filter(Boolean);
    const idx = words.findIndex((w, k) => q.slice(0, 3).every((x, j) => (words[k + j]?.text ?? '').toLowerCase().replace(/[^a-z0-9']/g, '') === x));
    if (idx >= 0) {
      const w = words[idx];
      const end = words[Math.min(words.length - 1, idx + q.length - 1)].endMs;
      mark({ type: 'zoom', startMs: w.startMs, endMs: Math.min(seg.endMs, Math.max(end, w.startMs + 2000)), params: { ...defaults('zoom'), scale: 1.15, easing: 'smooth', rampMs: 600 } }, 'slow push-in on the key line');
    } else report.notes.push("no laughs and the quote wasn't found: no emphasis added");
  }

  // 4. SHOUTED words (all caps in the captions) and exclamations: a pop and a quick zoom
  if (style.emphasis) {
    const sfx = sounds(style.emphasis.sfx);
    let k = 0;
    for (let i = 0; i < words.length && k < 2; i++) {
      const w = words[i];
      const core = w.text.replace(/[^A-Za-z]/g, '');
      const shouted = core.length >= 3 && core === core.toUpperCase();
      if (!shouted && !/!$/.test(w.text)) continue;
      if (busy('zoom', w.startMs - 1500, w.startMs + 1500)) continue;
      let j = i;
      while (j + 1 < words.length && words[j + 1].text.replace(/[^A-Za-z]/g, '') === words[j + 1].text.replace(/[^A-Za-z]/g, '').toUpperCase() && words[j + 1].startMs - words[j].endMs < 400) j++;
      const end = Math.min(seg.endMs, Math.max(words[j].endMs, w.startMs + 900), w.startMs + 2500);
      mark({ type: 'zoom', startMs: w.startMs, endMs: end, params: { ...defaults('zoom'), scale: style.emphasis.zoom, easing: 'snap' } }, `shouted "${w.text}"`);
      if (sfx.length) mark({ type: 'sfx', startMs: w.startMs, params: { ...defaults('sfx'), sound: pick(sfx, 10 + k), volume: 0.7 } }, 'pop on the shout');
      k++;
      i = j;
    }
  }

  // 5. shouts heard in the audio: a short shake
  if (style.shouts) {
    const shouts = (ae?.events ?? []).filter((x) => /shout|scream|yell/.test(x.label) && x.confidence >= 0.6 && x.ms >= seg.startMs && x.ms < seg.endMs - 500);
    let k = 0;
    for (const s of shouts) {
      if (k >= 2 || busy('shake', s.ms - 2000, s.ms + 2000)) continue;
      mark({ type: 'shake', startMs: s.ms, endMs: Math.min(seg.endMs, s.ms + 500), params: { ...defaults('shake'), intensity: 0.4 } }, 'shake on a shout');
      k++;
    }
  }

  // 6. retention punch-ins: a snap zoom on every other sentence that's long enough
  if (style.retention) {
    const ss = sentences(words);
    let k = 0;
    ss.forEach((s, i) => {
      if (i % 2 === 0 || s.end - s.start < style.retention!.minSentenceMs) return;
      if (busy('zoom', s.start, s.end)) return;
      mark({ type: 'zoom', startMs: s.start, endMs: s.end, params: { ...defaults('zoom'), scale: style.retention!.scale, easing: 'snap', focusY: 0.4 } }, 'punch-in on alternate sentence');
      k++;
    });
    if (k) report.notes.push(`${k} retention punch-ins`);
  }

  // 7. dead air, with the style's transition and sound at each join
  if (opts.cuts ?? style.cuts.silence) {
    const cuts = await suggestSilenceCuts(p, {});
    const tr = style.cuts.transition;
    for (const c of cuts) {
      p.markers.push({ ...c, params: { ...c.params, transition: tr, transitionMs: tr === 'crossfade' ? 250 : 220 }, source: 'autoedit', ...(opts.accept ? { proposed: undefined } : {}) });
      report.added.push({ type: 'cut', at: fmtTime(c.startMs), why: `${((c.endMs! - c.startMs) / 1000).toFixed(1)} s of dead air${tr !== 'none' ? `, ${tr} join` : ''}` });
      const cs = sounds(style.cuts.sfx ? [style.cuts.sfx] : []);
      if (cs.length) mark({ type: 'sfx', startMs: c.endMs!, params: { ...defaults('sfx'), sound: cs[0], volume: 0.5 } }, 'sound on the join');
    }
  }

  // 8. caption mishearings the comments revealed ("shelters" → "shooters")
  for (const w of cand?.warnings ?? []) {
    const m = /captions say "([^"]+)".*says "([^"]+)".*\(word #(\d+)\)/.exec(w);
    if (!m) continue;
    const i = Number(m[3]);
    const orig = t.words[i]?.text ?? '';
    if (p.captions.fixes[String(i)] !== undefined) continue;
    const fixed = orig.replace(/[A-Za-z']+/, (core) => (core[0] === core[0].toUpperCase() ? m[2][0].toUpperCase() + m[2].slice(1) : m[2]));
    p.captions.fixes[String(i)] = fixed;
    report.captionFixes.push({ i, from: orig, to: fixed });
  }

  p.markers.sort((a, b) => a.startMs - b.startMs);
  saveProject(p);

  // 9. reframe on faces (separate step: needs the footage)
  if (opts.reframe) {
    const { autoReframe } = await import('../reframe/apply');
    const r = await autoReframe(clipId, { accept: opts.accept });
    report.added.push({
      type: 'reframe',
      at: fmtTime(seg.startMs),
      why: 'split' in r && r.split ? 'split facecam/gameplay layout' : `${r.keyframes} crop keyframes following faces`,
    });
  }
  return report;
}

export function printAutoEdit(r: AutoEditReport, log = console.log) {
  log(`${r.clipId}: ${r.added.length} edits proposed (style ${r.style})`);
  for (const a of r.added) log(`  + ${a.type.padEnd(7)} ${a.at.padEnd(9)} ${a.why}`);
  for (const f of r.captionFixes) log(`  ✎ caption #${f.i}: "${f.from}" → "${f.to}"`);
  for (const n of r.notes) log(`  · ${n}`);
}
