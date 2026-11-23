# Architecture

How Clip Engine fits together, for someone new to the code. `CLAUDE.md` is the working guide: its "Layout" section maps
every folder, and its "Rules that keep the design working" are the invariants listed below in full. `docs/pipeline.md` is
the production process stage by stage, and `docs/operations.md` covers running it.

## What it does

A YouTube video or a Twitch broadcast goes in. The engine works out where the moments are, cuts each one into a 9:16 clip
with edits, captions and the creator's credit, renders it, checks it, puts it in front of a reviewer, and uploads what the
reviewer approves. It runs in two modes:
- **In a session:** the skills (`/clip`, `/queue-check`, `/clip-extractor`, `/clip-curator`, `/edit`) run as Claude Code agents.
- **Unattended:** the watchlist runs the same stages through OpenCode, one community-ranked moment at a time.

## The flow, and where each part lives

1. **Sources** (`src/ingest/`).
   - **YouTube:** yt-dlp metadata, json3 captions, comments, chapters, the Most Replayed heatmap and SponsorBlock.
   - **Twitch:** its web API for the broadcast, chat replay and viewer clips.
   - **Footage:** only the sections that are needed, through `resolveMedia`.
   - **Words:** whisper.cpp transcribes where there are no captions.
2. **Signals and moments.**
   - Each signal is one file in `src/discover/signals/`.
   - Chat reads go through one lexicon (`src/discover/chatAnalysis.ts`).
   - On streams:
     - The queue checkers (`src/scan/queues.ts`) find witnessed moments.
     - The moment ranker (`src/scan/moments.ts`, `src/track/rank.ts`) orders a broadcast by what viewers clipped and laughed at.
     - The tracker (`src/track/`) keeps every stream, moment, job and coverage span in SQLite.
3. **Judgment.**
   - Three queue experts (`agents/`, `.claude/agents/`) write checked verdicts (`src/scan/review.ts`).
   - Extraction scores start and end windows (`src/extract/`).
   - The candidate validator (`src/candidates/`) checks quotes, snapping and evidence, and ranks by the virality funnel.
   - The curator (`src/curate/`) keeps or drops, and every drop needs a ground.
4. **Clip projects.** One `clips/<clipId>/project.json` per clip (`src/project/`, schemas in `src/core/schemas.ts`).
   - Every edit is a **marker** in source-video milliseconds.
   - Each marker type is a plugin folder in `markers/`.
   - The first-pass edit, the editors, the captions decision and censoring are in `src/edit/`.
   - Framing (crop, blur-fit, the facecam split, solo spans) is in `src/reframe/` and `src/core/layout.ts`.
5. **Render** (`src/render/`):
   1. cut the 16:9 original;
   2. find the facecam;
   3. frame it in ffmpeg;
   4. draw the Remotion composition (`src/composition/`, the same one the Studio previews);
   5. normalise loudness.
6. **QA** (`src/qa/`):
   - length, loudness, dead air and black frames;
   - captions and layout;
   - content risk, swearing and the 18+ check;
   - the never-post list.
7. **Review** (`src/studio/`, `src/review/`).
   - The Studio is an Express and Vite server with a React app.
   - Decisions and reasons feed `feedback.jsonl` and `clip stats`.
   - Change requests go back to the editor agent (`src/track/revise.ts`, `src/pipeline/full.ts`).
8. **Publishing** (`src/publish/`, `tools/upload-cron.ts`).
   - YouTube's resumable upload, at a measured pace.
   - TikTok inbox drafts.
   - Analytics back into the learning loop.

**Long work** runs in one of two places:
- **The Studio's own jobs** (renders, downloads) go through a SQLite job queue (`src/jobs/`). The worker loop and the handlers are in `src/pipeline/`.
- **The watchlist and the other daemons** are in `tools/`; `docs/operations.md` lists them.

## Design principles

