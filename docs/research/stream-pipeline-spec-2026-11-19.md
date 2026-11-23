# Stream pipeline spec: discovery → dedupe → queue → content

2026-11-19. A design for the watchlist as one system: which streams it takes, how it knows what it has
already done (to the second), how work is queued without doubles, and how each queued piece goes through
the content pipeline. Written after the user's request: listed streamers first, topics on top (top 3 per
topic, every topic, every check), dedupe at discovery and again at the queue, and a time format that
handles a live stream growing between checks, a partly-queued hour, and a partly-processed hour.

---

## 0. In one paragraph

Every stream gets **one record** keyed by its broadcast id, whatever found it (by hand, a listed
creator, one or more topics). Its time is **VOD time** (0:00 = the broadcast's start), never wall-clock
hours. What has been done to each stream is kept as **interval sets**, one per layer: what was
*observed* (chat, viewer clips, audio read), what was *claimed* by a running job, what is *queued*, and
what is *done*. Dedupe is interval arithmetic on those sets: **wanted − done − claimed, merged into what is
queued**. That one rule covers the hour-by-hour cases: a queued partial hour is extended in place (the
first 40 minutes become the whole hour), and a partial hour already running keeps its claim while only
the rest (40:00 onwards) is queued. Work is two levels: a cheap **observe** pass that reads every minute of
every tracked stream, and an expensive **clip** pass that runs the full pipeline only on the moments the
observe pass ranks highest (by hand > listed creators > topics). The queue moves from a JSON file into
SQLite with leases, so a crash or restart resumes a job from its last finished stage.

---

## 1. What happens today (measured)

| Area | Today | Problem |
|---|---|---|
| Creators | Every 15 min, each listed Twitch creator's **newest** broadcast (`latestBroadcast`) is registered. | A creator who streams twice in a day: the first broadcast is only caught if a check saw it before the second started. |
| Topics | One topic stream added **per check, across all topics**, while fewer than 3 live topic streams are tracked (`TOPIC_STREAMS`, global). | GTA 6 (priority 1.5, biggest streams) holds all 3 slots. Fortnite, League, Counter-Strike, Valorant, Minecraft, GTA 5 RP and WoW have never been tracked (24 h report, 2026-11-19). |
| Stream dedupe | By broadcast id (`tw-<vod>`) in `library/tracking.sqlite`; source precedence manual > creator > topic. | Sound. Kept. |
| Minute dedupe | `scan.json` scanned ranges; a moment ≥ 50% inside them is not ranked again. | Scanned ≠ judged: a range scanned blind but never clipped hides its moments. |
| Moment identity | `moment@<peak rounded to 5 s>`. New viewer clips can move the peak, which makes a **new row**; the old row stays. | 27 overlapping pairs among 516 moments; one pending moment overlaps one already worked. A moment can be worked twice. |
| Queue | `library/watchlist-queue.json`, one writer (the daemon), one waiting moment job at a time. | A restart can lose or double a job (it happened twice on 2026-11-19); no leases, so only one worker is possible. |
| Throughput | One job at a time, 10–20 min each, back to back since 2026-11-19. | About 70–140 moment jobs a day; at about 50% yield, short of 100 shorts a day. |
| YouTube | Never read while live (since 2026-11-19); VODs up to 12 h. | Speed's 24 h streams are over the cap; on Twitch he keeps no VOD. |

What works and stays: moments first (the 12 genuine moment-job clips went 7 approved, 2 changes,
3 rejected; blind range scans went 7 of 33), the tracker, the per-tier order, the pass scoping in
`src/pipeline/full.ts`.

---

## 2. Invariants (what must always be true)

1. **One stream, one record.** Found by a creator check and two topics, it is still one record, with all
   three sources listed and the best tier used.
2. **Unknown is not quiet.** Every minute of a tracked stream is either *observed* or known to be not yet
   observed (a range with a reason), never silently skipped.
3. **No second goes through the expensive pipeline twice** unless a person asks for a retry. Two jobs never
   claim overlapping time on the same stream at the same moment.
4. **Order:** by hand, then listed creators, then topics. A topic never delays a listed creator's waiting
   moment.
5. **Restart-safe.** A job that was running when the worker stopped resumes from its last finished stage.
   Nothing is lost and nothing is done twice.
6. **Every skip, dedupe and merge is recorded with a reason**, so the coverage report can say why a
   stream or minute was not clipped.

Each invariant gets a test (section 10).

---

## 3. Identities and time

- **Stream key:** `tw-<vod id>` for Twitch, the video id for YouTube. A Twitch VOD id is fixed from the
  moment a broadcast starts recording, live or ended. A creator who restarts the stream gets a new VOD id:
  a new stream record, linked to the same channel.
- **Channel key:** platform + login. Used to tell that two topics found the same person, and that a
  channel has one live broadcast at a time.
- **Time:** VOD milliseconds from the broadcast's 0:00. Never wall-clock hours: a wall-clock hour drifts
  against the stream's start, and a YouTube live window moves (the Speed bug: three clips at 0:26, 1:31
  and 1:45 were the same live minute).
