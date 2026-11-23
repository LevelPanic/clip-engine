# Watchlist and clip pipeline: what changed (after), 2026-11-19

What the unattended clipper does now, what was wrong with it, and what was built to fix it, from the
user's report ("the last few clips were really bad … IShowSpeed was the same video over different subs …
the list I made isn't really working") through the four build steps of
`docs/research/stream-pipeline-spec-2026-11-19.md`. The spec says what was planned and why; this says what is
in the code, where, and what was measured. Nothing is committed.

---

## 1. The short version

- **Bad clips:** most of the "boring" rejects were **old leftovers**, not the moments the jobs were for.
  A moment job's editor took any kept candidate anywhere in the stream. Each job now works only on its own
  moment's candidates.
- **IShowSpeed:** his stream was **still live on YouTube** when it was clipped, and a live YouTube stream
  cannot be cut at a given time: all three clips were the same live minute. Live YouTube streams are now
  never read; the finished VOD is taken (up to 12 h).
- **Your list:** creators were being found, but **topic streams outranked them** and only GTA 6 ever
  got a topic slot. The order is now: streams added by hand → your listed creators → topics; every
  topic gets its own top 3 each check; every creator broadcast of the last 48 h is tracked.
- **Reliability:** a stream is one record whatever found it; a moment keeps its identity when new
  viewer clips move its peak; every minute of every tracked stream is read by a background observer and
  recorded in a coverage ledger; the job queue lives in SQLite with leases, fencing and stage
  checkpoints, so a crash or restart resumes a job instead of losing or doubling it.
- **Second audit (GPT):** checked claim by claim; its confirmed bugs are fixed (viewer clips that
  vanished, out-of-window candidates, YouTube failures recorded as done, no audience data) and its
  ranking idea runs as a shadow ranker.
- **Tests:** 273 offline tests pass; typecheck clean (project and daemons).

---

## 2. How it works now, end to end

Three long-running processes, plus the Studio:

```
                      every 15 min                          continuously                      every 20 min
 channels.json ─┐   ┌──────────────┐   tracker (SQLite)   ┌──────────────┐   watch_jobs (SQLite) ┌─────────────┐
 topics.json  ──┼──▶│  WATCHLIST   │──▶ streams ────────▶│   OBSERVER   │                      │ UPLOAD CRON │
 clip track   ──┘   │  discovery   │    (one row each,   │ reads chat,  │──▶ moments ranked ──▶│ approved →  │
                    │  + clip      │     all sources)    │ ranks moments│    (rank, altRank)   │ YouTube     │
                    │  worker      │◀── next moment ─────┤ coverage     │                      │ + analytics │
                    └──────┬───────┘                     └──────────────┘                      └─────────────┘
                           │ one moment job at a time (lease, checkpoints)
                           ▼
          scan window → 3 experts (+ community brief) → verifier → extractor → curator → editor/render/QA → review queue
```

1. **Discovery (watchlist, every `CHECK_MIN` = 15 min):** each listed Twitch creator's broadcasts of the
   last 48 h; each topic's top 3 eligible live streams; YouTube creators' uploads and finished stream VODs.
   Everything goes into the tracker, one row per broadcast.
2. **Observation (observer, continuous):** reads every tracked stream's chat in 60-minute chunks up to
   the live edge, refreshes viewer clips, and ranks each stream's moments every 20 minutes and after each
   read. What has been read is the stream's `observe` ledger.
3. **Selection (watchlist):** the next moment: by hand → listed creators → topics; within a tier each
   stream's best before anyone's second; at most 4 moments per stream; one moment job waiting at a time.
4. **Clip job (watchlist worker):** scan the moment's window (a minute before its region to 45 s after),
   run the three experts with the community's evidence, the verifier, the extractor, the curator and the
   editor on **this moment's candidates only**; one clip at most; submit to review. Each stage is
   checkpointed.
5. **Review (you, in the Studio)** → **upload cron** posts approvals one every 20 minutes (5–60 s,
   passing QA, a real title) and imports YouTube analytics once a day.

---

## 3. What was wrong, and what fixed it