The rules in `CLAUDE.md` come from a few ideas:
- **Source time everywhere.** Markers and clip edges are source-video milliseconds. The edited timeline exists only through one time map (`buildTimeMap`), so cuts, speed and freezes never move anything else.
- **Plugins by layer.** A marker type plugs in through its layer (camera, overlay, audio, time, framing). Editor, CLI and render code never name a type.
- **One picture.** One Remotion composition draws both the Studio preview and the export. Framing is the one exception: it is done in ffmpeg for speed and in CSS in the Studio, through the same geometry functions.
- **Evidence over opinion.**
  - A moment needs witnesses: chat, a reaction heard in the audio, or viewer clips.
  - A verdict needs a still or a quote that is checked.
  - A drop needs a ground.
  - Unknown is not quiet: an unread range is an error, not an empty result.
- **Files first.**
  - Per-video data is readable JSON written atomically (`writeJson`), and growing files have one writer.
  - SQLite holds only queues, the tracker and review state.
- **The channel credits what it clips.** A credit on screen, a link in every post and a do-not-clip list are enforced by QA and by the publishers.
- **Never posted.** Three gates (the ranker, curation and the publishers) keep nudity, slurs, minors and sexual titles out, whatever `--force` says.

## Layers

Every folder of `src/` has a place in one order, lowest first:

core → jobs → markers → project → composition → ingest → discover → scan → extract → candidates → review → curate →
reframe → qa → edit → render → judge → track → pipeline → publish → studio → cli → tools

A file imports only from its own folder or one below it, and `test/layers.test.ts` fails on any import that goes up
(dynamic `import()` included). That keeps the folders free of cycles. Two rules of thumb follow:
- **Shared code moves down.** For example, the opening filler words live in `core/vocabulary.ts` because candidates, QA and the judge all read them.
- **Low layers never call up.** Any layer may queue a job in `jobs/`. The loop that runs the jobs lives in `pipeline/` with the handlers, which know every stage, and it takes them as an argument.

## Known structural debt

Phase 2 of `docs/release-plan.md` works through these.
- **Daemon logic in `tools/`.** The decisions that matter most now live in `src/` with tests: what the upload scheduler sends, holds, defers or sets aside (`src/publish/scheduler.ts`); what a failed watchlist job becomes (`src/track/runner.ts`); what the cleanup may delete (`src/pipeline/cleanup.ts`). Still in `tools/`: the watchlist's discovery, its status page, and the observer's loop.
- **The Studio server and the four largest UI files** are big closures to split into routers, components and hooks.

## Reference

The material below was the background section of SCOPE.md: what the sources give us, the signals, what was reused from
other projects, and the output spec.

### What YouTube actually gives us

Tested 2026-11-06 with yt-dlp 2026.10.26, fetching metadata only:

| Video | Length | Most Replayed | Chapters | Auto-captions |
|---|---|---|---|---|
| Music video (2009, 1.8B views) | 3.5 min | 100 points of 2.1 s each. The top point is 0:00, an intro artifact | 0 | yes, with word timings |
| Huberman Lab Essentials (2024, 1M views) | 34 min | 100 points of 20 s each. Peaks at 21:05–21:45, 16:19 and 10:12 | 8 | yes |
| Lex Fridman episode (11 days old, 1.3M views) | 3 h 34 min | **none** | 15 | yes |

What this means for the design:

- **Most Replayed always has 100 points**, however long the video is. On a 3-hour video each point covers about 2 minutes. It tells us *which region* is hot, never where a clip starts or ends, so the transcript and the AI decide the actual cut.
- **It's often missing**, for example on new or low-view videos. That makes it a ranking boost, not the backbone, and discovery has to work from the transcript alone.
- **It has artifacts.** The first point is often the highest, because everyone starts watching there. Peaks can also mark where people land after skipping an intro or sponsor read. We drop the opening points and use SponsorBlock data to filter sponsor segments.
- **Captions with word-level timing come free** for most videos (json3 format). v0.1 needs no Whisper; Whisper becomes the fallback later.
- **Chapters come free** when the creator adds them, which gives good topic boundaries.
- **Discovery never needs the video file.** Candidates can be ready in about a minute while the video downloads in the background.

Environment (checked): Apple M1, 16 GB RAM, ffmpeg 9.0.2, Node 22, uv. yt-dlp isn't installed, but it works through uv with the installed Node as its JavaScript runtime (no Deno needed). Ollama and Whisper aren't installed.

### Clip-finding signals

