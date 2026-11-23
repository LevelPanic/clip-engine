# Operations

Running the channel: the daemons, the upload scheduler, the review page, the watchlist and publishing. `CLAUDE.md` has
a short version of each section; this file has the full behaviour and the history behind each rule. Dates name when a
rule was set, and "user" marks a decision the operator made.

## The daemons

| Daemon | Start it (outside any sandbox: it renders or spawns Chrome) | Log | What it does |
|---|---|---|---|
| Studio | `./clip open` (or `./clip studio`) | `.cache/studio.log` | the web app on http://localhost:4400: library, candidates, editor, review, jobs |
| Watchlist | `nohup npx tsx tools/watchlist.ts --daemon >> .cache/watchlist.log 2>&1 &` | `.cache/watchlist.log` | finds broadcasts, runs change requests and moment jobs one at a time, starts the observer; writes `library/watchlist-status.html` |
| Observer | started by the watchlist (`tools/observer.ts --daemon`) | `.cache/observer.log` | reads chat over every tracked stream and re-ranks its moments |
| Upload scheduler | `nohup npx tsx tools/upload-cron.ts --daemon >> .cache/upload-cron.log 2>&1 &` | `.cache/upload-cron.log` | uploads approved clips to YouTube at the pace below |
| Cleanup | `nohup npx tsx tools/cleanup.ts --daemon >> .cache/cleanup.log 2>&1 &` | `.cache/cleanup.log` | hourly: deletes rejected clips an hour after the rejection (the decision stays in `feedback.jsonl`) and the footage of streams nothing waits on |
| Worker | starts itself when a job is queued (`ensureWorker`) | `.cache/worker.log` | renders, downloads and other Studio jobs; exits when idle |

**Stopping one.** Find its process with `pgrep -fl "tools/watchlist.ts"` and stop it by number: `kill <pid>`. A stopped
watchlist puts its running job back in line (`interrupted`), never `failed`. Do not write `pkill -f "<pattern>" -n`: macOS
`pkill` reads anything after the pattern as another pattern, so `-n` matches every process with "-n" in its command line
(2026-11-23). After a change to code a daemon runs, restart it between jobs.

**Space.** Footage is the bulk of `library/`. The cleanup frees a stream's footage once no clip of it is waiting for review
or upload (`tools/cleanup.ts --dry-run` shows what it would delete), so clearing the review queue is what frees disk.

## Settings

Every setting the engine reads from the environment, generated from `src/core/config.ts` (`test/config.test.ts` checks this
table against it). `./clip config` shows the values in force; a value it cannot read is an error, not a silent default.

**paths**

| Setting | Default | What it does |
|---|---|---|
| `CLIP_DATA` | (see description) | Where library/, clips/ and exports/ live (default: the project folder). The tests point it at a temp folder. |

**publishing**

| Setting | Default | What it does |
|---|---|---|
| `CLIP_YOUTUBE_CLIENT_SECRETS` | (see description) | The Google OAuth client JSON (default: client_secrets.json in the project). |
| `TIKTOK_SECRETS` | (see description) | The TikTok app's keys JSON (default: tiktok_secrets.json in the project). |
| `TIKTOK_CLIENT_KEY` | (see description) | The TikTok client key, instead of the secrets file. |
| `TIKTOK_CLIENT_SECRET` | (see description) | The TikTok client secret, instead of the secrets file. |
| `TIKTOK_REDIRECT_URI` | (see description) | The TikTok login redirect (default: the one in the secrets file). |

**faces**

| Setting | Default | What it does |
|---|---|---|
| `CLIP_INSIGHTFACE_PY` | (see description) | A Python for the InsightFace sidecar, instead of the one it sets up in .cache/face-py. |
| `CLIP_FACE_DETECTOR` | hybrid | Apple Vision, InsightFace, or Vision with InsightFace filling its misses. |

**qa**

| Setting | Default | What it does |
|---|---|---|
| `CLIP_NUDITY_PY` | (see description) | A Python for the NudeNet sidecar, instead of the one it sets up in .cache/nudity-py. |

**judge**