| Problem | Evidence | Fix | Where |
|---|---|---|---|
| Moment jobs shipped old leftover clips | 7 of 20 moment-job clips were from elsewhere in the stream (4 rejected "boring"); TheBurntPeanut's 20k-view moment at 9:01 shipped a 12:23 talk clip | The curator and editor get only the pass's candidates; clips are attributed by candidate id | `passCandidates`, `pickForEdit`, `curate`, `edit` in `src/pipeline/full.ts` |
| A strong moment came out with no queue | xQc's 25k-view moment: "0 queues" at job time | The experts get the community's evidence; the virality expert judges the moment as a *found* moment when no queue covers it | `momentBrief`, `expertPrompt` |
| Curator "for the reviewer" candidates vanished | Kai's 12-clipper moment: confirmed, then left in `review` where nobody looks | When nothing is kept, the best `review` candidate is rendered with the curator's concern | `pickForEdit` |
| IShowSpeed clips were the same minute | Stream clock 25:41 in clips cut at 0:26, 1:31, 1:45 | Live YouTube is never read: ingest refuses it, every download refuses a video read while live, the watchlist waits for the VOD; cap raised 30 min → 12 h | `youtubeLive`, `liveFromStart` (`src/ingest/media.ts`), `ingest.ts`, `checkYouTube` |
| Topics outranked your list | GTA 6 topic streams ahead of listed creators | Tiers: by hand 0, listed creator 1, topic 2; a waiting lower-tier job gives its place | `tierOf`, `nextMoments`, `enqueueMoment` |
| Only GTA 6 was ever a topic | 3 global topic slots, all GTA 6 | Every topic, every check, its own top 3; listed creators never take a topic's place | `topicPicks` (`src/scan/topics.ts`), `checkTopics` |
| A creator's first stream of the day could be missed | Only the newest broadcast was read | Every broadcast live in the last 48 h | `recentBroadcasts` (`src/ingest/twitch.ts`), `checkTwitch` |
| The worker slept with work waiting | 2 jobs then a 15-minute sleep (about 70 moments a day at most) | Back to back; checks between jobs; sleeps only when idle | the daemon loop in `tools/watchlist.ts` |
| A restart lost or doubled jobs | Kai's best moment marked failed by a restart | Leases, fencing, stage checkpoints in SQLite (section 4.6) | `src/track/jobs.ts` |
| Subscriber-only VODs failed every moment | Typical Gamer: each moment job failed at the audio step | Any step that finds the broadcast unreadable skips the stream once | `unreadable`, `afterError` |
| Viewer clips vanished on refresh | ohnePixel's file empty at one snapshot while its 291k-view moment existed | Refreshes merge by clip slug; nothing seen is dropped; each fetch logged | `mergeViewerClips`, `fetchViewerClips` (`src/ingest/chat.ts`) |
| Duplicate moments | 27 overlapping pairs among 516 | A moment is a region; re-ranks match the row they have; duplicates `covered` | `sameMoment`, `planMoments`, `duplicatesOf` |
| Scanned minutes hid later moments | 107 regions hidden (second audit) | Scanned minutes are ranked; worked windows prevent double work instead | `rankStream` (`src/scan/rank.ts`) |
| YouTube failures recorded as done | A failed judge marked the job done; podcast lens for every source; 15 s floor; submit unchecked | Typed outcomes; lens by content; 5–60 s; submit checked | `quickClips`, `lensFor` |
| No audience data | `performance.jsonl` empty with 14 uploads | `clip analytics` daily from the upload cron (17 clips on the first run) | `analyticsIfDue` (`tools/upload-cron.ts`) |

---

## 4. Component by component

### 4.1 Discovery (`tools/watchlist.ts`)

- **Creators** (`checkTwitch`): `recentBroadcasts(login, since)` reads the channel's last 10 archives
  and keeps those live at any time in the last `RECENT_HOURS` (48). Each is upserted with source
  `creator:<name>`; `wrongStream` skips test streams, reruns/VOD channels and streams that ended under
  20 minutes. A channel live with no VOD is recorded as such.
- **YouTube creators** (`checkYouTube`): a live (or still-processing) stream is left unseen until it
  ends; stream VODs up to `MAX_YT_STREAM_MIN` (720) are queued as `youtube-check` jobs; streams that the
  old path read while live were forgotten once at startup so the VOD is taken.
- **Topics** (`checkTopics` → `topicPicks`): every enabled topic, every check, its top `TOPIC_TOP` (3)
  eligible streams. Eligible: `minViewers`, live (not a rerun or replay channel), a VOD recording, not on
  the topic's skip list or `doNotClip`, not a broadcast the tracker skipped before. A listed creator never
  takes a topic's place; a channel under two topics counts once. An already-tracked pick counts toward
  the 3 (taking it again only adds the topic to its sources). Tracked topic streams are followed to their
  end after they leave the top 3.
