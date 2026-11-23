// Fix names the auto-captions mishear, using the video's own metadata as the vocabulary.
// "Rec Room" came out as "Recreck Room", "Recck room" and "Wreck room"; "KreekCraft" as "CreekCraft".
// Only word text changes (never word count or order), so caption fixes keyed by word index stay valid.
import fs from 'node:fs';
import type { Transcript } from '../core/schemas';

const STOP = new Set(
  'the a an and or but of in on at to for with from by about into over after before is are was were be been this that these those it its his her their our your my we you they he she i me us them what when where who why how all any each every no not new full official episode podcast video live stream reaction part ft feat vs'.split(' '),
);

let dict: Set<string> | null | undefined;
/** The system word list (macOS ships one): a real word is never "corrected" into a name on its own. */
function dictionary(): Set<string> | null {
  if (dict !== undefined) return dict;
  try {
    dict = new Set(fs.readFileSync('/usr/share/dict/words', 'utf8').split('\n').map((w) => w.toLowerCase()));
  } catch {
    dict = null;
  }
  return dict;
}

const core = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Dictionary lookup that knows plurals and -ing/-ed forms (the word list only has base forms). */
function isWord(c: string): boolean {
  const d = dictionary();
  if (!d) return true; // no word list: be conservative and treat everything as a real word
  const forms = [c, c.replace(/ies$/, 'y'), c.replace(/es$/, ''), c.replace(/s$/, ''), c.replace(/ing$/, ''), c.replace(/ing$/, 'e'), c.replace(/(.)\1ing$/, '$1'), c.replace(/ed$/, ''), c.replace(/ed$/, 'e'), c.replace(/(.)\1ed$/, '$1'), c.replace(/er$/, ''), c.replace(/ly$/, '')];
  return forms.some((f) => f.length >= 2 && d.has(f));
}

/** Rough sound-alike key: c/ck/q → k, ph → f, z → s, silent w before r, doubled letters collapsed. */
export function phon(s: string): string {
  return core(s)
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/[cq]/g, 'k')
    .replace(/z/g, 's')
    .replace(/^wr/, 'r')
    .replace(/(.)\1+/g, '$1');
}

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export interface Term {
  tokens: string[];
  /** From the title or channel name: allowed to drive sound-alike fixes of multi-word names. */
  strong: boolean;
}

/** Proper names from metadata: capitalised runs of 1–3 words ("Rec Room", "Mark Cuban") and single
 *  unusual words ("KreekCraft", "Eminem"). Longer Title Case runs are headlines, not names, and chapter
 *  titles aren't used at all for the same reason. */
export function vocabulary(sources: { text: string; strong: boolean }[]): Term[] {
  const out = new Map<string, Term>();
  for (const { text, strong } of sources) {
    for (const line of text.split(/\n/)) {
      if (/https?:\/\//.test(line)) continue; // links and sponsor blurbs
      for (const m of line.matchAll(/[A-Z][A-Za-z0-9’']*(?:\s+[A-Z][A-Za-z0-9’']*)*/g)) {
        const toks = m[0].split(/\s+/).map((t) => t.replace(/[’']s$/, '')).filter((t) => core(t).length >= 2);
        while (toks.length && STOP.has(core(toks[0]))) toks.shift();
        while (toks.length && STOP.has(core(toks[toks.length - 1]))) toks.pop();
        if (strong && toks.length >= 2 && toks.length <= 3) out.set(toks.join(' ').toLowerCase(), { tokens: toks, strong });
        for (const t of toks) {
          const c = core(t);
          if (c.length >= 5 && !STOP.has(c) && !isWord(c) && !(t === t.toUpperCase() && !strong)) {
            const prev = out.get(c);
            out.set(c, { tokens: [t], strong: strong || !!prev?.strong });
          }
        }
      }
    }
  }
  return [...out.values()];
}

// replace the first run of letters/digits so punctuation and a trailing 's survive
const replaceCore = (text: string, to: string) => text.replace(/[A-Za-z0-9]+/, to);

export function applyVocabulary(t: Transcript, terms: Term[]): { i: number; from: string; to: string }[] {
  const fixes: { i: number; from: string; to: string }[] = [];
  const w = t.words;
  const set = (i: number, to: string) => {
    const from = w[i].text;
    const next = replaceCore(from, to);
    if (next !== from) {
      fixes.push({ i, from, to: next });
      w[i] = { ...w[i], text: next };
    }
  };
  for (const { tokens: term } of terms) {
    if (term.length >= 2) {
      // "Recck room" / "Wreck room" / "Recreck Room" → "Rec Room": the later words must match exactly,
      // the first may be a sound-alike or carry a stutter prefix.
      const [first, ...rest] = term;
      for (let i = 0; i + rest.length < w.length; i++) {
        if (!rest.every((r, k) => core(w[i + 1 + k].text) === core(r))) continue;
        const c = core(w[i].text);
        const f = core(first);
        if (c === f) continue; // already right (capitalisation alone isn't worth touching)
        const like = phon(c) === phon(first) || (c.length > f.length && c.endsWith(f)) || (f.length >= 3 && lev(phon(c), phon(first)) <= 1);
        if (!like) continue;
        set(i, first);
        rest.forEach((r, k) => set(i + 1 + k, r));
      }
    } else {
      // single names: only sound-alikes that aren't ordinary words ("CreekCraft" → "KreekCraft")
      const [name] = term;
      const p = phon(name);
      const stem = (z: string) => z.replace(/(ies|es|s|ed|ing)$/, '');
      for (let i = 0; i < w.length; i++) {
        const c = core(w[i].text);
        if (c.length < 4 || c === core(name)) continue;
        if (isWord(c)) continue;
        if (stem(c) === stem(core(name))) continue; // "midterm" vs "Midterms": an inflection, not a mishearing
        // "mid-term", "r/roblox": made of several pieces, leave alone (a trailing 's is fine)
        if ((w[i].text.replace(/['’]s\b/, '').match(/[A-Za-z0-9]+/g) ?? []).length > 1) continue;
        if (phon(c) === p || (p.length >= 7 && lev(phon(c), p) <= 1)) set(i, name);
      }
    }
  }
  return fixes;
}