| Setting | Default | What it does |
|---|---|---|
| `CLIP_CLAUDE` | (see description) | The claude CLI to run the headless judge with (default: found on PATH). |
| `CLIP_OPENCODE` | (see description) | The opencode CLI for the unattended agents (default: the OpenCode app, then PATH). |
| `CLIP_JUDGE` | claude | Which judge `clip judge` and batches use. |
| `CLIP_JUDGE_MODEL` | opencode-go/deepseek-v4.1-flash | The model the OpenCode judge runs. |

**render**

| Setting | Default | What it does |
|---|---|---|
| `CLIP_BROWSER` | (see description) | A Chrome to render with, instead of Remotion's headless shell. |
| `CLIP_CONCURRENCY` | (see description) | Render tabs (default: CPUs − 2, at least 2). |
| `CLIP_OVT` | (see description) | Video-decode threads per render (default 4). |
| `CLIP_HW` | on | Hardware video encoding (0 turns it off). |
| `CLIP_GL` | (engine default) | Chrome's GL backend for rendering (default: Remotion's choice). |
| `CLIP_LOG` | error | Remotion's log level while rendering. |

**pipeline**

| Setting | Default | What it does |
|---|---|---|
| `CLIP_PIPELINE_MODEL` | = CLIP_JUDGE_MODEL | The model the unattended pipeline's agents run (default: CLIP_JUDGE_MODEL). |
| `MAX_KEEP` | 3 | Candidates the unattended pipeline keeps per pass at most. |
| `FULL_EXPERT_TIMEOUT_MIN` | 60 min | Time limit for the three queue experts. |
| `FULL_VERIFY_TIMEOUT_MIN` | 45 min | Time limit for checking the experts' confirms. |
| `FULL_EXTRACT_TIMEOUT_MIN` | 60 min | Time limit for the extractor. |
| `FULL_CURATE_TIMEOUT_MIN` | 45 min | Time limit for the curator. |
| `FULL_EDIT_TIMEOUT_MIN` | 90 min | Time limit for the editor (and a change request). |

**transcripts**

| Setting | Default | What it does |
|---|---|---|
| `CLIP_WHISPER_MODEL` | (see description) | The whisper.cpp model (default: small.en; `small` is multilingual and translates to English). |

**watchlist**

