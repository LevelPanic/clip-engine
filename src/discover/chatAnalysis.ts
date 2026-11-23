// Reading stream chat: when it spikes above the channel's normal level, and what kind of reaction
// it is. Pure functions (tested in test/chat.test.ts).
//
// - Rate = distinct chatters per 10 s (one person spamming counts once), in 5 s steps.
// - Normal = median rate over the trailing 5 minutes, so it follows a stream that gets busier.
// - A spike is a rate ≥ 2.2× normal with at least 6 chatters. Chat reacts after the moment
//   (stream delay plus typing time), so the moment is taken to be the 25 s before the spike starts.
// - Bot accounts don't count. Only fetched ranges count: unfetched chat is unknown, not quiet.
import type { Range } from '../core/ranges';

export type ChatMessage = [number, string, string];
export type Reaction = 'funny' | 'hype' | 'shock' | 'tension' | 'fail' | 'rage' | 'cringe' | 'irony' | 'agree';

export interface ChatSpike {
  startMs: number; // first 5 s step above the threshold
  endMs: number;
  peakMs: number;
  ratio: number; // peak rate ÷ normal
  chatters: number; // distinct chatters in the peak 10 s
  normal: number; // normal chatters per 10 s around it
  reaction?: Reaction;
  reactions: Partial<Record<Reaction, number>>;
  clipRequests: number; // distinct people saying "clip it"
  top: { text: string; count: number }[]; // the most repeated messages
  /** Chat is busy because another channel raided (its viewers arrive spamming a raid message), not because of a moment. */
  raid?: boolean;
}

const STEP = 5_000;
const WINDOW = 10_000;
const TRAIL = 5 * 60_000;
export const SPIKE_RATIO = 2.2;
export const MIN_CHATTERS = 6;
export const LEAD_MS = 25_000; // how long before the spike the moment starts

export const BOTS = new Set(['nightbot', 'streamelements', 'fossabot', 'moobot', 'streamlabs', 'sery_bot', 'wizebot', 'botrixoficial', 'soundalerts', 'pokemoncommunitygame', 'kofistreambot', 'streamstickers', 'creatisbot', 'own3d', 'tangiabot']);

