// Data formats shared by every part of the engine (browser-safe: zod only).
import { z } from 'zod';

// ---------- transcript ----------

export const WordSchema = z.object({
  i: z.number().int(), // index in transcript.words, used as a stable id (caption fixes)
  startMs: z.number().int(),
  endMs: z.number().int(),
  text: z.string(),
  speakerChange: z.boolean().optional(), // YouTube marks a new speaker with ">>"
});
export type Word = z.infer<typeof WordSchema>;

export const TranscriptSchema = z.object({
  videoId: z.string(),
  source: z.enum(['youtube-auto', 'youtube-manual', 'whisper']),
  lang: z.string(),
  words: z.array(WordSchema),
  tags: z.array(z.object({ ms: z.number().int(), tag: z.string() })), // [laughter], [applause], [music]
  /** Ranges transcribed so far (streams are transcribed only where they're scanned). Absent = all of it. */
  covered: z.array(z.object({ startMs: z.number().int(), endMs: z.number().int() })).optional(),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

// ---------- clip project ----------

export const MarkerSchema = z.object({
  id: z.string(),
  type: z.string(),
  startMs: z.number().int(), // source-video time, so markers stay on the content when the clip is trimmed
  endMs: z.number().int().optional(), // spans only
  params: z.record(z.string(), z.unknown()),
  /** Suggested by the engine or agent; shown dashed until accepted, never rendered while proposed. */
  proposed: z.boolean().optional(),
  /** Who suggested it, e.g. "silence", "autoedit", "auto-reframe". */
  source: z.string().optional(),
});
export type Marker = z.infer<typeof MarkerSchema>;

export const CaptionSettingsSchema = z.object({
  enabled: z.boolean(),
  /** The look (src/core/captionLooks.ts): street, commentary, comic, native, or the older bold/boxed/clean. */
  style: z.enum(['street', 'commentary', 'comic', 'native', 'bold', 'boxed', 'clean']),
  position: z.number().min(0.1).max(0.95), // vertical centre, fraction of frame height
  fontSize: z.number().min(30).max(160),
  uppercase: z.boolean(),
  highlightColor: z.string(),
  combineMs: z.number().min(0).max(3000), // words closer than this share a caption page
  fixes: z.record(z.string(), z.string()), // word index → corrected text ("" hides the word)
  /** Mask strong swears ("f***ing") and slurs ("*****") in the captions (2026-11-22: on unless turned off). Only the text: the audio needs a bleep marker. */
  censor: z.boolean().default(true),
  /** A word or phrase said 3+ times in a row shows once with "X3" (2026-11-22: on unless turned off). */
  repeats: z.boolean().default(true),
});
export type CaptionSettings = z.infer<typeof CaptionSettingsSchema>;

/** A rectangle in source-video coordinates: x/y are the top-left corner, w/h the size, all 0–1. */
export const FramingBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0.04).max(1),
  h: z.number().min(0.04).max(1),
});
export type FramingBox = z.infer<typeof FramingBoxSchema>;

/** Split layout: the facecam on top and gameplay below (Twitch and other 16:9 streams). */
export const SplitLayoutSchema = z.object({
  cam: FramingBoxSchema,
  game: FramingBoxSchema,
  camShare: z.number().min(0.15).max(0.8).default(0.35), // height of the facecam band, fraction of 1920
  /** Extra headroom above the cam box, as a fraction of the source height (0.04 ≈ 43 px at 1080p).
   *  The cam band is top-aligned so the hat/forehead is not cropped by the cover fit. Optional so
   *  projects saved before this field still load; the renderer uses 0.04 when it is absent. */
  camTopPad: z.number().min(0).max(0.2).optional(),
  /** A margin at the top and bottom of the 9:16 canvas, as a fraction of 1920 (0.04 ≈ 77 px each
   *  side), where the blurred cover of the frame shows. The shorter bands show more width. */
  canvasPad: z.number().min(0).max(0.1).optional(),
  /** How the band under the cam shows the stream: `fill` crops a window to cover it (games),
   *  `fit` shows the whole frame at full width on the blurred cover (Just Chatting, websites, menus).
   *  Absent = fill (projects from before this field). See src/core/layout.ts. */
  content: z.enum(['fill', 'fit']).optional(),
});
export type SplitLayout = z.infer<typeof SplitLayoutSchema>;

export const defaultSplitLayout = (): SplitLayout => ({
  // bottom-right-ish opening guess; "Find facecam" replaces it with measured boxes
  cam: { x: 0, y: 0, w: 0.36, h: 0.36 },
  game: { x: 0.26, y: 0, w: 0.48, h: 1 },
  camShare: 0.35,
  camTopPad: 0.04,
  canvasPad: 0.04,
});

export const FramingSchema = z.object({
  mode: z.enum(['blur', 'crop', 'split']), // blur-fit, fill-and-crop, or facecam over gameplay
  cropX: z.number().min(0).max(1), // crop mode: 0 = left edge, 0.5 = centre, 1 = right edge
  zoom: z.number().min(1).max(3), // extra base zoom on the main picture
  split: SplitLayoutSchema.default(() => defaultSplitLayout()), // split mode's boxes (always present after parsing)
});
export type Framing = z.infer<typeof FramingSchema>;