| Setting | Default | What it does |
|---|---|---|
| `CHECK_MIN` | 15 min | How often the creators and topics are checked for broadcasts. |
| `RECENT_HOURS` | 48 h | A creator check takes every broadcast live within this. |
| `MOMENTS_PER_STREAM` | 4 | Moment jobs per stream at most. |
| `MAX_JOBS` | (see description) | Jobs to run before a one-off watchlist run stops (default: --max, else 2). |
| `WATCHLIST_RETRIES` | 1 | Retries for a job that failed on a timeout or the network. |
| `AUTO_CLIPS` | 3 | Clips per YouTube video the watchlist makes at most. |
| `AUTO_EDITED` | off | Clip edited YouTube channels too (1), not only streams and podcasts. |
| `MIN_YT_MIN` | 15 min | A YouTube upload shorter than this (or the creator's minMinutes) is skipped as a Short or an edited clip. |
| `MAX_YT_STREAM_MIN` | 720 min | A YouTube stream recording longer than this is skipped (too long to ingest whole). |
| `TOPICS` | on | Follow the trending games in topics.json (0 turns topics off). |
| `TOPIC_TOP` | 3 | Each topic's top streams taken into the tracker. |
| `MOMENT_RANKER` | score | The ranking the watchlist orders moments by (outside the trial). |
| `RANKER_TRIAL` | on | The blind ranker trial (0 turns it off). |
| `TRIAL_TOP` | 4 | A stream's top moments each trial arm draws from. |

**observer**

| Setting | Default | What it does |
|---|---|---|
| `OBSERVE_CHUNK_MIN` | 60 min | Chat read per job at most. |
| `OBSERVE_LIVE_BATCH_MIN` | 10 min | A live stream's new minutes are read in batches of this. |
| `OBSERVE_IDLE_S` | 60 s | Sleep when there is nothing to read. |
| `RANK_EVERY_MIN` | 20 min | Each tracked stream is re-ranked this often. |
| `TRACK_ENDED_HOURS` | 48 h | An ended stream is followed this long (viewer clips keep coming). |

**uploads**

| Setting | Default | What it does |
|---|---|---|
| `UPLOADS_PER_DAY` | 8 | Uploads in any 24 hours at most. |
| `UPLOAD_MIN` | 180 min | Minutes between uploads at least. |
| `LEAD_MIN` | 5 min | An upload goes live this long after it is uploaded. |
| `HOLD_RETRY_MIN` | 60 min | A clip held by a passing error is tried again after this. (also read as `QUOTA_MIN`) |
| `REFUSED_PAUSE_MIN` | 20 min | Pause after a refusal for good, so a fault cannot sweep the line aside. |
| `AUTH_RETRY_MIN` | 10 min | While the YouTube login is broken, a token refresh is tried this often. |
| `MIN_UPLOAD_S` | 5 s | An approval shorter than this is a broken export and is set aside. |
| `ANALYTICS_HOURS` | 24 h | How often the scheduler pulls YouTube analytics (0 turns it off). |

**cleanup**

| Setting | Default | What it does |
|---|---|---|
| `CLEANUP_MIN` | 60 min | How often the cleanup sweeps. |
| `REJECTED_GRACE_MIN` | 60 min | A rejected clip is deleted this long after the rejection. |
| `SOURCE_GRACE_HOURS` | 24 h | A source's footage is kept this long after its last activity. |
| `SOURCE_DELETE` | media | What goes when a source is done: its media, or the whole folder. |

## Upload scheduler

- **Upload scheduler** (`tools/upload-cron.ts --daemon`, log `.cache/upload-cron.log`): **at most 8 in any 24 hours, 3 hours apart** (`UPLOADS_PER_DAY`, `UPLOAD_MIN` 180; `paceAt`, `src/publish/pace.ts`; user, 2026-11-22, change 2 of `docs/research/censorship-review-2026-11-22.md`: 26 in one day in one title template looked mass-produced), counted from the publish records so a restart or an upload by hand counts, and never more than YouTube's limit let through the last time it refused (for 2 days after); each live 5 minutes after upload. **While `channel.json` has a `careful` period** (until 2026-12-06), an approval with a `sexual` flag from any expert, an 18+ tick or an f-word in its first 3 s (`checkCareful`, `src/qa/unsafe.ts`) is held as `deferred` and the next one goes; the deferred go back in line by themselves when the period ends (**Check again** on the review page after a re-edit). Whether the creator is on screen, not a cutscene, is the reviewer's call: the To review tab says so above Approve (most of the channel's streamers use an avatar, so the layout cannot tell). It takes approvals of 5–60 s (`MIN_UPLOAD_S`; 15 s is the editing target, not an upload rule: Shorts have no minimum, and an approval under it is the reviewer's call) with a real title. **QA does not hold an approval back** (user, 2026-11-22): the reviewer saw the report and approved, so a failed QA is logged with the try and the clip goes up; only the missing credit and the **never-post list** (nudity, a slur said, a minor, a sexual title; see Rules) still stop one, checked before an upload call is spent. A sexual title holds the approval as `blocked-title` until the title is edited (then it uploads by itself); the rest are set aside. A refusal that made no upload call moves straight to the next approval instead of waiting for the next slot. A refusal is written to `reviews.sqlite`; the review page's Approved tab shows it on the clip with **Retry upload** (`POST /api/clips/:id/retry-upload`, `releasePick`). A broken YouTube login (expired, revoked) is a hold, not a failure: the approval becomes `blocked-auth`, nothing new is picked, a token refresh is tried every 10 minutes, and the held clips go back in line by themselves after `./clip auth youtube`. **The Google OAuth app is in Testing mode, so a login lasts 7 days**; publishing the app (OAuth consent screen → Publish) removes the limit. **YouTube limits this channel's uploads** (`uploadLimitExceeded`): on 2026-11-19 and 11-20, 10 went up and the 11th was refused until about a day after the first; on 11-21, 19 went up in 24 hours with no refusal. The user treats 10 a day as the limit (they suspect the account is shadow-banned, 2026-11-21). That is the channel's own limit; a Cloud quota increase does not raise it, and the API answers other calls normally while it holds. **The Cloud project has its own daily limits**, reset at midnight Pacific: the API units (`quotaExceeded`) and **"Video Uploads per day"** (`rateLimitExceeded`), which **counts refused upload calls too**: on 11-20 Pacific it refused the 27th call, 26 of which the channel's limit had refused at a 20-minute retry, and so held the line from 01:38 to 08:18 UTC after the channel's limit had already lifted. **It stays on one clip until that clip uploads** (`pickApproved`, `src/review/db.ts`; user, 2026-11-20): a YouTube limit or a passing network/5xx error holds the clip (`held`, its tries counted in `attempts`), the same clip is tried again when the limit should lift (2026-11-22: the channel's limit a day after the first upload of the last 24 hours, `limitLiftsAt`; the project's quotas at midnight Pacific, `pacificMidnightAfter`; a passing error every `HOLD_RETRY_MIN`, **60** minutes; each try spends one of the project's upload calls), the next approval waits behind it, and a restart picks the held clip up again at the try time already set (`nextTryAt`); only an upload, a refusal retrying cannot fix (set aside as `failed`, with **Retry upload**) or the reviewer taking the approval back moves the line on. **Every try is a line in `library/upload-log.jsonl`** (kept, never pruned; the tries before 2026-11-20 19:15 UTC were read back from `.cache/upload-cron.log`, marked `from`), and the review page's Approved and Uploaded tabs show the last 30. The scheduler also writes `library/upload-status.json` (`src/publish/uploadStatus.ts`: which limit, YouTube's words, the next try), which the review page's Approved tab shows as a banner with each waiting clip's place in line (`GET /api/upload-status`, SSE `upload-status`).

