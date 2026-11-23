# Clip engine — production pipeline

> **TL;DR:** stream → scan in ranges → 3 queue checkers (meme, viral, clip) → 3 experts look and give
> a verdict per queue → one candidate per confirmed moment → score/rank all (no dropping) → curator
> keeps/reviews/drops with a ground and a reason → trim, 9:16 layout, meme/expert edits, subtitle
> expert → render/QA → user review → schedule/post.

The workflow from a live stream to clips the user reviews. It is split into roles so each one has a
narrow job and a checked output. `agents/README.md` has the cast and the contracts between them;
`agents/vocabulary.md` has the words they all use.

In a session, the stages are skills:

```
/queue-check <id> --from … --to …   →   /clip-extractor <id>   →   /clip-curator <id>   →   /edit <id>
```

`/clip <link>` is the quick pass (one judge on the strongest seeds) for a few clips from a short range
or a YouTube video. Both paths end in the same candidates.

## 1. Retrieve the stream

- Find the live/current broadcast (Twitch top streams, channel, or a direct VOD link). English only for now.
- `./clip scan <link> --from … --to …` ingests if needed and scans a range: chat, viewer clips, audio
  reactions, and a transcript around the strongest seeds. About a minute per 15 minutes of stream.
- `./clip live` lists the big streams right now. `./clip status` shows what is already in the library.
- A stream is only known where it was scanned. **Unknown is never quiet.**
- **Unattended (the watchlist, 2026-11-19):** the stream is not scanned blind in 20–30 minute ranges.
  `./clip moments <link>` ranks its moments from what viewers did (viewer clips over the same seconds,
  distinct people laughing in chat), and the tracker (`./clip streams`, `./clip track <link>`) records
  every stream and moment. Each moment job scans one moment's window (a minute before its region to
  45 s after) and runs stages 2–5 on it with one clip at most. The same stages, a few minutes at a time.

Output: a library video (`tw-<vod>` or YouTube id) with its metadata and signals for the scanned ranges.

## 2. Queue checking, in segments

Split the range into segments of 20–30 minutes (a moment job's window is one short segment of a few
minutes). For each segment:

**a. The three checkers** (`./clip queues <id> --from … --to …`, deterministic, seconds) list queues: a
region around a moment where independent **witnesses** agree something happened. There are three
witnesses: a chat spike, a reaction heard in the audio (laugh, shout, cheer), viewer clips. Fast speech
and title words are context, not witnesses.

| Checker | Finds | Needs |
|---|---|---|
| **meme** | A quick, loopable gag. | A reaction heard, or chat laughing, gasping or mocking. Short region. |
| **viral** | A moment with reach beyond the fans. | Two witnesses, or viewer clips people actually watched. |
| **clip** | A story with a setup and a payoff. | Speech plus a witness. Long region. |

Chat trails the moment by 5–25 s, so the checkers line chat up with what it reacted to and place the
queue on the moment, not on its aftermath. A raid, a burst of subs or a yes/no vote is busy chat with
no moment, and is not a witness. Each queue also reports what chat said over its whole region: its
mood, the most repeated messages, how many people call it fake, and any slur typed (many streams show
chat in the frame). Each queue has a stable id (`meme@1:46:25`), its witnesses,
what fixed the moment's time (`audio` exact, `clip` or `chat` estimated), the evidence, and risks.

**b. The three experts** (`.claude/agents/`: meme expert, virality expert, story expert) each review
their kind's queues. They work from a **dossier** (`./clip queues … --dossier`): one call prints, for
four queues at a time, the words around each, the two minutes after it when chat is ahead of the
streamer or calls it fake (always for a story), and stills at the seconds that matter. They read the
words, **look at the stills**, and save one verdict per queue with `./clip queue-review`, a batch at
a time. The story expert also reads the whole segment's words once, for a story nobody reacted to
(the checkers cannot see one). They run on DeepSeek V4.1 Flash (or the session, when the queue set is
small enough to do inline); `agents/README.md` says which model runs what, and why.

- `confirm`: an archetype, the frame they saw, a confidence, for viral queues why a stranger would send it, and a `cut` note for the extractor (what must be inside, which pause to keep, where the clean out is).
- `reject`: a ground (`no-visible-cause`, `chat-only`, `event-not-moment`, `lore`, `no-reach`, …).
- `merge`: it is the setup or the tail of another queue.

The CLI refuses a confirm that cites no frame, a frame nobody fetched a still for, a quoted line
that is not in the transcript, a reject with no ground, and any word outside the vocabulary.
`/queue-check` transcribes the segment once beforehand, runs the three in parallel, checks every
confirm against the stills it cites (`./clip queue-review --evidence`), and reports.

Output: `library/<id>/queue-review.json`. Confirmed verdicts within 20 s of each other are **one
moment**, however many experts flagged it.

