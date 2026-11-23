# Clip Engine field report
19 November 2026 · Local watchlist snapshot around 18:44 UTC

## What I would build

Open Studio and see the best few things that happened across the channels you follow. Each suggestion plays immediately from the original footage, shows what changed and where the payoff lands, and lets you keep it, adjust the boundaries, or dismiss the event. When several creators encounter the same scene, you can compare their reactions in place. Rendering starts after a moment earns the cost. A separate lane can continue to deliver automatically edited clips from proven formats.

The immediate bet is to improve **which four moments per broadcast get expensive attention**. A small change recovered an approved clip with the inputs already on disk. The larger bet is that coverage across creators can reveal editorial choices that a single-stream clipper cannot offer.

## What the engine actually saw

| Snapshot measure | Result | Interpretation |
|---|---:|---|
| Twitch broadcasts recorded by tracker | 26, totalling 239.2 broadcast hours | 18 creator-sourced and 8 topic-sourced. All eight topic records were GTA 6. |
| Cached chat ranges on those broadcasts | 147.3 h, about 62% | Interval union per VOD, clipped to recorded length, excluding disabled chat. A cached interval can still omit messages in a very busy second. |
| Scan ranges / transcript coverage | 9.6 h / 12.1 h | Measured independently. Transcription can extend past a scan window. A content Scout needs a budget to inspect the remaining footage. |
| Tracked moments | 516, including 498 pending | Only 65 pending rows fit the current four-per-stream cap and stream eligibility in this snapshot. 22 pending rows belonged to skipped streams. |
| Latest recorded human decisions | 219 unique clip IDs | 21 approved, 7 changes, 191 rejected across pipeline generations. 159 of the 191 rejects have no reason. |
| Saved audience performance | 0 records | The operational review table includes 14 approvals marked uploaded. The system has human labels but no local observations connecting rank or edit choices to audience response. |

At the last saved per-topic check, Fortnite had one stream above its viewer floor, League had two and World of Warcraft had three. Further eligibility checks still apply. The current daemon chooses one candidate across categories and can skip the entire category check when its global live slots are full. Expanding the eligible sources and expanding full-video downloads are independent spending decisions.

The ledger also needs source history. On ohnePixel broadcast `tw-2932275268`, the final saved viewer-clip file was empty while the tracker retained a moment supported by 291,583 viewer-clip views. The cause of that empty refresh is unknown. Append observations with a fetch time and completeness flag so a later empty response can be distinguished from withdrawn evidence. This would also make honest as-of-live replays possible.

## I replayed the ranking

I used the production moment functions with frozen cached viewer clips and chat and disabled the scanned-range exclusion for retrospective rediscovery. Of the 21 approved IDs, 16 had a source cut on a tracked broadcast. A hit means a ranked peak landed inside that cut or within 30 seconds of it. Budgets are per broadcast. Counts represent previously approved cuts recovered, not a blind review of all suggestions.

| Ranking method | Approved cuts reached in top 4 | Approved cuts reached in top 12 |
|---|---:|---:|
| Viewer clips alone | 4 / 16 | 5 / 16 |
| Chat laughter alone | 5 / 16 | 8 / 16 |
| Current combined score | 5 / 16 | 8 / 16 |
| Alternate viewer-clip and laughter nominations | **6 / 16** | **11 / 16** |

The alternative alternates the two ranked lists from the viewer-clip list first, discards nominations within 30 seconds of an already selected peak, and draws from the remaining list when one runs out. The current and alternate methods each filled 91 top-four slots across the 26 broadcasts. At top four both also landed near seven of 29 alignable previously rejected cuts. At top twelve those figures were nine for the current method and seven for the alternate. Most suggestions have no human label, so a precision or predicted approval rate would be misleading.

The result held directionally when I tightened the match tolerance to ten seconds. The current method reached 3 approvals in four and 6 in twelve. Alternating reached 5 and 10. Jerma’s approved moped crash is a concrete example. Laughter ranked it first, combined scoring put it ninth, and alternating brought it into the top four. The opposite failure also matters. Laughter alone missed SypherPK’s approved MrBeast clip altogether. Two methods can achieve the same aggregate count and find different stories.

The underlying combined score adds raw views, 25 per additional clipper and 12 per laugher. A mature viewer clip can easily dominate a strong reaction. More subtly, merging overlapping regions can shift the representative peak away from a nearby event. The alternate experiment changes both selection and deduplication, so the observed difference cannot be assigned to either alone.

These are historical positives chosen by earlier pipelines, on a launch-heavy sample. Viewer counts matured after the events and earlier scan decisions influenced which chat and transcripts were cached. Use the result to nominate a challenger for prospective testing. It does not establish live recall or virality.