- **By hand** (`clip track <link>`): source `manual`, ranked at once, first in line; `manual` sticks.

### 4.2 The tracker (`library/tracking.sqlite`, `src/track/db.ts`)

- **streams:** one row per broadcast. `source` is the best source (sets the tier), `sources` every
  list that found it (e.g. `["creator:Nickmercs", "topic:GTA 6"]`). Status `tracking` / `done` /
  `skipped` (with the reason). The observer closes a stream ended over 48 h with nothing waiting.
- **moments:** one row per moment region, with `rank`, `altRank`, `covered_by`, clip ids and a note.
  Status `pending` → `queued` → `working` → `clipped` / `no-clip` / `failed`, or `skipped` (gambling
  chapter, unreadable) or `covered` (its seconds belong to another moment).
- **coverage:** the ledger (4.4), per stream and layer (`observe`, `clip`).
- **watch_jobs:** the job queue (4.6).

### 4.3 Viewer clips and chat (`src/ingest/chat.ts`)

- A viewer-clip refresh is a page of the channel's top clips over a period, filtered to one broadcast,
  so a newer broadcast can push an older one's clips off the page. `mergeViewerClips` merges by slug: a
  clip seen once stays, its views only go up, an exact offset beats an estimate; `fetches` logs how many
  came back each time. The write takes the video's lock.
- Chat is still range-based (`fetched` ranges in `chat.json`); unknown is not quiet.

### 4.4 The observer and the coverage ledger

- **`tools/observer.ts`** (log `.cache/observer.log`, heartbeat `library/observer.json`; the watchlist
  starts it when it is not running). Each loop: close streams that are finished; rank streams due
  (`RANK_EVERY_MIN`, 20); read one 60-minute chat chunk (`OBSERVE_CHUNK_MIN`) of the stream that needs it
  most (by hand → listed creators → topics, live first, least read first), then re-rank that stream.
  Ranking is `rankAndStore` (`src/scan/rank.ts`), the same code `clip moments` and `clip track` use.
- **The ledger** (`src/track/coverage.ts`): spans of VOD time, each `queued` / `claimed` / `done` /
  `failed` / `skipped` with a job id and reason. One rule: **wanted − done − claimed − skipped, merged into
  the one queued job.** So:
  - a queued first 40 minutes grows into the whole hour, same job (no duplicate);
  - a first 40 minutes already running keeps its claim, and 40:00 onwards is queued as a new job;
  - a job that died is recovered from the chat file: what it read is done, the rest back in line;
  - chat a scan already read is imported as done; a stream with chat off is done on viewer clips alone.
- **First pass:** 32 streams, 169 h of chat read, 148 h to read (now 178 h read, 144 h to read on 33
  streams); about 1.5 minutes per stream hour, so 3–4 hours to catch up.

### 4.5 Moments: identity, coverage and two rankings (`src/scan/moments.ts`)

- **Identity:** `sameMoment` (regions overlap by half the shorter, or peaks within 30 s). On every re-rank
  `planMoments` matches each ranked moment to the row it has, keeps its id, and updates a waiting row's
  bounds, window and eligibility (into or out of a gambling chapter); a worked row keeps the bounds its
  job used and only takes the new numbers.
- **Covered:** a new moment whose peak is inside a worked moment's window, or a waiting duplicate
  (`duplicatesOf`), becomes `covered` by that moment. 23 existing duplicates were folded.
- **Two rankings:** `rank` (the combined score: views + 25 per extra clipper + 12 per laugher; what the
  watchlist uses) and `altRank` (`alternateOrder`, the second audit's challenger: the viewer-clip list and
  the laughter list take turns, viewer clips first, nominations within 30 s of a chosen one passed over).
  Jerma's approved moped crash: #10 by score, #2 alternating. `clip rankers` compares them on judged
  moments; first reading: approved in the top 4, 7 combined vs 8 alternating (15 outcomes, too few).
  `MOMENT_RANKER=alternate` switches once one wins on 20+.
- Scanned minutes are no longer excluded from ranking; `scanned` only marks them.

### 4.6 The job queue (`src/track/jobs.ts`, table `watch_jobs`)

