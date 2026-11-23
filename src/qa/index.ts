// Automatic QA on an export before a person sees it: length, loudness, dead air, black frames,
// caption overflow and content risk. Results go to exports/<clip>.qa.json and the review screen.
import path from 'node:path';
import { paths, writeJson, readJsonIf } from '../core/paths';
import { run } from '../core/proc';
import { loadProject } from '../core/project';
import { loadCandidates } from '../candidates';
import { endingWarnings, hookWarnings } from './hook';
import type { AdultCheck } from './adult';
import type { UnsafeCheck } from './unsafe';
import type { LanguageCheck } from './language';

export interface QaIssue {
  level: 'fail' | 'warn';
  check: string;
  detail: string;
}

export interface QaReport {
  clipId: string;
  passed: boolean;
  issues: QaIssue[];
  loudnessLufs: number | null;
  durationS: number;
  checkedAt: string;
  /** The 18+ check (src/qa/adult.ts): where the review page's 18+ check starts. */
  adult?: AdultCheck;
  /** The never-post check (src/qa/unsafe.ts) on this render: the publishers refuse what it found. */
  unsafe?: UnsafeCheck;
  /** Swearing, measured (src/qa/language.ts): warnings only. */
  language?: LanguageCheck;
}

const TARGET_LUFS = -14;

export async function measureLoudness(file: string): Promise<{ lufs: number | null; truePeak: number | null }> {
  const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const tail = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const I = /I:\s+(-?[\d.]+) LUFS/.exec(tail);
  const tp = /Peak:\s+(-?[\d.]+) dBFS/.exec(tail);
  return { lufs: I ? Number(I[1]) : null, truePeak: tp ? Number(tp[1]) : null };
}