## 3. Extract clips — weighted windows

A queue is a region, not a cut. For each confirmed moment the extractor (`/clip-extractor`) reads the
weighted windows (`./clip windows <id> --queue <queueId>`), which try start and end points on word
boundaries and score them for the kind:

All three are **15–60 s**; the extractor chooses short or long. The kind changes the weights:
- **meme:** the moment about a third of the way in; opens a beat before the hit, ends after the laugh or scream.
- **viral:** includes the peak and the strongest reaction; starts on a sentence that sets it up.
- **clip:** includes the setup sentence through the payoff; never ends on a question.

The scorer adds an **ever-so-slight buffer**: 300 ms before the first word and 400 ms after the last.
The buffer is part of the clip, and the validator keeps it. Four seconds with nothing happening at the
open is a **dead open** and costs a window points; a window that stops before a reaction says so.
Where nothing is said (a scare, a fall), windows are cut around the moment itself.

`clip windows --queue` scores its windows around the moment the expert saw (not the checker's
estimate) and shows the expert's own cut scored the same way. The extractor starts from the expert's
`start`, `end` and `cut` note, checks the words and the first frame at both edges, and picks.

**Every confirmed moment gets extracted,** one candidate per moment; a low score is not a reason to
leave it out. The validator (`./clip candidates add`) still refuses invalid windows (under 15 s, a
quote not in the transcript, muted or sponsor overlap, a duplicate). A moment with no words is added
as a **visual** candidate: no quote, but a witness must be inside it.

Output: one candidate per confirmed moment, with its window, quote, the expert kind and queue id.

## 4. Score, rank, then curate

- **Score/rank all:** every candidate gets the six funnel scores (stop, hold, share, standalone,
  payoff, delivery) from the extractor, by the 2 / 5 / 9 anchors in `agents/vocabulary.md`, ranked
  against each other first. The engine computes virality (weights depend on the lens: stream or talk),
  signal convergence, a rank and a verdict. Nothing is removed at this point.
  - The validator cross-checks scores against the transcript (`score check:` warnings) and says when
    a whole batch scored the same.
- **Curator** (`/clip-curator`): reviews the full ranked field with the experts' notes and assigns a
  **niche**, an angle and a **fit** to each candidate. A low virality score can still be a perfect fit
  for a niche.
  - `keep` — fits a niche and has a clear use; proceed to editing.
  - `review` — uncertain, or it carries a risk flag a person must judge; left for the user with the question spelled out.
  - `drop` — only on a ground: no niche **and** no standalone use, a duplicate, muted, broken, unsafe, not English. Low score alone never drops a clip.
  - Every drop records a `removalWeight` (0–100) and a reason. The user can reverse any drop.
- The ledger is saved through `./clip curate`, which checks it, fills in the scores itself and is the
  only thing that changes a candidate's status.
- Only `keep` and `review` clips go to the edit stage.

Output: a ranked field plus `library/<id>/curation.json` with niche, fit, decision, ground, removal
weight, reason and fixes for the editor.

## 5. Edit the clip

`/edit` does these in order: **structure, then decoration, then captions.**

- **Trim:** something happens within about 2 s; the archetype's setup is inside; the clip ends on the
  landing line or a beat after the reaction; nothing private is on screen in the first frames.
- **Layout:** the clip is cut from the source in its original 16:9 first, then framed to 1080×1920:
  split facecam/gameplay, crop or blur-fit. Facecam detection + panel refinement; the automatic split
  is skipped for event/IRL clips with no gameplay facecam (`--no-split`); the default for Twitch facecam clips is the split layout (facecam top, the game or the whole frame below, on a blurred cover). The engine sets and checks it at render (`src/qa/layout.ts`); a split with no face in its camera band falls back to blur-fit.
- **Meme editor:** hook text that leaves before the hit, one punch-in on the punch word, an emoji and
  a flash on the reaction, dead-air cuts, a speed-up in the middle of a long run-up. It never cuts the
  pause before a laugh.
- **Expert editor:** a cut to the first word, dead-air cuts, a context line, a slow push-in on the
  quoted line; notes when the ending or the length is wrong.
- Both editors find the moments first (where someone laughed, the word before it, the quoted line)
  and place edits on them. They write **proposed markers**; `--review` is read-only. They do not stack
  an edit on one that is already there, and they do not touch captions or the review note.
- `/edit` checks every proposal against the words and the frame, keeps what has a purpose, and
  accepts or rejects.
- **Subtitle expert** (`/subtitle-expert`): owns captions. Decides **on/off**, the style
  (`street` by default, `commentary` for talk, `comic`, `native`; `bold`/`boxed`/`clean` are the legacy
  looks), position (0.72, or 0.74 in a crop; safe zone), uppercase/font, and word fixes. Off when the
  clip is music/crowd-only, has burned-in captions, is non-English, is text-heavy, or has an
  unreliable transcript. It does not auto-hide intentional repetition or auto-censor profanity; those
  are flagged. The engine never turns captions back on once someone turned them off.