// What chat types when something happens, grouped by the reaction it signals. Tokens are matched after
// `normToken` (lowercase, trailing punctuation dropped, stretched letters collapsed: "LMAOOO" → "lmao",
// "WWWW" → "w", "hahahaha" → "haha"). Keep every chat word list in the engine here: the queue checkers,
// the chat signal and `clip chat` all read reactions through `reactionOf`.
//
//   funny   – laughing at it                      hype  – cheering a play or a win
//   shock   – disbelief or confusion              tension – fear, suspense: the payoff has not happened yet
//   fail    – mocking a loss, a death, a mistake  rage  – the streamer is losing it
//   cringe  – awkward, second-hand embarrassment, innuendo ("ayo", "pause": run the risk checks)
//   irony   – chat knows something the streamer doesn't, or mocks a claim ("Clueless", "COPIUM",
//             "pepeLaugh", "cinema"). The outcome is usually still to come: look later, not earlier.
//   agree   – a take landed ("TRUE", "REAL", "based"): evidence for an opinion clip, not a gag
//
// Sources (2026-11-12): StreamElements usage stats, emote dictionaries, Know Your Meme, Merriam-Webster
// slang, and chat seen in this library. Emote meaning is set by use and differs by channel (a channel
// may ban KEKW and laugh with LULW), so a spike's mood is a lead for the expert, never a verdict.
// Unverified outside this library: "sob" and "geeg" (seen next to LOL and gg here).
const LEXICON: Record<Reaction, string[]> = {
  funny: [
    'lul', 'lulw', 'lule', 'kekw', 'kekl', 'kek', 'omegalul', 'ome', 'lmao', 'lmfao', 'lol', 'lolw', 'xd', 'xdd', 'xdx', 'icant', 'elegiggle',
    'haha', 'rofl', 'deadge', 'imdead', 'imcrying', 'sob', 'bahaha', 'omegadance', 'pointandlaugh', '😂', '🤣', '💀', '😭',
  ],
  hype: [
    'pog', 'pogchamp', 'poggers', 'pogu', 'poggies', 'pogcrazy', 'letsgo', 'lfg', 'hypers', 'ez', 'ezclap', 'w', 'ww', 'gigachad', 'chad',
    'peepoclap', 'clap', 'goat', 'goated', 'insane', 'hype', 'cracked', 'clean', 'clutch', 'nasty', 'sheesh', 'godlike', 'huge', 'massive',
    'peak', 'holy', 'lethimcook', '🔥', '🐐', '👏',
  ],
  shock: ['what', 'wtf', 'wth', 'huh', 'd:', 'wutface', 'noway', 'aintnoway', 'pausechamp', 'omg', 'omfg', 'yoo', 'hello?', 'excuse', 'jumpscare', '😳', '😱', '😨', '🫢'],
  tension: ['monkas', 'monkaw', 'monkagiga', 'monkaomega', 'prayge', 'scared', 'scary', 'nervous', 'careful', 'peepows'],
  fail: [
    'l', 'll', 'sadge', 'f', 'o7', 'cooked', 'rip', 'ripbozo', 'pepehands', 'biblethump', 'joever', 'itsjoever', 'unlucky', 'washed', 'fraud',
    'fraudwatch', 'throw', 'throwing', 'choke', 'choked', 'sold', 'selling', 'bozo', 'ratio', 'ff', 'gg', 'geeg', 'nt', 'pain', 'despair',
    'notlikethis', 'failfish', 'jebaited', 'pepega', 'deserved', '🤡',
  ],
  rage: ['crashout', 'malding', 'mald', 'madge', 'tilted', 'raging', 'unhinged'],
  cringe: [
    'cringe', 'weirdchamp', 'weird', 'ick', 'yikes', 'awkward', 'monkahmm', 'dansgame', 'susge', 'sus', 'corny', 'eww', 'ew', 'crickets', 'bruh',
    'uhh', 'uhm', 'umm', 'erm', 'ermactually', 'stare', 'oof', 'ayo', 'ayoo', 'pause', '4head', '😬',
  ],
  irony: [
    'kappa', 'clueless', 'aware', 'cinema', 'copium', 'copege', 'hopium', '5head', 'surely', 'trust', 'pepelaugh', 'pepepoint', 'kekwait', 'clipfarming',
    // chat does not believe it: "cap", "LARP", "AI" (seen in this library on a faked purchase and a tall story)
    'cap', 'capping', 'capper', 'larp', 'larping', 'fake', 'scripted', 'staged', 'acting', 'bait', 'ragebait', 'ai',
  ],
  agree: ['true', 'real', 'facts', 'fax', '+1', '+2', 'based', 'valid', 'yep', 'nodders', 'fr', 'frfr', 'exactly'],
};
const WORD_TO_REACTION = new Map<string, Reaction>();
for (const [r, words] of Object.entries(LEXICON) as [Reaction, string[]][]) for (const w of words) WORD_TO_REACTION.set(w, r);

// Ordinary words that are a reaction only when chat shouts or stretches them: "NO", "nooo", "YOOO",
// "WAIT", "OOOO". In a normal sentence ("no I think he's right") they say nothing.
const EMPHATIC: Record<string, Reaction> = { no: 'shock', nah: 'shock', yo: 'shock', wait: 'shock', bro: 'shock', hell: 'shock', stop: 'shock', o: 'hype', yes: 'hype', go: 'hype', run: 'tension', help: 'tension' };