export async function qaClip(clipId: string): Promise<QaReport> {
  const file = path.join(paths.exports, `${clipId}.mp4`);
  const issues: QaIssue[] = [];
  const p = loadProject(clipId);

  const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const durationS = Number(probe.stdout.trim());
  if (!durationS) throw new Error(`no export for ${clipId}`);
  // the same limits as the upload scheduler (tools/upload-cron.ts): a clip it would refuse fails here,
  // before anyone reviews it, instead of being approved and then turned away at upload
  if (durationS > 60) issues.push({ level: 'fail', check: 'length', detail: `${durationS.toFixed(1)} s: over 60 s. YouTube blocks a claimed Short over a minute and the upload scheduler refuses it: trim it` });
  else if (durationS < 5) issues.push({ level: 'fail', check: 'length', detail: `${durationS.toFixed(1)} s: under 5 s, a broken export` });
  else if (durationS < 10) issues.push({ level: 'warn', check: 'length', detail: `${durationS.toFixed(1)} s: very short` });

  const { lufs } = await measureLoudness(file);
  if (lufs !== null && Math.abs(lufs - TARGET_LUFS) > 2) issues.push({ level: 'warn', check: 'loudness', detail: `${lufs.toFixed(1)} LUFS (target ${TARGET_LUFS})` });

  // dead air (> 1.5 s of near-silence) and black frames
  const sd = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=noise=-45dB:d=1.5', '-vf', 'blackdetect=d=0.3:pix_th=0.08', '-f', 'null', '-']);
  const silences = [...sd.stderr.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)].map((m) => ({ end: Number(m[1]), dur: Number(m[2]) }));
  for (const s of silences) issues.push({ level: 'warn', check: 'dead air', detail: `${s.dur.toFixed(1)} s of silence ending at ${s.end.toFixed(1)} s` });
  const blacks = [...sd.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)];
  for (const b of blacks) issues.push({ level: 'fail', check: 'black frames', detail: `black from ${Number(b[1]).toFixed(1)} s to ${Number(b[2]).toFixed(1)} s` });

  // hook: the first 1.5 s decide most of the stop rate. Flag silence, a black open, a long wait,
  // or a filler word. The rest (is the face interesting, is the line a hook) needs a person.
  try {
    const { loadTranscript } = await import('../ingest/ingest');
    const { buildLines } = await import('../ingest/transcript');
    const seg = p.segments[0];
    const transcript = loadTranscript(p.videoId);
    const firstWord = transcript.words.find((w) => w.endMs > seg.startMs && w.startMs < seg.endMs);
    const firstSilence = silences.find((s) => s.end - s.dur <= 0.25);
    const firstBlack = blacks.map((b) => Number(b[1])).find((t) => t <= 0.25);
    for (const w of hookWarnings({
      silenceAtStartS: firstSilence?.dur,
      blackAtStartS: firstBlack,
      firstWordOffsetMs: firstWord ? Math.max(0, firstWord.startMs - seg.startMs) : undefined,
      firstWord: firstWord?.text,
    }))
      issues.push({ level: 'warn', check: 'hook', detail: w });
    // and the other half: does it end on the payoff or on a question/transition?
    const lines = buildLines(transcript).filter((l) => l.endMs > seg.startMs && l.startMs < seg.endMs);
    for (const w of endingWarnings({ lastLine: lines[lines.length - 1]?.text }))
      issues.push({ level: 'warn', check: 'payoff', detail: w });
  } catch {
    // no transcript: the visual checks above still ran
  }

  // captions: pages shrink to fit, so flag only words that would shrink below 75% (hard to read)
  if (p.captions.enabled) {
    const { loadTranscript } = await import('../ingest/ingest');
    const { CHAR_EM, CAPTION_WIDTH } = await import('../core/captionMetrics');
    const words = loadTranscript(p.videoId).words.filter((w) => w.startMs >= p.segments[0].startMs && w.endMs <= p.segments[0].endMs);
    const em = CHAR_EM[p.captions.style];
    const tiny = words.map((w) => p.captions.fixes[String(w.i)] ?? w.text).filter((t) => CAPTION_WIDTH / (t.length * em) < p.captions.fontSize * 0.75);
    if (tiny.length) issues.push({ level: 'warn', check: 'captions', detail: `shrunk a lot to fit: ${[...new Set(tiny)].slice(0, 3).join(', ')}` });
  }

  // things a person must check: content risk and leftover proposals
  const cand = loadCandidates(p.videoId).candidates.find((c) => c.id === p.candidateId);
  for (const w of cand?.warnings ?? []) if (w.startsWith('risk:')) issues.push({ level: 'warn', check: 'content', detail: w.replace(/^risk:\s*/, '') });
  const { isStillImage } = await import('../ingest/media');
  if (isStillImage(p.videoId)) issues.push({ level: 'warn', check: 'footage', detail: 'the source is a still image (audio-only upload): this short is static art with captions' });
  // this channel posts other people's streams: an export that does not say whose it is does not go out
  const { loadChannel } = await import('../core/channel');
  const { CREDIT } = await import('../core/project');
  const rendered = readJsonIf<{ credit?: boolean }>(path.join(paths.exports, `${clipId}.json`));
  const inProject = p.markers.some((m) => m.type === CREDIT && !m.proposed);
  // the render says whether the credit was in the picture; a credit added since is not in this file yet
  if (loadChannel().creditOnScreen && !(rendered?.credit ?? false)) issues.push({ level: 'fail', check: 'credit', detail: inProject ? `this export was rendered before the creator's credit was on the clip: render again` : `the creator is not named on screen: \`clip credit ${clipId}\` adds the line, then render again` });
  // the framed picture, as the render checked it (src/qa/layout.ts)
  const layout = readJsonIf<{ layout?: { ok: boolean; issues: string[]; fellBack?: string } }>(path.join(paths.exports, `${clipId}.json`))?.layout;
  if (layout && !layout.ok) for (const d of layout.issues) issues.push({ level: 'fail', check: 'layout', detail: d });
  if (layout?.fellBack) issues.push({ level: 'warn', check: 'layout', detail: `rendered blur-fit instead of split (${layout.fellBack.replace(/^split → blur-fit: /, '')}); the split boxes are still in the project` });
  const proposed = p.markers.filter((m) => m.proposed).length;
  if (proposed) issues.push({ level: 'warn', check: 'edits', detail: `${proposed} proposed edits aren't in this render` });

  // sexual content: a lead for the reviewer's 18+ check (age-restricted on YouTube), never a failure
  let adult: AdultCheck | undefined;
  try {
    const { checkAdult } = await import('./adult');
    adult = await checkAdult(clipId);
    if (adult.detected) issues.push({ level: 'warn', check: '18+', detail: `sexual content (${adult.reasons.join('; ')}): the review page's 18+ check starts ticked` });
  } catch {
    // the check is a lead; QA stands without it
  }
  // never posted, approved or not (the publishers refuse it): a failure the reviewer sees before A
  let unsafe: UnsafeCheck | undefined;
  try {
    const { checkUnsafe } = await import('./unsafe');
    unsafe = await checkUnsafe(clipId, adult);
    for (const r of unsafe.reasons) issues.push({ level: 'fail', check: 'unsafe', detail: `never posted: ${r.why}` });
  } catch {
    // the publisher runs it again before any upload
  }

  // swearing: how much is heard, in the open, unmasked in the captions, in the title (warnings only)
  let language: LanguageCheck | undefined;
  try {
    const { wordsThatPlay } = await import('./adult');
    const { checkLanguage, languageWarnings } = await import('./language');
    const { suggestedPost } = await import('../core/project');
    const { postFor } = await import('../core/post');
    language = checkLanguage({ words: await wordsThatPlay(clipId), captions: p.captions, title: postFor(p.post, suggestedPost(p)).title });
    for (const w of languageWarnings(language)) issues.push({ level: 'warn', check: 'language', detail: w });
  } catch {
    // no transcript: nothing said to measure
  }

  const report: QaReport = {
    clipId,
    passed: !issues.some((i) => i.level === 'fail'),
    issues,
    loudnessLufs: lufs,
    durationS,
    checkedAt: new Date().toISOString(),
    ...(adult ? { adult } : {}),
    ...(unsafe ? { unsafe } : {}),
    ...(language ? { language } : {}),
  };
  writeJson(path.join(paths.exports, `${clipId}.qa.json`), report);
  return report;
}

export const loadQa = (clipId: string) => readJsonIf<QaReport>(path.join(paths.exports, `${clipId}.qa.json`));

/** Bring an export to -14 LUFS (what Shorts, TikTok and Reels normalise to) with a -1 dBTP ceiling. */
export async function normalizeLoudness(file: string, out: string): Promise<{ before: number | null; gainDb: number }> {
  const { lufs } = await measureLoudness(file);
  if (lufs === null || !isFinite(lufs)) return { before: lufs, gainDb: 0 };
  const gain = Math.max(-20, Math.min(20, TARGET_LUFS - lufs));
  const r = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', file,
    '-c:v', 'copy',
    '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=false`,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    out,
  ]);
  if (r.code !== 0) throw new Error(`loudness normalisation failed: ${r.stderr.slice(-300)}`);
  return { before: lufs, gainDb: gain };
}