Tested 2026-11-06 on real videos. Neither of the two recent podcast episodes we tried had a Most Replayed heatmap, so the other free signals matter more than the heatmap does.

**In v0.1.** All of these are free and come from data we already fetch.

| Signal | What it finds | Notes from testing |
|---|---|---|
| Most Replayed heatmap | The region viewers rewatch | Only on some videos. Coarse; drop the opening points |
| Timestamped comments | Moments viewers point at ("14:50 I'm dead") | Fetching about 1,000 top comments takes about 20 s, and 5–13% of them had timestamps. On one 2 h episode, the two most-liked timestamps fell in the two minutes with the most laughter |
| Caption tags | `[laughter]`, `[applause]` and `[music]`, inserted by YouTube's auto-captions | A 2 h comedy podcast had 158 `[laughter]` tags, and a lecture had none. Free, but inserted inconsistently and mostly English |
| Cold-open teaser | Shows that open with a montage of their own best moments | In 2 of 2 Diary of a CEO episodes, the first ~90 s matched about 10 later moments by shared 6-word phrases. That recovers the creator's own picks from text alone |
| Chapters | Topic boundaries | Only when the creator added them |
| Title | The moment the title promises | Passed to the judge so it can locate that moment. It can point at an ad: one episode's title promised a "Street Fighter reaction", and that turned out to be the sponsor read |
| Speech rate | Fast, excited stretches | Computed from word timings |
| SponsorBlock | Sponsor reads to exclude, plus user-marked highlights | Highlights are rare (1 of 5 videos) and often just mark where content starts, so they get low weight |

Rules for comments:
- Pad back 20–40 s, because people timestamp the punchline rather than the setup.
- Weight by the square root of likes.
- Ignore comments with 4 or more timestamps, which are usually chapter lists.

**Later, by phase**
- **v0.2:**
  - Audio events (laughter, cheering, shouting, gasps) from Apple's built-in SoundAnalysis. It knows 303 sound labels and processed 30 min of audio in 7.5 s on this M1. That speed was measured on a test tone, so detection quality on real podcast audio is still untested. It needs a small Swift tool and an audio-only download.
  - Loudness and pitch excitement.
  - Live-chat velocity for streams (yt-dlp `live_chat`), and the Twitch Clips API (viewer-made clips with VOD offsets) for gaming.
  - Matching against the show's official clips channel. This shows which moments humans picked and how their clips performed. We use it to train lenses and to avoid duplicating clips that already exist, not to repost them.
  - Query search ("every time they talk about money") with local embeddings and SQLite.
- **v0.3:**
  - A learning loop from your own posted shorts, using YouTube Analytics and Instagram insights (TikTok only gives counts). It tracks the win rate per lens first, then similarity to past winners.
  - Cross-talk detection to find heated debates (pyannote).
- **v0.3+:** visual signals for gaming and reaction content: scene cuts, facial expressions, and in-game text such as kill feeds. They share their cost with face tracking for reframing.
- **Skip:**
  - Listing YouTube user Clips: there's no API for it.
  - Searching Shorts or TikTok for existing clips: the API quota allows about 100 searches a day, and scraping breaks the platforms' terms.
  - Google "key moments".
  - Research highlight-detection models such as the Moment-DETR family.

### Reuse: what we take from existing projects

Researched 2026-11-06. Every repo was opened. Star counts and dates come from GitHub.