## Review page

- **Review page:** A approve, C changes, R reject and then 1–5 for why (boring, layout, cut, title, context; R again for no reason). On To review the editor's hand-over is shown above the note box, which starts empty: **Make changes needs a note you wrote** (an empty box focuses it), and `setReview` drops a decision note that is just the hand-over the clip came in with (2026-11-23: the box used to be prefilled, and 7 hand-overs went out as change requests). On Approved, Changes asked and Rejected, **↩ Back to review** (U) undoes the decision: the clip waits in To review again (an approval leaves the upload line; a queued revise skips a clip no longer waiting for changes). E (or Edit) opens the clip in the editor; the editor's **↩ Review** button, or the browser's back, returns to the same clip on its tab (`#/review/<clipId>`; the address follows the clip on screen). **C with a note is acted on** (2026-11-20): the watchlist queues a `revise` job first in line (tier 0; `revisionsToQueue`, `src/track/revise.ts`; one per request, keyed by clip and the time it was sent back, so a failed one is not retried by itself and a new note runs again), the editor agent does what the note asks first (`reviseClip`, `src/pipeline/full.ts`: it may switch a layout request to the whole frame; there is no blur effect, so hiding something means cropping, zooming or cutting), renders, reads QA and submits the clip back to review with a hand-over that starts "You asked: …". A clip cut from a YouTube stream while it was live is not revised (editing cannot fix the footage). The reasons go to `feedback.jsonl` and `clip stats` ("why … were rejected"); `clip review <clip> reject --reason layout,boring` does the same.
- **18+ (2026-11-22, user):** the To review tab has an **18+** check above Approve (`8` toggles it); ticked, the clip uploads age-restricted on YouTube. It starts from the **18+ check** QA runs (`checkAdult`, `src/qa/adult.ts`, stored as `adult` in `exports/<clip>.qa.json`; a `18+` QA warning when found, never a failure): points from what is said in the clip (explicit words 2 each, words sexual only in some uses 1 each; cut words do not count), the queue experts' `sexual` flag (2, or 3 from two kinds of expert), lewd chat while it played (5+ chatters 2, 12+ 3) and **NudeNet** on a still every 2 s of the export (`tools/nudity/`, MIT, on-device, its own uv venv in `.cache/nudity-py`; nudity in 2+ stills or one at 0.7+ 6, one still under 0.7 only 2 because both such hits on the first 101 clips were bare skin, revealing clothing in 40%+ of stills 2); 4 points tick it, and the line under the check says what was found and what was not read. The decision is `review.adult` in the project and `adult` in `reviews.sqlite` (a clip approved before the check has none, and its upload takes what the check found) (and `adult`/`adultDetected` in `feedback.jsonl`); every other tab shows it as a mark, not a check. `clip adult <clips…|--review>` runs the check again; `clip review <clip> approve --adult|--no-adult`.