- Render, normalise to −14 LUFS, then QA: length, loudness, dead air, black frames, caption overflow,
  content risk. Fix and re-render if QA fails.

Output: a 9:16 export that passes QA.

## 6. Package and schedule

- `./clip post <clip>` gives five title options in the viral clip format: bold name+action (default),
  quoted spoken line, curiosity, chat-aware, and searchable context. Short nickname, one all-caps
  word, 1–2 reaction emojis, no colon.
- **The title is true.** A prank, a bit or a retracted claim is titled as what it was.
- **The credit.** Every clip names its creator on screen for its whole length (the `credit` marker;
  new clips have it, `./clip credit <clip>` adds it to an older one). Under the caption, every post
  carries the creator's channel, the source opened at the second the clip starts, the stream's title
  and game, and a line saying the channel is automated and not affiliated. An edited caption cannot
  lose it. QA fails an export with no on-screen credit, which blocks publishing.
- **The channel's own words** (its name, the line about what it is, how a creator asks for a change
  or a removal, and the do-not-clip list) are in `channel.json`.
- Description and 3–5 hashtags are generated; the publisher sends no tags.
- `./clip publish <clip>` schedules the upload: private until the slot, first +5 minutes, next +10,
  next +15, measured from the first upload in the batch. `--now` and `--publish-at` override.
- `./clip analytics` imports the outcome later (engaged views, average view %, shares, subscribers)
  and `./clip stats` calibrates the scores against reality, by lens, **by queue expert** and **by niche**.

## 7. User review

The user sees the clips in the review page / Studio and decides what to keep. Their decisions and
ratings feed the feedback log, with the expert that found each clip and the niche the curator gave it,
so the queue checkers, experts, editors and title generator can be calibrated against what the user
actually posts and what performs.

Anything an agent flagged as `privacy`, `minor`, `slur`, `sexual`, `self-harm`, `misleading` or
`staged` reaches the user word for word. The pipeline does not decide those.

## Roles

| Role | Output |
|---|---|
| Stream retriever | library video + metadata, scanned ranges |
| Queue checkers (engine) | meme / viral / clip queues with witnesses, evidence and risks |
| Meme expert | verdicts on meme queues: quick, loopable gags |
| Virality expert | verdicts on viral queues: reach beyond the fans, with the share trigger |
| Story expert | verdicts on clip queues: setup → landing, with the cut |
| Clip extractor | one candidate per confirmed moment, weighted window, no score-based drops |
| Scorer (engine) | virality, convergence, rank, verdict |
| Curator | niche + fit + keep/review/drop, ground, removal weight and reason |
| Meme editor | meme markers (proposed) |
| Expert editor | professional markers (proposed) |
| Subtitle expert | caption decision + word fixes |
| Intro editor (`/clip-intro`) | optional, on request: 4–8 word premise line in the hook text |
| Publisher | scheduled YouTube upload, TikTok inbox draft |
| Reviewer | keep / post / changes |

## The run's last step

The coordinator writes a **preview page** and opens it in the Review pane: both (or all) clips playable,
with length, scores, curator decision, the risk flags and the title/hook check. `ohne-preview.html` is
the model. The user sees the result before any prose; the written report is the index, not the
deliverable.

## Automated clipper: what it does not solve

The channel is a promoter. It credits the creator on screen and under every post, links back, and
stops when asked. That is the right way to run a clip channel. It is not a licence.

- **Permission.** The streams belong to their creators. Many welcome clip channels and some publish
  rules for them; a credit implies none of that. Clip the creators who allow it, act on a removal
  request the day it arrives (`channel.json` → `doNotClip`), and do not monetise someone else's stream
  without their say.
- **The platforms' rules.** YouTube, TikTok and Instagram demote or refuse to pay for re-uploads with
  nothing added, and YouTube's "inauthentic content" rule targets templated mass production
  (`agents/research.md`, section 7). Saying the channel is automated is honest; it does not exempt
  it. The edit pass (hook text, captions, cuts, framing) is what makes a clip more than a re-upload,
  so "export as is" at 100 clips a day is the risky path.
- **Links.** A link in a Shorts description is not clickable (`agents/research.md`, item 45). The
  on-screen credit is what a viewer sees; the description is the record.
- **Other people's material inside a stream.** An awards show, a song, a video the streamer is
  watching: the experts flag `third-party` and `music`, and a person decides.
- **The TikTok integration's own terms** (`legal/terms.html`) say the uploader owns or has the rights
  to what is uploaded. Posting a creator's stream there needs that creator's permission.

This is a reading of policy text, not legal advice.
