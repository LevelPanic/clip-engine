# Changelog

What was built, measured and decided, newest first. These entries were the dated log in SCOPE.md until
2026-11-23; SCOPE.md now keeps the plan, the current state and the backlog.

## 2026-11-24

- **Settings → Uploads (user: "please also add settings that let me adjust schedules for uploads and quantity"):** a Settings page in the Studio (nav: Settings) for the upload schedule: uploads per day, hours between uploads, optional posting hours in a time zone (overnight works), minutes until a Short goes live, and Pause uploads. Drafts are previewed with what they allow and warnings (a cap the gap or the hours cannot reach, over 10 a day, under an hour apart); Save writes `library/upload-schedule.json` (`src/publish/schedule.ts`), and the uploader, which now re-reads the schedule every minute instead of the env settings once at start, follows it with no restart. The pace gained the posting window and the pause (`windowOpenAt`, `paceAt`); the review page's upload bar says when the next waits for the posting hours or uploads are paused. An unreadable schedule file pauses uploads. `test/schedule.test.ts` (6 tests). Live check: a saved pause reached the uploader within a minute and Reset restored the 00:11 slot; the uploader and Studio were restarted for the new code.
- **Upload anyway (user: "make warnings have a upload anyway"):** an approval the careful period holds now has **Upload anyway** beside Check again on the review page (a second click confirms, and it lapses after 6 s). It records `review.uploadAnyway` (`uploadAnyway`, `src/review/index.ts`), puts the clip back in the upload line, and `gateApproval` lets it past the careful period only; the never-post list (nudity, a slur said, a minor, a sexual title), a missing credit and the 5–60 s length still refuse, by the 2026-11-22 rule. A new decision clears it. Tested in `test/scheduler.test.ts` and `test/adult.test.ts`; on the review page the button and its confirm step were checked on a held clip and cancelled (nothing was sent). The uploader was restarted for the new rule while it waited for its 00:11 slot.
- **Editable post text and Regenerate (user: "make the title editable. also a button to let me say regenerate title and regenerate description"):** the review page's heading is now the title a clip uploads with (it was the working title, which often differs: the generated upload title can add a nickname, caps and emoji the working title never had), editable in place, and so is the description above the credit. Regenerate title / Regenerate description open a popup with a direction and run a new `post-text` job (`src/pipeline/postText.ts`, `test/post-text.test.ts`): 3 titles or 2 descriptions from the pipeline's model in about 7 s, checked against the never-post title words and length. Tested on a rejected clip (it cannot upload): direction "lead with how tired he is, no skull emoji" gave three titles that did both; "one sentence, say it's the end of a 24 hour stream" gave two that did; Use, the in-place edit, select-on-edit and Esc all worked; the clip's post was restored to the suggestion after. The `Popover` is now fixed to the screen under its button, so a scrolling panel cannot clip it.
- **The Studio redesigned (user: "update the design of the entire frontend. modern and sleek. following design principles. managing whitespace. following design systems like impeccable"):** checked against Impeccable's anti-pattern catalog (impeccable.style/slop) and its "operate" guidance for tools. New tokens (`src/studio/web/ui/tokens.css`): a neutral graphite with one blue for interaction (the purple accent was the catalog's "AI palette"), a near-white primary button kept to one per view, tinted state colours, Instrument Sans and JetBrains Mono through `@remotion/google-fonts` (no new dependency), a 4 px space scale with 48 px between sections, smaller radii, motion tokens with reduced-motion. Components: a sticky full-width nav with the brand mark, `PageHead` on every page, underline tabs with count pills, tinted chips and callouts (no coloured outlines or stripes), 32 px controls. **Review** is now three panes on one screen (the queue, the clip, the decision panel with its note and buttons fixed at the bottom) instead of the clip list below the fold; the selected clip scrolls into view inside the queue only. After the user's notes on the first version ("put that in a popup", "move that to an info box above the clip's info", "make video take more space", "keep it 9:16", "the shortcuts can be in a popup on a shortcuts button on the review page's tabs line"): the page heading became a popup on the nav's Review link (every section's link has one), the upload status moved above the clip's details as one line that opens in place over them on hover or focus, the shortcuts are a **Shortcuts** popup at the far right of the tabs line (`?` opens it), and the clip is exactly 9:16 at the row's full height (530 × 942 at 1920 × 1080). Library: labelled batch form, counts on the sections. Jobs: aligned tables with state chips. The video page and the editor follow the tokens; per-card Edit, Scan new part and Apply style are no longer primary. Removed: uppercase section labels, the selected row's side stripe, hatched cut zones. Checked at 1440 × 900, 1100 × 800 and 375 × 812 (no sideways scroll, no console errors). `DESIGN.md` records the system; a new test holds the palette to WCAG AA.
- **A pause switch for finding new clips (user: "make a pause button for me in the studio so i can pause the process that looks for new clips but keeps the uploader and editor going so it edits the changes asked and cleans stuff"):** every Studio page but the editor has a switch at the right of the nav bar (`DiscoverySwitch`, `src/studio/web/Discovery.tsx`; `GET`/`POST /api/watchlist`). Paused (`library/watchlist-pause.json`, `src/track/watchlist.ts`), the watchlist checks no creators or topics and queues no moment jobs, its worker takes change requests only (`claimNext` with `claimableKinds`), and the observer reads no chat (its ledger picks up where it stopped). A clip job already running finishes; waiting moment jobs keep their place. The upload scheduler and the cleanup are separate daemons and keep going. A resume checks the creators and topics at once. The watchlist writes a heartbeat each minute (`library/watchlist-heartbeat.json`), so the switch shows "Watchlist not running" when it has stopped. Earlier the same day (user: "pause the clip engine") every daemon was stopped; they were started again with finding clips paused.

## 2026-11-12 to 2026-11-23

- **The watchlist is running again (2026-11-23 05:38 UTC, user: "ok all clips reviewed. resume the watcher and everything"):** every clip was reviewed (94 approved, 25 changes asked, 62 rejected), so the watchlist was started; it queued 22 `revise` jobs first (tier 0) for the clips sent back with a note, then moments. Disk 7.4 GiB free; `tools/cleanup.ts --dry-run` frees no footage yet (approved clips waiting to upload and the 25 changes still reference their streams). The cleanup daemon had never stopped (my check missed it); starting a second one deleted the 13 rejected clips past their hour a few minutes early, and stopping it with `pkill -f "…" -n` killed every user process with "-n" on its command line (BSD pkill reads a trailing `-n` as a second pattern): both cleanup daemons, a Remotion Chrome of moodverse-v2, the first revise run (put back in line), app renderers (Claude, Spotify, ChatGPT respawned theirs). Never put options after the pattern; kill by pid. One cleanup daemon runs again. **Review page fix:** on To review the note box was prefilled with the editor's hand-over, so Make changes sent it as the request: 7 Twitch clips (tw-2933599748-c02, tw-2932469290-c03, tw-2933941381-c01, tw-2936386266-c01, tw-2933861646-c02, tw-2934897780-c01, tw-2936433878-c01) and 3 iShowSpeed ones went to Changes asked with a hand-over as the note. The box now starts empty with the hand-over shown above it, Make changes needs a note, and `setReview` drops a note equal to the hand-over (tested). **Held (user: "Hold them"):** the 7 Twitch revise jobs with a hand-over as the request were closed in `watch_jobs` (state `done`, result `held …`) before any ran, so the watchlist does not queue them again (checked: `revisionsToQueue` returns none); the clips stay in Changes asked until the user writes the change and sends it again (a new decision is a new request and a new job). 14 revise jobs with the user's own notes went ahead.
- **The watchlist is paused (2026-11-23, user: "can you pause the clip maker? low on storage atm"):** stopped with its running job (an extractor stage on tw-2937823332) back in line; nothing new is clipped. The observer (chat reads, small), the upload scheduler and the Studio still run. Disk: 4.0 GiB free; the project holds about 50 GB (`library/` 36 GB, 33 of it stream footage; `exports/` 8 GB; `.cache/` 5.4 GB). The 1.3 GB edit study was deleted (user: "Yes, delete it"), leaving 6.3 GiB free; its results are in `docs/research/meme-edits-2026-11-22-data/`. Five old test leftovers in `.cache/` (feed, face-test, calibration, tbp.mp4, elias-windows; 2 GB, from 2026-11-10 to 11-12, read by no code) were deleted too (user: "Yes, delete them"): 7.8 GiB free. `tools/cleanup.ts --dry-run` frees nothing now: every source still has a clip waiting for review. **To resume:** `nohup npx tsx tools/watchlist.ts --daemon >> .cache/watchlist.log 2>&1 &` (unsandboxed).
- **Facecam-only and game-only spans (2026-11-23, user: "yes, build them"):** the `solo` marker frames only its span and goes back to the split. `soloGeometry` is read by both framing sides; `resolveKeys` drops a span not over a split. The meme editor puts the first laugh of a split clip on the facecam and "look at this" on the stream. A real render of a copy of `tw-2934373999-c03` (deleted after) showed split → facecam only → split → game only → split, with the credit clear of the face. 337 tests pass (5 new in `test/solo.test.ts`).
- **The meme-edit vocabulary is built (2026-11-22, user: "Yes, build them"):**
  - **New markers:** `tilt`, `mono` (black and white through a new `filter` hook in the marker contract), `counter` (count or stopwatch) and `pointer` (arrow/circle + label).
  - **Changed markers:** `zoom` `direction: out` (the reveal); `text` styles `box` (the premise box, TikTok's look) and `chat` (a Twitch chat card).
  - **Captions:** a line said 3+ times becomes "X3" (`captions.repeats`).
  - **Sounds:** air horn, record scratch, glass break and boing in `assets/sfx/`. Synthesized here, so we own them; Apple's classifier hears air horn, disc scratching (weak), glass breaking and a synthesizer.
  - **The meme editor places:** the box at the open, zoom + tilt on up to 3 reactions, a reveal on a silent open, a tint beat, a counter on a spoken countdown, a time-skip card, a chat card from the moment's own chat (filtered: readable, no emotes, no risk words, swears masked, clear of cuts), and freeze + black and white on a fail ending.
  - **Bug found and fixed:** re-running an editor dropped its premise box, because it saw its own old box as "a hook is there".
  - **Checked:** a real render of a copy of `tw-2937478169-c01` (deleted after) showed every one of them in the export, the air horn included (466 Hz band −25 → −9 dB). 332 tests pass (14 new).
- **The meme edits clip channels use, studied (2026-11-22, user: "we need to expand our vocabulary on meme edits … get a large sample set we can study and take out easy edits with examples"):** `docs/research/meme-edits-2026-11-22.md`.
  - **Sample:** 175 streamer-clip Shorts from 38 channels (median 2.3M views), measured automatically. 120 were labelled edit by edit by 24 Sonnet agents (1,483 edits). Sudden sounds were matched across all of them. The videos, measures and sheets were deleted on 2026-11-23 to free disk space; the labels, tallies and scripts are in `docs/research/meme-edits-2026-11-22-data/`.
  - **Findings:** a median 11 edits a Short, each on a word or a reaction. Zoom punches come with a 4–8° tilt. The open is a premise box with an emoji in TikTok's text style. Layout switches (cam only 21%, game only 16%, zoom-out reveal 34%) are edits we cannot make yet.
  - **Missing and easy (S or less):** the premise box, tilt, zoom-out, black-and-white with a freeze for fail endings, the tint beat, a caption repeat counter "X3", a time-skip card, real Twitch chat as a card, an arrow/circle, a counter/stopwatch, and four sounds.
- **Censoring tools for the editor (2026-11-22, user: "Yes, change 3" of `docs/research/censorship-review-2026-11-22.md`):** (B1) captions mask strong swears at the root and slurs whole by default (`captions.censor`, "Mask swears" in the Inspector); 37 clips in To review get 67 more words masked on their next render (7 were masked by hand before). (A4) QA warns `language`: swears heard by kind, bleeped, an f-word in the open, unmasked captions, a swear in the title. (B2) The `bleep` marker mutes the clip's sound through a new `gain` hook in the marker contract (the composition applies it, `wordsThatPlay` treats a word under it as not said) and plays a 1 kHz tone; `./clip censor` places bleeps over every slur and the f-words in the first 3 s, and the edit skill and the pipeline prompt run it before every render. (B3) The `blur` marker blurs or blacks out a box of the 9:16 frame. Checked in a real render of a copy of `tw-2937478169-c01` (deleted after): under the bleep the source was gone and the tone peaked at −8 dB against speech at −1 to −5 (the first tone was 25 dB too quiet: the generated wav peaked at −22.5 dB; fixed), the blur blurred the cars and left the captions and the credit sharp, and QA said "1 strong swear heard (s-word ×1), 1 bleeped". `clip censor --review` finds an f-word in the open on 3 waiting clips. Tested (`test/censor.test.ts`, 8 tests).
- **The uploader slowed down, and a two-week careful period (2026-11-22, user: "Yes, change 2" of `docs/research/censorship-review-2026-11-22.md`):** (C4) at most 8 uploads in any 24 hours, 3 hours apart (was one every 20 minutes; 26 went up on Nov 21), counted from the publish records, and never more than YouTube's limit let through the last time it refused (`src/publish/pace.ts`). A limit is waited out to when it lifts instead of tried hourly: the channel's limit to a day after the first upload of the last 24 hours, the project's quotas to midnight Pacific (62 refused calls on Nov 19–21 counted against the project's daily uploads). (C5) `channel.json` → `careful` until 2026-12-06: an approval with a `sexual` flag from any expert, an 18+ tick or an f-word in its first 3 s is held (`deferred`, not refused) and goes up by itself after it; 23 of the 122 clips in To review would be held if approved (16 sexual, 7 f-word open, 3 18+). The creator on screen and not a cutscene is a line above Approve, not a check: 45 of 173 clips are blur layout because the streamer uses an avatar (penguinz0, TheBurntPeanut), so the layout cannot tell. The review page's Approved tab shows the pace, the next slot and the careful period. Tested (`test/pace.test.ts`, 10 tests); the uploader and the Studio were restarted on it. Note: the hourly cleanup deletes a rejected clip an hour after the rejection, so the 11 rejected in change 1 are gone (their rejections stay in `feedback.jsonl`).
- **Sexual content stopped at both ends (2026-11-22, user: "Yes, build change 1" of `docs/research/censorship-review-2026-11-22.md`):** three gates (CLAUDE.md → Rules → "Never posted"). (A3) The ranker skips a moment whose viewer clips are titled for sex or whose chat was lewd (10+ people and 5%+ of chat; about 1% of 4,691 tracked moments, among them the nude shower, the bed scene and the strip club). (A2) Curation refuses `keep`/`review` on a moment flagged `sexual` by two experts, `slur` or `minor` unless the reason says how the cut avoids it, and the pipeline never hands such a `review` pick to the editor; the experts reject `unsafe` when the nude body or the sex scene is the moment. (A1) The publishers and the upload scheduler refuse nudity the 18+ check is sure of, a slur said, a `minor` flag and a sexual title, `--force` or not; QA shows it as `✖ unsafe`; a sexual title holds the approval until it is edited. `clip unsafe --review --approved` found 11 of 127 waiting clips (4 nudity, 6 titles, 1 minor), none for a slur said. The report's 11 riskiest waiting clips were rejected with the reason in the note (reversible with `clip review <clip> review`). Not done (the report's changes 2 and 3): slowing uploads, caption masking, swearing in QA, bleep and blur markers. 10 tests in `test/unsafe.test.ts`.
- **Views collapsed on 2026-11-21; QA no longer blocks uploads (2026-11-22, user: "make the qa not block uploads … recently it has been causing some flags on youtube and now our viewership has tanked"):** uploads to 08:58 UTC Nov 21 got about 500–1,800 views each; from 09:18 on most get 0–20 even after 30 h (median 10 for Nov 21's 26 uploads). Two uploads are gone from YouTube (missing from `videos.list` and the uploads playlist): ExtraEmily's GTA 6 nude shower (`tw-2932651985-c06`, 18+ check 13 points) and Peanut's brawl (`tw-2932226282-c10`); the API cannot say whether YouTube removed them. All views are Shorts (91% from the Shorts feed, 16.9% of signed-in viewers 13–17). The uploader no longer sets aside an approval that failed QA (it logs the failure and uploads; the credit still stops one): `tw-2931374441-c35` (16% black) went up. A Fable session (`censorship-review`) is writing `docs/research/censorship-review-2026-11-22.md`: why the flags, where risky content gets through, gates and edits (bleeps, caption masks, a blur marker, crops), and the riskiest waiting clips. **To do:** read it with the user and pick what to build.
- **18+ check on the review page (2026-11-22, user: "make it so there's a 18+ check in the reviewer window … so the upload goes with a 18+ check on youtube. make it also detect the sexual content …"):** the To review tab has an 18+ check above Approve (`8` toggles it), started from an 18+ check that QA now runs (`src/qa/adult.ts`: words said in the clip, the experts' `sexual` flag, lewd chat, NudeNet on stills; 4 points tick it, the reasons show under the check). The decision is fixed with the approval (`review.adult`, `reviews.sqlite`), and the other tabs show it as a mark. An 18+ upload asks YouTube for the age rating, reads it back, and schedules only when it is there; otherwise it stays private with a YouTube Studio link (YouTube's docs do not list the rating as writable). **To do:** read the first 18+ upload's result (`exports/<clip>.publish.json`: `ageRestriction`) and update CLAUDE.md with whether the API takes it.
- **Held clips are tried every 60 minutes (2026-11-21, user: "10 a day is the limit cuz i think a shadow ban is going on my account.. also bump the retry to every 60 minutes"):** `HOLD_RETRY_MIN` is 60 (was 20), the page says how often from `retryEveryMin` in `upload-status.json`, and a restart keeps the try time a hold set instead of trying at once. Why it matters beyond the user's ask: the overnight hold was a second limit, the project's "Video Uploads per day" quota (`rateLimitExceeded`), which counts refused upload calls; 26 refused tries at 20 minutes during the channel's hold used it up, so the line stayed held from 01:38 to 08:18 UTC after the channel's limit had lifted at 00:58. Then 18 went up from 08:18 to 14:37 with no refusal, 19 in 24 hours: the channel's limit did not stop at 10 that day. The user treats 10 a day as the limit and suspects the account is shadow-banned.
- **Uploads held by YouTube's per-channel limit (2026-11-20, user: "uploading isnt working i think"):** the scheduler works. YouTube allows this channel about 10 uploads a day (`uploadLimitExceeded`): 10 went up between 01:05 and 04:05 UTC, then every try from 11:18 was refused, while the API answered other calls. That is the channel's limit, not the Cloud project's quota, so a quota increase would not raise it (the after doc said it would; corrected). The scheduler logged both limits as "quota full"; it now names which one and writes `library/upload-status.json`, and the review page's Approved tab shows a banner with the hold, when it should lift and each clip's place in line. 20 approvals were waiting, about two days of uploads at this limit. Then (user: "uploader should stay at a single clip until it gets uploaded … keep trying every 20 minutes … keep the logs"): the scheduler now holds one clip until it uploads and tries it every 20 minutes (it used to release it and wait an hour), a restart resumes the same clip (a clip left `uploading` by a crash used to be stuck for good), and every try is kept in `library/upload-log.jsonl` (49 earlier tries read back from the text log), shown on the review page. 284 tests.
- **Change requests now run (2026-11-20, user: "changes asked not getting run?"):** nothing acted on C ("Make changes") in the review page; the edit skill only read the note when someone ran `/edit` by hand, and 10 clips were waiting. The watchlist now queues a `revise` job for each request with a note, ahead of moment jobs: the editor does what the note asks, renders, and resubmits with "You asked: … Changed: …". One try per request. The three iShowSpeed clips are left (their footage is the wrong live minute: reject them). No blur effect exists: censoring is by crop, zoom or cut (a blur marker would be a new marker type). 278 tests.
- **Blind ranker trial (2026-11-19 night, user said build it):** moment jobs rotate between three arms (`score` only, `alternate` only, `both`), evenly by job count within the best tier waiting; each job records its arm, costs the same, and is reviewed without the arm showing. `./clip rankers` reports approved per job per arm. **To do:** review the trial's clips as they come; read the result once both one-ranking arms have 20+ judged jobs, then keep or switch the ranker (`MOMENT_RANKER=alternate`). 276 tests.
- **GPT's review of the after doc (2026-11-19 night):** three gaps verified and fixed. The observer made 383 of 400 reads under 10 s and its backlog grew (a live stream's few new seconds went first every loop): live tails are now read in 10-minute batches and the time between goes to older footage. Discovery waited behind clip jobs: it has its own timer now. A restarted job could lose credit for a clip it had already submitted: resume now reconciles against review records and saved checkpoints (`outputsFor`). The live crash test (kill -9 mid-job) resumed after the saved checkpoint without re-running the experts. 275 tests. Proposed next: a blind ranker trial (both rankings' exclusive picks, equal cost, reviewed without knowing which chose them).
- **After doc (2026-11-19):** `docs/research/watchlist-after-2026-11-19.md` is the record of what the watchlist and clip pipeline do now and what was built (the problems, each fix and where it is, the components, commands and settings, tests, numbers, open items).
- **Spec step 4 (2026-11-19 evening):** the watchlist's job queue moved from `watchlist-queue.json` into the tracker (`watch_jobs`, `src/track/jobs.ts`; 182 jobs imported, the file kept as `.imported`): a moment can never be queued twice (unique index), a job is claimed in one transaction with a 10-minute lease renewed every minute, a dead worker's job goes back in line (its pid is gone or the lease ran out), and the dead worker's late writes are refused (fencing). Moment jobs checkpoint each stage (`scanned`, `queue-check`, `extract`, `curate`, `edit`) and a restarted job resumes after the last one instead of from the start. Every CLI call in a job is non-blocking so the lease keeps being renewed. 273 tests. Next: camera memory (Ludwig's VALORANT-portrait split), then a second worker with a render lock.
- **Spec step 3 (2026-11-19 evening):** a coverage ledger per stream (`src/track/coverage.ts`, the `coverage` table in the tracker): queued / claimed / done / failed / skipped spans with one rule (*wanted − done − claimed − skipped, merged into the one queued job*), recovery for a dead worker, tested row by row from the spec's hour-by-hour table. The **observer** (`tools/observer.ts`, started by the watchlist) reads every minute's chat of every tracked stream in 60-minute chunks and does all the ranking in its own process; the watchlist no longer ranks. `clip streams` shows `read N%` and the backlog (first pass: 32 streams, 169 h read, 148 h to read, about 3–4 h to catch up). 267 tests. Next: step 4 (clip queue in SQLite with leases, checkpoints, provenance).
- **Spec step 2 (2026-11-19 evening):** a moment is a region: re-ranks match the row they have (a moved peak no longer makes a second row; a waiting row takes new bounds and eligibility; a worked row keeps the bounds its job used); duplicates and peaks inside a worked window are `covered` (23 folded on the first pass); scanned minutes are no longer hidden from ranking (the second audit found 107 regions hidden that way). The second audit's alternating ranker runs in the shadow (`altRank`): on Jerma's stream it puts the approved moped crash #2 where the combined score has it #10. `./clip rankers` compares the two on judged moments; switch with `MOMENT_RANKER=alternate` once one wins on 20+. 257 tests. Next: step 3 (coverage ledger, observe jobs).
- **Spec step 1 and the audit's four fixes (2026-11-19 evening):** viewer-clip refreshes merge by slug and never empty the file (`mergeViewerClips`; ohnePixel's 291k-view moment had lost its clips to an empty page); a pass keeps only the extractor's in-window additions; the YouTube quick path fails a failed stage instead of calling it done, judges streams as streams, uses the 5–60 s rule and checks the submit; `clip analytics` runs daily from the upload scheduler (17 clips with audience numbers on the first run: SypherPK's token clips 1.2–3.6k views, 54–63% stayed to watch); every topic's top 3 each check, listed creators never taking a topic's place (`topicPicks`: League, WoW and Fortnite tracked for the first time); every creator broadcast of the last 48 h (`recentBroadcasts`); `sources` on every stream. 248 tests. Next: spec step 2 (moment matching, shadow ranker).
- **Stream pipeline spec (2026-11-19, user asked for it):** `docs/research/stream-pipeline-spec-2026-11-19.md`. One record per stream whatever found it; VOD time; a coverage ledger of interval sets per stream (observe and clip layers; queued / claimed / done) with one dedupe rule, *wanted − done − claimed, merged into queued*, which covers a partly-queued hour (extended in place) and a partly-running hour (the rest queued from where the claim ends); every topic's top 3 each check, listed creators not counted; a cheap observe pass over every minute and the expensive clip pass on ranked moments; moments matched by region so a moved peak updates the same row (27 duplicate pairs among 516 today); the queue in SQLite with leases and stage checkpoints; 2 workers with a render lock. Migration in six steps (section 11); decisions D1–D6 wait on the user. A second audit (GPT, same day) was checked claim by claim and folded in as section 13: four small fixes come first (viewer-clip refreshes overwrite with an empty page; `passCandidates` trusts extractor additions outside the window; the YouTube quick path records failures as done; no audience analytics collected), moment jobs take a median 26 min (throughput corrected: two workers about 30 approved a day at today's yield; the uploader caps at 72 a day), and Ludwig's c25 framed a VALORANT portrait as his camera.
- **Bad clips, Speed duplicates, the creator list (2026-11-19, user):** three bugs. (1) **Leftover clips:** a moment job's editor was told to clip "every kept candidate without a clip" in the whole stream, so when the moment gave nothing better it shipped an old range-scan leftover from hours away, credited to the moment (TheBurntPeanut's 20k-view moment at 9:01 shipped a 12:23 talk clip). 7 of the 20 moment-job clips were leftovers (4 rejected "boring"); the 12 real moment clips went 7 approved, 2 changes, 3 rejected. Now the curator and editor get only the pass's own candidates (`passCandidates`, `pickForEdit`), the experts get the community's evidence (`momentBrief`; a 25k-view xQc moment had come out "no queues"), and when the curator keeps nothing its best "for the reviewer" candidate is rendered with the concern instead of dying unseen (Kai's 12-clipper moment). The 14 mishandled moments (incl. ohnePixel's 291k-view one) were reset to run again. (2) **iShowSpeed:** a YouTube stream ingested while live has no stable timeline; all three Speed clips (0:26, 1:31, 1:45) were the same live minute. YouTube streams are never read while live now (`youtubeLive`), the watchlist waits for the VOD (cap raised 30 min → 12 h); a 23.8 h Speed VOD is over the cap. (3) **Order:** moments go by hand (`clip track`, ranked at once) → listed creators → topics; the GTA 6 topic streams had been outranking the list. The three streams added by hand in testing were set to the listed-creator tier. Also: the daemon works back to back (was 2 jobs then a 15-minute sleep, about 70 moments a day at most), a restart puts the running job back in line (one restart had marked Kai's best moment failed), and a subscriber-only broadcast found by any step skips the stream once (Typical Gamer's two VODs failed every moment). 246 tests.
- **Consistency scan (2026-11-19):** every `./clip` command and flag named in the docs, skills and pipeline prompts exists, and every path in CLAUDE.md does. Code fixed: `clip intro` no longer adds a second hook next to the editors' `street`/`comment` hook (test added); QA now fails an export over 60 s (the scheduler would refuse it) or under 5 s; the pipeline's retry sends each expert only its own kind's pending queues, and the verifier no longer sends them back a second time; `clip topics` previews with the daemon's inputs (tracked streams, visited, tail); the watchlist lost its blind-segment leftovers and labels a gone broadcast apart from a subscriber-only one; chat "bait" counts as doubt, as in LEXICON. Docs and skills brought in line: caption looks (street/commentary/comic/native, legacy bold/boxed/clean) in PROCESS and `/subtitle-expert`; the hook style and size in `/clip-intro` and `/edit`; hook length per lens (6 stream, 8 talk) in `/clip-extractor`; the moment-first entry in PROCESS, README, `/clip`, `/queue-check`; the upload scheduler and reject reasons in README and `agents/README.md`; `clip tiktok post`/`status` in CLAUDE.md (the stale "Schedule to YouTube (P)" line removed); the backlog re-dated, items 0 and 1 marked superseded, and a new first item: rate what the moment jobs produce. 237 tests.
- **Moment-first watchlist and the tracker (2026-11-19, built):** `clip moments` ranks a broadcast's moments from viewer clips and chat laughter (on ohnePixel it puts the 238k-view moment first, on TheBurntPeanut the 8.4k "banned" one, on Kai Cenat the 5.4k one), `library/tracking.sqlite` records every stream (live/ended/done/skipped with the reason) and every moment (pending → clipped / no-clip / skipped), `clip streams` shows it, `clip track <link>` adds a stream by hand, and the watchlist works one moment per job (each stream's best before anyone's second, at most 4 per stream). The first real check tracked 11 streams and queued xQc's 25k-view moment; ohnePixel, TheBurntPeanut and Kai Cenat were added by hand. The old range jobs are retired when the watchlist restarts (armed to happen when its last range job ends). Next: look at what the first moment jobs produce; then whether a stronger model should make the final pick.
- **Why the automated clips are boring (2026-11-19):** the user rejected 26 of 33 (23 "boring"); 4 of 5 approvals came from the meme expert, most rejects from the story expert (talk, opinions). Measured against what viewers clipped (Twitch viewer clips by views): of the 66 most-viewed viewer clips on the 15 streams the watchlist touched, 29 were in minutes it never scanned (ohnePixel's 120k-view clip, TheBurntPeanut 5.5k, CaseOh 5.2k, Kai Cenat's top 6) and it made a clip of 7. Causes: (1) it scans the newest 20–30 minutes of a stream blind, not where the moments are; (2) in long ranges the experts never reach many queues (Nickmercs: 102 of 224) and the queue score cannot rank them; (3) up to 3 clips per range are made whatever the range holds (a quota, not a bar), so talky moments fill it; (4) cheap-model judging all the way. The manual way that works (the user gives a stream link and asks for clippable moments) is moment-first: the strongest signals across the stream, then a look at the best few. Proposed: a moment-first watchlist (rank a stream's moments by viewer clips and chat laughter, scan and judge only the top few, an evidence bar instead of a quota).
- **Processes and memory (2026-11-18 late):** the Studio's file watcher kept one timer entry per file path ever written (a leak for as long as it ran) and the review page refetched the whole list and restarted its video on every save anywhere (agents save constantly): fixed, pages now batch reloads and the video restarts only for its own clip; a failed list fetch retries instead of hanging on "Loading…". The watchlist retries a job once after a timeout or network error (the Nickmercs 30:37–50:37 range is requeued at the next restart). Daemon memory is small (Studio ~125 MB, the rest 20–35 MB); the Mac itself was swapping (2.9 of 4 GB swap). The YouTube login expired at 23:45 UTC: `./clip auth youtube`.
- **Health sweep (2026-11-18):** fixed: (1) the YouTube login (Testing-mode Google app, 7-day logins) expires 2026-11-18 ~23:45 UTC; the upload cron would have marked every approval failed in turn, it now holds them and resumes after `./clip auth youtube`; (2) the disk is 97% full and the cleanup kept the footage of every stream with an uploaded clip forever; uploaded approvals no longer count; (3) `clip frames <queue id>` made empty `library/clip@…` folders; removed, and it now refuses. Checked and fine: 29 clips in review (exports, QA, credit, titles, lengths, no duplicate moments), 4 uploads public with the credit and no claims, secrets git-ignored, Studio job failures all from before the temp-dir fix. Open: the watchlist runs one job at a time (~1 h each; 8 waiting, the oldest 6 h), and a pipeline stage that times out is not retried (Nickmercs 30:37–50:37 lost its confirmed moments).
- **Edits and captions (2026-11-18):** the user found the edits generic and the subtitles "default options". Ten top streamer-clip Shorts (up to 9.1M views) were studied frame by frame (`docs/research/edits-research-2026-11-18.md`): short italic outlined phrases, a whole phrase in yellow on the beat, action and commentary lines, few cuts, often no captions. New caption looks (street default, commentary, comic, native), matching text styles (action, comment, title), and edit-skill guidance on narrator lines and fewer stacked effects. Next: compare looks on posted clips with `clip analytics`.
- **Upload floor (2026-11-18, user):** an approved 13.6 s clip (SypherPK `tw-2931627858-c13`, "perfect" per the user) sat in Approved because the upload scheduler refused anything under 15 s and the review page did not show it. The scheduler now takes approvals from 5 s up (60 s cap stays), refusals show on the review page with Retry upload, and the clip is up: (link kept out of the repo).
- **Topics (2026-11-18):** the watchlist also follows trending games in `topics.json`: GTA 6 (launching 2026-11-19; 2.8M Twitch viewers, 392k live on YouTube the day before), Fortnite, League, Counter-Strike, Valorant, Minecraft, GTA 5 RP and WoW. For each it takes the biggest English Twitch stream that is not a watched creator and not already scanned, one topic job at a time, alternating with creator jobs (`src/scan/topics.ts`, `clip topics`, `clip topics --suggest --youtube`). YouTube is research only until there is range scanning for YouTube live streams.
- **Layout and reject reasons (2026-11-18):** a review of 36 Twitch renders and 418 expert verdicts (`docs/research/layout-and-detection-review-2026-11-18.md`) found the bad shorts came from the layout, not only the moments. Built: the split sits on a blurred cover of the frame (no black pad); the camera band is sized to the cam panel and cropped into it, never widened into the game or browser beside it; non-game categories (Just Chatting, IRL, websites) show the whole frame under the cam (`content: 'fit'`); facecam detection reads the whole clip; the framed picture is checked before every render (`src/qa/layout.ts`: black bars, a face in the camera band) and a split that fails falls back to blur-fit; the engine owns the layout, not the editor agent. The review page asks why on R (1–5: boring, layout, cut, title, context), counted in `clip stats`. Not built yet from the same report: per-creator layout profiles, the detection changes (chat laughter as a gate and rank, a quieter-chat spike test, an evidence floor before edit). Known gap: another player's face in the camera band passes the check.
- v0.6 is built and tested, and so is the split facecam/gameplay layout. Typecheck passes; `npm test` passed 195 tests then (99 before the agent audit; 237 on 2026-11-19); `npm run test:e2e` passes 3 against real Twitch (re-run 2026-11-14).
- **Agent audit (2026-11-12):** `docs/history/audit.md` has the findings and what is still open. The agents are now defined (`.claude/agents/`, `agents/`), the hand-offs are checked ledgers, and the queue checkers, editors and subtitle engine were fixed. See "Agent audit" below.
- **Model policy (2026-11-14, user):** **no Sonnet.** The session and any subagent use **DeepSeek V4.1 Flash** (`opencode-go/deepseek-v4.1-flash`). Small stages run inline; subagents are for independent, heavy or parallel work and get a written, measured brief: video id, range, kind, exact commands, output format, turn/still budget, stop condition. The Sonnet measurements in `docs/history/audit.md` §6–9 are historical. The new process and target: `docs/history/audit.md` §10.
- **Facecam headroom (2026-11-15, user):** the split cam band now gets `camTopPad` (default 0.04 of the source height) and is top-aligned, so the cover fit no longer cuts the streamer's hat/forehead. Applied in ffmpeg and the Studio; `canvasPad` (default 0.04) also insets the whole split stack top/bottom so the shorter bands widen both boxes for more horizontal FOV; 195 tests. All five HutchMF clips re-rendered; c05's facecam box was widened (`0,0.45 0.25×0.35`) to show the full head in the static poster.
- **Channels list (2026-11-16):** `channels.md` is the living list of target channels — confirmed (penguin0, SypherPK, Nickmercs, NickEh30, Typical Gamer, iShowSpeed, Trash Taste, Ninja, CDawgVA, ExtraEmily, Ludwig, xQc, Joey/The Anime Man), suggestions (Kai Cenat, Jynxzi, CaseOh, xQc, HasanAbi, ExtraEmily, Sketch, TimTheTatman, Ninja, Ludwig, CDawgVA, Misfits, Sidemen, and more), and runs already done. Update status after each run.
- **Trash Taste run (2026-11-16):** YouTube `YKgdD_eBteY` (“Stop Paying Your Taxes”, 1:48), 5 candidates — MrBeast/Joey story, YouTube Shorts rant, airline points, wedding will, Zuckbot — all rendered blur-fit (the active-speaker crop was tried and reverted); 4 keep / 1 review. Preview: `trash-preview.html`; none submitted.
- **Trash Taste post batch (2026-11-16):** the four kept clips `YKgdD_eBteY-c01`–`c04` are being posted through `tools/youtube-drip.sh`; `c05` (review) is excluded. First: (link kept out of the repo), live 08:28:39Z; the next three upload every 10 minutes and go live 5 minutes after each upload. Log: `.cache/youtube-drip-trash.log`.
- **Packaging (2026-11-16):** the on-screen credit is a **source banner** — platform badge + exact handle (`▶ YouTube youtube.com/@TrashTaste`, `🎮 Twitch twitch.tv/hutchmf`), not just a name. The post credit now leads with the full episode/stream at the clip's start, then the channel URL. Trash Taste clips also get a last-2.5 s **FULL EPISODE** end card. A separate **clip-intro** agent can write a 4–8 word premise for the hook text (`./clip intro`) — an optional review pass the user requests, not a step on every clip; it names the host instead of using “he”, and must fit two lines under the banner; titles were cleaned (no repeated show name, one emoji). Applied to the five Trash Taste clips; design and rationale: `packaging-preview.html`; 195 tests.
- **Scheduled YouTube batch (2026-11-15):** 7 clips — HutchMF `tw-2928592128-c03` (kill list) and SypherPK `tw-2926212958-c01`–`c06`, without the discarded `c07`. All uploaded private; YouTube publishes at **19:57:10Z, then every 10 minutes to 20:57:10Z**. Links and times: `scheduled-preview.html`. This batch's uploads were made together; for the requested upload-one-at-a-time cadence use `tools/youtube-drip.sh` (one upload every 10 min, each scheduled +5 min; `--dry-run` and rerun-safe).
- **Second self/DeepSeek run (2026-11-15):** SypherPK VOD `tw-2926212958`, 2:00–2:30, 18 queues. Three DeepSeek experts, 37 turns, **~$0.04** at list; extraction/curation/edit inline. 7 candidates, 4 keep / 3 review; all 7 rendered with split + 4% canvas padding + cam headroom. Preview: `sypher-preview.html`; none submitted. Details: `docs/history/audit.md` §12.
- **First self/DeepSeek run (2026-11-14):** HutchMF `tw-2928592128`, 29:00–49:00, 18 queues. Three DeepSeek experts + one re-check, 44 turns, **~$0.05** at list; extraction, curation and the edit were inline. 5 candidates, **1 keep** (`c02`, 21.3 s, in the review queue) and 4 review; `c03` (the kill-list moment, 32.9 s) is a dry-run preview. Details: `docs/history/audit.md` §11.
- **Sonnet delegation (2026-11-14, historical):** the three experts, `/clip-extractor` and `/clip-curator` ran on Claude Sonnet 5.5 from measured instructions (`docs/history/audit.md`, section 6; `agents/README.md`, "Which model runs what"). On the trial half hour: about $1.40 instead of about $46 at API list prices, the same verdict on every queue, four of five moments. The four trial moments are extracted (`tw-2926144284` `c08`, `c09`, `c11`, `c12`; the engine marks all four `skip`). Superseded by the model policy above.
- **Automated clipper (2026-11-14):** the channel's positioning (see "The idea"). Built in: the `credit` marker on every clip, the credit under every post, `channel.json`, the do-not-clip list, a QA check that fails an uncredited export (`docs/history/audit.md`, section 7).
- **Handover (2026-11-14, historical):** `docs/history/handover.md` is the brief for whoever takes over, written for the Fable/Sonnet session: what happened, the state of the data, the sequence the pipeline was run in, what bites, what is open. Its model note supersedes the Sonnet parts. A second fresh stream was scanned and waiting (ohnePixel `tw-2928608594`, 1:00:00–2:00:00).
- **First coordinated run (Sonnet, historical; 2026-11-14):** ohnePixel `tw-2928608594`, 1:00:00–2:00:00. 27 verdicts (2 confirms), 2 candidates (`c01`, `c02`), both **review** (fit 45/55; `slur` on both, `privacy` on `c02`), no keeps, no submitted clips. A dry-run edit of `c02` rendered 36.4 s, 1080×1920, with the credit and passing QA, but was not submitted. The run found and fixed the live-VOD read (`--live-from-start`) and the mixed-framing filter bug; 193 tests now. Details and the checklist: `docs/history/audit.md`, section 9.
- **Older clips are not retrofitted (user, 2026-11-14):** the 14 clips rendered before the credit existed stay in the review queue as they are and stay unposted (neither publisher takes them). The channel posts fresh clips, made from now on.
- **Whole process on a fresh stream (Sonnet, historical; 2026-11-14):** CaseOh `tw-2927311587`, two half hours, everything delegated on Sonnet: 94 turns, about $4. Three clips are in the review queue (`c06`, `c02`, `c07`); four candidates wait for a decision (`c01`, `c03`, `c04`, `c05`). What it found and changed: `docs/history/audit.md`, section 8.
- **English only for now:** skip non-English streams/clips until there is a translation/caption pass. The two eliasn97 German Icon League clips stay in review but are not posted.
- **YouTube uploads are scheduled by default:** private until the next slot, +5 minutes for the first clip, +10 for the next, +15 after that, measured from the first upload in the batch. `--now` and `--publish-at` override.
- **2026-11-12 upload batch:** five clips scheduled private at 03:08–03:28 UTC (xQc, Peanut yacht, Austin, Cloakzy, weenie); links and state in `docs/history/context.md`. The Ron clip is rendered and QA-passed but the sixth upload was blocked by YouTube `uploadLimitExceeded`; retry after the daily limit resets.
- **Session handoff:** `docs/history/context.md` has the current batch, decisions, blockers and next steps.
- **Daily stream discovery (2026-11-12):** `clip live` is Twitch-only and live-only. For daily top English streams use SullyGnome (`/channels/1/watched?language=en` for past 1 day, `/channels/1/peakviewers?language=en` for peak viewers) and TwitchTracker (`/channels/live?language=english` for live, `/channels/ranking/english` for 30 days). YouTube: Playboard (`/en/chart/live/`, Daily/Weekly/Monthly, peak concurrent viewers) or Streams Charts (cross-platform, paid API with language/date filters). A snapshot of 2026-11-12 00:43 UTC is `library/trending/2026-11-12.json`.
- **Weighted extraction + curation (2026-11-12):** every queue is extracted through `clip windows` (kind-specific start/end weights) and `/clip-extractor` into one candidate per queue; all candidates are scored/ranked, never dropped by score. `/clip-curator` then assigns niche + fit and decides keep/review/drop, recording a `removalWeight` and reason in `library/<videoId>/curation.json`.
- **Nothing is committed:** the repo has no commits and every file is untracked. Commit only when the user asks.
- **Library:** the earlier YouTube videos, plus these Twitch broadcasts:
  - `tw-2921546465`: an xQc broadcast, 1:00–1:15 scanned.
  - `tw-2924308181`: xQc live, 3:27–3:52 scanned over 3 passes, with candidate c01 exported and in review.
  - `tw-2924308181-c01-v2` is a duplicate of c01 using the split layout; it rendered 1080×1920 and passed QA.
  - `tw-2924308181-c02` is a demo candidate (the 50/90-deal beat) made after the split work; the automatic `split` job chose its layout and its export passed QA.
  - `tw-2924946375`: Shiphtur live on MapleStory (still recording at 15:30 GMT), with `c01` rendered in split and `c01-v2` in blur-fit for comparison.
  - `-6PuYw92m1c`: Katt Williams on Diary of a CEO (1h50), ingested and judged with the heuristic judge.
  - `Qc6A28W97zM`: KreekCraft, “Roblox has 5 hours left..” (17:39), ingested and judged with the heuristic judge; c01/c02 rendered.
  - `tw-2925789999`: nickmercs live on Zelda (still recording on 2026-11-11), 3:54–4:06 scanned; heuristic produced 4 recuts, the agent pass 5 candidates (2 post, both rendered and QA'd).
  - `tw-2926082452`: jynxzi live on Rainbow Six Siege (2026-11-11), 32:00–42:00 scanned; 3 candidates (trivia Fleetwood Mac and the stream-pace rant are post; Turkey/Brazil is recut), two rendered and QA'd.
  - `tw-2926035553`: HasanAbi live (2026-11-11), 2:27–2:46 scanned around the Hegseth/Tomb of the Unknown segment. Two `hot-takes` candidates, both post: “ESL problems” and “first day at standing school”; both rendered and QA'd.
  - `tw-2924115677`: eliasn97, The Icon League MD-06 (2026-11-09, 5:45:24, German event). 0:50–1:05 scanned; `small.en` hallucinated on German, so captions are off. Two event clips made from the viewer-clip moments: `c01` DNA Athletics 5-4 celebration/MVP (15 s, blur + hook) and `c02` Eintracht Spandau's carnival entrance (46 s, crop + hook + push-in); both rendered and QA'd.
- **Studio:** usually left running, detached.
  - Restart: `kill $(lsof -ti tcp:4400)`, then `./clip open --no-browser`, with the sandbox disabled.
  - Log: `.cache/studio.log`.

**Agent audit (2026-11-12)**
- **Why:** the process grew to queues → experts → extraction → curation → editors → subtitle expert in a few days, mostly as names in docs/pipeline.md. The audit read every skill and lens against the code, ran the engines on the library, measured what the design assumed, and researched what a virality and a meme expert should know. Full findings: `docs/history/audit.md`.
- **Agents defined:** three queue experts as subagents (`.claude/agents/meme-expert.md`, `virality-expert.md`, `story-expert.md`) sharing `agents/queue-expert.md`; `/queue-check` coordinates them. `agents/README.md` is the cast and contracts, `agents/vocabulary.md` the words, `agents/research.md` the sources.
- **Checked hand-offs:** `clip queue-review` (verdicts: a confirm must cite a frame, a reject a ground) and `clip curate` (a drop needs a ground from the vocabulary, a weight and a reason). `clip vocab` prints the lists both are checked against (`src/core/vocabulary.ts`).
- **Queue checkers rewritten** (`src/scan/queues.ts`): witnesses (chat spike, reaction heard, viewer clips) vs context (speech, title); chat shifted to moment time (measured lag: median 17.5 s); the tuned audio detector instead of raw events; a gate per kind; stable ids (`meme@1:46:25`); coverage reporting; the limit says what it hides.
- **Measured on the library:** chat peaks a median 17.5 s after the reaction it follows (43 cases); 16% of raw audio events are reactions by the tuned thresholds; a viewer clip's offset is an anchor good to one clip length, not its start or end (291 clips). Numbers and method in `agents/research.md` §5.
- **Candidates:** `visual` candidates (no quote, a witness inside) for scares, falls and faces; `kind`/`queueId` kept for the learning loop; `score check:` warnings and a batch note for flat scores; the 300/400 ms buffer now survives the validator; expert risk flags arrive as `risk:` warnings.
- **Editors and captions fixed:** effects land on the punch word and the reaction (they were at fixed fractions of the clip); the pause before a laugh is kept; editors no longer overwrite `review.note` or re-enable captions; the subtitle engine judges only what is inside the clip (it was turning captions off on podcast clips) and never turns captions back on by itself.
- **Docs tied to code:** the talk lenses listed the stream weights and post bar; `test/lenses.test.ts` now fails on drift.
- **Found among the rendered clips:** `tw-2926144284-c01` ("Lacy buys a BMW X6M…") is a prank he admits at 1:38:39; an order-number page is on screen two seconds in and a slur is in the on-screen chat at 0:18. Rendered, not submitted, not posted. Recut and retitle, or drop: the user's call.
- **Trial (Lacy 1:30:00–2:00:00):** the three experts found **5 moments** where the earlier run had 1 (a prank, a confession, banter, a misspeak, and a story with no checker queue that the story expert found by reading on). 21 verdicts, 11 rejects with grounds, every verdict citing frames. Cost: about 1.15M tokens for the half hour. Their notes on the instructions led to a second round of fixes: stale stills, chat read over the whole region, vote detection, `found` moments, whole-range transcription, locks on the ledgers (docs/history/audit.md §3).
- **Written to the library by the audit:** `queue-review.json` for `tw-2926144284`; its candidates' warnings refreshed (6 of 7 draw a `score check:`; only c01 draws risk warnings); c01's QA re-run.
- **Not proven yet:** whether scores now spread (needs a fresh extraction run); whether expert confirms match the user's ratings (calibration set is nine clips); `/edit` after its rewrite.

**In test (2026-11-10): virality ranking**
- Candidates now carry a quality score and the funnel scores (`stop`, `hold`, `share`, `standalone`, `payoff`, `delivery`). A weak stop/standalone/payoff caps the clip; a `stop` more than 3 above `delivery` is capped at 50 (a hook that goes nowhere). The list ranks by **60% virality + 40% signal convergence** (`src/candidates/virality.ts`), with `post` before `recut` before `skip`.
- Shipped with it: updated `lenses/*`, the `/clip` skill and judge prompt, Studio chips and verdict badges, `clip candidates score` for manual corrections, QA warnings for a silent/black/filler/late first word and for ending on a question or transition.
- Test: nine existing clips hand-scored with the new rubric. The first run's top/below-the-line feeds were called a clear improvement (2026-11-10). After adding `delivery`, 3 of the 9 pass `post` (50 Cent/Diddy, Cuban "ruthless", KreekCraft/Black Sea); 6 are `recut`, including the Cuban "money" clip (slow open) and GameCharlie1 (ends on its own question, no payoff). The clips themselves were not recut; only the order and verdicts changed.
- P0 audit fixes: the Studio now sorts and bulk-selects by `verdict` (not raw score); `FeedbackRow` logs `scores`, `virality`, `convergence`, `verdict`, hook, title and platform, and `clip stats` groups by virality/verdict/delivery/platform; the cheat rule no longer caps a 10/7 (delivery 7 clears the post bar); convergence merges caption laughter with audio laughter so one laugh is one witness; `lenses/README.md` defines payoff vs delivery.
- Calibration: a 10-clip reel (`rate-1-to-5.mp4`) with burned-in labels CLIP 01–10. The user's ratings are stored in `library/calibration.json`: `01:5, 02:4, 03:3, 04:5, 05:4, 06:4, 07:5, 08:2, 09:5, 10:4`.
- **The ratings broke the one-size-fits-all model.** On the seven scored talk clips, the old stream weighting was *negatively* correlated with the ratings (Spearman −0.54): the user liked the slow-open Cuban clip and the static-art SmartLess clip that the stream gate had marked recut. Quality score correlated +0.54.
- **Fixed with format-aware scoring:** `podcast-general`/`hot-takes` now use talk weights (`stop` 15%, `hold` 25%, `share` 25%, `standalone` 15%, `payoff` 20%) and tolerate a slow open; `stream-moments` keeps the stop-heavy weights. Talk posts require virality ≥65, delivery ≥4, payoff ≥5 and standalone ≥6. On the nine calibrated clips, the post list went from 3 to 8 and **8 of 9 verdicts match the ratings** (all 4–5s post; the 2 is recut); Pearson 0.70 / Spearman 0.47. The one remaining false positive is Black Sea River (model 76, user 3).
- Also added `clip candidates lens <videoId> <candidateId> <lens>` so a misclassified commentary/video can be moved to the right weights. `Hn0cZBN1JfA` (KreekCraft commentary) is now `podcast-general`.
- Next: log the headless judge in and run a fresh scan with the talk/stream split. The one remaining known miss is the model overrating Black Sea River; collect more ratings before tuning further.

**Per-clip framing pipeline (built 2026-11-11)**
- `renderClip` now cuts the clip from the source in its **original 16:9 format** first (`original.mp4`), then runs facecam detection on that clip, then applies the 9:16 framing to the original clip. The clip is the canonical object; corrections are per clip, not per stream.
- Auto-split detection uses the original clip file (`detectSplit({ file })`), not the whole source section. Verified on a duplicate Nickmercs clip; render/QA pass.
- The facecam box still comes from the face-detection heuristic, so the top-of-head issue remains until we add panel/rectangle detection or a stronger detector. The per-clip structure is the foundation for that.
- **Detector test (Nickmercs, 8 frames):** InsightFace found the face 8/8 on the full 1080p frame (0.64–0.78, ~0.23 s/frame); MediaPipe found 1/8 full-frame but 8/8 on a cropped cam ROI (0.75–0.93, ~0.003 s/frame). MediaPipe needs the ROI, so it was not wired in.
- **Hybrid detector + panel rectangle built:** Vision runs for rectangles and conservative faces; InsightFace fills frames where Vision misses a small/serious face. A stable rectangle near an edge that contains the persistent face becomes the cam panel. On Nickmercs the panel was found exactly (`0.776,0.339 0.213×0.321`), which fixes the head/game-in-band problem; both Nick clips re-rendered and QA'd.
- **Temporal-variance border refinement** (`src/reframe/panel.ts`, idea from `kiy0ni/auto-video-editor`, MIT): sample 24 frames, compute per-pixel variance, snap each panel border where the webcam room differs from the game/desktop. This handles **borderless** overlays: Hasan's cam snapped from `0.717,0.755 0.223×0.245` to `0.642,0.640 0.294×0.360`, showing the full panel/head instead of cutting the top. Re-rendered and QA passed.
- **99 tests** pass, including “a detected webcam panel wins over the face-grown box.” Manual box editing remains the guarantee when variance is ambiguous.

**Event streams (Icon League, 2026-11-12)**
- **`clip make <videoId> <candidateId> --no-split`** keeps a Twitch clip in blur/crop instead of enqueueing the automatic facecam search. Event broadcasts (sports, award shows, IRL) have no gameplay facecam; the commentary box is a tiny overlay, not a layout.
- **`CLIP_WHISPER_MODEL=small ./clip transcript <id> --from … --to …`** transcribes a window with the multilingual model. The default `small.en` **translates German to English** (it does not leave it as German), which is fine for judging but not for German captions. Windowed transcriptions merge into `transcript.json`; the small model is 488 MB.
- **Twitch viewer-clip `offsetMs` points at the end of the clip, not its start.** The clip file is the reliable content; the offset is the creator's moment. A 16 s "tor" clip can be the celebration and MVP presentation, not the goal. Pull frames around the offset before cutting.
- **Nine-minute clip search:** the viewer-clip title is the fastest signal, then frames every 2–4 s; the transcript is useless for music/crowd moments. `clip frames` stills are the right tool.
- **eliasn97 output:** `c01` (15 s, blur, hook “DNA WIN 5-4”) and `c02` (46 s, crop, hook + push-in). German commentary stays uncaptioned; the visuals and crowd carry them. Both QA-pass and are in review, but **not posted: English-only for now.**
- **Not built:** a proper "event" format that starts from viewer clips and skips the transcript/sentence snapping. The current workaround is to add a candidate with an English quote from the windowed transcript, or write `candidates.json` by hand.

**Full-VOD queues + editors (2026-11-12)**
- **Three queue checkers** (`src/scan/queues.ts`, `./clip queues <id> --from … --to … --kind meme|viral|clip|all`): each reads chat velocity/mood, audio screams/laughs, viewer clips/views, speech rate/transcript, title words and laughter, then emits a short window with evidence, context and risks. Meme weights laughs/chat and short windows; viral weights viewer clips/emotion; clip weights speech/story. They are deterministic and fast, so every segment of a VOD can be checked by all three.
- **Two editors** (`src/edit/editors.ts`, `./clip editors <id> [--meme] [--expert] [--review] [--accept]`): the meme editor proposes hook text, punch-ins, emoji, flash, dead-air cuts, speed and captions; the expert editor proposes intro trims, dead-air cuts, a context hook, captions, ending fixes and a subtle push-in. They write proposed markers into the clip by default (`source: editor:meme` / `editor:expert`); `--review` is read-only, `--accept` commits them. Re-running replaces that editor's previous pass, and the two passes de-duplicate overlapping dead-air cuts. Both score the clip 0–100 and list risks.
- **TheBurntPeanut comparison (single VOD):**
  - Old last-15-min window: 1 clip (yacht heist).
  - Full-VOD viewer-clip map + 3 segment agents → 9 queues, 4 clips: yacht heist, undercover Austin, Cloakzy hates veterans, weenie dog. The agents flagged the TOS/crude/UI-only risks and ranked the queue types differently.
  - Queue extraction is seconds; the 7 queue-window scans took ~2 min; renders ~2 min each. The extra time buys coverage and context, not just more clips.
- **Caveat:** scanning a live VOD from 0:00 hangs on Twitch audio, so the pass uses the full-VOD viewer-clip map plus targeted segment scans. Times over 59 minutes must be written `h:mm:ss` (`1:59:30`, not `119:30`).

**Viral titles + subtitle expert (2026-11-12)**
- **Title research:** sampled 215 recent English Shorts and 100+ titles from the exact clip channels around xQc, Jynxzi, Hasan, TheBurntPeanut, stableRonaldo and Cloakzy. The repeatable pattern: short community name first (`Peanut`, `Ron`, `xQc`, `Jynxzi`), a present/past-tense action, one all-caps word, 1–2 reaction emojis at the end, under ~60 characters, no colon. Curiosity gaps (“No way…”, “…went WRONG”, “Someone’s getting cancelled…”) and quotes also work. Official Hasan Shorts use ultra-short reactions (“FINALLY 😭”, “OMG 😭”, “ITS OVER 😭”).
- **New `suggestTitles`:** five options — bold name + action (default), quoted spoken line, curiosity (“No way …”), chat-aware (“The chat knew EXACTLY…”) and the old searchable context. It shortens TheBurntPeanut → Peanut and stableRonaldo → Ron, changes tense, uppercases one word, picks an emoji from the mood, and drops colons.
- **Editors now write into the clip:** `./clip editors <id>` adds the meme/expert suggestions as proposed markers by default (`--review` is read-only). The two passes de-duplicate overlapping dead-air cuts.
- **Subtitle expert:** `./clip subtitles <id>` reviews/applys captions: on/off (no speech, music/crowd, burned-in captions, non-English, text-heavy, unreliable transcript), style/position (bold gaming, boxed busy, clean talk; y 0.68–0.74, never over facecam/scoreboard/chat), and word fixes. It deliberately **does not auto-hide** intentional repetition (“swim swim swim”) or auto-censor profanity; those are flagged for the expert. Skill: `.claude/skills/subtitle-expert/SKILL.md`.
- **TheBurntPeanut examples:** `<Name>'s <plan> went WRONG 💀`, `His name is LITERALLY <name> 💀`, `<Name> HATES <group>? 💀`, `It ISN'T what you think 😭` (the patterns; the posted titles are kept out of the repo).

**Weighted extraction + curation (2026-11-12)**
- **`./clip windows <videoId> --from … --to … --kind …`** scores candidate start/end windows around every queue. Every clip is **15–60 s**; the extractor decides short vs long. The queue kind changes the weights: meme favors a tight reaction, viral the peak plus reaction, clip the setup sentence through the payoff. Components: duration fit, peak position, hook speed, sentence ending, laugh/scream/viewer-clip payoff, sentence boundaries, setup/context, muted overlap. Extraction adds a **300 ms before / 400 ms after buffer** that is part of the clip. Output: top windows with score, quote and why.
- **Extraction agent** (`/clip-extractor`): reads the queue + weighted windows, checks transcript/frames, picks the best window and adds **one candidate per queue**. It does not drop low scores; it only rejects invalid windows (under 15s, quote not in transcript, muted/sponsor). Every queue becomes a scored/ranked candidate.
- **Curation agent** (`/clip-curator`): reviews the whole ranked field, assigns a niche (meme/viral/clip-story/talk/gaming/IRL) and niche fit 0–100, then `keep` / `review` / `drop`. A drop requires no niche + no standalone use (or duplicate/muted/broken/TOS) and records a `removalWeight` 0–100 + reason in `library/<videoId>/curation.json`. Low score alone never drops a clip. Only keep/review proceed to editing.
- The process is written end-to-end in `docs/pipeline.md`; the skills are `.claude/skills/clip-extractor/SKILL.md` and `.claude/skills/clip-curator/SKILL.md`.

**TikTok inbox upload (2026-11-12)**
- `./clip tiktok auth` connects a creator with desktop Login Kit + PKCE; `./clip tiktok upload <clipId>` sends the export to the TikTok inbox as a draft (scope `video.upload`), and the user finishes the post in TikTok. This avoids the unaudited Direct Post restriction (private/SELF_ONLY only); public auto-post needs TikTok's Content Posting API audit + `video.publish`.
- Setup: TikTok developer app → Login Kit + Content Posting API (Upload) → Desktop redirect `http://localhost:8080/tiktok/callback/` → save client key/secret in `tiktok_secrets.json` (example: `tiktok_secrets.example.json`).
- Tokens last 2h; refresh tokens last 180 days and rotate on every refresh. Inbox uploads are capped at 5 pending shares per 24h.

**YouTube publisher (built 2026-11-11)**
- `src/publish/youtube.ts`: OAuth loopback flow, token refresh, resumable `videos.insert`, title/description/tags, `publishAt`, and an idempotent `exports/<clip>.publish.json`.
- Commands: `./clip auth youtube`, `./clip publish <clipId> [--publish-at ISO] [--now] [--privacy …] [--force]`. **Default is scheduled:** the upload is private until the next slot, +5 minutes for the first clip, +10 for the next, +15 after that, measured from the first upload in the batch. `--now` uploads immediately; `--publish-at` sets an exact time. The Studio **Schedule to YouTube (P)** uses the same default. `nextPublishSlot()` reads future `publishAt` records in `exports/*.publish.json`; schedules more than 2 hours out are ignored so a new batch restarts at +5.
- Studio: the review page has **Schedule to YouTube (P)**. It uploads private for the next 5-minute slot, then marks the clip approved and shows the link and go-live time.
- **Default scheduling (2026-11-12):** `publishYoutube` computes `publishAt` with `nextPublishSlot()` unless `--now` or an explicit `--publish-at` is given. The first upload is +5 minutes, each next one +5 after that (5/10/15…), measured from the first upload in the batch. Pending times come from `exports/*.publish.json`; schedules more than 2 hours out are ignored so a new batch restarts at +5. Scheduled uploads are private until YouTube flips them; the record keeps `publishAt`.
- Gate: only `verdict === 'post'` + passing QA, unless `--force`.
- Setup: Google Cloud project → enable YouTube Data API v3 → OAuth client (Desktop app, or Web app with `http://localhost:8080/oauth2callback`) → save the JSON as `client_secrets.json`. Check the project's Video Uploads quota and whether unverified uploads land private.
- **Token refresh is automatic** (verified by forcing expiry): `youtubeAccessToken()` uses the stored refresh token and rewrites `.cache/youtube-token.json`. A Testing-mode OAuth app still expires refresh tokens after 7 days; publish the app or re-auth weekly.
- **Subscribe quick effect:** the Inspector has **🔔 Subscribe** — a 3 s, 38 px text pill near the bottom with a fade. It uses the existing `text` marker, so it is editable like any other text.
- Upload settings: lens-based category (Gaming 20 / People & Blogs 22 / Entertainment 24), standard license, embeddable/public stats on, synthetic media off, English language, subscriber notifications off, `publishAt` validated and forced private.
- **Reach metadata:** official Creator Insider says Shorts-feed views don't depend on titles/hashtags; they are “frosting, not cake.” Titles/descriptions still help search, suggested and channel-page clicks. `clip post` now offers 3 title options (event, spoken line, context), a context-first description and 3–5 hashtags; the publisher sends no tags. YouTube: 3 hashtags show by the title, >60 are ignored, misleading/unrelated hashtags can get a video removed; tags play a minimal role.
- **Analytics:** `clip analytics [--days 28]` pulls published-clip metrics into `performance.jsonl`: views, engagedViews, averageViewDuration, averageViewPercentage, likes, comments, shares, subscribersGained. `outcome` = 40% engaged-view rate + 30% average view % + 20% shares + 10% subscribers; `clip stats` shows median outcome and Spearman calibration against virality/quality/signal. The public API has no exact “stayed to watch”; `engagedViews / views` is the proxy. Needs the `yt-analytics.readonly` scope (re-run `./clip auth youtube`).
- Not built yet: the one-command “popular stream → scan → judge → review” flow, playlists/thumbnails, Reels, and TikTok Direct Post (the inbox draft upload is built; public auto-post needs the TikTok audit).

**Heuristic judge (experimental, parked 2026-11-11)**
- **Decision:** use the **in-session agent** as the judge for now. The heuristic works as a shortlist but not as a final editor; it stays available for experiments (`--provider heuristic`, `CLIP_JUDGE=heuristic`) and is no longer the default. Headless Claude login is deferred.
- **Built:** `src/judge/heuristic.ts` turns discovery seeds into candidates with no LLM. It finds the setup before the seed peak, snaps to transcript lines, writes title/hook/quote/reason, and scores the full funnel from signals + word features. `./clip judge <videoId> --provider heuristic`; `CLIP_JUDGE=heuristic` makes scan/watch/batch use it. No login, no network, under a second.
- **Tested on two new sources:**
  - Katt Williams, Diary of a CEO (`-6PuYw92m1c`, 1h50): 20 seeds → 6 candidates. It found the cold-open/teaser moments, but titles are mid-sentence fragments ("it was necessary that I do a better acting job").
  - KreekCraft, "Roblox has 5 hours left.." (`Qc6A28W97zM`, 17:39): 8 seeds → 8 candidates. It found the two comment-heavy moments (46 comments at 7:03, 36 at 8:10). Both rendered and passed QA.
- **The limitation is clear:** it reads signals and text, not frames. The two Kreek clips open on documents/charts instead of the face; the Katt title/hook is not copy you'd post. It is a useful **shortlist**, not a final editor.
- **Single-stream head-to-head** (nickmercs, Zelda, `tw-2925789999`, 3:54–4:06):
  - Heuristic: 8 attempts → **4 accepted**, 4 rejected; all 4 `recut` (viral 36–39), **0 post**. It found the 12K/Zelda line, the nostalgia beat and the Saria answer, but its cuts started on weak lines and its titles were fragments.
  - Agent judge (same seeds): 5 attempts → **5 accepted**, **2 post** (the 12K line, the nostalgia beat), 3 recut. It also found the “Big Link” bit the heuristic missed. Both post clips rendered and passed QA (the 12K cut has a “first word at 1.8 s” hook warning; the nostalgia cut ends on a question).
  - Same stream, same signals: **heuristic 4/4 recut vs agent 2/5 post**. Heuristic is a candidate finder; the packaging/visual judgment is still the gap.
- **Next for it:** a first-frame face/motion check (so a document screen lowers `stop`), and a small local/API copy model if we want postable titles/hooks without Claude. Otherwise use it to shortlist and edit in the Studio.

## 2026-11-10: v0.6, Twitch and live streams

#### v0.6 build notes (2026-11-10)

**Built**
- **Sources** (`src/ingest/source.ts`):
  - YouTube ids stay as they are; Twitch broadcasts are `tw-<vod>`.
  - Channel links, bare names (`xqc`, `@xqc`), clip links (scan around the clip) and `?t=` start times are understood.
- **Twitch web API** (`src/ingest/twitch.ts`): broadcast details and live state, muted (copyrighted-music) stretches, chat replay, viewer clips with exact positions, a channel's newest broadcast.
  - Chat replay pages **by time offset only**: cursor paging fails with "failed integrity check" (it needs a browser token).
- **Signals:**
  - `chat`: distinct chatters per 10 s against a trailing 5-minute median; a spike is ≥ 2.2× with ≥ 6 chatters; the moment is taken as the 25 s before the spike; reaction type and "clip it" requests are recorded.
  - `clips`: viewer clips weighted by views.
  - Muted stretches are excluded like sponsor reads.
- **Partial data** recorded as ranges:
  - Audio comes in chunks (`library/<id>/audio/<start>_<end>.m4a`), and audio events are merged per chunk.
  - The transcript grows window by window (`covered`; caption fixes are remapped on each merge).
  - `clip transcript` on a stream transcribes the window first.
- **Scans** (`src/scan/`):
  - `planPass`: 2 min of overlap, 3 min live-edge margin, at least 1 min new on a live stream.
  - `runPass`: chat → viewer clips → audio → seeds → Whisper around the top 25 → seeds again.
  - `scan.json` records passes; a lock stops two scans of one video at once.
  - `clip scan`, `clip watch`, `clip chat`; a `scan` job; the Studio's stream panel; Twitch links and channels in batches.
- **Tests:** `npm test` (35 offline tests, about 1 s, including a simulated live stream) and `npm run test:e2e` (real Twitch).

**Found and fixed while testing**
- `fmtTime` printed 1:06:59.97 as "1:06:00.0", a minute early. This affected every transcript the judge read.
- A seed window reaching before a pass needed audio from two chunks, and Whisper read only one.
- The first chat client treated Twitch's integrity refusal as "chat turned off".
- `v2921546465` (11 characters) was read as a YouTube id.
- `clip watch xqc` didn't accept a bare channel name.
- **Twitch video sections weren't where the tool assumed:** one started 6.6 s early, another 0.74 s late. A clip exported from the first played 6.6 s early.
  - Each Twitch section's start is now measured against exact audio (`src/ingest/align.ts`): within 10 ms on the re-rendered clip.
  - Section requests get 10 s of lead so a late cut still covers the range.
- **A raid** (another channel's viewers arriving) looked like a hype moment. It's now flagged and barely counts.
- **An auto-clipping bot's clips** ("Viewer signal… Chat burst 1.4x", 1 view) counted as viewer clips. They're now dropped (by title, a `bot` name, or one account clipping constantly for nobody).
- An open Studio page didn't update when scan.json changed: the watcher chip went stale.
- A judge failure after a Studio scan wasn't shown, and its hint pointed at `batch-continue`.
- Stopping `clip watch` mid-pass left its lock behind; it now removes it.

**Tested live** (xQc, 2026-11-10; the broadcast was still recording):
- `clip watch xqc --every 3m --no-judge`: pass 1 3:27:10–3:39:10 (87 s, 5 seeds); a pass 3 minutes later 3:37:10–3:43:37 (41 s, 2 seeds); then a Studio **Scan new part**, 3:41:37–3:52:53 (6 seeds).
- I judged pass 1 by hand: one candidate. It was exported as is, from a section downloaded off the live broadcast: 1080p60 source, render 1.5× clip length, QA passed at −14.3 LUFS, placed in the review queue.

#### Split facecam/gameplay layout (built 2026-11-10)

**Built**
- **Framing mode `split`** (`FramingSchema` in `src/core/schemas.ts`): `split.cam` and `split.game` boxes in 0–1 source coordinates and `split.camShare` (the facecam band's fraction of the 9:16 height, default 0.35).
- **Renderer** (`src/render/framing.ts`, pure and tested): crop each box, scale it to cover its band, `vstack` the facecam (672 px) over the gameplay (1248 px). Blur, crop and split branches can be mixed with `enable` expressions, so a `reframe` marker can switch between them mid-clip.
- **Preview** (`src/composition/FramedVideo.tsx`): two CSS-cropped video layers with the same box math; the cam layer is muted so audio plays once. Checked in the Studio: the cam band is 672 px in 1080-space and both layer crops match ffmpeg.
- **Auto-detection** (`src/reframe/cam.ts`, `src/reframe/split.ts`):
  - A facecam is a face that keeps returning in the same region near a frame edge; a centred talking-head close-up is rejected.
  - The cam box grows the face 4.2× wide and 2.6× tall with 10% headroom, capped at 0.5 × 0.45 of the frame and snapped to the border. The game box is the largest window of the gameplay band's aspect that avoids the cam.
  - New Twitch clips get `autoSplit` and a high-priority `split` job; `renderClip` also resolves a pending one before cutting. A whole-clip `clip reframe` on Twitch uses the split layout when a cam is found; a selected range still uses crop-follows-faces.
- **Studio:** the Framing select has `split`, a **Find facecam** button, a facecam-band slider and a 16:9 source map where both boxes can be dragged and resized.
- **CLI:** `clip split <clipId>`; `clip reframe` says when it used the split layout.

**Verified**
- Duplicated `tw-2924308181-c01` to `…-c01-v2`, ran `clip split`: cam `0.00,0.354 0.185×0.204`, game `0.26,0 0.49×1`, band 35%. The face sample came from the real xQc webcam (face at `0.108,0.373 0.047×0.078`), and the box lands on the panel (about 0.2 × 0.2 of the 1920×1080 frame).
- `./clip render tw-2924308181-c01-v2`: 1080×1920, 11.2 Mbps, 96.3 s for 44.3 s (1.88×), QA passed at −14.3 LUFS. Frames at 2 s and 20 s show xQc on top and gameplay below, with captions over the gameplay.
- **Automatic path:** added a demo candidate (`c02`, the 50/90-deal beat, 19.5 s) and ran `clip make`. The `split` job ran by itself (2.6 s), set cam `0.00,0.354 0.192×0.211` and game `0.26,0 0.49×1`; no manual step. `./clip render tw-2924308181-c02` → 1080×1920, 11.1 Mbps, 45.7 s for 19.5 s (1.97×), QA passed at −14.9 LUFS.
- Studio preview for c02: framing is `split` and the two layers measure exactly 672 and 1248 px in 1080-space, matching the render. A box overlay on the source frame shows the yellow cam box on the webcam panel and the cyan game box on the gameplay.
- **Live test** (`tw-2924946375`, Shiphtur on MapleStory): picked a 38 s window (13:44–14:22) 3 minutes behind the live edge while the broadcast was `RECORDING`. `clip render` downloaded the section, found the cam on its own (`0.00,0.331 0.231×0.254`, game `0.26,0 0.49×1`) and rendered 1080×1920 in 142.8 s for 38 s (1.66×); QA passed at −14.0 LUFS. A blur-fit duplicate of the same window (72.2 s) gives a side-by-side comparison.
- **Fallback checked:** the first live pick (Kai Cenat's broadcast) was an IRL bathroom shot with no facecam. Detection found nothing, cleared `autoSplit` and left the clip in blur-fit, which is the intended behaviour.
- `npm test`: 49 pass, including `test/framing.test.ts` (split/blur/crop filter strings, span switching, corner and bottom-right cams, a close-up rejected, a single sighting rejected, the real xQc face).

**Limits**
- The cam panel is estimated from the face box, not the panel border. The Studio boxes are the fix when it's off. If the top of the head is clipped, drag the cam box up (or lower `split.cam.y`); the face box excludes hair, so some cams need more headroom than the default 10%.
- A `reframe` span that switches *to* split from a blur/crop base reuses the clip's split boxes. They're the default unless the user has set the base to split once, so the span action is best used from a split clip.

#### v0.6 plan: Twitch and live streams (researched 2026-11-07; built 2026-11-10, see the build notes above)

**What the user asked for**
- Clip from Twitch and other live streams.
- Pick a range ("from 1:00:00 onwards") and scan up to the live edge.
- Later, scan again from where the last pass stopped.

**How other clippers find moments** (vendor claims, mostly unverified)
- **Chat speed** against the channel's normal level: messages per 10 s against a rolling baseline, with the clip starting about 30 s before the spike because chat reacts late.
- **Emotes and words:** floods of LUL/KEKW (funny), Pog (hype), "Cooked", "?" spam, "clip it".
- **Audio spikes:** yelling and laughter (Eklipse, Powder).
- **Viewer-made clips** (Medal, StreamLadder).
- **Open-source examples:** clippy (5 s and 30 s windows, adaptive 1.5–2.5× threshold, 30 s debounce, Claude Haiku labels the last 50 messages), TwitchHighlightDetector, twitch-highlight-finder, and a moving-average chat-rate bot.
- **Twitch's own auto clips** reportedly launched mid-2026, so plain chat-spike clipping is becoming a free platform feature. Our edge is the judge reading the transcript, the editing, and review.

**Checked on a real xQc past broadcast** (`v2921546465`, 10.4 h, 2026-11-07)

| Data | Result |
|---|---|
| Listing past broadcasts | Works: `yt-dlp --flat-playlist -J "https://www.twitch.tv/<channel>/videos?filter=archives&sort=time"` |
| Metadata | Works. `chapters` are game changes (Just Chatting at 0:00, GTA V at 37:32) |
| Formats | Audio_Only plus 160p–1080p60, all HLS |
| Captions | **None** (`subtitles` and `automatic_captions` are both empty), so Whisper is needed |
| Section downloads | **Fast:** `--download-sections "*3600-3620" -f 720p60` took 6 s for 10.5 MB. Full broadcasts are 10–20 GB, so sections are essential |
| Viewer clips | Work: `https://www.twitch.tv/<channel>/clips?filter=clips&range=7d` lists clips with `view_count`, `duration` and `timestamp` (creation time) |
| Clip position in the broadcast | Not given by yt-dlp. Estimate it as clip creation time − stream start − clip length. Twitch's Helix API gives the exact `vod_offset`, but needs the user's own free developer app keys |
| Chat replay | **Works without login:** one request to Twitch's web API (see below) returned 54 messages at 1:00:00 |

The chat request was a POST to `gql.twitch.tv/gql` with:
- the public web Client-ID `kimne78kx3ncx6brgo4mv6wki5h1ko` (the one yt-dlp uses),
- operation `VideoCommentsByOffsetOrCursor`,
- persisted-query hash `b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a`.

The page is paged by cursor.

**Layout:** a facecam in a corner, a chat overlay on the left, and gameplay filling the frame. A single 9:16 crop cuts off either the face or the game.

**Blocked in agent sessions:** the auto-mode permission checker blocked installing `chat-downloader` (pip) and a second Twitch API request. The user may need to allow those requests, or use Twitch's official API with their own app keys.

**Phase 1: Twitch past broadcasts**
1. **Source type** in ingest: YouTube, Twitch or Kick.
   - Today `parseVideoId` (src/ingest/ingest.ts) only accepts 11-character YouTube ids.
   - `watchUrl` is hard-coded in ingest.ts, frames.ts and jobs/downloads.ts.
   - Ids would be prefixed, e.g. `tw-2921546465`.
2. **Chat signal** (`src/discover/signals/chat.ts`).
   - Messages per 10 s against a rolling median or moving average, shifted 5–20 s earlier.
   - Weight the reaction type (emote families, "clip it", "?" spam); ignore sub trains and bits.
   - Store the chat in `library/<id>/chat.json`.
3. **Viewer-clips signal:** where viewers clipped, weighted by views (the Twitch equivalent of "Most Replayed").
4. **Windowed Whisper:** transcribe only ±90 s around the strongest 20–25 seeds, about 9 min instead of about 75 min for 10 h.
   - The transcript then has gaps, so the transcript, captions and judge must handle partial coverage.
5. **Split layout:** facecam box on top, gameplay box below.
   - A new framing mode, or a marker type with two crop rectangles.
   - Find the facecam with the face tracker; let the user drag both boxes in the editor.
   - Change the ffmpeg `framingFilter` and the CSS `FramedVideo` together.
6. **The stream-moments lens** gets chat context: the judge sees the chat around each seed.
7. **Retention:** Twitch typically keeps past broadcasts for 7 days (60 for Partners), so batch runs should pick them up quickly.

**Range scans and repeat passes** (the user's request; works for YouTube streams too)
- **Commands:**
  - `/clip <url> --from 1:00:00`: scan 1:00:00 up to now.
  - `/clip <url> --continue`: scan from where the last pass stopped.
  - `clip watch <channel> --from 1:00:00 --every 15m`: run passes by itself until the stream ends.
- **Each pass:**
  1. Re-reads the length; a live past broadcast keeps growing.
  2. Fetches chat and viewer clips for the new stretch.
  3. Picks seeds, transcribes only those windows, judges, and appends candidates.
  4. Records the scanned range in `library/<id>/scan.json`.
- **Overlap:** start each pass about 2 min before the last one ended; the duplicate check drops repeats.
- **Live-edge margin:** stop about 3 min short of the live edge, because chat reacts late and the payoff may not have happened yet.
- **Chat baseline:** the first pass also looks at about 30 min before `--from`, so it knows what normal chat speed is.
- **Studio:** the video page shows "scanned 1:00:00–2:41:10 · next pass in 12 min".
- **Estimates (not measured):** a 15-minute pass takes about 2–3 min, so a moment reaches the candidates about 5–20 min after it happens.
- **Not tested:** downloading sections of a broadcast while the stream is still live.
- **Live chat during a stream:** Twitch IRC with an anonymous read-only nick (`justinfan…`) needs no credentials.

**Open questions for v0.6**
- Is it OK for the tool to call Twitch's web API with the public Client-ID, or should we require the user's own Twitch developer app (official, gives exact clip offsets)?
- Whose streams? Posting other streamers' clips depends on their permission.

**Sources:**
- Opus chat-spike guide: https://www.opus.pro/mcp/inspiration/clip-the-moments-your-live-chat-exploded
- Eklipse, how it clips: https://eklipse.gg/help/how-does-eklipse-automatically-create-clips/
- Powder: https://techcrunch.com/2023/11/20/powder-an-ai-clipping-tool-for-gaming-can-detect-when-a-creator-yells-during-a-stream
- clippy: https://github.com/hamzaskewl/clippy
- TwitchHighlightDetector: https://github.com/yakiya51/TwitchHighlightDetector
- chat-downloader: https://github.com/xenova/chat-downloader
- Helix get-clips: https://twitch4j.github.io/rest-helix/clips-get
- Twitch auto clips: https://streamchatai.com/blog/twitchs-new-ai-stream-summaries-and-auto-clips-what-they-actually-mean-for-your-channel

## 2026-11-06: v0.1 to v0.5

### v0.1 — "One link → one edited short"

#### Deliverables

1. **`clip ingest <url>`** fetches metadata, captions, the heatmap, chapters, about 1,000 top comments and SponsorBlock segments. It then downloads an H.264/AAC MP4 (up to 1080p) in the background. Captions are normalised into `transcript.json` (words with millisecond timings) and a compact `transcript.md` (timestamped sentences) for the agent to read.
2. **`clip discover <videoId>`** runs the v0.1 signals and writes seed windows to `signals.json`. The signals are heatmap peaks, timestamped comments, caption tags, cold-open teaser matches, speech rate and chapters. Each seed records which signals fired and how strongly. Seeds drop intro and sponsor artifacts, merge with overlapping neighbours and get context padding. Discovery works when any one signal is missing.
3. **The `/clip <youtube-url>` skill** runs ingest and discover, reads the transcript and seeds through a lens (starting with `podcast-general`) and writes 5–15 candidates via `clip candidates add`. Each candidate is validated: it must sit inside the video, last 15–90 s and start on a sentence. The skill then starts the Studio and gives you the link.
4. **Studio** (a local web app started with `clip studio`) has two parts:
   - A **candidate list** for each video, with the heatmap strip and candidate ranges drawn over it. Click a candidate to preview it, then choose **Make clip** or **Skip**.
   - An **editor** with a 9:16 preview player, a timeline (in/out handles, caption track and marker lane) and an inspector for the selected marker.
   - Keyboard first: Space plays, I/O set in/out, M drops a marker at the playhead, 1–9 pick its type, arrows nudge by one frame, Delete removes, ⌘Z / ⇧⌘Z undo and redo.
5. **Marker types** (all real and rendered):
   - `zoom`, a span: scale, easing and focus point.
   - `shake`, a span: intensity.
   - `flash`, a point: colour and length.
   - `sfx`, a point: a sound from `assets/sfx/` and its volume.
   - `text`, a span: text, position and style.
   - Plus two clip-level settings. **Captions** come automatically from the transcript, with word highlighting, style and position. Click a word to fix it, because auto-captions mishear: in testing, the punchline "shooters" was captioned as "shelters", while the comments quoting it had it right. **Framing** is blur-fit, centre crop, or crop with a manual x offset.
6. **Presets.** Save a clip's markers, caption style and framing as a named preset, then apply it to another clip, with markers placed relative to the clip's start and end.
7. **`clip render <clipId>`** writes a 1080×1920 H.264/AAC MP4 to `exports/`. The Export button runs the same command.
8. **CLI parity for edits.** `clip marker types | list | add | update | rm` are all validated against each marker's schema, so the agent can fully edit a clip without the UI.
9. **Marker template.** `markers/_template/` plus a short `markers/README.md`, so adding a type is copy, rename, edit.

#### Done when

- A link with no heatmap still produces candidates. Each candidate shows which signals backed it (comments, laughter, teaser, heatmap) next to the judge's reason.
- You can open a candidate; add a zoom, a boom, a flash and hook text; turn captions on; set blur-fit; and export a 9:16 MP4. In that export the SFX lands on the right frame and captions stay in sync to the end.
- Closing and reopening the project shows identical edits.
- A marker the agent adds through the CLI shows up in the Studio.
- A new marker type made from the template appears in the palette and renders, with no changes to editor code.
- Rendering a ~45 s clip on this M1 is timed and recorded, as the baseline for the 100/day goal.

#### v0.1 build notes (2026-11-06)

Tested on Flagrant ft. 50 Cent (1 h 57 m, no Most Replayed graph).

**Results against "Done when"**

| Check | Result |
|---|---|
| A link with no heatmap still produces candidates | Yes. Ingest took 29 s and discover 0.4 s. The judge proposed 9 candidates, the validator accepted all 9, and each shows its comment, laughter and speech signals |
| Zoom, boom, flash, hook text, captions and blur-fit export with the SFX on the right frame | Yes. The boom starts at 37.50 s into the export, and the marker sits at +37.51 s |
| Captions stay in sync to the end | Checked by eye on frames across the whole clip |
| Reopening shows identical edits | Yes. Every edit autosaves to `project.json`, and a reload restores it |
| A marker added by the agent through the CLI shows up in the Studio | Yes, live, about 1 s later. The Studio watches `clips/` |
| A new marker type from the template appears and renders, with no editor changes | Yes. `markers/tint` was copied from `_template`, showed up as palette key 6 and rendered in the export |
| A ~45 s render is timed and recorded | 55 s clip: 95–113 s in total, 1.5–1.8× the clip length (slower with the Studio open). Each export writes `exports/<clip>.json` |

**Changes from the plan**
- **Timeline:** a custom one instead of react-timeline-editor and wavesurfer.js.
  - Point markers and source-time snapping fit a custom lane better.
  - The waveform comes from ffmpeg peaks, so the browser never decodes 2 h of audio.
- **Rendering:**
  - The renderer frames the video (blur-fit or crop) in ffmpeg and sends Chrome one 1080×1920 video. The Studio still does the same framing live in CSS.
  - With 4 video-decode threads and VideoToolbox encoding, render time dropped from 4.7× to 1.5× the clip length.
  - On macOS 26, Remotion's Chrome Headless Shell crashes in its GPU process, so `bin/headless-shell` runs it with in-process GPU.
- **Caption warnings:** the validator compares the most-liked comments in a clip with its captions. It flagged "shelters" → "shooters" and "coign" → "cosign" automatically.
- **Open questions:** defaults used until you say otherwise:
  - Talking content first.
  - Claude Code as the judge.
  - Solo Remotion licence.
  - Four generated placeholder SFX in `assets/sfx/` (boom, whoosh, ding, pop).

#### Not in v0.1 (on purpose)

- Cuts inside a clip, freeze frames, speed ramps, and crossfade or whip transitions between shots.
- Whisper transcripts, and signals that need audio or video analysis.
- Automatic face-tracking reframe.
- Agent auto-editing and the review queue.
- Batch ingest, the job queue and QA checks.
- Uploading or publishing.

#### Second test run: `/clip` and `/edit` as a user would (2026-11-06)

Fresh videos: SmartLess with Linda Cardellini (58 min, conversation) and a 12-minute KreekCraft commentary video. The run turned up these bugs, all fixed and re-checked:

**Ingest and footage**
- **Caption rate limits:** a caption HTTP 429 aborted the whole ingest. yt-dlp now uses browser impersonation (curl-cffi), doesn't abort on caption errors, and retries the captions with backoff.
- **Download errors:** intermittent HTTP 403s on downloads failed jobs. Download, ingest and judge jobs now retry transient errors up to 3 times; the KreekCraft sections needed two retries.
- **Audio-only sections:** after 403s, a section came back with audio only and was accepted. Sections without a video stream are now rejected and retried, and ignored as footage.
- **Censored words:** written as `[ __ ]` (with spaces), they were dropped from the words, so captions skipped them and the censored-word risk check never fired.
  - They're kept as words now.
  - When a transcript is rebuilt, clips' caption fixes move to the new word numbers by time and text: clip 1's "shooters." moved from word 2742 to 2812.
- **Name fixes:** they flipped inflections ("midterms" ↔ "Midterm", "escalations" → "Escalation") and mangled "mid-term" and "r/roblox". These are skipped now.

**Discovery and judging**
- **Still-image uploads:** the SmartLess upload is a still image over an audio podcast, and nothing noticed.
  - Sections are now checked with freezedetect (SmartLess 0.98 still, real video 0.00).
  - The Studio shows a banner and QA flags it.
  - `/clip` now looks at one still before judging.
- **Title signal:** it fired on every mention of the guest's name ("cardellini", "cuban"). Names in the title and channel are ignored now.
- **Validator end-snapping:** it pushed a clip's end into the sponsor read the judge had stopped before, then rejected the clip. Ends are now clamped before excluded ranges.
- **Caption warnings:** a comment's typo ("remeber") was flagged as a caption mistake. Comment words that are just the caption word with letters missing are skipped.

**Editing**
- **autoedit punchlines:** it zoomed on filler ("know,") and dropped the clip's final payoff laugh when there were more than 3. Fillers are skipped now, and the last laugh is always kept.
- **Proposed markers:** `clip marker update` silently accepted a proposed marker and lost its source. Edits keep a proposal a proposal now.
- **Rejecting auto-reframe** left the clip stuck in crop mode. The framing it replaced is restored now.
- **Caption position:** on blur-fit, captions sat over the bottom of the picture (facecams, on-screen text). New clips place them in the blurred band below the picture (0.72 for 16:9, inside the safe zone).

**UI**
- "Fetching footage" and "Nothing here" showed while pages were still loading; they show "Loading…" now.
- The audio signal had no colour.
- The review queue showed source length instead of edited length.

**Whisper is wired in.**
- `clip whisper <id>`, and ingest queues it automatically when a video has no captions.
- It uses small.en at about 0.12× real time, with words matching YouTube's about 85% of the time and timing within about 40–50 ms.
- YouTube's transcript is kept as `transcript.youtube.json`.

#### Build status (2026-11-06)

**v0.2a: quick wins from testing v0.1 (done)**
- **Section-only downloads** (moved up from v0.4).
  - Only the footage around candidates is downloaded: a 2-minute section is about 20 MB and takes about 80 s, with 6 in parallel. A whole video would be 1.6–4.4 GB.
  - Tested frame-accurate: a section's first video frame and audio sample land exactly on its start time.
- **Misheard names fixed at ingest** from the title, channel and description. On the KreekCraft stream that was 90 fixes ("Wreck/Recck room" → "Rec Room", "CreekCraft" → "KreekCraft"); there were no false fixes on the other two test videos.
- **`clip frames`:** stills for the judge, local or remote.
- **Risk warnings:** censored words, and mentions of slurs.
- **Live-chat replay:** not available. yt-dlp returned none for three stream recordings on two channels, so there's no chat signal for now.

**v0.2 (done, except Whisper wiring)**
- **Time map** (`src/core/timeline.ts`) with `cut` (crossfade, whip, flash and zoom transitions), `speed` and `freeze` markers.
  - In a test export, audio after a whip cut, a second cut and a freeze landed within 6 ms of where the map predicts.
- **`reframe` marker** (a framing layer): cuts or pans of the crop. In the renderer it becomes an ffmpeg crop-x expression.
- **Audio events signal** (SoundAnalysis): 82% of caption laughs matched, per-minute correlation 0.87, about 18 s per hour of audio.
- **`clip search`** for themes.
- **Lenses:** `hot-takes` and `stream-moments`.
- **Dead-air cut suggestions.**
- **Whisper:** `clip whisper` uses small.en (2 h in about 14 min). Ingest queues it when there are no captions.

**v0.3 (done)**
- **Proposed markers** (dashed, previewed, never rendered until accepted).
- **`clip autoedit`:** hook text, punchline zoom, boom and flash on the content word before a laugh, dead-air cuts, and caption fixes taken from comments.
- **`/edit` skill.**
- **Review queue** (`#/review`, single keys) with QA results.
- **Learning loop:**
  - `feedback.jsonl` is written on every decision.
  - `clip stats` breaks approval down by lens, judge score and signal.
  - `clip perf-import` imports posted-clip numbers.
  - Pulling YouTube Analytics automatically needs your OAuth credentials and isn't built.

**v0.4 (done; the unattended judge needs a one-time login)**
- **Job queue and worker:** SQLite job queue (`library/jobs.sqlite`, Node's built-in SQLite) and a worker that starts on demand. The Jobs page shows median time per job kind.
- **`clip batch`:** takes links, a file of links, or a channel/playlist URL. Pipeline: ingest → discover → judge → make top N → autoedit → render → QA → review queue.
- **Unattended judge:** headless Claude Code (`claude -p` running the `/clip` steps).
  - The CLI bundled with the desktop app isn't logged in on its own. Log it in once with `/login` in a terminal.
  - Until then, judge with `/clip` in a session and run `clip batch-continue`.
- **QA:** length, loudness, dead air, black frames, caption overflow, content risk. Every render is normalised to −14 LUFS.
- **Auto-reframe** on faces (Vision): about 2.3 s per minute of 24 fps video. It follows the speaker in close-ups and cuts on source cuts; weak on wide multi-person shots.
- **Renders run one at a time:** a single render already uses all 8 M1 cores. Downloads, autoedits and QA run alongside, and a render whose footage is still downloading no longer blocks the render slot.

**End-to-end batch test (2 Diary of a CEO episodes, 3 clips each, judged in a session because the headless CLI wasn't logged in)**
- **Result:** 6 clips edited, rendered and QA'd in 11.5 min of wall clock. All passed QA at −14.0/−14.1 LUFS.
- **Footage:** 88 MB and 133 MB of sections, instead of 1.5–2 GB per video.
- **Median time per job (Jobs page):**
  - Per clip: render 103 s, QA 7 s, autoedit under 1 s.
  - Per video: ingest 20 s, audio and laugh detection 27 s, sections 81 s (in parallel with other work).
- **100 shorts a day:** about 3 hours of unattended rendering on this M1, plus the judge (a few minutes of Claude per video) and your review (about 30 s per clip in the review queue).
- **QA findings:**
  - One clip ran 60.6 s; flagged for the Shorts limit.
  - One long word overflowed the caption width. Caption pages now shrink to fit.

**v0.5: the Studio as a product (done, 2026-11-06)**
The flow: `/clip <link>` judges the candidates and opens the Studio on them. You either export a candidate as is, or edit it and export. Exports are QA'd and land in the review queue with their post text.
- **Candidates page:**
  - Each candidate has **Edit** and **Export**; tick several to export them together.
  - Export as is (captions and framing), or with an edit style.
  - Each card shows its clip's state: editing, rendering, QA, the MP4, review.
- **Edit styles** (`src/edit/styles.ts`, `clip styles`):
  - **clean** and **punch**.
  - **hype:** random booms, bass drops, shakes and emoji pops on laughs, a riser into the payoff, punch-ins on every other sentence, glitch jump cuts, pops on shouted words.
  - **story:** smooth push-ins, crossfades with a whoosh.
  - Styles are recipes over the same detected moments: punchlines, payoff, shouted words, audio shouts, sentence starts, dead air.
- **Quick effects** at the playhead: boom, emoji, glitch, whoosh, riser, flash, shake.
- **New markers and sounds:**
  - `emoji` and `glitch` markers, and a glitch transition for cuts.
  - New sounds: riser, bass drop, glitch, shutter, swish.
- **Span editing:** shift-drag the ruler (or `[` `]`) to select a span, then cut, speed, zoom, text, crop, blur-fit or auto-reframe just that part.
  - The reframe marker has a `mode` (crop or blur), so framing can switch part-way through a clip.
  - The renderer overlays a blur-fit branch and a crop branch with an ffmpeg `enable` expression.
- **Editor:**
  - Previous and next clip, in the candidate list's order.
  - Play clip stops at the out-point; `L` loops.
  - Watch, download, QA chip and review status in the top bar.
  - Duplicate a clip (…-v2), or delete it (to `clips/.trash/`; its candidate can be made again).
  - Leaving a clip saves the last edit.
  - Export asks before leaving out unaccepted proposals.
- **Post text:** title, caption and hashtags are suggested from the candidate (hook, lens, names in the title, channel).
  - They can be edited in the editor's Post panel, written next to each export as `exports/<clip>.txt`, and copied from the review page.
- **`clip open`** starts the Studio if needed and opens the page. Also new: `clip post`, `clip duplicate`, `clip delete`.