**Use directly**
- [remotion-dev/skills](https://github.com/remotion-dev/skills): Remotion's official agent skills (best practices, captions, render, studio). Install them in this project so the agent building the editor follows them: `npx skills add remotion-dev/skills`.
- `@remotion/player` for the editor preview, and `@remotion/captions` (`createTikTokStyleCaptions`) for word-timed caption pages. The caption components start from [remotion-dev/template-tiktok](https://github.com/remotion-dev/template-tiktok).
- [@xzdarcy/react-timeline-editor](https://github.com/xzdarcy/react-timeline-editor) (MIT) for the marker timeline. Its rows of actions with start, end and effect ID map one-to-one onto our markers. [wavesurfer.js](https://github.com/katspaugh/wavesurfer.js) (BSD-3) draws the waveform lane.
- Later, v0.2: `@remotion/install-whisper-cpp` (whisper.cpp on Metal, driven from Node) as the transcript fallback, and [auto-editor](https://github.com/WyattBlue/auto-editor) (`--export v1` gives JSON chunks) to suggest silence cuts.

**Copy the approach** (MIT-licensed, ported to TypeScript)
- [claude-shorts](https://github.com/AgriciDaniel/claude-shorts) is the closest match to our design: a Claude Code skill with Remotion captions. We take its scoring rubric as the first lens. It scores hook 0.30, standalone sense 0.25, emotion 0.20, value 0.15 and payoff 0.10, and keeps clips that score 60 or more. Its reframe modes per content type (talking head, screen recording, podcast) are also worth copying.
- [autoclip](https://github.com/zhouxiaoka/autoclip) (10k★) contributes three ideas:
  - Compact `id|time|text` transcript rows, which use about 40% fewer tokens.
  - Overlapping windows for long videos, with duplicate picks dropped.
  - Boundary rules: never end a clip on the next question, and extend it to finish the sentence.
- [AI-Youtube-Shorts-Generator](https://github.com/Anil-matcha/AI-Youtube-Shorts-Generator): ask for twice the clips you need and dedupe. Each clip carries a hook sentence and a reason.
- [cutlist](https://github.com/itsryanlenk/cutlist): every clip must cite a caption timestamp. Our validator enforces this so the judge can't invent moments.
- [openshorts](https://github.com/mutonby/openshorts) (7.5k★) for auto-reframe later:
  - The camera only moves when the subject leaves a central zone.
  - Speaker switches have a cooldown.
  - The active speaker is picked from mouth motion combined with audio energy.
  - Avoid its YOLO/ultralytics dependency, which is AGPL.
- [PaunClip](https://github.com/paundrapf/PaunClip) (TypeScript): reads captions before downloading anything, then downloads only the needed sections. That's our v0.4 disk saver.

**Be careful with**
- [youtube-agent-skill](https://github.com/Jakeschincariol/youtube-agent-skill) shows 4.7k★ and 1.4k forks on a single commit, so its popularity looks inflated. A few of its skills fit later stages: `/yt-shorts`, `/yt-edit` (finds filler and dead air), `/yt-package` (title and thumbnail) and `/yt-chapters`. Read each SKILL.md before copying it in, and don't install the pack wholesale.
- AGPL projects ([supoclip](https://github.com/FujiwaraChoki/supoclip), which trims lead-in banter from clip openings; [trykimu/videoeditor](https://github.com/trykimu/videoeditor), a Remotion editor with an AI copilot; ultralytics) are for ideas only. We don't copy their code, which keeps this codebase's licensing simple.
- `youtube-skills` repos built on paid credit APIs: skip them, since yt-dlp does the same locally.

**For later:** [yutu](https://github.com/eat-pray-ai/yutu) (YouTube Data API CLI and MCP server, Apache-2.0) for uploads, and [awesome-claude-video-skills](https://github.com/zhuyansen/awesome-claude-video-skills), an index of about 180 video-skill repos.

### Output spec: one master file for Shorts, TikTok and Reels

The same file goes to all three platforms. What differs per platform is metadata (title, description, hashtags), not the video.

- **Format:** 1080×1920 (9:16), 30 fps, H.264 High + AAC 48 kHz, `+faststart`, about 10–12 Mbps.
- **Length:** aim for 20–59 s, with a hard cap of 60 s for footage we don't own. YouTube blocks any Short over one minute that has an active Content ID claim, of any kind and even if the claim is wrong ([YouTube Help](https://support.google.com/youtube/answer/15424877)). Under a minute, nothing changes. Shorts can run up to 3 minutes, and Reels and TikTok accept longer, so 60 s is safe everywhere.
- **Safe zone:** none of the three publishes an official safe zone for organic posts, and third-party guides disagree on exact pixels. They agree on the shape, though: keep faces, captions and text in a central box of roughly 900×1300 px. That leaves about 250 px at the top, 400–480 px at the bottom (caption bar and buttons) and 150 px on the right (action buttons). The editor shows this box as an overlay, and captions default to the lower-middle inside it.