## Where work disappears or gets misattributed

| Finding | Evidence | Change |
|---|---|---|
| Scanned minutes suppress later discoveries | Replaying available evidence produced 2,058 over-threshold regions. Reapplying the scan filter removed 107. Of these, 89 did not overlap a currently queued, working, clipped, failed or no-clip moment region in the tracker. Resets and earlier range jobs mean some may have been investigated. | Store observed coverage per signal, and store the event-level disposition separately. Reuse footage while allowing late evidence to reopen a decision. |
| The job can claim the wrong cut | 29 completed moment jobs produced 23 output references to 22 distinct clips. Eight references pointed outside the requesting window. Among 15 in-window references, 8 had an approval, 4 a rejection, 2 a change request, and 1 awaited a decision. One clip ID was claimed by two different jobs. | Persist job ID, event ID, source segment and output ID together. Count unique approved events per job cohort. The older misattributions span earlier code versions. |
| Parallel extraction can reintroduce that attribution bug | On current code, an isolated fixture passed an extractor-added candidate an hour outside a 45-second job. `passCandidates` returned its ID. The extractor computes additions from a before/after diff across the whole broadcast. | Validate every ID against the permitted window and initiating job. Use a per-broadcast write lock until candidate storage can enforce ownership, then relax concurrency. |
| Reranking can preserve obsolete boundaries and eligibility | In a scratch tracker, I updated an existing moment with an expanded window, higher score and a newly excluded chapter. Its score changed. Its old bounds and pending state survived. | Update current evidence, proposed bounds and eligibility transactionally. Keep an immutable copy of the specific evidence and bounds used by a running job. |
| A YouTube failure can be recorded as success | Job `qSyo5d-dVzA` is marked done although its recorded result says the judge failed. The quick path also uses the podcast lens for every YouTube source, filters out cuts below 15 seconds despite the 5-second upload floor, and counts a submission without checking that command’s result. | Return typed outcomes for unavailable input, failed stage, no qualifying moment and submitted clip. Select the lens by content. Exercise the YouTube stream and edited-video paths separately. |
| More workers require stronger recovery | The watchlist uses JSON plus tracker writes. The existing Studio SQLite queue has transactional claiming but startup recovery requeues running jobs globally under a single-worker assumption. The verifier’s report is logged and its failure is allowed through. | Make the transaction that claims work own the lease. Fence expired workers from completing it. Persist stage results by job and have the next stage consume them. Verify kill/restart after candidate creation and after review submission. |

The watchlist also asks for range transcription/queues immediately before the full pipeline asks for it again. Some work is cached. Instrument both calls before estimating the saving from removing one. The larger cost is the number of agent stages a weak moment reaches.

## Where the time goes

| Historical timing | Observed |
|---|---:|
| Completed Twitch moment jobs, 29 | Median 26.2 min, mean 25.8 min, p90 39.0 min |
| Completed jobs reporting a review output, 23 | Median 28.1 min |
| Completed jobs with no output, 6 | Median 11.1 min |
| Editor agent, 25 successful logged invocations | Median 8.7 min |
| Extractor / verifier, 30 successful logged invocations each | Median 3.4 / 2.6 min |
| Saved final export timing, 15 unique referenced outputs with manifests | Median 1.38 min, p90 2.24 min |

The editor stage includes render and QA work. These overlapping timings should not be added. Across the first-to-last completed moment job in the snapshot, the daemon completed 29 in just under 18 hours. The 17 intervals between logged creator checks inside that window had a median of 66 minutes, and the longest reached 97 minutes. The daemon and operating policy changed during that period. Measure a fresh steady-state run before treating these as current service levels.

At the observed mean cost of a completed job, one continuously busy worker could complete roughly 56 such jobs per day before contention, downtime or failed attempts. Two could complete about 112. Reaching 100 approvals would require close to 90% approval per completed job under those assumptions. Two workers with a 50% job-to-approval yield would instead need about 14.4 minutes per job. The upload cron separately defaults to one item per 20 minutes, at most 72 per day before upload time or backoff. Make the dashboard distinguish moments observed, usable previews, approvals, and uploads.

## What the actual frames say

I sampled five frames from each of three exports and inspected their edit projects, QA and decisions. These observations concern those specific renders.

- **Jerma, moped into pole.** The opening names the moped, the road makes the setup legible, and the pole and aftermath remain visible in a 15.6-second export. You approved it even with a first-word warning at 1.9 seconds. A visual event can introduce itself before the streamer speaks. Clip `tw-2933227596-c01`.
- **xQc, first carjack.** The 31.3-second cut opens at a car, passes through a bright transition and spends its closing sampled frames on a seated character. The hook promises the first crime. You marked it boring despite a virality score of 72. Test whether the ending delivers the specific promise and whether the streamer adds anything distinctive to this version of the scene. Clip `tw-2932113307-c04`.
- **Ludwig, smashed mouse.** All five sampled frames enlarge the VALORANT character portrait, while the small real webcam is visible in the gameplay area. Layout QA recorded a face in 100% of its samples and a pass. Save the creator’s previously verified camera rectangle per scene layout, revalidate on scene changes and fall back to full frame when candidate panels conflict. Clip `tw-2931875711-c25`.