// Phrases, checked on the whole message before the word lists.
const PHRASES: [RegExp, Reaction][] = [
  [/\b(chat )?is this real\b|\babsolute cinema\b|\byeah right\b|\bsure buddy\b|\bhe (doesn'?t|doesnt|dont|don'?t) know\b|\bclip farm(ing)?\b/, 'irony'],
  [/\b(ain'?t|aint) no way\b|\bno (shot|way)\b|\bwhat the (f\w*|hell|heck)\b|\bholy (shit|crap|moly|fuck)\b|\b(wait|bro) what\b|\bexcuse me\b/, 'shock'],
  [/\boh no+\b|\buh oh\b|\bbehind you\b|\bi'?m scared\b/, 'tension'],
  [/\bcrash(ing|ed)? out\b|\b(he|she)'?s (so )?mad\b|\bcalm down\b/, 'rage'],
  [/\bso true\b|\bw take\b|\bno cap\b/, 'agree'],
  [/\blet'?s go+\b|\blets go+\b|\blet him cook\b|\bw (chat|stream|streamer|clip|rizz)\b|\bez clap\b/, 'hype'],
  [/\bit'?s (so )?(over|joever)\b|\b(he|she|they|you|we|i)'?(s|re|m)? (is |are |am )?(so )?cooked\b|\b(big )?l (take|chat|bozo|rizz|streamer)\b|\bbig l\b|\bskill issue\b|\bgo next\b/, 'fail'],
  [/^i can'?t+[!. ]*$|\bi'?m (dead|crying|weak|done)\b/, 'funny'],
  [/\bsecond hand embarrassment\b|\bso awkward\b/, 'cringe'],
];

/**
 * Chat saying the moment is not what it looks like: a lie, an act, a fake screenshot, a set-up. The same
 * words as the doubt entries in LEXICON (which set the mood), counted per person here; "AI" only as a whole
 * message, because "ai" inside a sentence is usually about something else.
 */
const DOUBT_MESSAGE = /\b(cap(ping|per)?|larp(ing)?|fake|scripted|staged|acting|clip ?farm(ing)?|(rage ?)?bait)\b|^a+i+[!?.]*$/i;

/** A short message that is an answer to a yes/no question: "yes", "YESSS", "nah", "fuck no", "1", "2". */
function voteOf(message: string): 'yes' | 'no' | undefined {
  const words = message.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return undefined;
  const last = normToken(words[words.length - 1]);
  if (['yes', 'yep', 'yea', 'yeah', 'ye', 'yessir', 'y', '1'].includes(last)) return 'yes';
  if (['no', 'nope', 'nah', 'n', '2'].includes(last)) return 'no';
  return undefined;
}

/** Subs, gifted subs, Bits and hype trains fill chat without anything happening on stream. */
const EVENT_MESSAGE = /\b(gift(ed|ing)? (a |\d+ )?(tier \d )?subs?|sub(scribed|scription)|resub|hype ?train|sub ?train|prime sub|ty for the (sub|gift|bits)|thanks for the (sub|gift|bits))\b|\bcheer\d{2,}\b/i;

/** A chat word as the lexicon spells it: lowercase, no trailing punctuation, stretched letters collapsed. */
export function normToken(word: string): string {
  let t = word.toLowerCase().replace(/[!.,;~*]+$/g, '');
  t = t.replace(/(.)\1{2,}/gu, '$1'); // "lmaooo" → "lmao", "wwww" → "w", "nooo" → "no"
  if (/^(ha|ah|he|ja|ka)\1+h?$/.test(t) || /^(ha){2,}/.test(t)) return 'haha';
  if (/^(lo)+l$|^l(ol)+$/.test(t)) return 'lol';
  if (/^lma+o+$|^lmfa+o+$/.test(t)) return t.startsWith('lmf') ? 'lmfao' : 'lmao';
  return t;
}

const isShouted = (word: string) => {
  const letters = word.replace(/[^\p{L}]/gu, '');
  return (letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) || /(.)\1{2,}/u.test(word);
};

/** "KEKW KEKW KEKW" → "KEKW"; trims and caps length so repeats group together. */
export function normalizeMessage(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const dedup = words.filter((w, i) => i === 0 || w.toLowerCase() !== words[i - 1].toLowerCase());
  return dedup.join(' ').slice(0, 60);
}

export function reactionOf(text: string): Reaction | undefined {
  const raw = text.trim();
  const t = raw.toLowerCase();
  if (/^\?+$/.test(t)) return 'shock';
  for (const [re, r] of PHRASES) if (re.test(t)) return r;
  const counts = new Map<Reaction, number>();
  for (const word of raw.split(/\s+/)) {
    const key = normToken(word);
    const r = WORD_TO_REACTION.get(key) ?? (isShouted(word) ? EMPHATIC[key] : undefined) ?? (/^\?{2,}$/.test(word) ? 'shock' : undefined);
    if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let best: Reaction | undefined;
  let n = 0;
  for (const [r, c] of counts) if (c > n) (best = r), (n = c);
  return best;
}

const isClipRequest = (text: string) => /\bclip(ped|ping| it| that| this| him| her| chat)\b|^clip!*$|\b(someone|somebody) clip\b|\bget the clip\b|\bthat'?s a clip\b|\bclip and ship\b/i.test(text.trim());

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Distinct chatters per 10 s, in 5 s steps; NaN where chat wasn't fetched. Index k covers [k·5 s, k·5 s + 10 s). */
export function chatRates(messages: ChatMessage[], fetched: Range[], durationMs: number): Float64Array {
  const n = Math.max(1, Math.ceil(durationMs / STEP));
  const users: Set<string>[] = Array.from({ length: n }, () => new Set());
  for (const [ms, user] of messages) {
    if (BOTS.has(user.toLowerCase())) continue;
    const k = Math.floor(ms / STEP);
    if (k >= 0 && k < n) users[k].add(user);
  }
  const rate = new Float64Array(n).fill(NaN);
  for (let k = 0; k < n; k++) {
    const a = k * STEP;
    const b = a + WINDOW;
    if (!fetched.some((r) => r.startMs <= a && r.endMs >= Math.min(b, durationMs))) continue;
    const both = new Set(users[k]);
    if (k + 1 < n) for (const u of users[k + 1]) both.add(u);
    rate[k] = both.size;
  }
  return rate;
}

/** Rate and the channel's normal rate at each 5 s step (NaN where chat wasn't fetched). */
export function chatLevels(messages: ChatMessage[], fetched: Range[], durationMs: number): { rate: Float64Array; normal: Float64Array } {
  const rate = chatRates(messages, fetched, durationMs);
  const trail = TRAIL / STEP;
  const normal = new Float64Array(rate.length).fill(NaN);
  for (let k = 0; k < rate.length; k++) {
    if (Number.isNaN(rate[k])) continue;
    const prev: number[] = [];
    for (let j = Math.max(0, k - trail); j < k; j++) if (!Number.isNaN(rate[j])) prev.push(rate[j]);
    // too little history (start of a fetched range): use what follows instead
    if (prev.length < 12) for (let j = k + 1; j < Math.min(rate.length, k + trail) && prev.length < trail; j++) if (!Number.isNaN(rate[j])) prev.push(rate[j]);
    normal[k] = Math.max(1.5, median(prev));
  }
  return { rate, normal };
}

export function findChatSpikes(messages: ChatMessage[], fetched: Range[], durationMs: number): ChatSpike[] {
  const { rate, normal } = chatLevels(messages, fetched, durationMs);
  const spikes: ChatSpike[] = [];
  let cur: ChatSpike | null = null;
  for (let k = 0; k < rate.length; k++) {
    const r = rate[k];
    const hot = !Number.isNaN(r) && r >= MIN_CHATTERS && r / normal[k] >= SPIKE_RATIO;
    if (hot) {
      const ratio = r / normal[k];
      if (!cur) cur = { startMs: k * STEP, endMs: k * STEP + WINDOW, peakMs: k * STEP, ratio, chatters: r, normal: normal[k], reactions: {}, clipRequests: 0, top: [] };
      else {
        cur.endMs = k * STEP + WINDOW;
        if (ratio > cur.ratio) Object.assign(cur, { ratio, peakMs: k * STEP, chatters: r, normal: normal[k] });
      }
    } else if (cur && k * STEP >= cur.endMs) {
      spikes.push(cur);
      cur = null;
    }
  }
  if (cur) spikes.push(cur);
  for (const s of spikes) describeSpike(s, messages);
  return spikes;
}

export interface ChatRead {
  /** Distinct people (bots excluded) who typed in the window. */
  chatters: number;
  /** The reaction at least three people shared, if any. */
  reaction?: Reaction;
  /** Distinct people per reaction. */
  reactions: Partial<Record<Reaction, number>>;
  /** Distinct people saying "clip it". */
  clipRequests: number;
  /** The most repeated messages, by distinct people. */
  top: { text: string; count: number }[];
  /** Another channel's viewers arriving: busy chat with no moment on stream. */
  raid: boolean;
  /**
   * Chat is busy for a reason that is not a moment: a raid, a burst of subs / a hype train, or a vote
   * (the streamer asked a question and chat is answering yes and no).
   */
  event?: 'raid' | 'subs' | 'vote';
  /** Several people pasting the same long message: usually boredom or a chat meme, not a reaction. */
  copypasta: boolean;
  /** Distinct people calling it fake, staged, a lie or AI. */
  doubt: number;
}

/** What chat said between `lo` and `hi`: reaction mix, clip requests, most repeated messages, raids. */
/** This many chatters calling a moment fake, staged or AI is a warning, not noise. */
export const DOUBT_MIN = 3;

export function readChat(messages: ChatMessage[], lo: number, hi: number, topN = 4): ChatRead {
  const by = new Map<string, Set<string>>(); // message → people who sent it
  const spelling = new Map<string, string>(); // the original spelling of each message group (first seen)
  const reacted = new Map<Reaction, Set<string>>();
  const clip = new Set<string>();
  const raiders = new Set<string>();
  const subbers = new Set<string>();
  const yes = new Set<string>();
  const no = new Set<string>();
  const doubters = new Set<string>();
  const chatters = new Set<string>();
  for (const [ms, user, text] of messages) {
    if (ms < lo || ms >= hi) continue;
    if (/raid/i.test(text)) raiders.add(user); // a raid: lots of chatters arriving with "raid" messages ("WW raid", "louuiRaid")
    if (EVENT_MESSAGE.test(text)) subbers.add(user);
    if (BOTS.has(user.toLowerCase())) continue;
    chatters.add(user);
    const norm = normalizeMessage(text);
    if (!norm) continue;
    const key = norm.toLowerCase();
    by.set(key, (by.get(key) ?? new Set()).add(user));
    if (!spelling.has(key)) spelling.set(key, norm);
    const r = reactionOf(norm);
    if (r) reacted.set(r, (reacted.get(r) ?? new Set()).add(user));
    if (isClipRequest(text)) clip.add(user);
    if (DOUBT_MESSAGE.test(text.trim())) doubters.add(user);
    const answer = voteOf(norm);
    if (answer === 'yes') yes.add(user);
    else if (answer === 'no') no.add(user);
  }
  let best: Reaction | undefined;
  let n = 0;
  for (const [r, u] of reacted) if (u.size > n) (best = r), (n = u.size);
  const top = [...by]
    .filter(([, u]) => u.size >= 2)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, topN)
    .map(([k, u]) => ({ text: spelling.get(k) ?? k, count: u.size }));
  const raid = raiders.size >= 8 && raiders.size >= 0.25 * chatters.size;
  const subs = subbers.size >= 6 && subbers.size >= 0.25 * chatters.size;
  // both camps answering at once is a vote on a question, not a gasp: a scare gets "NO", never "yes".
  // Over a long window the voters are a small share of everyone who typed, so the most repeated
  // messages decide too: when yes and no forms are most of what chat repeated, it was a vote.
  const repeated = top.reduce((n, t) => n + t.count, 0);
  const answers = top.filter((t) => voteOf(t.text)).reduce((n, t) => n + t.count, 0);
  const vote = yes.size >= 3 && no.size >= 3 && (yes.size + no.size >= 0.4 * chatters.size || (repeated > 0 && answers >= 0.5 * repeated));
  return {
    chatters: chatters.size,
    reaction: best && n >= 3 ? best : undefined,
    reactions: Object.fromEntries([...reacted].map(([r, u]) => [r, u.size])),
    clipRequests: clip.size,
    top,
    raid,
    ...(raid ? { event: 'raid' as const } : subs ? { event: 'subs' as const } : vote ? { event: 'vote' as const } : {}),
    copypasta: top.some((t) => t.count >= 4 && t.text.split(/\s+/).length >= 6),
    doubt: doubters.size,
  };
}

/** What chat said around a spike: reaction mix, clip requests, most repeated messages. */
function describeSpike(s: ChatSpike, messages: ChatMessage[]) {
  const r = readChat(messages, s.startMs - 5_000, s.endMs + 15_000);
  s.reactions = r.reactions;
  if (r.reaction) s.reaction = r.reaction;
  s.clipRequests = r.clipRequests;
  if (r.raid) s.raid = true;
  s.top = r.top;
}

/** Chat condensed for reading: one line per 10 s with the rate and the most repeated messages. */
export function chatDigest(messages: ChatMessage[], fetched: Range[], durationMs: number, range: Range): { ms: number; chatters: number; normal: number; top: string[] }[] {
  const { rate, normal } = chatLevels(messages, fetched, durationMs);
  const out: { ms: number; chatters: number; normal: number; top: string[] }[] = [];
  for (let a = Math.floor(range.startMs / WINDOW) * WINDOW; a < range.endMs; a += WINDOW) {
    const k = Math.floor(a / STEP);
    if (k >= rate.length || Number.isNaN(rate[k])) continue;
    const by = new Map<string, Set<string>>();
    const spelling = new Map<string, string>();
    for (const [ms, user, text] of messages) {
      if (ms < a || ms >= a + WINDOW || BOTS.has(user.toLowerCase())) continue;
      const t = normalizeMessage(text);
      if (!t) continue;
      by.set(t.toLowerCase(), (by.get(t.toLowerCase()) ?? new Set()).add(user));
      if (!spelling.has(t.toLowerCase())) spelling.set(t.toLowerCase(), t);
    }
    const top = [...by].sort((x, y) => y[1].size - x[1].size).slice(0, 3).map(([k2, u]) => `${spelling.get(k2)}${u.size > 1 ? ` ×${u.size}` : ''}`);
    out.push({ ms: a, chatters: rate[k], normal: normal[k], top });
  }
  return out;
}
