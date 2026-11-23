// Words that mean a person must look before a clip is posted. Browser-safe.
//
// These are word lists, so they are leads, not verdicts: they raise a flag with the word that matched
// and where; a person (or an expert looking at the frame) decides. Two uses:
//   - `riskTerms`: what chat, viewer-clip titles and speech say around a moment;
//   - `slurIn`: slurs typed in chat. Many streams show chat in the frame, so a slur in chat during a
//     clip can be a slur on screen in the clip, which no transcript check would ever see.

/** Categories of risk, each with the pattern that raises it. */
const RISK_TERMS: [string, RegExp][] = [
  ['privacy (leak, dox, address)', /\b(dox+(ed|ing)?|leak(ed|er|ing|s)?|leek(ed)?|address|phone number|license plate|credit card|order number)\b/i],
  ['sexual content', /\b(nude|naked|nsfw|sex|porn|dildo|penis|boobs?|tits|onlyfans|thirst trap)\b/i],
  ['hate or harassment', /\b(slurs?|racist|racism|homophob\w*|n[- ]word|hard r)\b/i],
  ['self-harm', /\b(suicide|kys|kill (yo)?urself|self[- ]harm)\b/i],
  ['swatting or threats', /\b(swat(ted|ting)|bomb threat|death threat)\b/i],
  ['drugs', /\b(coke|cocaine|meth|heroin|fent(anyl)?|crack|xans?|percs?|molly|shrooms|lsd)\b/i],
  ['platform action (TOS, ban, DMCA)', /\b(tos|banned|ban|strike|dmca|copyright)\b/i],
];

/** Risk categories whose words appear in `text`, with the word that matched. */
export function riskTerms(text: string): string[] {
  const out: string[] = [];
  for (const [label, re] of RISK_TERMS) {
    const m = re.exec(text);
    if (m) out.push(`${label}: "${m[0].toLowerCase()}"`);
  }
  return out;
}

// Slurs, written as patterns so common obfuscations (digits and symbols for vowels, stretched letters)
// still match. Kept short on purpose: the words platforms act on, not everything rude.
const SLURS =
  /\b(n+[i1!|]+[gq]{2,}[e3a@]+r*s?|n[i1!]gg?[a@4]h?s?|f+[a@4]+[gq]{1,2}([o0i1]+t)?s?|r+[e3]+t+[a@4]+r+d+(ed|s)?|tr[a@4]nn(y|ie)s?|k[i1]kes?|sp[i1]cs?|ch[i1]nks?|c[o0]{2}ns?|dykes?|g[o0]{2}ks?|wetbacks?|paki(s)?)\b/i;
/** Words the slur patterns would hit by accident. */
const NOT_SLURS = /^(fag(ged)?|coon(hound|skin)?s?|spic(e|es|y|ier)|chink(s)? in|niggle\w*|nigh\w*)$/i;

/** The first slur in a chat message or a line of text, lower-cased; undefined when there is none. */
export function slurIn(text: string): string | undefined {
  const all = text.trim().split(/\s+/).filter(Boolean);
  // "Sped" alone (or "SPED lol") is the insult; "he sped past them" is a verb
  if (all.length <= 2 && all.some((w) => /^sp[e3]d+s?$/i.test(w.replace(/[^\p{L}\p{N}]/gu, '')))) return 'sped';
  for (const word of all) {
    const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!bare || NOT_SLURS.test(bare)) continue;
    const m = SLURS.exec(bare);
    if (m && m[0].length >= bare.length - 2) return m[0].toLowerCase();
  }
  return undefined;
}

/** How many chat messages in a time range contain a slur, by how many people, and when the first was. */
export function chatSlurs(messages: [number, string, string][], startMs: number, endMs: number): { count: number; people: number; firstMs: number | null } {
  const people = new Set<string>();
  let count = 0;
  let firstMs: number | null = null;
  for (const [ms, user, text] of messages) {
    if (ms < startMs || ms >= endMs) continue;
    if (!slurIn(text)) continue;
    count++;
    people.add(user);
    if (firstMs === null || ms < firstMs) firstMs = ms;
  }
  return { count, people: people.size, firstMs };
}

// Strong swearing (reports/censorship-review-2026-11-22.md, B1 and A4). YouTube's advertiser guidelines
// treat the f-word as strong profanity, worst in the opening seconds, and its vulgar-language policy reads
// what is written on screen. Mild words (damn, hell, ass, crap) are left alone. Each pattern is a whole
// word, so "Scunthorpe", "shiitake" and "Dickens" are not hits.
const SWEARS: [string, RegExp, RegExp][] = [
  // [name, the whole word, the root whose letters after the first are masked]
  ['f-word', /^(mother)?f+u+c+k+\w*$/i, /f+u+c+k+/i],
  ['s-word', /^(bull|horse|dip|ape)?sh[i1]+t+(s|ty|tier|ting|ted|ter|head|heads|show|hole|holes|post|load|e)?$/i, /sh[i1]+t/i],
  ['b-word', /^bitch(es|y|ing|ass)?$/i, /bitch/i],
  ['c-word', /^cunts?$/i, /cunt/i],
  ['asshole', /^ass(hole|holes|wipe)$/i, /ass/i],
  ['dick', /^dick(s|head|heads)?$/i, /dick/i],
  ['pussy', /^puss(y|ies)$/i, /puss/i],
  ['bastard', /^bastards?$/i, /bastard/i],
];

const bareOf = (word: string) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** Which strong swear a word is ("f-word", "s-word", …), or undefined. A slur is not a swear: see `slurIn`. */
export function swearIn(word: string): string | undefined {
  const bare = bareOf(word);
  return bare ? SWEARS.find(([, whole]) => whole.test(bare))?.[0] : undefined;
}

/**
 * A caption with its strong swears masked (the root after its first letter: "f***ing", "bulls***") and
 * its slurs starred out whole. Case and punctuation stay. Pure and browser-safe: the caption renderer
 * uses it, so the Studio shows what the export will.
 */
export function maskSwearing(text: string): string {
  return text.replace(/\S+/g, (token) => {
    const bare = bareOf(token);
    if (!bare) return token;
    // "sped" is the slur only typed alone in chat; said in a caption it is the verb
    const slur = slurIn(bare);
    if (slur && slur !== 'sped') return token.replace(bare, '*'.repeat(bare.length));
    const hit = SWEARS.find(([, whole]) => whole.test(bare));
    if (!hit) return token;
    return token.replace(bare, bare.replace(hit[2], (root) => root[0] + '*'.repeat(root.length - 1)));
  });
}