- **Live edge:** recorded length − 3 min (chat trails the moment by 5–25 s; viewer clips by minutes).
  Nothing past the live edge is queued.
- **Settled:** a range is *settled* when the live edge is 30 min past it. Before that, viewer clips for it
  are still arriving and its moment ranking can change. Settledness decides when a moment is final enough
  to work (section 6.3), not whether it is observed.
- **Moment identity:** a moment is a *region* on a stream, not a peak second. On every re-rank, a new
  moment is matched to an existing one when their regions overlap by half the shorter one, or their peaks
  are within 30 s. A match updates the existing row (numbers, region, peak) and keeps its id and status.
  Only a moment matching nothing gets a new id. This removes the 27 overlapping pairs.

---

## 4. Discovery (every check, every 10 minutes)

### 4.1 Listed creators (channels.json)

For each Twitch creator, one API call: live status + the broadcasts of the last 48 h (not only the newest).
Each broadcast that is live, or ended less than 48 h ago, is upserted with source `creator:<name>`.
YouTube creators: the `/streams` or `/videos` tab; a live stream is recorded as *waiting for its VOD*,
never read while live.

### 4.2 Topics (topics.json): every topic, top 3 each, every check

For **every** enabled topic, read the category's top live English streams (one API call per topic) and
take the **top 3 eligible** by viewers:

- **Eligible:** English; at least the topic's `minViewers`; a VOD being recorded; not a rerun or replay
  channel; not on the topic's skip list or `doNotClip`; not a wrong stream (`wrongStream`: test stream,
  under 20 min ended); the chapter not a never-clip category (gambling).
- **Listed creators do not count toward the 3:** they are already in through 4.1. The 3 are what topics
  add on top. (Decision D2.)
- A channel found under two topics counts once, under the topic where it has more viewers (today's
  `seenLogin` rule).

Each pick is upserted with source `topic:<name>`. A stream that drops out of a topic's top 3 later is
**not** dropped: once tracked, it is followed to its end and through its 48 h cooling time. Picks
are cheap (an observe pass, section 6.1); the expensive work is chosen by moment, not by stream.

### 4.3 By hand

`clip track <link>`: upsert with source `manual`, ranked at once. `manual` sticks: no later creator or
topic check demotes it.

### 4.4 Dedupe at discovery

All three feeds go through one `upsertStream`. The key is the stream key, so a second finding is a merge:
`sources` becomes a set (`["creator:xQc", "topic:GTA 6"]`), and the stream's **tier** is the best of its
sources (manual 0, creator 1, topic 2). The record keeps `firstSeenAt`, `lastSeenLiveAt`, and the
viewers seen per check (a peak-viewers number for the coverage report).

### 4.5 Stream lifecycle

```
discovered → live → ended → cooling (48 h: viewer clips keep coming) → closed
                ↘ skipped (reason: subscriber-only, gone, no VOD, wrong stream, do-not-clip, over 12 h…)
```