/**
 * Why a clip was turned down, one tap each on the review page. Kept apart from the note so the
 * learning loop can count them: a layout reject and a boring-moment reject need different fixes.
 */
export const REJECT_REASONS = [
  { key: 'boring', label: 'Boring / no payoff' },
  { key: 'layout', label: 'Layout' },
  { key: 'cut', label: 'Cut wrong' },
  { key: 'title', label: 'Title or text wrong' },
  { key: 'context', label: 'Needs context' },
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number]['key'];
export const RejectReasonSchema = z.enum(REJECT_REASONS.map((r) => r.key) as [RejectReason, ...RejectReason[]]);

export const ReviewSchema = z.object({
  status: z.enum(['editing', 'review', 'approved', 'rejected', 'changes']),
  note: z.string().optional(),
  /** Why it was rejected (or sent back for changes). */
  reasons: z.array(RejectReasonSchema).optional(),
  /**
   * 18+: uploaded age-restricted on YouTube. The reviewer's call when deciding (the review page's check
   * starts from the 18+ check in QA, src/qa/adult.ts); fixed from then on, the other tabs only show it.
   */
  adult: z.boolean().optional(),
  at: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

/** What's posted with the video. Empty fields fall back to the suggestion (src/core/post.ts). */
export const PostSchema = z.object({
  title: z.string(),
  caption: z.string(),
  /** Whose clip it is, where it is from and what this channel is. Goes under the caption on every post. */
  credit: z.string().optional(),
  hashtags: z.string(),
  /** A few title options for the publisher; the chosen `title` is what gets uploaded. */
  titles: z.array(z.string()).optional(),
});
export type Post = z.infer<typeof PostSchema>;

export const SegmentSchema = z.object({ startMs: z.number().int(), endMs: z.number().int() });

export const ProjectSchema = z.object({
  version: z.literal(1),
  rev: z.number().int(), // bumped on every save; lets the Studio spot edits made by the CLI
  id: z.string(),
  videoId: z.string(),
  title: z.string(),
  candidateId: z.string().optional(),
  sourceDurationMs: z.number().int(),
  fps: z.literal(30),
  segments: z.array(SegmentSchema).length(1), // v0.1: exactly one; v0.2 adds cuts
  markers: z.array(MarkerSchema),
  captions: CaptionSettingsSchema,
  framing: FramingSchema,
  /** Review state: the agent edits, a person approves. */
  review: ReviewSchema.optional(),
  /** Post text overrides (title, caption, hashtags). */
  post: PostSchema.partial().optional(),
  /** Framing before a proposed auto-reframe switched to crop; restored if the proposal is rejected. */
  prevFraming: FramingSchema.optional(),
  /** A new Twitch clip: try the split facecam/gameplay layout once its footage arrives (see src/reframe/split.ts). */
  autoSplit: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const defaultCaptions = (): CaptionSettings => ({
  enabled: true,
  // short italic phrases with a thick outline, the shouted ones in yellow: what the top clip channels
  // use (captionLooks.ts). The old default, bold, is every auto-captioner's karaoke.
  style: 'street',
  position: 0.68,
  fontSize: 96,
  uppercase: true,
  highlightColor: '#FFE14D',
  combineMs: 900,
  fixes: {},
  censor: true,
  repeats: true,
});

export const defaultFraming = (): Framing => ({ mode: 'blur', cropX: 0.5, zoom: 1, split: defaultSplitLayout() });

// ---------- presets ----------

export const PresetMarkerSchema = MarkerSchema.omit({ id: true, startMs: true, endMs: true }).extend({
  anchor: z.enum(['start', 'end']), // placed relative to the clip's in- or out-point
  offsetMs: z.number().int(),
  durationMs: z.number().int().optional(),
});

export const PresetSchema = z.object({
  name: z.string(),
  createdAt: z.string(),
  markers: z.array(PresetMarkerSchema),
  captions: CaptionSettingsSchema.omit({ fixes: true }),
  framing: FramingSchema,
});
export type Preset = z.infer<typeof PresetSchema>;

// ---------- candidates ----------

/** The five virality qualities the judge scores (0–10). `score` stays the quality floor. */
export const ViralityScoresSchema = z.object({
  stop: z.number().min(0).max(10),
  hold: z.number().min(0).max(10),
  share: z.number().min(0).max(10),
  standalone: z.number().min(0).max(10),
  payoff: z.number().min(0).max(10),
  /** Does the clip deliver what the opening promised? A hook that goes nowhere is a recut, not a post. */
  delivery: z.number().min(0).max(10).optional(),
});
export type ViralityScores = z.infer<typeof ViralityScoresSchema>;

export const CandidateInputSchema = z.object({
  start: z.union([z.string(), z.number()]),
  end: z.union([z.string(), z.number()]),
  title: z.string().min(3),
  hook: z.string().min(1), // the opening line / on-screen hook
  reason: z.string().min(1),
  quote: z.string().default(''), // words actually spoken inside the clip (validated against the transcript)
  /** Nothing is said, or the words are not the point (a scare, a fall, a face). The clip then has to
   *  contain evidence instead of a quote: a chat spike, a reaction heard in the audio or a viewer clip. */
  visual: z.boolean().optional(),
  score: z.number().min(0).max(100), // quality: is this a good moment at all?
  scores: ViralityScoresSchema.optional(), // the funnel: stop, hold, share, standalone, payoff
  lens: z.string().default('podcast-general'),
  /** Which queue expert found it, and the queue it came from (e.g. "meme@1:46:25"). Kept for the learning loop. */
  kind: z.enum(['meme', 'viral', 'clip']).optional(),
  queueId: z.string().optional(),
});
export type CandidateInput = z.input<typeof CandidateInputSchema>;

export const CandidateSchema = z.object({
  id: z.string(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  title: z.string(),
  hook: z.string(),
  reason: z.string(),
  quote: z.string(),
  /** No quote: the clip was accepted on evidence inside it (chat, reaction, viewer clip), not on words. */
  visual: z.boolean().optional(),
  lens: z.string(),
  /** The queue expert that found it and its queue id, when it came through the queue pipeline. */
  kind: z.enum(['meme', 'viral', 'clip']).optional(),
  queueId: z.string().optional(),
  score: z.number(),
  /** The judge's funnel scores, when it supplied them. */
  scores: ViralityScoresSchema.optional(),
  /** 0–100, computed from `scores` (gated). Absent on older candidates. */
  virality: z.number().min(0).max(100).optional(),
  /** 0–1, computed from the discovery signals: independent evidence agreeing on this window. */
  convergence: z.number().min(0).max(1).optional(),
  /** 0–1, the order the Studio and `clip candidates list` use: 60% virality, 40% convergence. */
  rankScore: z.number().min(0).max(1).optional(),
  /** What to do with it: post, recut (good hook, missing payoff), or skip. */
  verdict: z.enum(['post', 'recut', 'skip']).optional(),
  /** 1 = strongest. Recomputed whenever candidates are loaded or saved. */
  rank: z.number().int().optional(),
  signals: z.record(z.string(), z.number()), // computed by the engine, not the judge
  why: z.array(z.string()),
  warnings: z.array(z.string()),
  status: z.enum(['new', 'made', 'skipped']),
  clipId: z.string().optional(),
  createdAt: z.string(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const CandidatesFileSchema = z.object({
  videoId: z.string(),
  candidates: z.array(CandidateSchema),
});
export type CandidatesFile = z.infer<typeof CandidatesFileSchema>;

// ---------- video metadata & signals ----------

export interface VideoMeta {
  id: string;
  url: string;
  /** Absent on videos ingested before Twitch support: YouTube. */
  platform?: 'youtube' | 'twitch';
  /** The stream is still running; the broadcast keeps growing (Twitch). */
  live?: boolean;
  /** When the stream started, the broadcast's 0:00 (Twitch). */
  startedAt?: string;
  /** Channel login, e.g. "xqc" (Twitch). */
  login?: string;
  game?: string;
  title: string;
  channel: string;
  durationMs: number;
  uploadDate?: string;
  viewCount?: number;
  width?: number;
  height?: number;
  hasHeatmap: boolean;
  chapters: { startMs: number; endMs: number; title: string }[];
  heatmap: { startMs: number; endMs: number; value: number }[];
  captions: 'youtube-auto' | 'none';
  commentCount: number;
  ingestedAt: string;
}

export interface MediaInfo {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
}

export interface SponsorSegment {
  startMs: number;
  endMs: number;
  category: string; // sponsor, selfpromo, interaction, intro, outro, preview, filler, poi_highlight…
}

export type SignalName = 'comments' | 'chat' | 'clips' | 'laughter' | 'audio' | 'teaser' | 'heatmap' | 'speech' | 'title';

export interface Seed {
  id: string;
  startMs: number;
  endMs: number;
  peakMs: number;
  score: number; // 0–100
  sources: Partial<Record<SignalName, number>>; // 0–1 strength of each signal inside the window
  why: string[];
  chapter?: string;
}

export interface SignalsFile {
  videoId: string;
  generatedAt: string;
  durationMs: number;
  available: Record<SignalName, boolean>;
  binMs: number; // resolution of `timeline`
  timeline: Record<SignalName, number[]>; // 0–1 per bin, for the Studio strip and candidate scoring
  excluded: SponsorSegment[]; // ranges no clip should overlap
  comments: { ms: number; likes: number; text: string }[];
  laughs: number[]; // ms of [laughter]/[applause] tags
  teaser: { teaserMs: number; momentMs: number; grams: number }[];
  seeds: Seed[];
  /** The range the seeds were picked from (a scan pass); absent = the whole video. */
  seedRange?: { startMs: number; endMs: number };
}