- **Dedupe:** a unique index on (kind, video, moment) among queued and running jobs.
- **Claim:** `claimNext(worker, lease)` in one `BEGIN IMMEDIATE` transaction, by tier then age. The worker
  id is `watchlist:<pid>`.
- **Lease:** 10 minutes, renewed every minute while the stages run. All CLI calls in a job are
  non-blocking child processes (`cli` in `src/pipeline/full.ts`), so the renewal timer keeps firing.
- **Dead worker:** `requeueStale` puts a running job back when its worker's pid is gone or its lease ran
  out (at startup and before every claim), keeping its checkpoint, `interrupted` + 1.
- **Fencing:** `saveStage` and `finishJob` only write while the caller holds the claim; a worker that
  lost its job cannot finish it.
- **Checkpoints:** `scanned`, then `queue-check`, `extract` (candidate ids), `curate` (picks), `edit`
  (clip ids). `stagesToRun` resumes after the last one.
- **Stop:** SIGTERM/SIGINT put the running job back in line at its checkpoint.
- **Swap:** a waiting moment job gives its place to a higher-tier moment (a retry or interrupted job
  keeps its place).
- **Import:** the old `library/watchlist-queue.json` was imported once (182 jobs) and renamed `.imported`.
  `tools/cleanup.ts` and the status page read the table.
- **Clip ledger:** a moment job's window is painted on the stream's `clip` ledger: claimed while it runs,
  then done, failed (with why) or queued.

### 4.7 The clip job (`src/pipeline/full.ts`)

- `momentBrief`: the experts and the extractor are told which moment the community picked, its region,
  views, clippers, laughers and clip titles.
- `passCandidates`: the pass's candidates are those the extractor added **inside the window**, plus an
  unclipped one already inside it (a moment run again keeps the candidate its first run made).
- The curator decides only those; `pickForEdit` gives the editor kept ones (strongest fit first), or, when
  none, the best `review` one with the curator's concern; a drop never.
- The editor is given an explicit list; clips are attributed by candidate id.

### 4.8 YouTube

- Never read while live (4.1); `clip ingest <id> --refresh` after it ends re-reads it and drops the
  footage cut while live.
- The quick path returns typed outcomes (`submitted`, `nothing-qualified`, `stage-failed`, `off`); a failed
  stage fails the job (retried once if transient); streams are judged as streams (`lensFor`); the 5–60 s
  rule; the review submit is checked.

### 4.9 Uploads and analytics (`tools/upload-cron.ts`)

- One approval every 20 minutes, 5–60 s, passing QA, a real title; a broken login holds approvals as
  `blocked-auth` and retries every 10 minutes.
- `clip analytics --days 28` runs once a day (`ANALYTICS_HOURS`, 24); state in
  `.cache/analytics-last.json`. First run: 17 clips with audience numbers (SypherPK's token clips
  1.2–3.6k views, 54–63% stayed to watch).

---

## 5. Commands and settings

| Command | What it shows or does |
|---|---|
| `./clip streams [id]` | Live, ended, done and skipped streams; `read N%` per stream; the observer's backlog; the next moments with their tier. With an id: the stream's read ledger and moments. |
| `./clip moments <link>` | A broadcast's moments with `#rank` and `alt #`; `scanned` marks regions read before. |
| `./clip track <link>` | Add a broadcast by hand: ranked at once, first in line. |
| `./clip topics` | Each topic's top 3 (tracked or new) and what was passed over and why. |
| `./clip rankers` | The two rankings against your review decisions; moments only the shadow ranking would try. |
| `./clip analytics` | Audience numbers for uploaded clips (also daily from the upload cron). |

| Setting | Default | Meaning |
|---|---|---|
| `CHECK_MIN` | 15 | Discovery interval (between jobs) |
| `RECENT_HOURS` | 48 | How far back a creator check looks |
| `TOPIC_TOP` | 3 | Streams per topic per check |
| `MOMENTS_PER_STREAM` | 4 | Moments worked per stream |
| `RANK_EVERY_MIN` | 20 | Re-rank interval (observer) |
| `OBSERVE_CHUNK_MIN` | 60 | Chat read per observer step |
| `TRACK_ENDED_HOURS` | 48 | How long an ended stream is followed |
| `MOMENT_RANKER` | `score` | `alternate` uses the shadow ranking |
| `WATCHLIST_RETRIES` | 1 | Retries for a transient failure |
| `MAX_YT_STREAM_MIN` | 720 | Longest YouTube stream VOD taken |
| `ANALYTICS_HOURS` | 24 | Analytics import interval |
| `TOPICS` | on | `TOPICS=0` turns topics off |