A skipped stream keeps its reason and can be reopened by hand (`clip track`).

---

## 5. The coverage ledger: the dedupe format

### 5.1 Data model (SQLite, `library/tracking.sqlite`)

```
streams   (stream_key PK, channel_key, platform, creator, title, game, sources JSON, tier,
           live, started_at, length_ms, live_edge_ms, status, skip_reason, peak_viewers,
           first_seen_at, last_seen_live_at, observed_to_ms, ranked_at, updated_at)

coverage  (stream_key, layer, from_ms, to_ms, state, job_id, reason, updated_at)
           layer: observe | clip
           state: queued | claimed | done | failed | skipped
           -- non-overlapping per (stream_key, layer, state); normalised after every write

moments   (stream_key, moment_id, peak_ms, from_ms, to_ms, window_from_ms, window_to_ms, score,
           views, clippers, laughers, titles, why, status, covered_by, clip_ids, note, updated_at)

jobs      (job_id PK, kind, stream_key, moment_id, from_ms, to_ms, tier, priority, state,
           claimed_by, lease_until, claimed_to_ms, stage, stage_data JSON, attempts, interrupted,
           error, result, created_at, started_at, finished_at)
```

`coverage` is the format the user asked for: per stream and layer, a set of time ranges, each with a
state and the job that owns it.

### 5.2 The one rule

When a check wants a range `W` covered on a layer:

```
todo  = W − done − claimed − skipped          (interval subtraction)
queued' = (queued ∪ todo), merged where contiguous or overlapping
```

- **Merge into the queued job, never a second job:** for the observe layer, a stream has at most one queued
  observe job; `todo` extends its range in place (same job id, new `to_ms`). For the clip layer, see 5.4.
- **Claimed is exact:** when a worker takes a job it writes `claimed_to_ms` (the end it actually took)
  and moves exactly `[from, claimed_to)` from queued to claimed. Anything the queued job had beyond that
  stays queued. That is how "the first 40 minutes were already processing" is detected: the claim says
  where processing stopped, and the rest counts from there.
- **Done is written by the job when it finishes:** `claimed → done`, with the job id, so the report can say
  which job covered which minutes.
- **A failed job** returns its claim to queued (a retry) or to `failed` with the error. A failed range is
  never silently dropped.

### 5.3 The hour-by-hour example, worked through

A stream started recording at VOD 0:00. Checks run at VOD 0:43, 1:03 and 2:03 (live edges 0:40, 1:00, 2:00).

| Check | Wanted | Ledger before | What happens | Ledger after |
|---|---|---|---|---|
| 0:43 | [0:00, 0:40) | empty | new observe job J1 | queued [0:00, 0:40) J1 |
| 1:03, **J1 still queued** | [0:00, 1:00) | queued [0:00, 0:40) J1 | todo = [0:40, 1:00) merged into J1: **the 40 minutes are overwritten by the whole hour** | queued [0:00, 1:00) J1 |
| 1:03, **J1 running** (claimed to 0:40) | [0:00, 1:00) | claimed [0:00, 0:40) J1 | todo = [0:40, 1:00): new job J2 **counting from 0:40** | claimed [0:00, 0:40) J1 · queued [0:40, 1:00) J2 |
| 1:03, **J1 done** | [0:00, 1:00) | done [0:00, 0:40) | todo = [0:40, 1:00): J2 | done [0:00, 0:40) · queued [0:40, 1:00) J2 |
| 2:03, J2 still queued | [0:00, 2:00) | done [0:00, 0:40) · queued [0:40, 1:00) J2 | J2 extended | done [0:00, 0:40) · queued [0:40, 2:00) J2 |
| J1 crashes at 0:25 | — | claimed [0:00, 0:40) J1 | lease expires; J1 checkpointed observe to 0:25 → done [0:00, 0:25), [0:25, 0:40) back to queued (merged with any queued job) | done [0:00, 0:25) · queued [0:25, …) |

