// YouTube json3 captions → transcript.json (word timings) and transcript.md (what the judge reads).
import type { Transcript, Word, VideoMeta, SponsorSegment } from '../core/schemas';
import { fmtTime } from '../core/time';

interface Json3 {
  events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number }[] }[];
}

export function transcriptFromJson3(videoId: string, j: Json3, lang = 'en'): Transcript {
  const raw: { ms: number; text: string; speakerChange: boolean }[] = [];
  const tags: { ms: number; tag: string }[] = [];

  for (const ev of j.events ?? []) {
    if (!ev.segs) continue;
    const t0 = ev.tStartMs ?? 0;
    const segs = ev.segs.filter((s) => (s.utf8 ?? '').trim() !== '');
    // YouTube's auto-captions often write background music as a line of just "Heat." — make it a tag.
    const line = segs.map((s) => s.utf8 ?? '').join(' ').replace(/>>/g, '').trim();
    if (/heat/i.test(line) && /^((heat|hey)[.,!]?\s*)+$/i.test(line)) {
      tags.push({ ms: t0, tag: 'music' });
      continue;
    }
    segs.forEach((seg, k) => {
      const ms = t0 + (seg.tOffsetMs ?? 0);
      let text = (seg.utf8 ?? '').replace(/\s+/g, ' ').trim();
      let speakerChange = false;
      if (text.startsWith('>>')) {
        speakerChange = true;
        text = text.replace(/^>>\s*/, '');
      }
      // pull out [laughter]-style tags; "[__]" / "[ __ ]" is YouTube's censored swear word: keep it as a word
      text = text.replace(/\[([^\]]+)\]/g, (_, tag: string) => {
        if (/^\s*_+\s*$/.test(tag)) return ' [__] ';
        tags.push({ ms, tag: tag.toLowerCase().trim() });
        return ' ';
      });
      const parts = text.split(/\s+/).filter(Boolean);
      if (!parts.length) return;
      // A seg is normally one word; manual captions put a whole line in one seg, so spread those evenly.
      const nextMs = k + 1 < segs.length ? t0 + (segs[k + 1].tOffsetMs ?? 0) : t0 + Math.min(ev.dDurationMs ?? 2000, 4000);
      const step = Math.max(80, (nextMs - ms) / parts.length);
      parts.forEach((p, n) => raw.push({ ms: Math.round(ms + n * step), text: p, speakerChange: speakerChange && n === 0 }));
    });
  }

  raw.sort((a, b) => a.ms - b.ms);
  const words: Word[] = [];
  for (let n = 0; n < raw.length; n++) {
    const w = raw[n];
    const prev = words[words.length - 1];
    if (prev && prev.startMs === w.ms && prev.text === w.text) continue; // duplicate
    const nextMs = raw[n + 1]?.ms ?? w.ms + 1000;
    const guess = Math.min(1200, Math.max(200, w.text.length * 80 + 120));
    words.push({
      i: words.length,
      startMs: w.ms,
      endMs: Math.max(w.ms + 1, Math.min(nextMs, w.ms + guess)),
      text: w.text,
      ...(w.speakerChange ? { speakerChange: true } : {}),
    });
  }
  return { videoId, source: 'youtube-auto', lang, words, tags };
}

