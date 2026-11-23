// The chat line for a chat card (docs/research/meme-edits-2026-11-22.md: 9% of top clip Shorts show a viewer's
// message big, a "Greenland is crazy"). We have every stream's chat replay, so the meme editor can pick the
// line chat actually said about the moment instead of writing one. Pure.
//
// A line has to be readable and safe to put on screen: a sentence (3–12 words, not an emote wall, a command,
// a link or an @), nothing from the risk lists (a slur, sexual words, a dox, self-harm, drugs), and strong
// swears are masked like the captions. Chat that echoes a line wins: the crowd's own caption.
import { BOTS, normalizeMessage, reactionOf, type ChatMessage } from '../discover/chatAnalysis';
import { maskSwearing, riskTerms, slurIn } from '../core/risk';
import { sexualTitleWords } from '../qa/adult';

export interface ChatLine {
  user: string;
  text: string;
  /** When it was first sent (source ms). */
  ms: number;
  /** How many people sent it. */
  echoes: number;
}

/** Twitch and 7TV emotes that are spelled like words: they read as noise on a card. */
const EMOTES = /^(lul|lulw|kek|kekw|omegalul|pog|pogu|poggers|pogchamp|kappa|monkas|monkaw|sadge|icant|ez|clap|catjam|pepega|pepelaugh|5head|copium|hopium|aware|bedge|o7|xd|lmao+|lmfao+|lol+|rofl|wtf|w|l)$/i;
/** A word a reader reads (not an emote such as PogChamp, KEKW or LUL, not a number). */
const readable = (w: string) => {
  const b = w.replace(/[.!?,]/g, '');
  return /^[a-z][a-z']*$/i.test(b) && !/[a-z][A-Z]/.test(b) && !/^[A-Z]{4,}$/.test(b) && !EMOTES.test(b);
};

/** Whether a message can go on screen as a card. Pure. */
export function cardable(text: string): boolean {
  const t = text.trim();
  if (t.length < 8 || t.length > 70) return false;
  if (/^[!/]|https?:|www\.|\.(com|tv|gg)\b|@/i.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length < 3 || words.length > 12) return false;
  const real = words.filter(readable);
  // a sentence: most words readable, and three different ones ("LUL LUL LUL" is an emote wall)
  if (real.length < Math.max(3, Math.ceil(words.length * 0.6)) || new Set(real.map((w) => w.toLowerCase().replace(/[.!?,]/g, ''))).size < 3) return false;
  if (words.some((w) => slurIn(w)) || riskTerms(t).length || sexualTitleWords(t).length) return false;
  return true;
}

/** The line chat said best between lo and hi (source ms), or null. Pure. */
export function pickChatLine(messages: ChatMessage[], lo: number, hi: number): ChatLine | null {
  const groups = new Map<string, { user: string; text: string; ms: number; users: Set<string> }>();
  for (const [ms, user, text] of messages) {
    if (ms < lo || ms >= hi || BOTS.has(user.toLowerCase()) || !cardable(text)) continue;
    const key = normalizeMessage(text).toLowerCase();
    if (!key) continue;
    const g = groups.get(key) ?? { user, text: text.trim(), ms, users: new Set<string>() };
    g.users.add(user);
    groups.set(key, g);
  }
  let best: { g: { user: string; text: string; ms: number; users: Set<string> }; score: number } | null = null;
  for (const g of groups.values()) {
    const reacts = !!reactionOf(normalizeMessage(g.text));
    // one person's line counts only when it reacts to the moment (a laugh, a gasp, hype)
    if (g.users.size < 2 && !reacts) continue;
    const score = g.users.size * 3 + (reacts ? 2 : 0) + (/[?!]$/.test(g.text) ? 0.5 : 0) - (g.text.length > 50 ? 1 : 0);
    if (!best || score > best.score || (score === best.score && g.ms < best.g.ms)) best = { g, score };
  }
  if (!best) return null;
  return { user: best.g.user, text: maskSwearing(best.g.text), ms: best.g.ms, echoes: best.g.users.size };
}