## A feature already hiding in your data

I searched the cached word transcripts for matching nine-word spans and checked a second line later in the scene. Four independent GTA playthroughs share the appliance dialogue and then the marriage dialogue. The first matching phrase starts at these VOD times, rounded to a second.

| Creator | Broadcast | First phrase |
|---|---|---:|
| KaiCenat | `tw-2932305259` | 2:52:04 |
| zackrawrr | `tw-2932469290` | 3:07:35 |
| NickEh30 | `tw-2932380541` | 3:23:18 |
| ohnePixel | `tw-2932275268` | 3:35:44 |

**Show these as four performances of one scene.** Let the editor compare the ten seconds after the line. A creator who interrupts, anticipates a twist or reacts unusually may give you a better short than a bigger channel playing the scene straight. If two reactions genuinely play off each other, preview a comparison cut. The timestamps belong to independent playthroughs. A shared live incident with multiple points of view needs separate evidence of simultaneity.

This is a practical first cross-stream feature. Index distinctive phrases already produced by Whisper, require multiple ordered matches to nominate a shared scene, and verify using source footage or audio. Keep the shared scene, individual creator reaction and final cut as separate records. Later, verified scene matches can also point a Scout toward a broadcast whose chat stayed quiet. Attribute dialogue to the game, streamer or guest before generating a hook in anybody’s name.

## Suggested build order

1. **Fix attribution and decouple discovery.** Ship the spec’s top three eligible streams per topic, recent broadcasts for listed creators and cheap independent observation. Add signal availability, age of last successful check, and an explanation for each excluded stream. Acceptance test: hold an edit worker busy for 30 minutes, observe the configured checks, interrupt a job and recover exactly one recorded output for that event.
2. **Ship a cheap preview and a shadow ranker.** Compare the current score with alternating nominations. Build the preview from cached sections and test only the minimum additional media required. Show the premise, event timestamp, proposed cut and payoff frame. Record separate verdicts for moment quality and edit quality. A recut should keep an event eligible. A dropped event should retain its reason.
3. **Give the Scout independent evidence.** Reserve a small, tunable fraction of preview slots for coverage without community peaks. For conversational content, look for a claim followed by a contradiction, reveal or punchline. For gameplay, use low-resolution motion, HUD changes and short video playback to check the consequence. A score change can nominate a clutch. The Scout must show which action decided it. A loud transition, repeated menu or cutscene with an interchangeable reaction is a useful negative example.
4. **Run one fair trial before adding edit workers.** Select whole chapters across high-chat, low-chat and dialogue-heavy streams. Hold out creators or dates, freeze evidence as it arrives, and randomize review order with the selection method hidden. Give each method the same previews and compute budget. Include random quiet windows so missed events can be measured. Track unique approved moments per ten previews, missed human-marked events, duplicate rate, p90 time from available footage to preview, and compute minutes per approved event. Compare variants against real audience performance at fixed ages once collection is working.
5. **Pilot the shared-scene feed on the four broadcasts above.** Judge one reaction per creator side by side. Use a stronger model for ambiguous comparisons or boundaries only if blind review shows the incremental cost buys better selections. Expand concurrency when queue age and measured stage time identify a constrained resource.

## Reproduction notes

The snapshot used read-only SQLite backups plus cached watchlist, feedback, scan, transcript and signal files copied during the same minute. Job duration is finish minus start for completed Twitch moment jobs. Source attribution uses saved project segments or candidate bounds and requires any overlap with the requesting window. This is a generous test of provenance. A nearby cut can still miss the actual event. Render times come from the latest available manifest per unique output and can reflect a rerender.

The operating code paths were `tools/watchlist.ts`, `src/cli/stream.ts`, `src/scan/moments.ts`, `src/track/db.ts`, `src/pipeline/full.ts`, `src/ingest/chat.ts`, `src/qa/layout.ts`, `src/jobs/queue.ts`, `src/jobs/worker.ts` and `tools/upload-cron.ts`. Run the offline suite with `node --import tsx --test --test-reporter=spec test/*.test.ts`. All 246 tests and TypeScript type checking passed. The default npm test wrapper hit a sandbox IPC restriction. Live provider integration, audience analytics collection and prospective editorial acceptance were outside this read-only audit.
