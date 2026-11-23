// Auto-reframe for crop mode: turns face detections into a few crop keyframes.
// The camera follows one subject (the speaker when lips can be read, else the biggest face), moves only when that
// subject leaves a central dead zone, waits a cooldown between moves, and hard-cuts instead of panning on big jumps.
// When the source itself cuts to a new shot, the reframe cuts with it: on the same frame and without waiting out the
// cooldown, since a cut hidden in a cut is invisible.
// Pure functions with no Node imports, so the Studio can use them too.
import type { FaceResult } from './faces';
import { clamp } from '../core/time';

export interface ReframeKeyframe {
  atMs: number; // source ms
  cropX: number; // Framing.cropX from here on: 0 = window at the left edge, 1 = at the right edge
  cut: boolean; // true: jump at atMs; false: a short pan that starts at atMs (see cropXAt)
}

export interface ReframeOptions {
  minHoldMs?: number; // cooldown between camera moves (default 1500); source cuts don't wait for it
  deadZone?: number; // central fraction of the window the subject can roam without moving the camera (default 0.4)
  zoom?: number; // Framing.zoom; zooming in narrows the window (default 1)
}

export interface SubjectSample {
  ms: number;
  x?: number; // smoothed centre of the subject, 0–1 of the source width; missing = no subject, hold
  track?: number; // which face track the subject is
}

/** Suggested length of a pan (cut: false), used by cropXAt. */
export const PAN_MS = 500;

// Which faces count
const MIN_FACE_H = 0.03; // smaller faces (fraction of frame height) are background
const BACKGROUND_RATIO = 0.5; // faces under half the height of the biggest face in frame are background
const CROWD_FACES = 5; // this many faces makes a crowd shot ...
const CROWD_MIN_H = 0.06; // ... in which only faces at least this big count

// Tracking and speaker detection
const TRACK_GAP_MS = 1500; // a face missing for longer than this comes back as a new track
const MOUTH_MIN_H = 0.1; // lip landmarks on smaller faces are too noisy to tell talking from not
const SPEAK_WINDOW_MS = 1200; // mouth activity is the spread of openness over this window, centred
const SPEAK_MIN = 0.06; // ... and at least this much counts as talking (close-ups: ~0.03 silent, 0.07–0.1 talking)
const SPEAK_LEAD = 1.4; // the speaker must be this much more active than the next readable face
const STICKY_RATIO = 0.7; // the current subject stays while it is at least this big next to the biggest face
const TIE_RATIO = 0.7; // faces this close in size to the biggest count as equally big: the nearest one wins
const SWITCH_MS = 600; // a new subject must keep winning this long before the camera switches to it
const GRACE_MS = 1500; // a subject missing this briefly in the same shot (a missed detection) is waited for
const SHOT_LOOK_MS = 1000; // a new subject is picked from this much of the shot ahead
const RECENT_MS = 1500; // ties between equally big faces go to the one nearest the subject's position over this window

// Camera
const SMOOTH_MS = 500; // the subject's position is averaged over this window
const SETTLE_MS = 400; // the subject must stay outside the dead zone this long before the camera moves
const LOOKAHEAD_MS = 1000; // a move aims at where the subject is over the next second, so it lands where they settle
const KEEP_IN_VIEW = 0.6; // ... while keeping where they are now within this central fraction of the window
const FRESH_SHOT_MS = 1500; // the first look at a new shot this soon after a source cut is placed on the cut itself
const SHOT_END_MS = 1000; // no pan or cut this close before a source cut: the shot is about to change anyway

interface Face {
  ms: number;
  cx: number;
  cy: number;
  h: number;
  mouth?: number;
  track: number;
  fresh: boolean; // first sighting of its track
  activity?: number; // mouth activity, when enough lip readings
}

/** Width of the 9:16 window as a fraction of the source width (FramedVideo's crop mode). */
export function windowWidth(srcW: number, srcH: number, zoom = 1) {
  return Math.min(1, 9 / 16 / (srcW / srcH) / zoom);
}