---

## 6. Tests (all offline; `npm test`: 273 pass)

| File | What it proves |
|---|---|
| `test/coverage.test.ts` | Every row of the spec's hour-by-hour table: a queued 40 minutes grows in place; a running 40 minutes keeps its claim while 40:00 on is queued as a new job; done → only the rest; a crash at 0:25 → done to 0:25, the rest requeued; budgets; done from elsewhere; failed asked again. |
| `test/jobs.test.ts` | One active job per moment; order by tier then age; **killed mid-job: requeued with its checkpoint, the dead worker's late writes refused, the new worker finishes it once**; lease expiry; retries keep checkpoints. |
| `test/moments.test.ts` | Region identity; a moved peak keeps its row; worked rows keep bounds; gambling chapter in/out; covered; duplicates folded; the shadow ranker lifts a buried laugh from 9th to 2nd. |
| `test/track.test.ts` | Tiers (by hand → listed → topics); `manual` sticks; three sources, one record; re-rank with a moved peak in the database; `MOMENT_RANKER=alternate`. |
| `test/pipeline.test.ts` | Only the pass's candidates, never a leftover; the "for the reviewer" fallback; in-window extractor additions only; the community brief; stages resume after the last one. |
| `test/topics.test.ts` | Every topic gets its top 3; listed creators never take a place; tracked counts, skipped gives its place; reruns, no-VOD, small, skip lists, opted out. |
| `test/viewer-clips.test.ts` | An empty refresh erases nothing; views only go up; exact offsets win; fetches logged. |
| `test/youtube-live.test.ts` | Live, processing or upcoming YouTube refused; finished fine; Twitch live still read from its start. |

---

## 7. What was measured

- Before the rebuild, blind range scans: 7 of 33 clips approved. Genuine moment-job clips (leftovers
  excluded): 7 of 12 approved, 2 changes, 3 rejected.
- Moment jobs take a median 26 min (29 jobs; 11 min with no clip, 28 with one; the editor stage 8.7 min).
- Tracker now: 33 streams tracking, 3 skipped, 2 done; 634 moments waiting, 15 clipped, 23 covered;
  181 finished jobs in the table (175 done, 6 failed).
- Observer backlog: 178 h of chat read, 144 h to read on 33 streams.
- YouTube uploads: about 10 a day (10 on 2026-11-19, 10 on 2026-11-20, then refused). This, not the
  pipeline, caps what reaches the channel. **Corrected 2026-11-20:** the refusal is `uploadLimitExceeded`,
  the channel's own upload limit, not the Cloud project's API quota (a 1-unit API call still worked
  while uploads were refused). The scheduler logged both as "quota full"; it now names which.

---

## 8. Known limits and what is open

- **Live check of step 4: passed.** `kill -9` on the whole watchlist mid-job; the restart resumed after the
  saved checkpoint without re-running the experts and finished with exactly one clip (section 8b).
- **YouTube upload limit:** about 10 a day. This is the channel's own limit (`uploadLimitExceeded`), so
  a Cloud quota increase (Google Cloud Console → YouTube Data API v3 → Quotas) would **not** raise it;
  an earlier version of this doc said it would. YouTube does not publish the number; it is understood to
  grow with the channel's history and standing. Since 2026-11-20 the review page's Approved tab shows the
  hold, which limit it is, and each waiting clip's place in line (`library/upload-status.json`).
- **Throughput:** one worker, about 55 moment jobs a day; at today's yield (about 45% reach review, 58%
  of those approved) about 15 approved a day, about 30 with two workers.
  More needs a second worker with a render lock (spec step 5) and stopping weak moments before the
  editor.
- **Camera memory:** Ludwig's c25 framed a VALORANT agent portrait as the camera (a face that is not the
  streamer's passes the layout check). Next build item: remember a creator's verified camera rectangle.
- **Laughter bar on huge chats:** a fully read 29 h Kai stream has 362 moments over the bar; the per-stream
  cap and the top-12 cut keep it harmless, but the bar may need to scale with chat size.
- **Typical Gamer:** subscriber-only VODs; skipped unless cookies from a subscribed account are provided.
- **iShowSpeed:** his YouTube streams are often over 12 h, and on Twitch he keeps no VOD.