const SENTENCE_END = /[.?!…]["')\]]*$/;
export const endsSentence = (w: Word | undefined) => !!w && SENTENCE_END.test(w.text);

export interface Line {
  startMs: number;
  endMs: number;
  text: string;
  firstWord: number;
  lastWord: number;
}

/** Group words into readable lines: break on speaker change, long pauses, or sentence ends after ~6 s. */
export function buildLines(t: Transcript): Line[] {
  const lines: Line[] = [];
  const tagsByWord = new Map<number, string[]>();
  let ti = 0;
  const tags = [...t.tags].sort((a, b) => a.ms - b.ms);
  t.words.forEach((w, n) => {
    const next = t.words[n + 1];
    while (ti < tags.length && (!next || tags[ti].ms < next.startMs)) {
      if (tags[ti].ms >= w.startMs || n === 0) {
        tagsByWord.set(n, [...(tagsByWord.get(n) ?? []), tags[ti].tag]);
      }
      ti++;
    }
  });

  let cur: Line | undefined;
  t.words.forEach((w, n) => {
    const prev = t.words[n - 1];
    const gap = prev ? w.startMs - prev.endMs : 0;
    const len = cur ? w.startMs - cur.startMs : 0;
    const breakHere =
      !cur || w.speakerChange || gap > 900 || len > 14000 || (len > 6000 && endsSentence(prev));
    if (breakHere) {
      if (cur) lines.push(cur);
      cur = { startMs: w.startMs, endMs: w.endMs, text: '', firstWord: n, lastWord: n };
      if (w.speakerChange) cur.text = '» ';
    }
    cur!.text += (cur!.text && !cur!.text.endsWith(' ') ? ' ' : '') + w.text;
    for (const tag of tagsByWord.get(n) ?? []) cur!.text += ` [${tag}]`;
    cur!.endMs = w.endMs;
    cur!.lastWord = n;
  });
  if (cur) lines.push(cur);
  return lines;
}

export function renderTranscriptMd(
  t: Transcript,
  meta: VideoMeta,
  sponsors: SponsorSegment[],
  range?: { fromMs: number; toMs: number },
): string {
  const lines = buildLines(t);
  const out: string[] = [];
  if (!range) {
    out.push(`# ${meta.title}`);
    out.push(`${meta.id} · ${fmtTime(meta.durationMs, 0)} · ${meta.channel} · ${t.source === 'whisper' ? 'Whisper transcript' : 'YouTube auto-captions'}`);
    out.push(
      'Each line: [m:ss.s] text. "»" = new speaker. [laughter]/[applause] are caption tags. "##" = chapter. "⛔" = sponsor, muted or non-content range (never clip it). "⋯" = not transcribed yet.',
    );
    out.push('');
  }
  // streams are transcribed in windows: show the gaps so nobody reads silence into them
  const gaps: { startMs: number; endMs: number }[] = [];
  if (t.covered) {
    let at = 0;
    for (const c of t.covered) {
      if (c.startMs > at) gaps.push({ startMs: at, endMs: c.startMs });
      at = Math.max(at, c.endMs);
    }
    if (at < meta.durationMs) gaps.push({ startMs: at, endMs: meta.durationMs });
  }
  const marks: { ms: number; text: string }[] = [
    ...gaps
      .filter((g) => !range || (g.endMs > range.fromMs && g.startMs < range.toMs))
      .map((g) => ({ ms: g.startMs, text: `⋯ not transcribed ${fmtTime(g.startMs, 0)}–${fmtTime(g.endMs, 0)} ⋯` })),
    ...meta.chapters.map((c) => ({ ms: c.startMs, text: `## ${fmtTime(c.startMs, 0)} ${c.title}` })),
    ...sponsors
      .filter((s) => s.category !== 'poi_highlight' && s.category !== 'filler')
      .map((s) => ({ ms: s.startMs, text: `⛔ ${s.category} ${fmtTime(s.startMs, 0)}–${fmtTime(s.endMs, 0)}` })),
  ].sort((a, b) => a.ms - b.ms);
  let mi = 0;
  for (const l of lines) {
    if (range && (l.endMs < range.fromMs || l.startMs > range.toMs)) {
      while (mi < marks.length && marks[mi].ms <= l.startMs) mi++;
      continue;
    }
    while (mi < marks.length && marks[mi].ms <= l.startMs) out.push(marks[mi++].text);
    out.push(`[${fmtTime(l.startMs)}] ${l.text}`);
  }
  // marks after the last line (a gap at the end, a range with no words yet)
  while (mi < marks.length) {
    const m = marks[mi++];
    if (!range || (m.ms >= range.fromMs - 1 && m.ms <= range.toMs) || m.text.startsWith('⋯')) out.push(m.text);
  }
  return out.join('\n') + '\n';
}