/** Window centre (0–1 of the source width) → Framing.cropX. */
function toCropX(centre: number, win: number) {
  return win >= 1 ? 0.5 : clamp((centre - win / 2) / (1 - win));
}
function clampCentre(centre: number, win: number) {
  return win >= 1 ? 0.5 : Math.min(1 - win / 2, Math.max(win / 2, centre));
}
const round = (v: number) => Math.round(v * 1000) / 1000;
const median = (vs: number[]) => {
  const s = [...vs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
function byTrack(faces: Face[]) {
  const map = new Map<number, Face[]>();
  for (const f of faces) {
    const list = map.get(f.track);
    if (list) list.push(f);
    else map.set(f.track, [f]);
  }
  return map;
}

/** Source cuts: from the detector when it reported them, else guessed where every face is new at once. */
function sourceCuts(result: FaceResult, frames: Face[][]): number[] {
  if (result.cuts) return result.cuts;
  return frames.flatMap((faces, i) =>
    i > 0 && faces.length && frames[i - 1].length && faces.every((f) => f.fresh) ? [faces[0].ms] : [],
  );
}

function candidates(result: FaceResult): Face[][] {
  return result.samples.map((s) => {
    let faces = s.faces.filter((f) => f.h >= MIN_FACE_H);
    if (faces.length >= CROWD_FACES) faces = faces.filter((f) => f.h >= CROWD_MIN_H);
    const maxH = Math.max(0, ...faces.map((f) => f.h));
    return faces
      .filter((f) => f.h >= BACKGROUND_RATIO * maxH)
      .map((f) => ({ ms: s.ms, cx: f.x + f.w / 2, cy: f.y + f.h / 2, h: f.h, mouth: f.mouth, track: -1, fresh: true }));
  });
}

/** Link faces across samples by position and size, so a person keeps one track id for the length of a shot. */
function track(frames: Face[][], samplesMs: number[], aspect: number, cuts: number[] | undefined) {
  let live: Face[] = []; // last sighting of each track
  let next = 0;
  frames.forEach((faces, i) => {
    const ms = samplesMs[i];
    // A source cut ends every track: nobody carries over into a new shot.
    if (cuts && i > 0 && cuts.some((c) => c > samplesMs[i - 1] && c <= ms)) live = [];
    live = live.filter((t) => ms - t.ms <= TRACK_GAP_MS);
    const pairs: { f: Face; t: Face; d: number }[] = [];
    for (const f of faces) {
      for (const t of live) {
        const ratio = f.h / t.h;
        if (ratio < 0.67 || ratio > 1.5) continue; // a different shot size: not the same face
        const d = Math.hypot((f.cx - t.cx) * aspect, f.cy - t.cy) / Math.max(f.h, t.h); // in face heights
        if (d < 0.8) pairs.push({ f, t, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    const taken = new Set<Face>();
    for (const { f, t } of pairs) {
      if (f.track >= 0 || taken.has(t)) continue;
      f.track = t.track;
      f.fresh = false;
      taken.add(t);
    }
    for (const f of faces) {
      if (f.track < 0) f.track = next++;
      live = live.filter((t) => t.track !== f.track).concat(f);
    }
  });
}

/** Mouth activity: spread of lip openness over a short window. Talking swings it; a still or smiling mouth doesn't. */
function measureActivity(frames: Face[][]) {
  for (const faces of byTrack(frames.flat()).values()) {
    for (const f of faces) {
      const vals = faces
        .filter((g) => g.mouth !== undefined && Math.abs(g.ms - f.ms) <= SPEAK_WINDOW_MS / 2)
        .map((g) => g.mouth!);
      if (vals.length < 4) continue;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      f.activity = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    }
  }
}

/** The best subject in one sample: a clear speaker, else the current subject if still prominent, else the biggest face. */
function choose(faces: Face[], current: number | undefined, lastX: number): Face {
  if (faces.length === 1) return faces[0];
  const readable = faces
    .filter((f) => f.activity !== undefined && f.h >= MOUTH_MIN_H)
    .sort((a, b) => b.activity! - a.activity!);
  if (readable.length >= 2) {
    const [top, next] = [readable[0].activity!, readable[1].activity!];
    if (top >= SPEAK_MIN && top >= SPEAK_LEAD * next) return readable[0];
  }
  const maxH = Math.max(...faces.map((f) => f.h));
  const cur = faces.find((f) => f.track === current);
  if (cur && cur.h >= STICKY_RATIO * maxH) return cur;
  // Faces about as big as the biggest (a wide shot): take the one nearest the camera, so it moves least.
  const big = faces.filter((f) => f.h >= TIE_RATIO * maxH);
  return big.reduce((a, b) => (Math.abs(a.cx - lastX) <= Math.abs(b.cx - lastX) ? a : b));
}

function analyse(result: FaceResult) {
  const samplesMs = result.samples.map((s) => s.ms);
  const frames = candidates(result);
  track(frames, samplesMs, result.width / result.height, result.cuts);
  measureActivity(frames);
  const cuts = sourceCuts(result, frames);
  const cutBefore = (i: number) => i > 0 && cuts.some((c) => c > samplesMs[i - 1] && c <= samplesMs[i]);

  const chosen: (Face | undefined)[] = [];
  let current: number | undefined;
  let seenMs = -Infinity;
  let pending: { track: number; i: number } | undefined;
  // Roughly where the camera is: the subject's median position lately (a last-moment lean shouldn't count).
  let recent: Face[] = [];
  const lastX = () => (recent.length ? median(recent.map((f) => f.cx)) : 0.5);

  // A new subject is picked from the next second of the shot, not one sample: in wide shots the detector misses
  // faces often, and the first face it happens to find is no better a choice than any other.
  const chooseAhead = (i: number) => {
    const end = Math.min(samplesMs[i] + SHOT_LOOK_MS, cuts.find((c) => c > samplesMs[i]) ?? Infinity);
    const ahead: Face[] = [];
    for (let j = i; j < frames.length && samplesMs[j] < end; j++) ahead.push(...frames[j]);
    const reps = [...byTrack(ahead).values()].map((fs) => {
      const acts = fs.flatMap((f) => (f.activity === undefined ? [] : [f.activity]));
      return {
        ...fs[0],
        cx: median(fs.map((f) => f.cx)),
        h: median(fs.map((f) => f.h)),
        activity: acts.length ? median(acts) : undefined,
        seen: fs.length,
      };
    });
    // Faces seen only once in that second are likely false or passing detections.
    const steady = reps.filter((r) => r.seen >= 2);
    return choose(steady.length ? steady : reps, undefined, lastX());
  };

  frames.forEach((faces, i) => {
    const ms = samplesMs[i];
    if (cutBefore(i)) {
      // The subject's track ended with the shot.
      current = undefined;
      pending = undefined;
    }
    if (!faces.length) return;
    if (current === undefined || (!faces.some((f) => f.track === current) && ms - seenMs > GRACE_MS)) {
      // No subject yet, or it's been gone too long: pick a new one. A subject missing only briefly is waited for.
      current = chooseAhead(i).track;
      pending = undefined;
      seenMs = ms;
    }
    const best = choose(faces, current, lastX());
    const present = faces.some((f) => f.track === current);
    if (best.track === current || !present) pending = undefined;
    else if (pending?.track !== best.track) pending = { track: best.track, i };
    else if (ms - samplesMs[pending.i] >= SWITCH_MS) {
      // Confirmed switch: it really started when the new subject first won, so follow it from there.
      current = best.track;
      for (let j = pending.i; j < i; j++) chosen[j] = frames[j].find((f) => f.track === current) ?? chosen[j];
      pending = undefined;
    }
    const subject = faces.find((f) => f.track === current);
    if (subject) {
      chosen[i] = subject;
      seenMs = ms;
      recent = recent.filter((f) => ms - f.ms <= RECENT_MS).concat(subject);
    }
  });

  const subjects: SubjectSample[] = samplesMs.map((ms, i) => {
    const s = chosen[i];
    if (!s) return { ms };
    // Average the same subject's position over a short window to take out detector jitter.
    const near = chosen.filter((c): c is Face => c?.track === s.track && Math.abs(c.ms - ms) <= SMOOTH_MS / 2);
    return { ms, x: near.reduce((a, c) => a + c.cx, 0) / near.length, track: s.track };
  });
  return { subjects, cuts };
}

/**
 * Crop keyframes for a 9:16 window over the source: the first at the start of the range, then one per camera move.
 * cropX uses Framing's convention (position of the window across the free horizontal space).
 */
export function planReframe(result: FaceResult, opts: ReframeOptions = {}): ReframeKeyframe[] {
  const minHold = opts.minHoldMs ?? 1500;
  const win = windowWidth(result.width, result.height, opts.zoom);
  const deadHalf = ((opts.deadZone ?? 0.4) * win) / 2;
  const { subjects, cuts } = analyse(result);
  if (!subjects.length) return [{ atMs: 0, cropX: 0.5, cut: true }];

  // Where to put the window for a subject from a given moment: the median over the next second, so a subject
  // who is still moving (or a source camera still panning) is met where they settle. But never so far ahead
  // that they are outside the central part of the window at the moment of the move.
  const aim = (from: number, subject: SubjectSample) => {
    let ahead = subjects.filter((s) => s.track === subject.track && s.ms >= from && s.ms <= from + LOOKAHEAD_MS);
    if (!ahead.length) ahead = [subject];
    const now = ahead[0].x!;
    const reach = (KEEP_IN_VIEW * win) / 2;
    return clampCentre(Math.min(now + reach, Math.max(now - reach, median(ahead.map((s) => s.x!)))), win);
  };

  const startMs = subjects[0].ms;
  // Open on the first subject seen within the cooldown, so the clip doesn't start with a move; else the centre.
  const first = subjects.find((s) => s.x !== undefined && s.ms - startMs <= minHold);
  let centre = first ? aim(first.ms, first) : 0.5;
  const plan: ReframeKeyframe[] = [{ atMs: startMs, cropX: round(toCropX(centre, win)), cut: true }];
  let lastMoveMs = startMs;
  let outsideSince: number | undefined;
  let shotStart = -Infinity;
  let freshShot = false; // a source cut happened and the camera hasn't looked at the new shot yet

  for (const s of subjects) {
    const cut = cuts.filter((c) => c <= s.ms).at(-1);
    if (cut !== undefined && cut > shotStart) {
      shotStart = cut;
      outsideSince = undefined;
      freshShot = true;
    }
    if (s.x === undefined) continue; // no subject: hold
    const fresh = freshShot && s.ms - shotStart <= FRESH_SHOT_MS;
    freshShot = false; // only the first look at a new shot can cut with the source
    if (Math.abs(clampCentre(s.x, win) - centre) <= deadHalf) {
      outsideSince = undefined;
      continue;
    }
    outsideSince ??= s.ms;
    let atMs: number;
    let hard: boolean;
    let target: number;
    if (fresh) {
      // The source just cut: cut with it, on the same frame.
      atMs = shotStart;
      hard = true;
      target = aim(s.ms, s);
    } else {
      // Wait until the subject has really left (not just leaned), then move from when they left, cooldown allowing.
      if (s.ms - outsideSince < SETTLE_MS) continue;
      atMs = Math.max(outsideSince, lastMoveMs + minHold);
      if (atMs > s.ms) continue; // still cooling down
      if (cuts.some((c) => c > atMs && c - atMs < SHOT_END_MS)) continue; // the shot ends soon: let the cut handle it
      target = aim(atMs, s);
      hard = Math.abs(target - centre) > win / 2;
    }
    if (Math.abs(target - centre) <= deadHalf / 2) continue; // where they settle is close enough already
    plan.push({ atMs, cropX: round(toCropX(target, win)), cut: hard });
    centre = target;
    lastMoveMs = atMs;
    outsideSince = undefined;
  }
  return plan;
}

/** cropX at a source time: cuts jump, pans ease over panMs. For previews and for building the render's crop path. */
export function cropXAt(plan: ReframeKeyframe[], ms: number, panMs = PAN_MS): number {
  if (!plan.length) return 0.5;
  let k = 0;
  while (k + 1 < plan.length && plan[k + 1].atMs <= ms) k++;
  const kf = plan[k];
  if (k === 0 || kf.cut || ms >= kf.atMs + panMs) return kf.cropX;
  const from = plan[k - 1].cropX;
  const t = (ms - kf.atMs) / panMs;
  return from + (kf.cropX - from) * t * t * (3 - 2 * t); // smoothstep
}
