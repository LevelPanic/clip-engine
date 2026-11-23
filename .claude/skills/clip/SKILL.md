---
name: clip
description: Turn a YouTube video or a Twitch stream into ranked short-form clip candidates. It ingests the video (captions, comments, chapters, SponsorBlock) or scans a range of a stream (chat, viewer clips, audio, a transcript around the best moments), judges it through a lens and adds validated candidates, then opens the Studio for review. Use when the user gives a YouTube or Twitch link (a broadcast, channel or clip) and wants clips, shorts or highlights from it, including "from 1:00:00 on" or "the new part since last time".
argument-hint: <youtube-or-twitch-link> [lens] [--from 1:00:00] [--to 2:00:00] [--continue]
allowed-tools: Bash(./clip:*), Bash(curl -s http://localhost:4400/*), Read, Write
---

# /clip: YouTube link → clip candidates

Arguments: `$ARGUMENTS`. The first is a YouTube link or 11-character id; the second is an optional lens (default `podcast-general`; see `lenses/`).
Run everything from the project root. The CLI is `./clip`.

**A Twitch link** (twitch.tv/videos/…, a channel, a clip, or a library id starting `tw-`), or a range or `--continue` on any video: follow **Streams** below instead of steps 1–2, then continue at step 3.

**Two ways to work a stream.** This skill is the quick pass: one judge reads the strongest seeds of a
scanned range and proposes its best candidates. The full process in `PROCESS.md` puts three experts on
every segment and then extracts, curates and edits: `/queue-check` → `/clip-extractor` →
`/clip-curator` → `/edit`. Use the full process when the user asks for it, or for a whole stream; use
this one for "a few clips from the last 15 minutes" and for YouTube videos.

The words for scores, evidence and the parts of a clip are defined in `agents/vocabulary.md`.

## Streams: scan a range

A stream runs 6–12 hours and may still be live, so it's scanned a range at a time, never all at once.

**With no range given, start from the moments.** `./clip moments "<link>"` ranks the whole broadcast's moments from viewer clips and chat laughter (each with the window to scan); scan the top few windows rather than the newest minutes. `./clip track "<link>"` hands the stream to the watchlist instead, which works through its best moments by itself.

1. **Scan:** `./clip scan "<link>" [--from 1:00:00] [--to 2:00:00] [--continue]`.
   - Pass on the user's range ("from 1 hour on" is `--from 1:00:00`; "the new part since last time" is `--continue`). With no range, a broadcast link starts at its `?t=` or 0:00.
   - A clip link scans around that clip; a channel link takes its newest broadcast.
   - It ingests if needed, then for the range: chat, viewer clips, audio laughs and shouts, a transcript around the best seeds, and the seeds. It takes about a minute per 15 minutes of stream.
   - If it says **Up to date**, tell the user (a live stream needs at least a minute of new stream beyond the last pass) and stop.
   - A live stream is scanned up to 3 minutes before the live edge; each `--continue` starts 2 minutes before the last pass ended.
2. **The seeds** are in its output. `./clip discover <id>` prints them again (it defaults to the last pass).
3. **Lens:** `stream-moments` unless the user said otherwise.
4. **Read each seed** (strongest first, up to 12), several in parallel:
   - `./clip transcript <id> --from <seed − 0:30> --to <seed + 0:30>` transcribes the window if it isn't yet (about 20 s), so you can read anywhere in the range.
   - `./clip chat <id> --from … --to …` shows chatters per 10 s, how far above normal, and the most repeated messages. Chat reacts 5–25 s **after** the moment, so the clip starts before the spike.
   - The seed's viewer clip titles say what viewers thought the moment was.
   - Look at the screen for gameplay moments: `./clip frames <id> <time>`.
5. **Judge** as in step 5, with these stream rules:
   - Start on the setup, before chat reacts. Chat peaks 5–25 s after the moment.
   - A `⛔ muted` stretch has no sound (Twitch muted copyrighted music): never clip it.
   - The quote must be in the transcript, so read the window first. A moment with no words (a scare, a fall) is added with `"visual": true` instead of a quote; it then needs a reaction, a chat spike or a viewer clip inside it.
   - Skip moments that only work if you saw the chat or an alert on screen.
   - A viewer clip's offset is near the moment, not exactly its start or end. Find the moment in frames.
   - When chat calls something fake, or laughs before the streamer does, read the two minutes after it before you title it.
6. **Add** as in step 6, then hand over (step 7) with `./clip open <id>`. Tell the user they can scan the new part later with `/clip <id> --continue`, the Studio's **Scan new part** button, or follow it live with `./clip watch <channel>`.

## 1. Ingest (about 1 min)

```bash
./clip ingest "<url>" --wait
```

This prints the video id, length and which data exists, and fixes names the captions misheard. `--wait` waits for the audio download and the laugh/cheer detection; about a minute for 2 hours. Video footage is downloaded later, only around the candidates.
If it says `captions: none`, Whisper transcribes the video in the background (about 7 min per hour); wait for it with `./clip jobs --active` before discovering.

## 2. Discover (under 1 s)

```bash
./clip discover <id>
```

Note which signals fired, the excluded ranges (sponsor reads, intro, cold-open montage) and the seeds.
"No seeds" means the signals are weak, so read the whole transcript in step 4.

Then look at one still from the middle of the video: `./clip frames <id> <a time near the middle>`, then read the image.
- If it's a still image (cover art over an audio-only podcast), tell the user now: shorts from this upload will be static art with captions. They may want the video version of the episode.
- Note the layout too (facecam over gameplay, a two-shot, a single speaker). It decides framing later.

## 3. Choose and read the lens

Pick the lens from the content unless one was given:
- `podcast-general`: comedy, conversation and YouTube commentary/essay videos about games.
- `hot-takes`: business, advice and interviews.
- `stream-moments`: **live** gameplay reactions, where the face/event on screen is half the moment. A commentary video about a game is talk, not stream.

Read `lenses/<lens>.md`. It defines the score, the boundary rules and how to write titles and hooks.

If `./clip stats` shows review decisions, read them.
- Lean towards what gets approved: lens, score range, signals.
- Follow the reviewer notes.

## 4. Read the transcript where it matters

- For each seed, strongest first (up to 15), read its window with 30 s of margin on each side. Send several of these in parallel:
  ```bash
  ./clip transcript <id> --from <seed start − 0:30> --to <seed end + 0:30>
  ```
- **Coverage:** signals miss moments, especially on new videos with few comments. If you have fewer than 8 promising moments, read the chapters with no seeds as well (`--from`/`--to` by chapter). The full transcript is `library/<id>/transcript.md`, about 15k tokens per hour.
- **Line format:** `[m:ss.s]` is the start time; `»` is a new speaker; `[laughter]`/`[music]` are tags; `[__]` is a censored swear word; `⛔` marks a range you must never clip.
- **Themes:** `./clip search <id> money rich poor` finds every place a theme comes up.
- **Look at the screen** when the moment is visual (streams, gaming, reactions): `./clip frames <id> <time> <time>` saves stills and prints their paths, and you read them. This takes about 15 s before footage exists, and is instant after.

## 5. Judge

1. Draft about twice as many moments as you'll keep.
2. For each one, choose the cut first: the first word of the setup, and the end just after the payoff. Check the first frame and the last line.
3. Score the batch together. Each moment gets the lens's **quality score** (`score`, 0–100: is this a good moment at all?) and the six **funnel scores** (0–10): `stop`, `hold`, `share`, `standalone`, `payoff`, `delivery`.
   - Use the 2 / 5 / 9 anchors in `agents/vocabulary.md`.
   - **Rank first, then score:** for each quality, order the moments from best to worst, then give numbers that keep that order. Most real moments are 5–7; a 9 is the best thing in the video.
   - For any score of 8 or more, or 4 or less, the `reason` says what you saw.
   - **Do not apply a gate and do not aim for "post".** The engine turns honest scores into virality, a rank and a verdict (`post`, `recut`, `skip`), with weights that depend on the lens: a talk clip may open slowly, a stream clip may not.
4. Drop duplicates and anything you scored under 60 for quality.
5. Keep the best **8–15**, and keep them diverse: not five clips from the same two minutes.

**The hook test:** mute the first 1.5 s. Is there a face or an event on screen, and does the first
line make a stranger stop with no context? If not, recut to the strongest line, or propose a cold
open (peak first, then rewind). A strong event behind a weak opening still dies.

**The trust test:** does the clip deliver what the opening promised? `payoff` is about the ending
(does it land on an outcome/reveal/punchline?); `delivery` is about the promise (does the first line
get the specific thing it set up?). A clip can have a payoff and still fail delivery. Examples:
"he explains why he left" needs the reason; "the race starts now" needs the race or its result;
"she reveals the name" needs the name said. If the payoff is strong but it ends on a question, a
transition or before the promise lands, score `delivery` low: find the longer cut that lands it, or
drop it. Write the `hook` from the payoff, not from the setup, and never promise something the clip
does not show. Posting a hook that goes nowhere is worse than posting nothing.

**The truth test:** the title and the hook say what really happened. If the speaker takes it back,
or it turns out to be a bit or a prank a minute later, the title says so.

Each candidate needs:

| field | rule |
|---|---|
| `start` | Time of the first word of the setup, as a string: `"14:13.4"`. Copy it from a line's `[m:ss.s]`. A bare number means milliseconds |
| `end` | Just after the payoff, e.g. `"15:08"`. Aim for 15–60 s (20–59 is ideal). The validator allows up to 90, but an export over 60 s fails QA, so `/edit` trims anything from 61 to 90 s |
| `title` | 60 characters or fewer, specific, true, with names |
| `hook` | The opening line, or an on-screen hook of 8 words or fewer |
| `reason` | Why it works: the setup and the payoff, and what you saw for each high or low score |
| `quote` | 5–20 words copied exactly from the transcript inside the clip |
| `visual` | `true` instead of a quote when nothing is said or the words are not the point |
| `score` | 0–100 quality: is this a good moment at all? |
| `scores` | `{ "stop": 8, "hold": 6, "share": 7, "standalone": 8, "payoff": 9, "delivery": 9 }` — the funnel; `delivery` is the trust score |
| `lens` | The lens name. It picks the weights: `stream-moments` is judged on the first second, the talk lenses are not |

## 6. Add and validate

Write the list to `library/<id>/judge.json`, then:

```bash
./clip candidates add <id> library/<id>/judge.json
```

The validator does the following:
- Snaps start and end to sentence boundaries, keeping 300 ms before the first word and 400 ms after the last.
- Extends the end to include laughter.
- Rejects candidates that are outside 15–90 s, overlap a ⛔ range, duplicate another candidate, quote words that aren't in the clip, or are marked `visual` with no evidence inside them.
- Attaches the signals that back each candidate, plus warnings such as a likely caption mishearing found through comments.
- Prints **`score check:`** warnings where the transcript contradicts a score (a high `stop` on a silent or filler open, a high `payoff` ending on a question, a high `share` with nothing backing it), and a **batch note** when every candidate scored about the same.

For each rejection, fix the times or the quote and add *only the fixed ones* from a new file (`judge-2.json`).
For each `score check:`, fix the cut or correct the score: `./clip candidates score <id> <candidateId> --stop … --hold … --share … --standalone … --payoff … --delivery …`.
Accepted candidates queue their footage (just their sections) automatically, so previews appear in the Studio within a few minutes.

## 7. Hand over

1. Open the Studio on the candidates: `./clip open <id>`. It starts the Studio if it isn't running and opens the browser at `http://localhost:4400/#/video/<id>`.
   The Studio's exports launch headless Chrome, so if your shell is sandboxed, run this with the sandbox disabled.
2. Reply with:
   - The link `http://localhost:4400/#/video/<id>`.
   - A table of the accepted candidates: id, time, length, score, title and the signals that backed it.
   - Any caption warnings.
   - One line on what the signals missed or got wrong, if anything.

Then tell the user what they can do on that page:
- **Export** a candidate as is (captions and framing), or tick several and export them together, optionally with an edit style (clean, punch, hype, story). Exports are QA'd and land in the review queue with their post text.
- **Edit** a candidate to open it in the editor: trim, style, quick effects (boom, glitch, emoji…), auto-reframe all or part of it, then Export.

Don't make clips or add markers unless the user asks. The user reviews candidates in the Studio, or asks you to `./clip make <id> <candidateId>` or `/edit` them.

## Example candidate

```json
{
  "start": "14:13.4",
  "end": "15:08",
  "title": "50 Cent on whether he's worried about Diddy getting out",
  "hook": "Is a documentary worse than a diss track?",
  "reason": "Opens on the documentary-vs-diss-track question, pays off with the shooters line and the room losing it, ends before the ad.",
  "quote": "are you concerned at all? No, I have shelters",
  "score": 88,
  "scores": { "stop": 8, "hold": 7, "share": 9, "standalone": 6, "payoff": 9, "delivery": 9 },
  "lens": "podcast-general"
}
```
