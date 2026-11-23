# Clip Engine — Scope

Status 2026-11-23: v0.1–v0.6 are built, and the full process (queue experts → extract → curate → edit →
review → upload) runs unattended from the watchlist. The project is being prepared as a public repo
(`docs/release-plan.md`). Every dated entry from before is in `docs/changelog.md`; the reference material
(what YouTube gives us, the signals, reuse, the output spec) is in `docs/architecture.md`.

## The idea

**What the channel is (decided 2026-11-14): an automated clipper.** It goes through public streams,
cuts the moments worth watching and posts them to send viewers to the creator. It is a discovery
channel for other people's content, and it says so. What follows from that is built into the tool, so
it does not depend on whoever runs it remembering:

- **Every clip names its creator on screen,** for its whole length (the `credit` marker). QA fails an export that was not rendered with one, and neither publisher will take it.
- **Every post says whose clip it is.** Under the caption: the creator's channel, the source opened at the second the clip starts, the stream's title and game, and a line saying the channel is automated and not affiliated (`creditBlock` in `src/core/post.ts`). `channel.json` holds the channel's own name and words.
- **A creator who says no is not clipped again.** `channel.json` → `doNotClip`. Scanning, clip-making and posting all refuse, and `--force` does not override it.
- **Titles are true.** A prank is titled as a prank.
- **A credit is not permission.** The platforms' rules on reused content still apply, and so do the creators' own: `docs/pipeline.md`, "Automated clipper: what it does not solve".

The full production pipeline is in `docs/pipeline.md`:
stream → segments → 3 queue agents (meme, virality, clip-worthiness) → clip extraction/ranking →
9:16 + meme/expert/subtitle passes → review → schedule.

Two engines connected by plain files:

- **Discovery** turns a YouTube link into a ranked list of possible clips: where to cut, and why.
- **Editor** turns a chosen clip into a finished short. You place typed markers on a timeline (zoom, boom, flash, text and so on), preview them live, and render an MP4.

Both engines improve by adding plugins rather than by rewriting the core. Discovery gets new *signals* and *lenses*. The editor gets new *marker types* and *presets*. Everything you can do in the UI is also a CLI command, so the local agent can do anything you can.

```
YouTube URL
   │  clip ingest       metadata, captions, heatmap, chapters, comments now; video downloads in background
   ▼
library/<videoId>/      transcript.json · signals.json · source.mp4
   │  /clip skill       signals + lens → judge → ranked candidates
   ▼
candidates.json         review in Studio, keep the good ones
   │  "Make clip"
   ▼
clips/<clipId>/project.json   markers, captions, framing (edited by you or the agent)
   │  clip render
   ▼
exports/<clipId>.mp4    1080×1920
```

## Key decisions

1. **Discovery = signals + lens + judge.**
   - *Signals* are cheap, deterministic inputs (see Clip-finding signals). Each signal is a small module that outputs scored time ranges, and adding one never touches the others.
   - A *lens* is a markdown rubric for one kind of content, such as `podcast-funny`, `podcast-hot-takes` or `gaming-clutch`. Specialised extraction means writing a new lens or a new signal.
   - The *judge* reads the transcript and signals through a lens. It outputs candidates with exact start and end times (snapped to sentence boundaries), a title, a hook line and a reason, with each signal's score shown separately.
   - **In v0.1 the judge is the agent itself (Claude Code running the `/clip` skill).** There's no model to install, judgment quality is the best available, and it costs roughly 15k tokens per hour of video. A local model (Ollama) or a cheap API can plug into the same judge interface later for unattended batch runs. This M1 with 16 GB limits local models to about 8B parameters. That's enough for rough triage but weak at judging whether a moment is funny and makes sense on its own.