## 8b. After GPT's review of this doc (same evening)

GPT read this doc and checked the running system. Its three findings were verified and fixed:

| Finding | Verified | Fix |
|---|---|---|
| The observer spent its time on tiny reads | 383 of the last 400 reads covered 10 s or less (median 2 s) and the backlog grew 146.5 → 147.5 h: a live stream's few new seconds were "live first" every loop, followed by a re-rank | A live stream's new minutes are read in 10-minute batches (`OBSERVE_LIVE_BATCH_MIN`); a short tail left queued is taken back; older gaps are always wanted, so the time between batches goes to the backlog; a stream that ends is read to its end (`readUpTo`, `unqueueFrom` in `src/track/coverage.ts`) |
| Discovery waited for editing | `await worker(1)` ran before the check was due; a clip job runs a median 26 min | Discovery runs on its own timer every `CHECK_MIN`; the worker loop only works and idles |
| A restart could lose credit for a clip | A resumed edit counted only clips that were not in review when it started, so a clip it had already submitted counted as nothing; a resumed job could also return "no candidates" before reaching its saved clip ids (its candidate was made by then) | A job resumed after its edit returns the saved clips; the pass's candidates are saved with the extract checkpoint; before the editor runs, picks that already have a clip in review count and are not edited again (`outputsFor`) |

**Live crash test:** Kai's moment job (2:53) was killed with `kill -9` (the whole process tree, no handler)
after its queue-check checkpoint. The restarted watchlist found the dead worker's job, put it back with its
checkpoint, and logged "resuming after queue-check": the three experts did not run again and it went
straight to the extractor. It was restarted once more (for these fixes) and resumed after the same
checkpoint. It then finished with **exactly one result**: the extractor added c10–c14, the curator left
c12 for the reviewer (in-game nudity in the frame), the editor made `tw-2932305259-c12`, and the job row,
its checkpoint and the moment all record that one clip. 275 tests pass.

**The blind ranker trial (built after the review, at the user's go-ahead).** Moment jobs take turns
between three arms: `score` (a stream's top 4 by the combined score only), `alternate` (by the shadow
ranking only) and `both` (in both top 4s, kept in the rotation so the channel is not starved of its likely
best moments). The arm with the fewest jobs goes next among the best tier waiting, so a stream added by
hand still goes first. Each job costs the same (one moment, the same pipeline, one clip at most), the job
row records its arm, and the review page never shows it. `./clip rankers` tallies approved per job per
arm; read it once both one-ranking arms have 20+ judged jobs. Full clips, not cheap previews: the preview
lane is still an option, not built. Settings: `RANKER_TRIAL=0` turns it off, `TRIAL_TOP` (4). 276 tests.

## 8c. Change requests (2026-11-20)

The review page's **C ("Make changes")** saved the note and nothing acted on it: 10 clips were waiting.
The watchlist now queues a `revise` job per request with a note, first in line (`src/track/revise.ts`,
`reviseClip` in `src/pipeline/full.ts`): the editor does what the note asks first, renders, reads QA and
submits the clip back to review with "You asked: … Changed: …". One try per request (keyed by clip and
the time it was sent back). Clips cut from a live YouTube stream are left alone (the footage is wrong).
There is no blur effect, so censoring is done by cropping, zooming or cutting.

## 9. Decisions still with the user (spec section 12)

| | Question | Running now |
|---|---|---|
| D1 | Check cadence | every 15 min between jobs; the observer reads continuously |
| D2 | Topic top 3 excluding listed creators | yes (excluded) |
| D3 | Per-stream cap | flat 4 (the length-scaled cap is not built) |
| D4 | Workers | 1 (a second waits on step 5) |
| D5 | YouTube streams over 12 h | skipped |
| D6 | Subscriber-only VODs | skipped |

## 10. Operating it

- Start: `nohup npx tsx tools/watchlist.ts --daemon >> .cache/watchlist.log 2>&1 &` (it starts the
  observer), `nohup npx tsx tools/upload-cron.ts --daemon >> .cache/upload-cron.log 2>&1 &`. Both need the
  sandbox off (renders use Chrome).
- Restart: send SIGTERM to the process tree; the running job goes back in line at its checkpoint. A crash
  is recovered the same way at the next start (dead pid or expired lease).
- Logs: `.cache/watchlist.log`, `.cache/observer.log`, `.cache/upload-cron.log`; status page
  `watchlist-status.html`.
