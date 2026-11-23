# Clip engine: selection logic and process report — 2026-11-17

## 1. What was going wrong

Three separate problems were mixed together:

1. **The watchlist used the no-LLM heuristic judge.** It ranked candidates almost entirely on
   signal volume, so a 2.3× "mostly fail" chat blip could beat a 14.5× funny explosion. It also
   ignored the skill's setup/payoff test. This is why the review queue filled with weak moments.
2. **YouTube was treated as one kind of content.** For streamers, the watchlist watched `/videos`,
   which on YouTube is edited uploads (penguinz0's 6–10 minute videos, Typical Gamer's edited
   videos), instead of `/streams` (live and past broadcasts). Clipping edited uploads produces
   clips of clips, not stream highlights.
3. **The render pipeline had a temp-directory race.** `sections` and `split` jobs could download the
   same range into the same temp directory; one job deleted it while the other was still writing.
   ffmpeg then failed with `No such file or directory`. That produced the "clips are failing"
   symptom independently of content quality.

## 2. What changed

### 2.1 The judge: the full manual process, automated

The watchlist now runs the same four stages as the manual pipeline for Twitch streams:

```
queue-check (meme, virality and story experts in parallel + coordinator check)
  -> clip-extractor
  -> clip-curator
  -> edit
```

Each stage is an OpenCode Go / DeepSeek V4.1 Flash agent reading the same skill file a human/Claude
session would read:

- `queue-check`: `src/pipeline/full.ts` starts the three experts in parallel, checks pending queues,
  sends undecided moments back to all three experts once, then runs the coordinator's evidence check.
- `clip-extractor`: every confirmed moment becomes a candidate, with the expert's cut, edge checks,
  scores and risk flags.
- `clip-curator`: niche, angle, fit, keep / review / drop, with reasons and fixes.
- `edit`: fixes the structure, sets the split/blur layout, runs the meme and expert editors, settles
  captions, renders, reads QA, fixes failures, checks post text and submits to review.

YouTube videos/podcasts keep the quick one-judge `/clip` path, because that is the manual path for
YouTube videos. The pipeline never approves or uploads.

The old heuristic judge remains available as `clip judge --provider heuristic` for experiments, but
the watchlist never uses it. The Claude provider remains available for manual runs; the default model can
be changed with `CLIP_JUDGE_MODEL` / `CLIP_PIPELINE_MODEL`.

The automation's stage order is the manual stage order:

```
classify source → scan range → queue-check → extractor → curator → edit → review
```

### 2.2 Viral / funny logic: what actually changed

There are **no changes to the virality formula** in `src/candidates/virality.ts`:

- the six funnel scores — stop, hold, share, standalone, payoff, delivery — are unchanged;
- the `post / recut / skip` verdict thresholds are unchanged;
- `rankScore` is still computed by the engine, and the watchlist still picks in engine-rank order.

There are **no changes to the funny/hype/shock/... lexicon or spike thresholds** in
`src/discover/chatAnalysis.ts`: distinct chatters per 10 s, 5 s steps, trailing 5-minute median,
≥2.2× normal with ≥6 chatters, 25 s lead, bot/raid/event filters.

What changed is **where the evidence comes from and who applies it**:

- the old heuristic made the selection from its own chat-volume score;
- the LLM judge applies the same clip-skill tests to the transcript, signals, viewer clips, and
  measured chat explosions;
- the engine's own ranking still decides the final order, so adding chat evidence did **not**
  re-order the candidates.

In short: the viral/funny definitions did not move. The inputs and the judge did.

### 2.3 Measured chat explosions

`clip chat <videoId> --top 10` now lists the strongest explosions across a stream:

```
[1:51:40] 8.0× normal · 16 chatters · funny · lol · LMAO · yes
[1:04:40] 7.0× normal · 28 chatters · hype  · 2 · 3 · 22
```

For Twitch, these are measured from the chat replay and appended to the judge prompt as extra
evidence. They are advisory: the judge must still verify the words and the setup/payoff. For
YouTube, yt-dlp did not expose live-chat replay for the tested VODs ("no subtitles"), so YouTube
streams still use comments, heatmap and transcript signals. The engine does not pretend YouTube chat
was measured when it was not.

### 2.4 Stream vs edited classification

`tools/classify-channels.ts` classifies by platform surface, not duration:

