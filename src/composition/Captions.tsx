// Word-timed captions: TikTok-style pages with the spoken word highlighted.
import React, { useMemo } from 'react';
import { AbsoluteFill, Sequence, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { createTikTokStyleCaptions, type Caption, type TikTokPage } from '@remotion/captions';
import type { CaptionSettings, Word } from '../core/schemas';
import { srcToT, type TimeMap } from '../core/timeline';
import { msToFrames } from '../core/time';
import { CHAR_EM, CAPTION_WIDTH } from '../core/captionMetrics';
import { FONT } from './context';
import { fontFamilyOf } from './fonts';
import { CYCLE_COLORS, isLoud, lookOf, splitPages } from '../core/captionLooks';
import { maskSwearing } from '../core/risk';
import { HEIGHT as H } from './props';

const SENTENCE_END = /[.?!…]["')\]]*$/;

/** Apply fixes and hide YouTube's censor marks. Returns null for hidden words. */
/** A word as the captions show it: its fix if it has one, YouTube's [__] as ****, and (unless the clip
 *  turned `censor` off) strong swears and slurs masked. null when the word is hidden. */
export function captionText(w: Word, fixes: Record<string, string>, censor = true): string | null {
  const fixed = fixes[String(w.i)];
  const text = fixed ?? w.text;
  if (!text.trim()) return null;
  const shown = text.replace(/\[__\]/g, '****');
  return censor ? maskSwearing(shown) : shown;
}

const bare = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}*]/gu, '');

/**
 * A word or a phrase of up to three words said three or more times in a row is one caption: the phrase once,
 * with "X3" on its last word, shown until the last repeat ends ("SIT DOWN X3"; docs/research/meme-edits-2026-11-22.md).
 * Pure; works on any list of timed words.
 */
export function collapseRepeats<T extends { text: string; t0: number; t1: number }>(list: T[], min = 3): T[] {
  const out: T[] = [];
  let i = 0;
  while (i < list.length) {
    let best: { n: number; times: number } | null = null;
    for (let n = 1; n <= 3 && i + n * min <= list.length; n++) {
      const key = list.slice(i, i + n).map((x) => bare(x.text)).join(' ');
      if (!key.replace(/ /g, '')) continue;
      let times = 1;
      while (i + (times + 1) * n <= list.length && list.slice(i + times * n, i + (times + 1) * n).map((x) => bare(x.text)).join(' ') === key) times++;
      if (times >= min && (!best || times * n > best.times * best.n)) best = { n, times };
    }
    if (!best) {
      out.push(list[i]);
      i++;
      continue;
    }
    const phrase = list.slice(i, i + best.n);
    const lastOfRun = list[i + best.n * best.times - 1];
    phrase.forEach((x, k) => out.push(k === phrase.length - 1 ? { ...x, text: `${x.text.replace(/[.,!?…]+$/, '')} X${best!.times}`, t1: lastOfRun.t1 } : x));
    i += best.n * best.times;
  }
  return out;
}

/** Caption tokens on the edited timeline, in composition ms (0 = first frame). Words inside cuts or
 *  outside the clip are dropped; words in sped-up spans get shorter. */
export function captionTokens(words: Word[], s: CaptionSettings, map: TimeMap): Caption[] {
  const list: { text: string; t0: number; t1: number; speakerNext: boolean }[] = [];
  const shown = words.map((w) => ({ w, text: captionText(w, s.fixes, s.censor !== false) }));
  shown.forEach(({ w, text }, k) => {
    if (text === null) return;
    const t0 = srcToT(map, w.startMs);
    if (t0 === null || t0 < 0 || t0 >= map.durationMs) return;
    const tEnd = srcToT(map, Math.max(w.startMs, w.endMs - 1));
    const t1 = Math.min(map.durationMs, tEnd !== null && tEnd > t0 ? tEnd : t0 + 250);
    list.push({ text, t0, t1, speakerNext: !!shown[k + 1]?.w.speakerChange });
  });
  const tokens = s.repeats === false ? list : collapseRepeats(list);
  return tokens.map((x, k) => ({
    text: (k === 0 ? '' : ' ') + x.text,
    startMs: x.t0 - map.tStart,
    endMs: x.t1 - map.tStart,
    timestampMs: null,
    confidence: null,
    pageBreakAfter: SENTENCE_END.test(x.text) || x.speakerNext,
  }));
}

