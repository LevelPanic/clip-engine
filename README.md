# Clip Engine

The engine behind an automated clip channel: it finds moments in public streams and videos, cuts them, and posts them with
the creator named on screen and linked under every post, to send viewers to the source.

Turn YouTube videos and Twitch streams into short-form clips for Shorts, TikTok and Reels. It finds the moments, edits
them (zooms, booms, captions, jump cuts, face-tracking crops), renders a 9:16 MP4, checks it, and lines
it up for you to approve. It works one video at a time with Claude, or as a batch.

## Setup

**Requirements**
- macOS (Apple Silicon was used for the measured baselines). The face and audio tools use Apple Vision and SoundAnalysis.
- Xcode Command Line Tools (`xcode-select --install`). These supply `swiftc` for the Swift tools and the compiler whisper.cpp builds with.
- Node 22.5 or later (`.nvmrc`) and ffmpeg.
- [uv](https://docs.astral.sh/uv/):
  - yt-dlp runs through `uvx`, always at the latest version.
  - The face (InsightFace) and nudity (NudeNet) sidecars each set up their own Python 3.12 environment on first use.
- Remotion downloads its Chrome Headless Shell on the first render.
- The unattended agents (the watchlist's pipeline, change requests and `clip judge --provider opencode`) run through [OpenCode](https://opencode.ai) with `opencode-go/deepseek-v4.1-flash`. Change it with `CLIP_PIPELINE_MODEL`.
- The interactive skills (`/clip`, `/edit` and the others) run in Claude Code.

**Install**

```bash
git clone <this repo> && cd clip-engine
npm ci
cp channel.example.json channel.json      # your channel's name, disclosure line and do-not-clip list
cp channels.example.json channels.json    # the creators the watchlist follows (optional)
./clip --help
```

**Optional logins** (`docs/operations.md` → "Publishing" has the steps):
- **YouTube uploads:** put a Google OAuth client in `client_secrets.json` (see `client_secrets.example.json`), then run `./clip auth youtube`.
- **TikTok inbox uploads:** put the app's keys in `tiktok_secrets.json` (see `tiktok_secrets.example.json`), then run `./clip tiktok auth`.

None of these files is committed: `.gitignore` keeps your configs, logins, footage and renders out of the repo.

## Quick start

```bash
./clip studio            # http://localhost:4400
```

In Claude Code, from this folder:

```
/clip https://www.youtube.com/watch?v=2v99_8xJoqA      # find and judge the candidates, then open the Studio on them
/edit all                                               # edit, render and send them for review
```

On the candidates page, each candidate has two ways out:

- **Export**: render it now, as is (captions and framing) or with an edit style. Tick several to export them together.
  Exports are QA'd and land in the review queue with their post text.
- **Edit**: open it in the editor, change what you like, then **Export**.

Twitch streams are scanned a range at a time, including streams that are still live:

```
/clip https://www.twitch.tv/videos/2921546465 --from 1:00:00     # scan from 1:00:00 to now, judge it
/clip tw-2921546465 --continue                                 # later: the part since the last pass
```

```bash
./clip watch xqc --every 15m      # follow a live channel: a pass every 15 min until the stream ends
```

Or as a batch, unattended:

```bash
./clip batch https://www.youtube.com/@TheDiaryOfACEO/videos --limit 3 --per-video 5 --lens hot-takes
./clip batch-status
```

Then review at http://localhost:4400/#/review:
- **A** approves.
- **R** rejects, then **1–5** for why: boring, layout, cut, title, context.
- **C** requests changes. Write the change in the note first; the editor agent acts on it.
- **U** sends a decided clip back to review.
- **8** ticks 18+.

The upload scheduler (`tools/upload-cron.ts --daemon`) uploads approvals to YouTube:
- at most 8 in any 24 hours, 3 hours apart, each going live 5 minutes after it uploads;
- it waits out YouTube's limits;
- it holds approvals while the login is expired;
- it never posts a clip without its creator credit, or one on the never-post list (nudity, a slur, a minor, a sexual title).

`docs/operations.md` covers every daemon: what it does, how to start and stop it, and its log.

The watchlist (`tools/watchlist.ts --daemon`) does this unattended for the creators in `channels.json` and the games in `topics.json`: it ranks each stream's moments from viewer clips and chat laughter and runs the full process on the best ones, one moment at a time, back to back. Streams you add with `clip track` go first, then the creators you listed, then the topics:

```bash
./clip moments https://www.twitch.tv/videos/2921546465   # the stream's moments, best first
./clip track https://www.twitch.tv/videos/2921546465     # add it to the tracker by hand
./clip streams                                          # what is live, tracked, done and next
```

## How it works

1. **Ingest** fetches the captions, top comments, chapters, Most Replayed graph and SponsorBlock data in about 30 s.
   - It fixes names the captions misheard, using the title and channel.
   - It downloads the audio and listens for laughs, cheers and shouts (Apple SoundAnalysis).
2. **Discover** turns signals into seed moments:
   - Timestamped comments.
   - Caption and audio laughter.
   - Cold-open teaser matches.
   - The heatmap, speech rate and title words.
3. **Judge:** Claude reads the transcript around the seeds through a lens (`lenses/`) and proposes candidates.
   - The validator snaps them to sentences, keeps them clear of sponsor reads, checks the quotes are actually said, and flags caption mistakes and content risks.
4. **Footage:** only the sections around candidates are downloaded (about 20 MB per candidate instead of 2–4 GB per video).
5. **Edit:** markers on a timeline, all stored in source-video time:
   - zoom, shake, flash, sfx, text, tint
   - **cut** (jump cuts with crossfade, whip, flash or zoom transitions), **speed**, **freeze**
   - **reframe** (the crop follows faces)

   `autoedit` makes a first pass as *proposed* markers you accept or reject, in an **edit style**:
   - **clean:** captions, hook text, dead-air cuts and one push-in.
   - **punch:** a snap zoom and a boom on punchlines, and a flash on the first.
   - **hype:** random booms, shakes and emoji pops on laughs, a riser into the payoff, punch-ins and glitch jump cuts.
   - **story:** smooth push-ins, and crossfades with a whoosh.

   In the editor, **quick effects** drop a boom, emoji, glitch, whoosh, riser, flash or shake at the playhead.
   **Shift-drag** the ruler (or press `[` and `]`) to select a span, then cut it, speed it up, zoom, add text, or crop, blur-fit or auto-reframe just that part.
6. **Render** produces 1080×1920 H.264/AAC at about 1.5–2× the clip length on an M1, normalised to −14 LUFS.
7. **QA** checks length, loudness, dead air, black frames, caption overflow and content risk.
8. **Review:** approve, reject or request changes. Decisions and imported view counts feed `clip stats` (what gets approved, by lens, score and signal).
9. **Post:** each export comes with a title, caption and hashtags (`exports/<clip>.txt`), suggested from the candidate and editable in the editor's Post panel.
   The review page has download and copy buttons.

## The full process on a stream

`/clip` is the quick pass: one judge reads the strongest seeds. For a whole stream, the full process
puts three experts on every 20–30 minute segment and checks every hand-off (see `docs/pipeline.md`, and
`agents/README.md` for who does what):

```
/queue-check <id> --from 1:30:00 --to 3:00:00    three experts (meme, virality, story) give a verdict per queue
/clip-extractor <id>                             one candidate per confirmed moment
/clip-curator <id>                               niche, fit, keep / review / drop
/edit <id>                                       trim, layout, edits, captions, render, QA, submit for review
```

## Streams (Twitch)

- **Signals:** a Twitch broadcast has no captions, comments or heatmap. Instead the scan uses:
  - **chat**: distinct chatters per 10 s against the channel's normal level, plus the kind of reaction (funny, hype, shock, fail) and "clip it" requests;
  - **viewer clips**: where viewers clipped it, weighted by views, with their titles;
  - **audio**: laughs and shouts.
- **Transcription:** Whisper transcribes only around the strongest moments.
- **Each pass** covers a range:
  - It starts 2 min before the last one ended.
  - On a live stream it stops 3 min short of the live edge, because chat reacts after the moment.
  - Stretches Twitch muted for copyrighted music are never clipped.
- **In the Studio:** the video page shows what's been scanned, with **Scan new part** and **Scan range** buttons.
- **Chat:** Twitch's web API is the only source of chat replay. It's unofficial, so Twitch could change it.
- **Judging:** each pass is judged automatically when the `claude` CLI is logged in. Otherwise `/clip <id> --continue` judges it in a session.

## Studio keys

| key | does |
|---|---|
| `Space` / `Enter` | play / play the clip from its in-point to its out-point |
| `L` | loop between the in- and out-points |
| `I` / `O` | set in / out at the playhead |
| `1`–`9`, then `M` | pick a marker type, then drop it at the playhead |
| `←` `→` (`⇧` for 10) | nudge the selected marker (or the playhead) by one frame |
| `⇧`-drag the ruler, or `[` `]` | select a span for the span actions (cut, speed, zoom, text, crop, blur, auto-reframe) |
| `A` | accept the selected proposed marker |
| `⌫` | delete the selected marker |
| `⌘Z` / `⇧⌘Z` | undo / redo |
| `↑` `↓` `E` (or `Enter`) `⇧E` `X` `S` | on a video page: choose a candidate, edit it, export it, tick it, skip |
| `A` `R` `C` `U` `8` `E` | in the review queue: approve, reject (then `1`–`5` for why, `R` again for none), changes (needs a note), back to review, 18+, open in the editor (its **↩ Review** comes back to the same clip) |

Click any caption word, in the transcript or on the timeline, to fix what the auto-captions misheard.
The editor's top bar steps to the previous or next clip from the same video, and its `⋯` menu duplicates a clip (to try another edit) or deletes it.

## CLI (selection)

```bash
./clip ingest <url> --wait                # metadata, captions, comments, audio + laugh detection
./clip scan <twitch link|channel|clip> --from 1:00:00 [--to …] [--continue] [--judge]   # one pass over a stream range
./clip watch <channel> [--every 15m]      # a pass every 15 min until the stream ends
./clip moments <link> [--top 8] [--json]   # a stream's moments from viewer clips and chat laughter, best first
./clip track <link>                       # put a broadcast in the tracker by hand
./clip streams [videoId]                  # the tracker: live, tracked, done, skipped, and what is next
./clip topics [--suggest] [--youtube]     # the games the watchlist follows and what it would take next
./clip chat <id> --from 1:06:00 --to 1:07:00   # condensed stream chat
./clip discover <videoId>                 # signals → seeds
./clip queues <id> --from 1:30:00 --to 2:00:00 [--kind meme|viral|clip] [--transcribe range]   # queues with evidence
./clip windows <id> --queue meme@1:46:25  # scored start/end windows for a queue
./clip queue-review <id> [file|-] [--pending --from … --to …]   # the experts' verdict ledger
./clip curate <id> [file|-]               # the curator's ledger (keep / review / drop)
./clip vocab [archetypes|triggers|rejects|risks|niches|drops]   # the words the ledgers accept
./clip editors <clipId> [--meme|--expert] [--review]   # meme and expert edits as proposals
./clip subtitles <clipId> [--review] [--no-settings]   # caption decision and word fixes
./clip search <videoId> money rich        # where a theme comes up
./clip frames <videoId> 1:59:40 2:00:28   # stills for judging what's on screen
./clip candidates add <videoId> judge.json
./clip make <videoId> c03                 # candidate → clip (downloads its footage)
./clip open [videoId|clipId|review]       # open the Studio there (starts it if needed)
./clip autoedit <clipId> [--style hype] [--reframe]   # first-pass edit as proposals (`clip styles` lists them)
./clip suggest-cuts <clipId>              # proposed jump cuts on dead air
./clip reframe <clipId> [--from 1:02 --to 1:20]   # face-tracking crop, for all or part of the clip
./clip accept <clipId> [ids] [--reject]
./clip marker add <clipId> speed --at +4 --to +9 --param rate=1.5
./clip marker add <clipId> cut --at 14:20.1 --to 14:22.0 --param transition=whip
./clip marker add <clipId> freeze --at 14:50.8 --param durationMs=1200
./clip render <clipId>                    # exports/<clipId>.mp4, then QA
./clip post <clipId> [--hashtags "…"]     # the post text: title, caption, hashtags
./clip duplicate <clipId>                 # a copy (…-v2) to try another edit
./clip delete <clipId>                    # moves it to clips/.trash/; its candidate can be made again
./clip review <clipId> submit|approve|reject|changes --note "…" [--reason boring,layout]
./clip stats                              # approval rate by lens, queue expert, niche, score, signal
./clip perf-import views.csv              # clipId,platform,views[,avgViewPct][,likes]
./clip batch <links|file|channel> …       # the whole pipeline, unattended
./clip jobs [--active] [--retry <id>]     # the job queue
```

To add a marker type, see `markers/README.md`: copy the `_template` folder, rename it, and edit.
To add a lens, see `lenses/README.md`. To add a signal, add a file in `src/discover/signals/`.

## Tests

```bash
npm test              # offline, about 1 s: logic plus a simulated live stream
npm run test:e2e      # real Twitch, a few minutes
```

`clip batch`'s unattended judge runs Claude Code headless (`claude -p`). Log the CLI in once by running it and typing `/login`. Without it, batches stop after discovery: judge with `/clip` in a session, then run `./clip batch-continue`.

## Docs

| | |
|---|---|
| `CLAUDE.md` | how to work in the code: the module map, the rules the design depends on, testing, measured baselines |
| `SCOPE.md` | the idea, the key decisions, where things stand and the backlog |
| `docs/architecture.md` | how it fits together, and the reference material behind it (signals, sources, output spec) |
| `docs/pipeline.md` | the full production process on a stream, stage by stage |
| `docs/operations.md` | running the channel: the daemons, the upload scheduler, the review page, the watchlist, publishing |
| `docs/changelog.md` | what was built, measured and decided, newest first |
| `docs/research/` | the studies and reviews the rules cite |
| `agents/`, `lenses/`, `markers/README.md` | the agents' contracts and vocabulary, the judge's rubrics, how to add a marker type |

## Use

The engine downloads public streams and videos and posts clips of them. The footage belongs to its creators. Every clip
names its creator on screen and links back in its post, and `doNotClip` in `channel.json` keeps anyone who asks out of
every step. A credit is not permission: the platforms' rules on reused content and each creator's wishes still apply,
and following them is up to whoever runs it.

## Licence

MIT (`LICENSE`). The engine depends on software with its own terms: Remotion's licence (free for individuals and
companies of up to 3 people) and InsightFace's model terms (non-commercial unless licensed). `THIRD_PARTY.md` has the list.