| Creator | Source | Why |
|---|---|---|
| penguinz0 | Twitch `moistcr1tikal` | live; YouTube `/videos` are 6–10 min edits |
| SypherPK, Nickmercs, NickEh30, Ninja, ExtraEmily, Ludwig, xQc | Twitch | live/VODs |
| Typical Gamer | Twitch `typicalgamer` | live; YouTube `/videos` are edits |
| iShowSpeed | YouTube `/streams` | live + 1.9–4.7 h broadcasts; `/videos` are edits |
| Trash Taste | YouTube `/videos` | podcast; no `/streams` tab |
| CDawgVA | YouTube edited — skipped | no `/streams` tab; 24–39 min edits |
| Joey | Twitch `theanimeman` | channel exists, no recent broadcast; YouTube `/videos` are edits |
| Gigguk (Garnt) | Twitch `gigguk` | stream; last VOD “Playing Wuthering Waves 3.8 For The First Time” |

YouTube keeps past broadcasts in `/streams` and edited uploads in `/videos`. That distinction held for
every channel tested.

### 2.5 Live streams are bounded

A live check now scans at most the **last 20 minutes**, not every hour since the last check. If the
daemon was offline, it starts at `now − 20m` instead of trying to backfill the whole stream. Live
tails are queued automatically; one active job per creator. Long YouTube stream VODs over 30 minutes
are skipped by default to avoid multi-hour ingests (`MAX_YT_STREAM_MIN`).

### 2.6 Review, scheduler and cleanup

- The Studio review page has only **Approve**, **Make changes** and **Reject**. The
  "Schedule to YouTube" button and the P shortcut are gone.
- Approved clips are split into **Approved** (waiting for the scheduler) and **Uploaded** (the
  scheduler wrote a publish record). The Uploaded tab shows the YouTube link and live time.
- Approval writes the review DB. The upload scheduler picks approved, unpicked clips only.
- The scheduler now uploads **one clip every 20 minutes** (`UPLOAD_MIN=20`), still scheduling each
  clip to go live 5 minutes after its own upload.
- `tools/cleanup.ts` runs hourly:
  - deletes rejected clips after a 60-minute grace period: project, exports, review row;
  - keeps the rejection in `feedback.jsonl` and writes an audit line to `cleanup.jsonl`;
  - removes heavy source media (audio, sections, video) for streams that are analysed, have no
    active review/approved/changes clip, no queued/running job, and no activity for 24 hours.
    Metadata, transcript, chat, signals and candidates are kept. `SOURCE_DELETE=all` removes the whole
    source directory instead.
- Studio and CLI clip lists are title-first; the id is secondary.

### 2.7 Render race fixed

Every section/audio download now creates its own `mkdtemp` directory. The shared
`sections.tmp-<start>` and `audio.tmp-<start>` paths are gone, so two jobs cannot delete each other's
files mid-write. The SypherPK sections/split jobs then completed and the clip passed QA.

## 3. Manual stream review vs the automated process

### 3.1 The manual full process

The high-quality manual path for a stream is:

1. **Scan a range** — chat, viewer clips, audio reactions, transcript around the strongest seeds.
2. **Three queue experts in parallel** (`/queue-check`) — meme, virality and story experts read the
   same range and save confirmations, queues and risks.
3. **Extractor** (`/clip-extractor`) — turns each confirmed moment into one candidate, chooses the
   edges, checks the first/last words and frames, scores it.
4. **Curator** (`/clip-curator`) — assigns a niche and fit, keeps/reviews/drops, saves the ledger.
5. **Editor** (`/edit`) — fixes the in/out points, sets the 9:16 layout, runs meme/expert proposals,
   checks every proposal against the words and screen, settles captions, renders, reads QA, checks
   post text, submits to review.
6. **Human review** — approve, ask for changes, or reject.
7. **Upload** — approved clips are scheduled.

The quick manual `/clip` path is closer to what the automation does: one judge reads the strongest
seeds of a scanned range, reads the words and frames, scores the batch and adds candidates. It still
has a human choosing which seeds to read and looking at frames.

### 3.2 The new automated process

1. **Classify** the channel (Twitch / YouTube streams / YouTube videos / edited) and decide whether it
   is eligible.
2. **Check** live/VOD state; queue a 20-minute live tail or a 30-minute VOD chunk, one active job per
   creator.
3. **Scan** the range: chat replay, viewer clips, audio, transcript around seeds.
4. **Queue-check** with the meme, virality and story experts in parallel; the orchestrator retries
   undecided moments and runs the coordinator's evidence/risk check.
5. **Extract** every confirmed moment into one candidate, with the expert's cut, edge checks, scores
   and risk flags.