## The watchlist

- **Moments first, from a tracker (2026-11-19).** The watchlist no longer scans the newest 20–30 minutes of a stream blind (that missed 29 of the 66 most-clipped moments on the streams it worked, and 23 of 26 rejects were "boring"). It works moment by moment, the way a stream link handed to a session is clipped:
  - `./clip moments <link|id>` ranks a broadcast's moments from what the community did (`src/scan/moments.ts`): viewer clips over the same seconds are one moment (views add up, two clippers count), and chat laughter (distinct people laughing in 10 s, the best single signal measured) where chat is fetched. Only moments over the bar (50+ views, two clippers, or 5+ laughing well over the stream's normal), best first; scanned minutes are **not** left out (that hid moments whose evidence came later), `scanned` marks them. `--json` for the watchlist.
    - **A moment is a region, not a peak second** (`sameMoment`, `planMoments`, `duplicatesOf` in `src/scan/moments.ts`; spec step 2): a re-rank matches each moment to the row it has (regions overlapping by half the shorter, or peaks within 30 s), keeps its id, and a waiting row takes the new bounds, window and eligibility (into or out of a gambling chapter) while a worked one keeps the bounds its job used. A moment whose peak is inside a worked moment's window, or a waiting duplicate, is `covered` (`covered_by`): its seconds run once.
    - **Two rankings:** `rank` (the combined score: views + 25 per extra clipper + 12 per laugher; the watchlist's order) and `altRank` (the shadow ranking, `alternateOrder`: the viewer-clip list and the laughter list take turns, so a big laugh is not buried by a mature clip; Jerma's approved moped crash is #10 by score, #2 alternating). Both are stored per moment; `./clip rankers` counts approved/rejected moments in each one's top 4. `MOMENT_RANKER=alternate` switches the watchlist once the shadow ranking wins on 20+ judged moments.
    - **The blind ranker trial** (on unless `RANKER_TRIAL=0`; `inArm`, `nextArm` in `src/track/db.ts`, `src/track/trial.ts`): moment jobs take turns between three arms: `score` (in a stream's top `TRIAL_TOP`, 4, by the combined score only), `alternate` (by the shadow ranking only) and `both` (in both, kept so the trial does not starve the channel); the arm with the fewest jobs goes next, among the moments of the best tier waiting (a stream added by hand still goes first). Each job costs the same (one moment, the same pipeline, one clip at most) and records its `arm` on the job row; the review page never shows it, so you review blind. `./clip rankers` tallies per arm: jobs, clips, approved / changes / rejected / waiting / no clip, and **approved per job**; read it once both one-ranking arms have 20+ judged jobs.
  - **The tracker** (`library/tracking.sqlite`, `src/track/db.ts`): every stream (whose, when, live or ended, where we found it, `tracking`/`done`/`skipped` with the reason) and every ranked moment (`pending` → `queued` → `working` → `clipped` / `no-clip` / `failed`, or `skipped` with why, or `covered` by the moment that has its seconds). Wrong content is recorded, not just avoided: test streams, reruns/VOD channels, streams that ended under 20 min, subscriber-only broadcasts, moments in a gambling chapter (`wrongStream`, `NEVER_CLIP`), and **sexual moments** (`skipSexual`, `src/track/rank.ts`, 2026-11-22: a viewer clip titled for sex, or lewd chat from 10+ people and 5%+ of chat over it; on 4,691 tracked moments the 95th percentile is 2%, GTA 6's nude shower was 7%, about 1% pass. Viewers clip sex and nudity scenes the most, so ranking by views alone sent jobs to the clips YouTube removed). A sexual moment is recorded wherever it ranks, not only in the top 12, because the job picker reads a row's stored rank. A rule's skip is lifted on a re-rank where it no longer holds. `./clip streams` shows live, tracked, done and skipped streams with their moment counts and what is next; `./clip streams <id>` one stream's moments. The status page (`library/watchlist-status.html`) has the same.
  - **The job queue** (`src/track/jobs.ts`, the `watch_jobs` table in `library/tracking.sqlite`; spec step 4, 2026-11-19; the old `watchlist-queue.json` was imported once and kept as `.imported`): a unique index on (kind, video, moment) among queued and running jobs, so a moment is never queued twice even by a race; `claimNext` takes the next job (by hand → listed creators → topics, oldest first) in one transaction with a **lease** (`claimed_by` = `watchlist:<pid>`, 10 minutes, renewed every minute while the stages run as child processes); `requeueStale` puts back a job whose worker's pid is gone or whose lease ran out; every write a worker makes (`saveStage`, `finishJob`) is **fenced** by its claim, so a worker that lost a job cannot finish it twice. **Checkpoints:** a moment job records `scanned`, then the pipeline's stages (`queue-check`, `extract` with the candidate ids, `curate` with the picks, `edit` with the clip ids; `PIPELINE_STAGES`, `stagesToRun` in `src/pipeline/full.ts`), and a restarted job resumes after the last one. **Resume reconciles output:** a job that had finished its edit returns its saved clips; the pass's candidates are saved with the extract checkpoint (a candidate made since does not drop out); and before the editor runs, a pick that already has a clip in review counts as this job's and is not edited again (`outputsFor`). The job row holds its moment, window, checkpoint and clip ids (provenance); its window is painted on the stream's `clip` ledger (claimed → done/failed/queued). `tools/cleanup.ts` and the status page read the table.
  - **The observer** (`tools/observer.ts`, log `.cache/observer.log`, heartbeat `library/observer.json`; the watchlist starts it when it is not running): the cheap pass over **every minute** of every tracked Twitch stream, in its own process so a clip job never holds it up. It reads chat in chunks of up to 60 minutes (`OBSERVE_CHUNK_MIN`), by hand → listed creators → topics, live first, least-read first; **a live stream's new minutes are read in batches of `OBSERVE_LIVE_BATCH_MIN` (10)** and the time between goes to older footage (`readUpTo`, `unqueueFrom`; without it 383 of 400 reads were under 10 s and the backlog grew), and a stream that ends is read to its end; re-ranks each stream every `RANK_EVERY_MIN` (20) and right after a read (`rankAndStore`, `src/track/rank.ts`, shared with `clip moments`/`clip track`); closes a stream ended over 48 h with nothing waiting. What has been read is the stream's `observe` **coverage ledger** (`coverage` table; `src/track/coverage.ts`): spans `queued` / `claimed` / `done` / `failed` / `skipped` with the job and the reason. One rule, *wanted − done − claimed − skipped, merged into the one queued job*: a queued 40 minutes grows into the hour in place, a running 40 minutes keeps its claim while 40:00 onwards is queued as a new job, a job that died is `recover`ed from the chat file (read → done, the rest back in line). Chat a scan already read is imported as done; a stream with chat off is done on viewer clips alone. `clip streams` shows `read N%` per stream and the observer's backlog; `clip streams <id>` the ledger. Tested row by row from the spec's table (`test/coverage.test.ts`).
  - **The watchlist loop:** creators and topics register broadcasts (a creator check takes **every broadcast live in the last `RECENT_HOURS`, 48**, not only the newest: `recentBroadcasts`; a stream is one tracker row with every list that found it in `sources`, its tier from the best); the observer ranks each tracked stream again every `RANK_EVERY_MIN` (20; new clips, new chat); ended streams are followed for `TRACK_ENDED_HOURS` (48) because viewer clips keep coming. One `twitch-moment` job waits at a time. **Order (`tierOf`, `src/track/db.ts`): a stream added by hand (`clip track`, source `manual`) first, then the listed creators (channels.json), then topics**, which fill the time the creators leave; within a tier `nextMoments` gives each stream's best moment before any stream's second, at most `MOMENTS_PER_STREAM` (4) per stream. A waiting job gives its place to a higher tier that came up since, and `clip track` ranks the stream at once, so "do this one" is the next job. `manual` sticks: a creator or topic check never demotes it. The job scans the moment's window (a minute before its region to 45 s after) and runs the full pipeline on it with one clip at most; the moment ends `clipped` (with the clip ids) or `no-clip`. **The daemon works back to back** while anything waits; **discovery has its own timer** (every `CHECK_MIN`, 15, whatever the worker is doing: a clip job's stages are child processes, so the process stays free); the worker sleeps only when idle, looking each minute for a stream added by hand. A stop or restart puts the running job back in line (`interrupted`), never `failed`. A bar, not a quota: a stream with nothing over the bar gives nothing.
  - **A moment job works on its own candidates only** (`src/pipeline/full.ts`, 2026-11-19): the experts get the community's evidence (`momentBrief`: views, clippers, laughers, clip titles), and the virality expert judges the moment as a found moment when no queue covers it; the curator decides only this pass's candidates (`passCandidates`: just extracted, plus an unclipped one already inside the window); the editor gets an explicit list (`pickForEdit`: kept, strongest fit first; when nothing is kept, the best "review" candidate with the curator's concern for the reviewer). Before this, the editor took any kept leftover anywhere in the stream, and most "boring" rejects were old range-scan leftovers credited to a 20k-view moment.

## Topics and discovery

- **Topics:** `topics.json` lists trending games the watchlist follows besides the creators (`name`, `twitch` category exactly as Twitch names it, `youtube` search, `minViewers` default 2000, `priority`, `enabled`, `skip` logins). **Every check reads every topic and takes each topic's top 3 eligible streams** (`topicPicks`, `src/scan/topics.ts`; `TOPIC_TOP`, default 3; the spec's section 4.2) into the tracker; a stream already tracked counts toward its 3 and taking it again only adds the topic to its `sources`. Eligible: at least `minViewers`, live (not a rerun or VOD channel), a VOD being recorded, not on the topic's skip list or `doNotClip`, not a broadcast the tracker skipped before (the next one takes the place). **A listed creator never takes a topic's place** (the creator check has them). One channel under two topics counts once, under the bigger. Tracked topic streams are followed to their end after they leave the top 3; their moments wait behind the listed creators' (see the order above). A job that fails on a timeout or a network error is queued again once (`retryable`, `WATCHLIST_RETRIES`, default 1); the ledgers make the retry start where the failed run stopped. A daemon that starts puts back any job still marked running. `./clip topics` shows what is live per topic and each topic's top 3 (tracked or new); `./clip topics --suggest [--youtube]` lists trending Twitch categories (and YouTube live viewers) not yet in the list. YouTube is research only: a YouTube live stream can only be ingested whole. **A YouTube stream is never read while live** (`youtubeLive`, `src/ingest/media.ts`): its DVR window moves, and every section comes back as the live minute (three iShowSpeed clips at 0:26, 1:31 and 1:45 were all the same minute). Ingest refuses it, every download refuses a video read while live until `clip ingest <id> --refresh` after it ends (which also drops the footage cut while live), and the watchlist waits for the VOD (`MAX_YT_STREAM_MIN`, default 720). `TOPICS=0` turns topics off.
- **Daily discovery:** `clip live` is Twitch live-only. For the day's biggest English streams use SullyGnome (`/channels/1/watched?language=en` past 1 day, `/channels/1/peakviewers?language=en` peak viewers) and TwitchTracker (`/channels/live?language=english`). YouTube: Playboard (`/en/chart/live/`, daily peak concurrents) or Streams Charts (paid API). Snapshots can live in `library/trending/YYYY-MM-DD.json`.

## Publishing

- **YouTube publishing:** `./clip auth youtube` (one-time OAuth; `client_secrets.json` in the project root) then `./clip publish <clipId>` (only a `post` verdict with passing QA unless `--force`). **An 18+ clip** (`review.adult`, or `--age-restricted`) goes up **private** with `contentDetails.contentRating.ytRating = ytAgeRestricted`, the rating is **read back** (`youtubeVideoState`), and only when YouTube's record shows it is the video scheduled (`scheduleYoutube`, a `videos.update` of the status part). YouTube's docs do not list that field as writable (an old answer calls it read-only), so a clip it did not restrict **stays private** (`heldPrivate` in `exports/<clip>.publish.json`) and the review page links it in YouTube Studio with the steps; it is never public without the restriction. Unproven until the first 18+ upload: the first one's read-back says which. **Uploads are scheduled by default:** private until the next slot, +5 minutes for the first clip, +10 for the next, +15 after that, measured from the first upload in the batch. `--now` uploads immediately (with `--privacy`), and `--publish-at ISO` sets an exact time. **Drip uploader:** `tools/youtube-drip.sh [--force] [--dry-run] <clip...>` uploads one clip every 10 minutes and schedules each to go live 5 minutes after its own upload (`EVERY_MIN`/`LEAD_MIN` override); it skips clips that already have `exports/<clip>.publish.json`, so a rerun is safe. Run it detached with `nohup … > .cache/youtube-drip.log 2>&1 &`. From the Studio, approving (A) is what schedules a clip: the upload scheduler picks approvals up. It uses the Data API resumable upload and stores `exports/<clip>.publish.json` so retries don't double-post. Setup: Google Cloud project → YouTube Data API v3 → OAuth client (Desktop app, or Web app with `http://localhost:8080/oauth2callback`) → save the JSON as `client_secrets.json`. **Token refresh is automatic**: `youtubeAccessToken()` refreshes with the stored refresh token and rewrites `.cache/youtube-token.json`; a Testing-mode OAuth app still expires refresh tokens after 7 days, so publish the app or re-auth weekly.
- **TikTok publishing:** `./clip tiktok auth` (desktop Login Kit + PKCE, local callback `http://localhost:8080/tiktok/callback/`) then `./clip tiktok upload <clipId>` uploads the export to the creator's **TikTok inbox** as a draft; the user finishes the post in TikTok. `./clip tiktok post <clipId>` is Direct Post as a private (SELF_ONLY) post (needs `video.publish` and a private account); `./clip tiktok status <publishId>` checks an upload. It uses the `video.upload` scope and does **not** need the Content Posting API audit. Direct public posting (`video.publish`) requires TikTok's app audit — unaudited clients can only post to private/SELF_ONLY accounts. Setup: create a TikTok developer app, add **Login Kit** + **Content Posting API** (Upload), register the localhost redirect URI for a **Desktop** app, save the client key/secret as `tiktok_secrets.json` (or `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET`). Tokens refresh automatically; refresh tokens last 180 days and rotate on every refresh. Inbox uploads are capped at 5 pending shares per 24h.
- **YouTube reach/analytics:** the Shorts feed is driven by stayed-to-watch/engaged views, average view %, shares and subscribers — not titles/hashtags. `./clip post <clipId>` now prints three title options and a context-first description with 3–5 hashtags; the publisher uses the chosen title and sends no tags (tags are minimal). `./clip analytics [--days 28]` pulls `views, engagedViews, averageViewDuration, averageViewPercentage, likes, comments, shares, subscribersGained` for published clips into `performance.jsonl` and computes `outcome` (engaged 40%, avg view % 30%, shares 20%, subs 10%); `clip stats` shows median outcome and Spearman calibration against virality/quality/signal. The public API has no exact “stayed to watch” metric; `engagedViews / views` is the proxy. Analytics needs the `yt-analytics.readonly` scope and the API enabled in the Cloud project; data lags 2–3 days, so rows with zero views are skipped.