2. **The editor uses Remotion (React) as both previewer and renderer.**
   - A marker type is one folder containing a parameter schema (zod) and a small React component.
   - The same component draws the live preview in the editor and renders the final MP4, so the export matches the preview.
   - New marker types are small React components, the kind of code agents write well, so telling the agent to "add a vinyl-scratch marker" is realistic.
   - Tradeoffs: rendering is slower than raw ffmpeg (fine as a background job, and we'll measure it on the M1). Remotion is free for individuals and companies of up to 3 people and paid above that.
   - ffmpeg still does everything non-creative: probing, cutting and proxies.

3. **Markers stick to the content.** Markers store source-video timestamps in integer milliseconds, not positions on the clip timeline. If you trim the clip's start, the boom stays on the punchline. Once cuts arrive (v0.2), markers inside removed ranges are hidden, not deleted.

4. **v0.1 markers decorate time; v0.2 markers restructure it.**
   - Zoom, shake, flash, SFX, text and captions don't change a clip's length, so the timeline is a straight 1:1 copy of the source range.
   - Cuts, freeze frames, speed ramps and real transitions do change length, and they need source-to-timeline mapping. Building that second keeps v0.1 small.
   - The project format includes a `segments` list from day one (a single segment in v0.1), so v0.2 doesn't break old projects.

5. **Files first, database later.** Everything for a video lives in `library/<videoId>/` as readable JSON next to the media. The agent can read it directly and it's easy to debug. SQLite comes with the job queue in v0.4.

6. **One language: TypeScript/Node** for the CLI, discovery, editor and renderer. Python comes in only if a later ML piece needs it, such as face tracking for auto-reframe.

## Roadmap

- **v0.2: Restructure time.** Jump cuts, freeze frames, speed ramps, transitions, reframe keyframes, Whisper, new signals, more lenses.
- **v0.3: The agent edits, you review.** `/edit`, proposed markers, review screen, feedback, learning loop.
- **v0.4: Throughput.** Batch ingest, SQLite job queue, QA, auto-reframe, section-only downloads, unattended judge, time-per-clip metrics.
- **v0.5: The Studio as a product.** Export or edit from the candidates page, edit styles, quick effects, span editing, post text, `clip open`.
- **v0.6: Twitch and live streams (built).** Twitch sources, chat and viewer-clip signals, windowed Whisper, range scans and repeat passes over a stream that's still live, `clip watch`, a test suite.
- **Next:** see **On the plate** below, the backlog in priority order.

### Where we left off (updated 2026-11-23)

**State**

- **What runs:**
  - the Studio (`./clip studio`, http://localhost:4400);
  - the watchlist (`tools/watchlist.ts --daemon`), which works on change requests first and then on the best community moments of the listed creators and topics, one job at a time;
  - the observer, which reads chat and re-ranks the moments;
  - the upload scheduler, at most 8 uploads in any 24 hours, 3 hours apart;
  - the hourly cleanup.

  Every agent runs on DeepSeek V4.1 Flash through OpenCode. `docs/operations.md` covers how each one runs.
- **Safety, after YouTube removed two videos on 2026-11-21:**
  - never-post gates in the ranker, in curation and in the publishers;
  - censoring tools: masked captions, the `bleep` and `blur` markers, and `clip censor`;
  - the 18+ check, with age-restricted uploads;
  - a careful period until 2026-12-06.

  The full account is in `docs/research/censorship-review-2026-11-22.md`.
- **Editing:** the meme editor's vocabulary comes from 175 top clip Shorts (`docs/research/meme-edits-2026-11-22.md`). It covers:
  - the premise box, snap zooms and tilts, reveals and tint beats;
  - counters and chat cards;
  - freeze plus black-and-white fail endings;
  - facecam-only and game-only spans.
- **Review:**
  - A approves, C asks for changes and R rejects with a reason. There is an 18+ check, and ↩ Back to review (U) undoes a decision.
  - The editor agent acts on change requests.
  - Seven change requests sent with only the editor's hand-over as the note are held until a note is written (2026-11-23).
- **Release:** the project is being prepared as a public GitHub repo (`docs/release-plan.md`). It is public at https://github.com/LevelPanic/clip-engine, with CI (typecheck and tests) on every push.
- **Disk:** about 7 GiB was free on 2026-11-23. The cleanup frees a stream's footage once none of its clips is waiting for review or upload.
- **Standing decisions (user):**
  - English only.
  - Older clips are not re-rendered when the editor improves (2026-11-14).
  - No Sonnet: DeepSeek runs the session's agents (2026-11-14).
  - The engine owns the layout (2026-11-18).
  - QA does not hold back an approval (2026-11-22).

**What's left:** see **On the plate** below. Keep it current: tick items off, add new ones as they come up.

**The user's mental model:**
1. A link goes into `/clip`, and the Studio opens on the candidates.
2. They pick the good ones.
3. For each one, they export it as is, or edit it and then export.

For streams the link comes with a range ("from 1 hour on") or "the new part since last time". Their goal is about 100 shorts a day.

### On the plate (backlog, updated 2026-11-22)

In priority order. Each item says where to work and when it's done. Move an item to the build notes when it's finished, and keep this list current.

**Release as a public GitHub repo (added 2026-11-23, user: "put live" as a public repo): done 2026-11-23**
- **Where:** `docs/release-plan.md` (four audits: git safety, architecture, Studio design system, docs/layout). Phase 0 makes it safe to commit (ignores, example configs, personal data out, LICENSE, noreply author email); phase 1 docs and layout; phase 2 the import cycle, thin daemons, the CLI split, one config module; phase 3 the Studio's tokens and primitives; phase 4 CI, a fresh-clone test, then the push.
- **Done when:** the repo is public, a fresh clone passes typecheck and tests with the example configs, and nothing personal or creator media is in its history.
- **Status (2026-11-23):** done. All four phases shipped, and the repo is public at https://github.com/LevelPanic/clip-engine with CI on every push. Commits are authored as LevelPanic with the noreply email. Left for later, not blocking: the watchlist's discovery and status page and the observer's loop (still in `tools/`), the Studio server's routers and the big UI files, and tests for the worker, render, Whisper and the judge (`docs/release-plan.md`).

**Next. The rest of the censorship review (added 2026-11-22)**
- **Where:** `docs/research/censorship-review-2026-11-22.md`. All three of "The three changes to make first" are built (see "Where we left off").
- **Before anything:** the user checks YouTube Studio for a warning or a strike (C1); it decides how careful the next two weeks must be.
- **On 2026-12-06 the careful period ends** and the deferred approvals go up by themselves, 8 a day: look at them before then (some may be stale or better rejected), or move `careful.until` in `channel.json`.
- **Left in the report, not asked for yet:** title lint in `suggestTitles` so sexual and shock words are never proposed (A5); NudeNet on the 16:9 cut before the edit, with boxes, so cuts and blurs can be proposed automatically (A6, then B4); a risk strip above Approve with the flags, the NudeNet stills and the swear count (A7); 18+ never for nudity, in the wording (A8); a "camera only" framing for a span (B4); a blur over the chat overlay when a slur was typed (B5, now possible by hand with the blur marker). The blur box is static: a moving subject needs a marker per stretch, or tracking from NudeNet's boxes.
- **Open from change 1:** a `minor` flag is on the moment, so no edit clears it (`tw-2936814907-c03`, someone else's reel, can only be rejected); a slur in an on-screen chat is still only a warning (the blur marker can now hide it by hand).
- **Done when:** the user has picked which of the rest to build, or set them aside.

**First. Uploads: about 10 a day reach YouTube, and approvals run about 20 a day (added 2026-11-20)**
- **Where:** `tools/upload-cron.ts`, `pickApproved` (`src/review/db.ts`, oldest approval first).
- **Decide (the user):** how the 8 a day are used. Since 2026-11-22 (change 2) they go up 3 hours apart across the day, oldest approval first, so approving more than 8 a day grows a backlog of ageing clips. Options: keep that; put the best approvals first instead of the oldest; drop approvals older than a few days; send the overflow to TikTok.
- **Done when:** the backlog stops growing, or the user has picked how it is handled.

**Next. The rest of the meme-edit vocabulary (added 2026-11-22; the easy ones are built)**
- **Where:** `docs/research/meme-edits-2026-11-22.md` section 4; `src/core/layout.ts` (`splitGeometry`), `src/render/framing.ts` + `src/composition/FramedVideo.tsx` (both framing sides), `markers/`.
- **Left (M):** a ranking `list` overlay (rows that fill in). Cam-only / game-only spans are built (2026-11-23, `solo`).
- **Watch:** whether the new proposals get approved more or less than before (`clip stats`, the reviewer's reject reasons). If the reviewer turns down most tilts, tint beats or chat cards, lower their confidence or drop the rule.
- **Not for this channel:** meme pictures and videos, people cut-outs and commercial music (copyright / Content ID).
- **Done when:** the list is built, or the user sets it aside.

**Next. Rate what the moment jobs produce (added 2026-11-19)**
- **Where:** `./clip streams` (what each moment job made: `clipped` with clip ids, or `no-clip`) and the Studio review queue.
- **Check:** approve/reject the first 10–20 clips from moment jobs with reasons; compare the reject rate and the "boring" share with the 26-of-33 rejects before the rebuild.
- **Then decide:** whether a stronger model should make the final pick on each moment (DeepSeek runs the experts now), and whether the bar (`MIN_VIEWS`, `MIN_LAUGHERS` in `src/scan/moments.ts`) is right.
- **Done when:** one day of moment jobs is reviewed and the numbers are in this section.

**0. Prove the audited agent pipeline on a full stream**
- **Superseded 2026-11-19:** the watchlist now runs this pipeline unattended (DeepSeek through `src/pipeline/full.ts`), one ranked moment per job. What stays open below is rating what it produces; the Sonnet runs are history.
- **Done 2026-11-14:** the trial's four new moments are candidates (`c08`, `c09`, `c11`, `c12`), extracted on Sonnet (historical). The engine marks all four `skip`; three carry slur warnings for the on-screen chat.
- **Next:** `/clip-curator tw-2926144284`, then `/edit` on what it keeps. In a new session, check that `/clip-extractor` and `/clip-curator` come back as an agent's report (they were `context: fork` on Sonnet in the historical setup; the session that set this up had the old versions loaded).
- **Then run:** `/queue-check <id> --from … --to …` on 60–90 minutes of a fresh stream → `/clip-extractor` → `/clip-curator` → `/edit`. This was the real test of the Sonnet setup (historical): `docs/history/audit.md` section 6 is one half hour. Note the turns and the time per stage.
- **Cost:** measured historically: about $1.40 per half hour for the three experts on Sonnet 5.5 (was about $46). Under the current policy the session and the agents are DeepSeek V4.1 Flash; the same tokens are about $0.05, so the live constraint is turns, context and hand-offs.
- **Done 2026-11-14 on a fresh stream** (`docs/history/audit.md`, section 8). **Open from it:** watch and rate the three clips in the review queue; decide what opens the publish gate (every candidate was scored `skip` or `recut`, and `clip publish` wants `post`: let an approved review open it, or score again after the edit); one rule for captions over a game's own subtitles; a second stream, since both the instructions and the engine changed during this one.
- **Second fresh-stream run, the first coordinated one (Sonnet, historical; 2026-11-14):** ohnePixel `tw-2928608594`, 1:00–2:00, `docs/history/audit.md` section 9. 27 verdicts, 2 confirms, 2 candidates, both `review`, no keeps. The c02 dry run rendered with the credit and passed QA, but the split layout shows chat behind the transparent facecam; crop-only removes it and loses the face. **Open:** decide `c01`/`c02`; whether a mask for the cam box is worth building; whether `--live-from-start` should be the default rule for a stream that is still live.
- **Check:**
  - Do the six scores spread (not 7–8 across the board)? The batch note from `clip candidates add` says when they don't.
  - Do the experts' confirms match what the user would post? Rate the confirmed moments 1–5 and compare with `confidence` and the verdict. Add them to `library/calibration.json`.
  - Are rejects right? Read ten `reject` verdicts with their frames.
- **Decide:** `tw-2926144284-c01` (the BMW prank): recut to about 1:36:07–1:36:46 and retitle as a prank, or drop.
- **Then, from docs/history/audit.md "Still open":** put the experts on the unattended paths (`clip watch`, `clip batch`); show kind, `visual`, niche, fixes and the verdict ledger in the Studio; per-channel emote meanings; confirm viewer-clip offsets by aligning one clip's audio.
- **Done when:** one stream has gone through all four skills, the user has rated the result, and `clip stats` shows a row per queue expert and per niche.

**1. Log the headless judge in, then prove the unattended loop**
- **Mostly superseded 2026-11-19:** the watchlist's moment jobs are the unattended loop and need no `claude` login. The login still matters for `clip watch`, `clip batch` and the Studio's **Scan new part** (scan job → judge job).
- **The user's action:** the bundled `claude` CLI (path from `findClaude()` in `src/judge/index.ts`) says "Not logged in". Run it once in a terminal and type `/login`.
- **Then:** `./clip watch <live channel> --every 10m` judges each pass into candidates by itself. Also check the Studio **Scan new part** path (scan job → judge job).
- **Done when:** a watcher run adds candidates on its own, with no session.

**2. GTA 6 / montage mode (with or without voice)**
- **Why:** GTA 6 will produce a flood of gameplay montages, some with voiceover and some music-only. The current pipeline is transcript-first: candidates need a quote, boundaries snap to sentences, and captions are on. A music-only montage has no transcript, so it can’t be judged or validated today.
- **New format `montage`**, alongside talk and stream:
  - **Lens** `lenses/montage.md`: `stop` = first frame/action, `hold` = pacing and beat variety, `share` = spectacle/skill, `payoff` = the climax, `delivery` = the title/hook matches what is shown. No talk-style `standalone`; the game and title carry context.
  - **Validator:** `quote` optional, no sentence snapping; start/end on scene cuts or audio beats; 10–30 s.
  - **Discovery:** scene cuts (`ffmpeg scdet`), motion, audio energy/onsets, music vs speech (VAD), on-screen text OCR (objective/kill feed), viewer clips/chat.
  - **Judge:** frames at start, middle and payoff plus the audio curve; no transcript.
  - **Render:** no captions, music track, beat-matched cuts; voiceover optional; full gameplay or split facecam.
  - **Studio:** montage timeline without the transcript/caption lane; waveform and beat markers.
- **Build order:**
  1. `montage` lens + optional quote/validator + frame/audio scoring.
  2. `clip montage` / `--format montage` candidate path.
  3. Beat-synced autoedit and no-caption render.
  4. GTA 6 event/OCR signals (mission, chase, explosion, wanted level).
- **Done when:** a 10-minute GTA 6 source becomes a 20-second 9:16 montage with beat-matched cuts and no transcript or captions, and the same path handles a voiceover version.
- **Sources:** GTA 6 streams/clips, viewer clips and top montages as the labeled corpus. Watch third-party/copyright.

**3. Exercise what hasn't run yet**
- **A full 8-hour broadcast in one pass** (`clip scan tw-… --from 0:00`): estimated about 12 min of chat, plus audio, laugh detection and Whisper for 25 windows. Check time, memory (chat.json size for a huge chat) and the Studio strip on a 10 h video (it's cramped; it may need a zoomed view of the scanned part).
- **A Twitch batch** (`clip batch https://www.twitch.tv/<channel> --limit 1`): ingest → scan → judge → make → render → QA.
- **From v0.5:** the Hype and Story styles through a bulk export, the Library batch form's style picker, and the editor's "accept proposals before export?" prompt.

**4. Kick sources**
- yt-dlp has Kick VOD and clip extractors.
- Add `kick` to `src/ingest/source.ts` (ids like `kick-<uuid>`), an ingest path like `ingestTwitch`, and formats in `src/ingest/downloads.ts`.
- Chat replay on Kick needs its own (unofficial, Cloudflare-protected) API. Start without chat: audio, transcript and seeds only.
- Check section alignment the same way as Twitch (`measureSectionStart`).

**5. Smaller improvements, noted while building**
- **`clip watch` stops when the stream ends.** It could wait for the channel's next stream (`--keep-watching`).
- **`clip watch --export N`:** export the top N new candidates of each pass as is, for a fully hands-off live pipeline.
- **Chat replay overflow:** pages by time offset lose messages in seconds with more than one page (about 60) of chat. Rates at giant spikes are undercounted (still spikes). Fixing it needs another source (e.g. recording live chat over IRC during `clip watch`, which is official and anonymous).
- **Viewer clips without a broadcast link** get an estimated position (creation time − duration). It could be refined by matching the clip's audio, as for sections.
- **YouTube live chat replay** isn't used (yt-dlp `--sub-langs live_chat`). It would give YouTube streams the chat signal too.
- **Raid handling** only damps the chat signal. Also skip the first minute after a raid when picking seeds.
- **Split layout follow-ups:**
  - The cam box is estimated from the face, not detected from the panel border; a border/edge check would make it exact on more layouts.
  - The reframe marker carries no boxes, so a span switching to split reuses the clip's layout. Giving the marker its own cam/game boxes would let one clip use different split framings.
  - Add a **Split here** timeline span action (today the Inspector's split option is clip-level).
- **Publisher follow-ups:** add playlist/thumbnail support, a schedule picker to override the default +5/+10 slots, Reels, TikTok Direct Post after the audit, and a queue so a review batch can post one at a time within quota.
- **Earlier ideas the user mentioned:** background music and trending sounds (needs licensed audio), B-roll.

**6. Housekeeping**
- **Nothing is committed** (no commits; everything untracked). Commit only when the user asks.
- **The Twitch web API is unofficial.** If `npm run test:e2e` starts failing on the API test, check the persisted-query hash and the field names in `src/ingest/twitch.ts` first.

## Open questions

1. What do you clip first: talking content (podcasts, interviews, commentary) or visual content (gaming, sports, reactions)? v0.1 discovery is led by the transcript, so visual content would need audio and visual signals sooner.
2. ~~Is 9:16 the only output?~~ Resolved: one 9:16 master for Shorts, TikTok and Reels (see Output spec).
3. Are you OK with the agent (Claude Code) as the v0.1 judge, with a local model added later?
4. Remotion's license: are you working solo or in a team of 3 or fewer? Larger teams need a paid licence. The alternative is an ffmpeg-only renderer with no live preview of effects.
5. Do you have SFX you want to use? If not, v0.1 ships a few generated placeholder sounds and a folder to drop yours into.