export function buildPages(tokens: Caption[], s: CaptionSettings) {
  const pages = createTikTokStyleCaptions({ captions: tokens, combineTokensWithinMilliseconds: s.combineMs, breakOnSilenceAfterMilliseconds: 700 }).pages;
  // a look shows a few words at a time (street: 3): short phrases read at a glance
  return splitPages(pages, lookOf(s.style).maxWords);
}

export const Captions: React.FC<{ tokens: Caption[]; settings: CaptionSettings; clipEndMs: number }> = ({ tokens, settings, clipEndMs }) => {
  const { fps } = useVideoConfig();
  const pages = useMemo(() => buildPages(tokens, settings), [tokens, settings]);
  return (
    <AbsoluteFill style={{ zIndex: 20 }}>
      {pages.map((page, k) => {
        const lastTo = page.tokens[page.tokens.length - 1]?.toMs ?? page.startMs + 500;
        const next = pages[k + 1]?.startMs ?? Infinity;
        const end = Math.min(next, lastTo + 600, clipEndMs);
        const from = msToFrames(page.startMs, fps);
        const dur = msToFrames(end, fps) - from;
        if (dur <= 0) return null;
        return (
          <Sequence key={k} from={from} durationInFrames={dur} layout="none">
            <CaptionPage page={page} s={settings} index={k} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const CaptionPage: React.FC<{ page: TikTokPage; s: CaptionSettings; index: number }> = ({ page, s, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const look = lookOf(s.style);
  const t = page.startMs + (frame * 1000) / fps;
  // shrink a page whose longest word wouldn't fit the 900 px safe width ("counterproductive.")
  const longest = Math.max(...page.tokens.map((tk) => tk.text.trim().length), 1);
  const fit = Math.min(s.fontSize, Math.floor(CAPTION_WIDTH / (longest * CHAR_EM[look.key])));
  const loud = isLoud(page.tokens);
  const pageColor = look.highlight === 'loud' && loud ? s.highlightColor : look.highlight === 'cycle' ? CYCLE_COLORS[index % CYCLE_COLORS.length] : 'white';

  // how the phrase arrives: snap (street) overshoots a touch, rise slides up, pop grows in
  const snap = spring({ frame, fps, config: { damping: 14, stiffness: 260 }, durationInFrames: 6 });
  const soft = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 5 });
  const enter =
    look.animation === 'snap'
      ? `scale(${0.82 + 0.18 * snap})`
      : look.animation === 'rise'
        ? `translateY(${(1 - soft) * 14}px)`
        : look.animation === 'pop'
          ? `scale(${0.9 + 0.1 * soft})${look.highlight === 'cycle' ? ` rotate(${(1 - soft) * -4}deg)` : ''}`
          : '';
  const shadow =
    look.shadow === 'hard'
      ? `0 ${Math.round(fit * 0.08)}px 0 rgba(0,0,0,0.95)`
      : look.shadow === 'soft'
        ? `0 ${Math.round(fit * 0.06)}px ${Math.round(fit * 0.18)}px rgba(0,0,0,0.7)`
        : undefined;
  const text: React.CSSProperties = {
    fontFamily: look.font === 'montserrat' && !look.italic ? FONT : fontFamilyOf(look.font),
    fontWeight: look.weight,
    fontStyle: look.italic ? 'italic' : 'normal',
    fontSize: fit,
    lineHeight: look.box ? 1.4 : 1.08,
    letterSpacing: look.font === 'barlow' ? '0.01em' : undefined,
    textTransform: s.uppercase ? 'uppercase' : 'none',
    whiteSpace: 'pre-wrap',
    color: pageColor,
    WebkitTextStroke: look.stroke ? `${Math.max(2, Math.round(fit * look.stroke))}px black` : undefined,
    paintOrder: 'stroke',
    textShadow: shadow,
  };
  const inner = page.tokens.map((tok, k) => {
    const active = look.highlight === 'word' && tok.fromMs <= t && t < tok.toMs;
    return (
      <span key={k} style={active ? { color: s.highlightColor } : undefined}>
        {k === 0 ? tok.text.trimStart() : tok.text}
      </span>
    );
  });
  return (
    <div
      style={{
        position: 'absolute',
        left: 90,
        right: 90,
        top: s.position * H,
        textAlign: 'center',
        transform: `translateY(-50%) ${enter}`,
      }}
    >
      {look.box ? (
        <span
          style={{
            ...text,
            background: 'rgba(0,0,0,0.78)',
            padding: '4px 22px',
            borderRadius: 18,
            boxDecorationBreak: 'clone',
            WebkitBoxDecorationBreak: 'clone',
          }}
        >
          {inner}
        </span>
      ) : (
        <div style={text}>{inner}</div>
      )}
    </div>
  );
};