**Why intervals, not fixed hour slots.** Hour slots need special cases for every one of these rows
(a partial slot, a partial slot running, a slot split by a crash). With intervals, every row is the
same rule. Hour (or 30-minute) slots stay useful for **display** in the coverage report ("hour 3 of
xQc: observed, 2 moments clipped").

**Check cadence.** Checks every 10 minutes, but an observe job is only queued when there are at least
10 new minutes, or the stream ended. That is "hour by hour" without waiting an hour: the merge rule makes
the cadence irrelevant to correctness, only to cost.

### 5.4 The clip layer: moments as windows

A moment job claims its **window** (the region with a minute before and 45 s after). When a moment is
about to be queued:

1. If its **peak** is inside a `done` or `claimed` clip range: it is the same moment, already worked or
   being worked → `covered_by = <job>`, never queued. (Today's duplicate rows end here.)
2. Else the window is trimmed to `window − done − claimed`. If what is left still holds the peak and at
   least 60 s, queue that. Otherwise merge it into the job that covers its peak's neighbour, or record it
   `covered_by`.
3. If it overlaps a **queued** moment job: the two windows are merged into one job (the higher score
   keeps the id). One clip pass covers both.

A moment re-ranked later (more viewer clips) only changes its score and region (3 above), never creates a
second job for the same seconds.

---

## 6. Two levels of work

### 6.1 Observe (cheap; every minute of every tracked stream)

Per stream, one job at a time, extending as in 5.3:

- chat replay for the new range (incremental; about 10 min of chat in 11 s),
- viewer clips for the whole VOD (one API call; they arrive late, so this repeats while the stream is
  live or cooling),
- optional: audio reactions for the new range (about 18 s per hour; needs the audio download: skip by
  default, use only where chat is off),
- re-rank the stream's moments (`rankMoments` with moment matching, 3).

About a minute per hour of stream, no LLM. This is what makes "unknown is not quiet" true for every
stream on both lists, without paying for the expensive pass everywhere.

### 6.2 Clip (expensive; only the best moments)

The existing moment job: scan the window (transcript, frames) → three experts with the community brief
→ verifier → extractor → curator → editor → render/QA → review. One clip at most per job.

### 6.3 Which moment next

Score = community score (views, clippers, laughers) × tier weight × freshness, picked in this order:

1. **Tier:** by hand, then listed creators, then topics.
2. **Fairness:** within a tier, each stream's best before any stream's second.
3. **Settled first:** a moment whose region is settled (5.3, 30 min behind the live edge) goes before an
   unsettled one of similar score; an unsettled moment can still go if nothing settled is waiting.
4. **Per-stream cap scales with length:** `1 + floor(hours / 3)`, at most 8 (a 23 h xQc stream gets 8,
   a 2 h stream 1). Today's flat 4 gives a 2 h stream as much as a 23 h one. (Decision D3.)
5. **Freshness:** a moment loses half its priority every 24 h after its stream ended: a launch-day GTA 6
   clip is worth more today than in three days.
6. **Topic budget:** each topic at most a share of the clip jobs per day (default: its `priority` ×
   1/number of topics), so one topic cannot take all the topic time. Listed creators have no budget.

---

## 7. The queue

- **Store:** the `jobs` table in SQLite (replaces `watchlist-queue.json`). Writes are transactions, so
  any number of processes can read it, and two workers can never take the same job.
- **Kinds:** `observe` (6.1), `clip` (6.2), `youtube-vod` (a YouTube VOD: ingest → quick pass, as today).
- **Leases:** a worker claims a job with `claimed_by`, `lease_until` (now + 10 min) and renews it every
  minute. A job whose lease expired belongs to a dead worker: it goes back to queued from its last
  checkpoint (`stage`). This replaces the signal handling and the hand-written restart scripts.
- **Dedupe at the queue:** observe jobs: one queued per stream (5.2). Clip jobs: 5.4. Plus a unique index
  on `(kind, stream_key, moment_id)` among queued and claimed jobs, so a race cannot insert a double.
- **Workers:** 2 by default. The agent stages are network-bound (DeepSeek), so two moment jobs overlap
  well; rendering takes a **render lock** (one Chrome render at a time). Observe jobs run on a separate
  lightweight worker so they never wait behind a 20-minute clip job.
- **Throughput (corrected after the second audit, section 13):** a moment job takes a **median 26 min**
  (29 jobs; 11 min when it ends with no clip, 28 min when it makes one), not the 15 min first assumed.
  One worker does about 55 jobs a day, two about 110. At about 45% of jobs reaching review and 58% of
  those approved, two workers give about 30 approved a day; 100 a day needs both a better yield and
  cheaper jobs (stop a weak moment before the editor; the editor stage is a median 8.7 min). The upload
  scheduler is a second cap: one clip per 20 minutes is at most 72 a day. (Decision D4.)

---

## 8. The content pipeline per clip job, with checkpoints

| Stage | Checkpoint written | On resume |
|---|---|---|
| scan window (transcript, frames) | `stage = scanned` | skip; idempotent anyway |
| queue-check (experts + verifier) | verdict ids | experts see only pending queues (already true) |
| extract | candidate ids added (`passCandidates`) | reuse them; do not extract again |
| curate | decisions for those ids | skip if every id has a decision |
| edit + render + QA + submit | clip ids | attribute only this job's clips (`pickForEdit`) |
| done | `clip` coverage → done, moment → clipped / no-clip | — |

Every stage reads only the job's own window and candidates (in place since 2026-11-19).

---

## 9. Edge cases

| Case | Handling |
|---|---|
| Creator streams twice in a day | 4.1 reads every broadcast of the last 48 h. |
| Stream restarts (new VOD id) | A new stream record, same channel; both followed. |
| Same streamer under two topics, or a listed creator in a topic's top list | One record (4.4); counts once under its bigger topic; listed creators never take a topic's 3 slots. |
| Topic stream changes category mid-stream | Still followed (tracked streams are not dropped); its moments keep the chapter for the never-clip check. |
| Live, no VOD (Speed on Twitch) | `skipped: no VOD`; rechecked each check in case recording starts. |
| Subscriber-only VOD (Typical Gamer) | `skipped: subscriber-only` at the first failure of any step. Reading it needs a logged-in account's cookies, which only the user can export (decision D6). |
| VOD deleted or expired | `skipped: gone`; claimed jobs end failed with that reason. |
| YouTube live | Never read while live; the VOD is taken when it ends; over 12 h skipped (decision D5). |
| Muted (copyright) stretches | Observed as muted ranges; never clipped (already true). |
| Chat turned off | Observe still reads viewer clips; audio reactions for that stream (6.1). |
| Viewer clip offsets estimated | `clipSpan`: one clip length either side; moment matching (3) absorbs the drift. |
| Worker crash or restart | Lease expiry (7); resume from `stage` (8). |
| Two daemons started by mistake | Both are workers on the same SQLite queue: safe. The scheduler (discovery) takes a lock row so only one runs checks. |
| A stream on both lists by hand and topic | Tier 0 wins, sources kept. |

---

## 10. Observability and tests

- **`clip coverage [--since 24h] [--html]`:** the table built by hand on 2026-11-19, as a command: every
  stream of both lists (and the topics' top 3s that were not taken, with why), its live/ended state, its
  observed minutes, its moments (done / waiting / cap), its clips by review decision, and a **Covered**
  column (`yes`, `partly`, `not yet`, `no` + reason). The status page shows the same.
- **Per-stream timeline:** `clip streams <id>` draws the ledger by 30-minute slot: observed, claimed,
  done, moments, clips.
- **Invariant tests** (offline, simulated streams like `test/scan.test.ts`):
  - the six rows of 5.3, plus a crash mid-claim, give exactly the ledgers in the table;
  - a re-ranked moment whose peak moved 20 s updates the same row (3);
  - a moment whose peak is inside a done window is never queued (5.4);
  - a stream found by a creator and two topics is one record with tier 1;
  - with 8 topics, every topic gets its top 3 considered each check;
  - two workers never claim overlapping time on one stream.

---

## 11. Migration (in order; each step ships on its own)

1. **Discovery:** every topic, top 3 each (4.2); creators' broadcasts of the last 48 h (4.1); `sources`
   as a set. *Done when* the coverage report shows streams for every topic that is live.
2. **Moment matching** (3) and the clip-layer dedupe (5.4) on today's tables. *Done when* no two moments
   of a stream overlap, and the 27 existing pairs are merged.
3. **Coverage ledger + observe jobs** (5, 6.1), with `scan.json` imported as observe-done ranges.
   *Done when* every tracked minute is observed or has a reason, and the 5.3 tests pass.
4. **SQLite queue with leases and checkpoints** (7, 8); the JSON queue is imported then retired.
   *Done when* killing the worker mid-job loses nothing and doubles nothing.
5. **Second worker + render lock** (7). *Done when* two clip jobs overlap and renders never do.
6. **`clip coverage`** (10). Can ship any time after 1.

---

## 12. Decisions for the user

- **D1. Check cadence:** every 10 min, observe queued only with 10+ new minutes (recommended), or
  literally hourly.
- **D2. Topic top 3:** excluding listed creators (recommended: topics add on top), or including them.
- **D3. Per-stream cap:** scaled by length, `1 + hours/3`, max 8 (recommended), or a flat number.
- **D4. Workers:** 2 to start (recommended; about 50 approved a day at today's yield), measure the yield
  after the 2026-11-19 fixes, then go to 3–4 if the machine keeps up (renders are serialised either way).
- **D5. YouTube streams over 12 h** (Speed): skip (today), or ingest the first 12 h (YouTube often keeps
  only part of a stream over 12 h; needs checking per stream).
- **D6. Subscriber-only VODs** (Typical Gamer): skip (today), or the user exports Twitch cookies from a
  subscribed account for yt-dlp to use.

---

## 13. Second audit (GPT, 2026-11-19 18:44 UTC snapshot): what was checked and what changes

The user had a second model audit the project (`~/Downloads/clip-engine-deep-audit-2026-11-19.md`).
Each claim below was checked against the code or the library before it went into this plan.

| Claim | Checked | Change to this plan |
|---|---|---|
| The extractor's additions are a before/after diff over the whole broadcast, and `passCandidates` trusts them, so a candidate added outside the window would be this pass's. | True (`extract` in `src/pipeline/full.ts`). The prompt forbids it; nothing enforces it. | `passCandidates` keeps only candidates that overlap the window; one extractor per broadcast at a time (a lock) until candidates record the job that made them. **Fix now.** |
| A re-rank updates a moment's numbers but keeps its old bounds, window and pending state, even when it moved into a never-clip chapter. | True (`upsertMoments` updates score, views, clippers, laughers, titles, why only). | Moment matching (section 3) updates bounds, window and eligibility of a *pending* moment in one transaction; a running job keeps a frozen copy of what it was given. **Step 2.** |
| ohnePixel `tw-2932275268`'s viewer-clip file was empty while the tracker held its 291,583-view moment. | True at the snapshot; refilled two minutes later (41 clips, top 478,600 views). `fetchViewerClips` overwrites the file with whatever came back. The query is the channel's top clips for a period, filtered to this broadcast, so a newer broadcast's clips can push an older one's off the page. Likely also why xQc's 25k-view moment came out with no queue at job time. | Merge by clip slug (keep the highest views, never drop a clip seen before), record `fetchedAt` and how many came back per fetch. **Fix now.** |
| The YouTube quick path records a failed judge as a finished job, uses the podcast lens for every YouTube source, drops cuts under 15 s (the scheduler takes 5 s), and counts a submission without checking it. | True (`quickClips` in `tools/watchlist.ts`). | Typed outcomes (`unavailable`, `stage failed`, `nothing qualified`, `submitted`), lens by content (`stream-moments` for streams), the 5–60 s rule, the submit checked. **Fix now.** |
| Moment jobs take a median 26 min. | True (29 jobs: median 26.2, mean 25.8). | Throughput corrected (section 7). |
| Ludwig `tw-2931875711-c25`: the camera band shows the VALORANT agent portrait; the real webcam is small in the game band; layout QA passed. | True (frame checked). The known gap: another face in the band passes. | Remember a creator's verified camera rectangle per scene layout and check new splits against it; fall back to the whole frame when they disagree. **After step 4.** |
| Scanned minutes stop later moments from being ranked (107 regions; 89 not worked). | Consistent with `rankMoments`' `done` filter. | Already section 5: observed ≠ judged. Step 3. |
| No audience data: `performance.jsonl` is empty though 14 clips were uploaded; 159 of 191 rejects have no reason. | True. The rejects without a reason mostly predate the reason keys. | Run `clip analytics` daily now that the login includes the analytics scope. **Fix now** (a schedule, no code). |
| Interleaving the viewer-clip list and the laughter list (instead of one combined score) put 6 of 16 approved cuts in the top 4 and 11 of 16 in the top 12, against 5 and 8. | Not re-run here. Small, historical sample; the audit says so itself. | A **shadow ranker**: both rankings are computed and saved for every stream; the scheduler keeps the current one until approvals per job favour the other on new streams. Step 2. |
| Persist job, event, source segment and output together. | Agrees with section 8. | Each job row records its moment, window, candidates and clip ids; counts are by unique approved moment. Step 4. |

**Not adopted yet, kept as product options for the user:** a *preview lane* (the user keeps or drops a
moment from cached footage before anything is rendered; it cuts the 26 min a weak moment costs, but
puts a person before the expensive work); a *Scout* that reserves a few slots for stretches with no
community peak; a blind trial of rankers; and the *shared-scene feed* (four creators reached the same
scripted GTA scene; compare their reactions). The curator's notes on Kai's scripted-dialogue clips
("Rockstar's dialogue with Kai in the corner cam") are a reason to pilot that one carefully.

**Status 2026-11-19 evening:** the four *now* fixes and step 1 are built: viewer clips merge
(`mergeViewerClips`), `passCandidates` keeps only in-window additions, the YouTube quick path returns
typed outcomes with the lens by content and checked submits, `clip analytics` runs daily from the upload
scheduler (17 clips had numbers on the first run), every topic's top 3 each check (`topicPicks`), every
creator broadcast of the last 48 h (`recentBroadcasts`), and `sources` on every stream. **Step 2 built
the same evening:** moments matched by region (`planMoments`; a moved peak updates its row, a waiting row
takes new bounds and eligibility, a worked row keeps its own), `covered` for duplicates and for peaks inside
a worked window (23 existing duplicates folded), scanned minutes no longer hidden from ranking, and the
shadow ranker (`altRank`, `alternateOrder`; `clip rankers` compares; `MOMENT_RANKER=alternate` switches).
**Step 3 built the same evening:** the coverage ledger (`src/track/coverage.ts`, the `coverage`
table) with the one rule and recovery, tested on every row of 5.3; the observer daemon
(`tools/observer.ts`) reads every minute's chat in 60-minute chunks and does all the ranking, in its own
process; the watchlist starts it. First pass: 32 streams, 169 h of chat read, 148 h to read. **Step 4 built the same
evening:** the job queue in the tracker (`src/track/jobs.ts`, `watch_jobs`): unique active jobs per
moment, transactional claims with leases and pid-based dead-worker detection, fenced writes, stage
checkpoints (`scanned`, `queue-check`, `extract`, `curate`, `edit`) the pipeline resumes from, the clip
layer painted on the coverage ledger; the JSON queue imported (182 jobs) and retired. Next: camera memory
(section 13), then step 5 (a second worker and the render lock).

**Revised order:** the four fixes marked *now* → step 1 (discovery) → step 2 (moment matching + shadow
ranker) → steps 3–4 (ledger, SQLite queue, provenance) → camera memory → workers and upload cadence,
measured.