6. **Curate** every candidate: niche, angle, fit, keep / review / drop, with reasons and fixes.
7. **Edit** the kept candidates: fix the structure, set the 9:16 layout, run the meme/expert editors,
   settle captions, render, read QA, fix failures, check post text, submit to review.
8. **Human review** — approve / make changes / reject.
9. **Scheduler** uploads approved clips every 20 minutes; **cleanup** removes rejected clips and safe
   source media.

No step approves or uploads automatically.

### 3.3 Where they differ

| Dimension | Manual full process | Automated full pipeline |
|---|---|---|
| Discovery | Three experts + extractor + curator | Same three experts + extractor + curator, run by DeepSeek agents |
| Visual check | Human/experts look at frames, layout, facecam | Experts and coordinator verifier read the stills |
| Edges | Extractor/editor fix in/out points | Same extractor/editor, automated |
| Captions / meme edits | Editor and subtitle expert | Same edit skill: meme/expert proposals, captions, QA |
| Niche / angle / fit | Curator assigns | Same curator, automated |
| Titles | Human/lens-written, checked | Extractor/editor-written, reviewer can edit |
| Volume | A handful of carefully worked clips | Curator keeps; editor caps at `MAX_KEEP` (3) per range |
| Latency | Minutes to hours per batch | ~30–60 min per range (three experts + extractor + curator + edit) |
| Cost | Multiple agent calls + editing | Multiple DeepSeek calls per range; cheap but not free |
| Human role | Chooses moments, edits, approves | Final approve / make changes / reject only |
| Failure mode | Slower; depends on the operator | Agents can misread context; no human coordinator; YouTube uses the quick path |

The automation now runs the same stage list, with DeepSeek agents in the roles a human/Claude session
would fill. The remaining differences are judgment and oversight, not the process: the automated
coordinator verifies the ledger but does not have a person's context; the editor caps at `MAX_KEEP`
clips per range; and YouTube videos still use the quick `/clip` pass instead of the stream queue
experts.

### 3.4 Current evidence

- The full pipeline's queue-check on SypherPK 2:55–3:15 confirmed **5 moments** across the meme,
  virality and story experts; the one moment passed on as `other-kind` was sent back to all three
  experts and resolved. The extractor added **7 candidates**, the curator decided **keep 9 · review 6
  · drop 6**, and the editor submitted **3 review clips** (`c07`, `c18`, `c11`), all QA-passed:
  - “you going to get kicked out?” (26.7 s)
  - “SypherPK: the camera glitches are censoring me” (18.0 s)
  - “SypherPK finds something foul in the coffee shop sink” (36.3 s)

  Five more kept candidates were left as candidates because of the `MAX_KEEP=3` cap; they can be
  edited in a later pass or by raising `MAX_KEEP`.
- The full pipeline's first run (penguinz0 3:42–3:54) correctly returned "no candidates" after the
  experts rejected every queue: a quiet tail is not forced into a clip.
- The quick-path clips produced before the full pipeline are still in review (penguinz0 game death,
  NickEh30, Nickmercs roulette). The old heuristic batch was cleared (120 placeholders rejected).
- The render temp-dir race is fixed; the full-pipeline sections/split/edit jobs complete.
- By 2026-11-18 11:42Z the watchlist had **32 review clips** from the full pipeline across xQc,
  Nickmercs, Ludwig, SypherPK, penguinz0 and NickEh30; **1 uploaded** (CaseOh), **1 approved waiting**
  (the old blocked placeholder), and **6 queued jobs**. Gigguk (Garnt) was added to the confirmed
  creators; his newest VOD tail (6:25–6:55) is queued.

## 4. Known limits / next decisions

- The full process is automated, but it is still agents: the coordinator verifier cannot exercise a
  human's judgment, and the editor caps at `MAX_KEEP=3` clips per range. Extra kept candidates stay
  as candidates for manual editing.
- YouTube videos/podcasts use the quick `/clip` judge, not the stream queue experts. Their manual
  process is the quick pass; only Twitch streams run the full queue-check → extractor → curator → edit.
- YouTube live-chat replay is not available for the tested iShowSpeed VODs; YouTube streams use
  comments/heatmap/transcript. Capturing live chat for an active YouTube stream is a separate job.
- Long YouTube stream VODs (>30 min) are skipped unless `MAX_YT_STREAM_MIN` is raised.
- Rejections are logged but do not yet feed back into the experts' prompts or the watchlist priority.
- The scheduler still needs the YouTube daily quota to allow uploads; quota exhaustion is a deferral,
  not a failure.
- Subscriber-only Twitch broadcasts are skipped after the first access failure.
