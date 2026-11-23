# Audit — agents, process and reliability (2026-11-12)

What was checked, what was wrong, what was changed, and what is still open. Written after the process
grew from "one judge reads the seeds" into queues → experts → extraction → curation → editors →
subtitle expert in a few days.

**How it was done:** read every skill, lens and process doc against the code behind it; ran the queue
checkers, the window scorer, the editors and the subtitle engine on the 13 scanned broadcasts in
`library/`; measured three things the design depended on (chat lag, audio label noise, where a viewer
clip's offset really points); researched what a virality expert and a meme expert should know
(`agents/research.md`, with sources); then fixed what was wrong, ran the three experts on a real
30-minute segment, and fixed what they tripped over.

**Result in one paragraph:** the roles in docs/pipeline.md existed mostly as names. Three of them (the queue
experts) had no definition at all, the lenses described a scoring rubric the engine no longer used, the
queue checkers often pointed 10–20 seconds after the moment and counted classifier noise, the editors
placed effects at fixed fractions of the clip, the subtitle engine turned captions off on ordinary
podcast clips, and every hand-off between agents was prose or hand-written JSON that nothing checked.
All of that is fixed and tested (99 → 169 offline tests; the real-Twitch end-to-end tests pass). The three experts were then run on a real half hour and found 5 moments where the earlier run had 1; their notes on the instructions produced a second round of fixes (section 3). What is not fixed is listed at the end.

**Follow-ups, 2026-11-14:** section 7 is the channel's positioning as an automated clipper that credits what it clips; section 8 is the whole process run on a fresh stream (three clips in the review queue, about $4 of delegated work). **Section 6:** the same work was moved to Sonnet 5.5 with measured
instructions. The trial half hour cost about $46 at API list prices; it now costs about $1.40, with
the same verdict on every queue and four of the five moments. 192 offline tests now.

## 1. Findings

Severity: **A** = produced wrong clips or lost work; **B** = made agents unreliable; **C** = smaller.

### The agents themselves

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| 1 | B | **The three queue experts had no definition.** docs/pipeline.md described a meme, a virality and a clip-worthiness expert; nothing in `.claude/` defined them. Each run depended on whatever brief the session improvised. | No `.claude/agents/`; no skill for the queue stage. | **Fixed.** `.claude/agents/{meme,virality,story}-expert.md`, a shared protocol (`agents/queue-expert.md`) and a coordinator skill (`/queue-check`). |
| 2 | B | **No shared vocabulary.** The curator's ledger used niches like "IRL sports fail" and "talk / clip-story" that no other stage knew; chat moods were five small regexes in one file and a different lexicon in another. | `library/tw-2926144284/curation.json`; `queues.ts` vs `chatAnalysis.ts`. | **Fixed.** `src/core/vocabulary.ts` (archetypes, share triggers, reject grounds, risk flags, niches, drop grounds), printed by `./clip vocab` and enforced by the ledgers; `agents/vocabulary.md` for the rest. |
| 3 | B | **Hand-offs were unchecked.** Experts returned prose. The curator hand-wrote JSON and then ran `candidates skip` separately. Nothing verified an expert had looked at a frame, or that a drop had a reason. | `/clip-curator` step 6–7 (old). | **Fixed.** `./clip queue-review` and `./clip curate` validate and write both ledgers. A confirm must cite a frame; a drop must name a ground. |
| 4 | B | **Queue ids changed between runs** (`meme-3` was "third group found in this range"), so nothing could refer to a queue reliably. | `queues.ts` (old) `id: \`${kind}-${out.length + 1}\``. | **Fixed.** Ids are the kind and the moment's time (`meme@1:46:25`) and resolve within ±15 s. |
| 5 | B | **The extractor was told to do something the validator forbids:** "if a queue has no transcript/quote, still extract it". Every candidate needed a quote found in the transcript, so a scream, a fall or a face could not be added at all. Those are most of what a meme is. | `/clip-extractor` step 4 (old) vs `quoteFound` in `src/candidates/index.ts`. | **Fixed.** A `visual` candidate needs no quote but must have a witness inside it (a reaction heard, a chat spike, a viewer clip). The anti-invention rule is kept: evidence replaces the quote, it does not waive it. |
| 6 | B | **The extractor ran `clip windows` before anything was transcribed.** Streams are transcribed only around the top seeds, so most queue regions had no words when windows were scored. | Skill step order (old); `scan/index.ts` `MAX_TRANSCRIBED_SEEDS`. | **Fixed.** `clip queues --transcribe` fills the listed regions once; windows print the exact command when a region still has no words; wordless regions get windows cut around the moment. |
| 7 | B | **`/edit` ignored half the edit stage.** docs/pipeline.md listed the meme editor, the expert editor and the subtitle expert; the skill only knew `autoedit`. | `.claude/skills/edit/SKILL.md` (old). | **Fixed.** `/edit` now runs trim → layout → editors as proposals → check each → captions → render → QA, with an edit-device table. |
| 8 | B | **Two parallel processes with no rule for which to use** (`/clip` seeds → judge, and queues → extractor → curator). | docs/pipeline.md vs `/clip`. | **Fixed.** `/clip` is the quick pass; the four stage skills are the full process; both say so. |

### Docs that contradicted the engine

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| 9 | A | **The talk lenses listed the stream weights and post bar.** `podcast-general.md` and `hot-takes.md` said stop 35% and "post only when virality ≥ 70, delivery ≥ 7, payoff ≥ 7, standalone ≥ 7". The engine uses stop 15% and 65 / 4 / 5 / 6 for talk since the calibration on 2026-11-10. The judge was reasoning about a rubric that no longer existed. | `lenses/*.md` (old) vs `src/candidates/virality.ts`. | **Fixed**, and `test/lenses.test.ts` now fails when a lens file and the engine disagree. |
| 10 | B | **Three different descriptions of the gate.** The skill and lenses said "capped at 65" and "capped at 50"; the engine multiplies by 0.65 and 0.5. The judge was told to apply the gate itself. | `/clip` step 5 (old), `lenses/`, `virality.ts`. | **Fixed.** The docs say what the engine does and that the agent never applies it. |
| 11 | C | `stream-moments.md` said both "start 2–4 s before the event" and "starting 2–4 s early is often wrong". | Same file, two sections. | **Fixed** (1–2 s; up to 3 for a scare). |
| 12 | B | **"Viewer-clip `offsetMs` points at the end of the clip"** was written as a rule after one event stream. Three modules assumed three different things (start, end, ±30 s). Measured on 291 clips: it is neither. 42% were created sooner after the offset than their own length, and title words were said before the offset about as often as after it. | `signals/clips.ts`, `extract/window.ts`, `queues.ts` (old); measurements in `agents/research.md` §5. | **Fixed.** One definition (`clipSpan`, `clipNearness`): an anchor good to one clip length either way. |

### The queue checkers

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| 13 | A | **Queues sat on the aftermath, not the moment.** The window was placed 8 s before the busiest bin. When that bin is a chat peak, the moment is earlier: measured median 17.5 s from a laugh or scream to the chat peak (43 cases). So chat-led meme queues often did not contain the thing chat reacted to. | `WINDOW.meme.before = 8000` (old); `agents/research.md` §5.33. | **Fixed.** Every step reads chat from the 0–25 s after it, so a laugh and the spike it caused land on the same step and the queue is placed on the moment. |
| 14 | A | **Classifier noise counted as reactions.** The queue checker counted every raw audio event above the tool's 0.3 floor, including `battle_cry`, `gasp` and `booing`, which the audio signal's own tuning notes call noise. Of 2,369 raw events in the library, 386 (16%) are reactions by the tuned thresholds; the most frequent label is `booing` (865). | `queueBinScore` (old) vs `signals/audio.ts`. | **Fixed.** One exported detector (`detectReactions`) is used by queues, windows, editors and subtitles. |
| 15 | B | **The three checkers produced nearly the same list.** Weights differed by a few points, so meme and viral queues were the same moments with different window lengths. | First run on Lacy 1:30–2:00: 6 of 8 meme queues also in viral. | **Fixed.** Each kind has its own gate (`queueGate`): meme needs a reaction or chat laughing/gasping/mocking; viral needs two witnesses or watched viewer clips; clip needs speech plus a witness. |
| 16 | B | **Fast speech alone made a queue.** Any bin over ~150 wpm counted as a "source". On a fast talker that is every bin, and adjacent bins merged into one group, so a whole segment could collapse into one queue. | `sources = parts > 0.28` including `speech` (old). | **Fixed.** Speech and title words are context, never witnesses (the rule `convergenceScore` already used). |
| 17 | B | **Unscanned looked like quiet.** `clip queues` on a range with no chat or audio printed "0 queues". | `buildQueues` (old) ignored `chat.fetched`. | **Fixed.** `coverageOf` reports what is missing; a blind range with no queues is an error that names the `clip scan` to run. |
| 18 | B | **`--limit 8` silently dropped queues** before any expert saw them, in a process whose rule is "nothing is dropped by score". Of the seven clips the last Lacy run produced, one (c03, the chair) is outside every checker's top 8 for its 30-minute segment and another (c02) sits 6th to 8th. | `.slice(0, limit)`; `clip queues tw-2926144284 --from 2:00:00 --to 2:30:00`. | **Fixed.** The limit is a view: the header says how many weaker queues are hidden and the flag that lists them. |
| 19 | C | Chat evidence showed the first five messages of the bin, not the repeated ones; the rate was labelled "/10s" on 5 s bins; overlapping queues could suppress each other transitively. | `samples: inBin.slice(0, 5)` (old). | **Fixed.** Top repeated messages by distinct people; 10 s rate; greedy region claiming. |
| 20 | B | **The chat lexicon missed how chat actually types.** "hahaha", "LMAOOO" and "lolol" did not match; there were no tokens for tension, rage, irony or agreement; raids were detected but sub bursts and copypasta were not. | `FUNNY = /\b(lol|lmao|lul|kek|…|haha|jaja)\b/` (old). | **Fixed.** One lexicon, nine moods, stretched and shouted forms, events, copypasta, and "doubt" (chat calling it fake, staged or AI). |

### Editors and captions

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| 21 | A | **The subtitle engine turned captions OFF on ordinary spoken clips.** It compared the whole video's laugh tags with the clip's word count: a 148-word clip from a podcast with 235 tags anywhere in it was "mostly non-speech tags". | `./clip subtitles 2v99_8xJoqA-c01 --review` printed `captions OFF`. | **Fixed.** Only tags and reactions inside the clip count. Same clip now: `captions ON`. |
| 22 | A | **The meme editor's "punch in on the reaction" was not on the reaction.** The zoom, emoji and flash were placed at 25–45% of the clip's length whatever happened there. The expert's "push-in on the key line" was at 30%. | `at = clipStart + min(dur*0.45, max(2500, dur*0.25))` (old). | **Fixed.** The editors find the reaction, the content word before it and the quoted line, and place edits on them. No reaction heard: no punch-in, and a note says so. |
| 23 | A | **Running the editors overwrote the reviewer's note.** The expert editor wrote its own remark into `review.note`, replacing whatever the user had written on a clip marked `changes`. It also set a review status on clips that had none, which hid them from `/edit all`. | `p.review = { …, note: value }` (old). In the library: `tw-2926144284-c01` carries `review: editing, note: "trim 14s; keep setup + payoff"`, written by the editor, not by a person. | **Fixed.** Editors never touch `review`; remarks go to `notes` in their output. Tested. |
| 24 | A | **Editors re-enabled captions the subtitle expert had turned off**, and re-running `clip subtitles` reverted any caption decision made from the frames. | `captions.enabled = true` in both editors; `applySubtitleFixes` (old). | **Fixed.** Captions have one owner. The engine never turns them back on by itself; `--no-settings` applies word fixes only. Tested. |
| 25 | B | **Dead-air cuts could cut the pause before a laugh,** and a gap filled with laughter counted as dead air. | `gap > 1000` between words (old). | **Fixed.** Reaction time is removed from gaps; a silence that runs into a reaction is a comic pause and is kept. |
| 26 | C | Editors could stack a cut or a zoom on one `autoedit` had already proposed; "QA has not passed" was shown for clips never rendered. | Dedupe only among `editor:*` sources (old). | **Fixed.** |

### Scoring

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| 27 | B | **The scores did not discriminate.** All seven Lacy candidates: share 8, delivery 8, everything else 6–8, all verdict `post`, including one the curator noted "ends on 'Drop' with no visible break or fall" and has 0% signal. | `./clip candidates list tw-2926144284`. | **Addressed, not proven.** Anchors for 2 / 5 / 9 on each score; rank-first procedure; `score check:` warnings where the transcript contradicts a score; a batch note when everything scores the same. Whether scores now spread needs a fresh extraction run. |
| 28 | B | **The 300 ms / 400 ms buffer did not survive validation.** `clip windows` added it; `candidates add` snapped the start back to 150 ms and the end to 250 ms. | `snapStart`, `snapEnd` (old). | **Fixed.** The validator uses the same constants. Tested end to end. |
| 29 | C | A judge writing `"start": 853.4` meant seconds; bare numbers are milliseconds. The error said only "lasts 0.0 s". | `parseTime`. | **Fixed** (clear error). |
| 30 | B | **Batch mode ranked by quality score alone**, against the project's own rule, and could make clips the engine had marked `skip`. | `afterJudge` sorted by `b.score - a.score`. | **Fixed** (`pickForBatch`: rank order, never `skip`). |
| 31 | B | **No way to trace a result back to the expert that found it.** Candidates did not record their queue kind or the curator's niche, so `clip stats` could never say which expert or niche performs. | `FeedbackRow`. | **Fixed.** `kind`, `queueId`, `niche`, `fit` are logged; `clip stats` groups by queue expert and by niche. |

### Truth, privacy and policy

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| 32 | A | **A prank is rendered and titled as fact.** `tw-2926144284-c01`, "Lacy buys a BMW X6M on impulse and Ron loses it". At 1:38:39 he says "you guys believe that I actually bought a car… I tricked you guys… I don't actually want a new car". Chat was already typing "Ai" and "LEEKED". Nothing in the old process read past the clip or could read that chat. | `./clip transcript tw-2926144284 --from 1:38:10 --to 1:39:20`. | **Process fixed, clip not touched.** Experts read on two minutes when chat is ironic or doubtful; "told as fact" is a named failure mode; the queue now warns that chatters call it fake, staged or AI. In the trial both finished experts found the prank on their own. **The clip itself is your call** (retitle as a prank, or drop). It is rendered, not submitted and not posted. |
| 33 | A | **The same clip shows an order-confirmation page with an order number** two seconds in, while chat types "DONT SHOW THE NUMBER", **and a slur in the on-screen chat** at 0:18 ("Retarded purchase"; this stream burns chat into the frame). Nothing looked at what was on the monitor or in the overlay. | Frames at 1:35:42 and 1:35:58 (from the local section). | **Process fixed, clip not touched.** `privacy` and `slur` are risk flags the experts raise from frames; flags reach QA automatically as `risk:` warnings; candidates warn when chat typed a slur during the clip; `/edit` checks the first frames. The order number is probably part of the fake page, but that is for you to judge. |
| 34 | B | **Risk detection was eight words** (`tos|strike|banned|ban|nude|sex|dildo|penis`). | `TOS` regex (old). | **Improved.** Six categories on chat, clip titles and speech, plus the experts' flags from frames. Still word lists: a person decides. |
| 35 | B | **"Export as is" at volume is what platforms penalise.** YouTube excludes unedited clips and re-uploads from Shorts revenue and has an "inauthentic content" rule for templated mass production; TikTok and Instagram demote reposts with nothing added. | Official pages in `agents/research.md` §7. | **Noted in docs/pipeline.md.** Not a code issue. Worth a decision about how much edit every posted clip gets. |

### Concurrency

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| 36 | B | **Three agents reading one segment could lose transcript windows.** `clip transcript` and `clip chat` read a file, add a window and write it back with no lock; three experts would also each pay for the same Whisper runs. | `ensureTranscribed`, `fetchChat`. | **Fixed.** `withVideoLock`; and `/queue-check` transcribes once before the experts start. |
| 37 | C | A running Studio from before a schema change would strip new fields when it saved candidates. | zod strips unknown keys. | Studio restarted during this audit. Restart it after any schema change. |

## 2. What the research changed

Full notes and sources: `agents/research.md`. The parts that changed behaviour:

- **Virality expert:** the question is whether a *cold viewer* would stop, stay and send it, because feeds show a clip to strangers first and streamer clips are watched far more by non-fans than fans. It names one share trigger; "fans will like it" is `none`, which is a reject. It reads what chat said, not how fast it scrolled (a study of 2M Twitch clips found chat content separates popular clips better than volume).
- **Meme expert:** memeable is not "funniest". It asks whether the cause is in the clip, whether it reads on mute, and whether it can name the violation and the safety cue (benign-violation theory). A detected laugh needs a visible cause, because people laugh constantly in company.
- **Story expert:** finds the landing line first, walks back to the earliest sentence the landing needs, and always reads the two minutes after.
- **Scoring anchors** for 2 / 5 / 9 on each funnel score, written from the platform signals (stay rate, relative watch time, sends).
- **Edit devices:** stacked effects read as irony; the pause before a laugh is the joke's timing; hook text leaves before the hit. All timing advice is practitioner lore and is labelled so.

What could not be sourced is listed at the end of `agents/research.md`. No official numeric threshold exists for any platform metric.

## 3. Trial run

The three experts were run on one real segment, `tw-2926144284` (Lacy) 1:30:00–2:00:00, each given only
its definition file and the range, and asked to add notes on anything unclear in the instructions. The
ledger is `library/tw-2926144284/queue-review.json`; `./clip queue-review tw-2926144284` prints it.

| Expert | Queues | Confirmed | Merged | Rejected | Time | Tokens |
|---|---|---|---|---|---|---|
| meme | 8 | 2 (`prank` 0.85, `misspeak` 0.65) | 1 | 5 (`nothing-happened` ×4, `no-reach` ×1) | 25 min | 362k |
| virality | 2 | 1 (`argument` · `debate`, 0.65) | 0 | 1 (`no-reach`) | 16 min | 239k |
| story | 10 | 4 (`prank` 0.75, `confession` 0.6, `banter` 0.6, `misspeak` 0.6) | 1 | 5 (`nothing-happened` ×3, `chat-answer` ×2) | two sittings (cut off by a usage limit, then resumed) | 550k |

**Result: 5 moments in 30 minutes, where the earlier run had 1.**

| Moment | What it is | Who | Flags for a person |
|---|---|---|---|
| 1:36:27 | A prank: Ron believes Lacy bought a $155K BMW and crashes out. | meme 0.85; second readings from story (a longer cut that lands on "I'm getting a Ferrari truck instead") and virality | misleading, staged, privacy, profanity |
| 1:44:04 | A confession: "I don't even have the login to my investment account. It's actually kind of sad." | story 0.6 | slur (on-screen chat at the open) |
| 1:47:49 | Banter: asks his guest's chat whether the guest has ever smoked, lands on "the absolute peak American experience". | story 0.6 | drugs, slur, profanity |
| 1:52:27 | A misspeak: screams at his producer about a camera angle, five silent seconds, realises he is watching his friend's stream. | meme 0.65; story 0.6 | none |
| 1:54:06 | Absurd: a confident wrong explanation of daylight saving ("the sun revolves around the earth… clouds block off the sunlight ray beams"). | **found by the story expert; no checker queue existed** | slur (on-screen chat) |

The earlier run's one clip from this half hour is the first row, titled as a real purchase.

**What it showed**

- **Looking works.** Every verdict cites three to five frames, rejects included. All three experts found, independently, that the "BMW purchase" is a prank (one from the chat overlay in a still, two by reading on), that an order number is on screen, and that chat called it staged. The old process missed all of it on the same footage.
- **False positives are named, not kept.** Eleven of twenty verdicts are rejects, each with what was actually on screen: chat voting yes/no on a question he asked, a shout to call someone from another room, riders calling to each other on scooters.
- **The checkers miss quiet stories.** The daylight-saving ramble has no laugh, no chat spike and no viewer clip, so no queue. The story expert found it only because it reads on. Experts can now record such a moment (`"found": true`).
- **One moment, one clip.** Three experts confirmed the prank; they are one moment. The most confident verdict leads and the others are shown to the extractor as second readings with their own cuts.
- **Cost is high.** About 1.15 million tokens for this one half hour with the session's model, or roughly 230k per moment found. That run also wrote protocol notes, hit bugs that are now fixed and transcribed piecemeal, so it is an upper bound, but the shape is real: three experts on every 30-minute segment of a 6-hour stream is 36 runs. See "Still open".

**What the experts' notes changed** (all fixed and tested during the audit)

| Note | Fix |
|---|---|
| A cached still was wrong: three different seconds were one byte-identical file, made before the footage was on disk. An expert noticed only because the on-screen chat ran backwards. | `clip frames` replaces stills older than the local footage, refetches stills that come back identical for different seconds, never keeps or prints one it cannot trust, and keys the cache on width too (`src/ingest/frames.ts`). |
| The read-on trigger never fired for the queue that needed it: found by a viewer clip, no chat spike, so "mood neutral, doubt 0" while 17 chatters typed fake/AI/cap. | Chat is read over every queue's whole region, spike or not: mood, top messages, doubt and slurs. |
| Three of eight meme spikes were chat answering a question he asked ("yes ×21, NO ×9"). | A yes/no vote is detected and is not a witness: the segment went from 21 queues to 15 with no real moment lost. Suggestions ("weed ×15") still need the expert: reject ground `chat-answer`. |
| Three experts saving into one ledger with no lock. | `withVideoLock` around verdict and curation saves. |
| Reads transcribed piecemeal: eleven small Whisper runs by one expert, each renumbering the transcript and re-saving a clip's caption fixes; a read one second past coverage would start Whisper on a sliver. | `clip queues --transcribe range` transcribes the whole segment once, before the experts start (`/queue-check` step 2); slivers under 3 s are ignored. |
| A story with no queue had nowhere to go. | `"found": true` verdicts; `clip windows --queue` works from the ledger for them. |
| Both experts could pass one moment to the other with `other-kind`, and nobody would judge it. | The pending check prints `⚠ nobody judged …`; the protocol says kinds overlap and both may confirm. |
| "Which way do I look from a viewer clip's offset?" | The queue says, per clip: a clip made sooner after its offset than its own length has its content before the offset. |
| No archetype for a prank; no flag for drugs; no ground for "chat is answering his question". | `prank`, `drugs`, `chat-answer` added to the vocabulary. |
| `reason` was asked to carry five different things; `seen` was read by the extractor as "must be inside the cut". | A `cut` field for how to cut it; `reason` is why; `seen` is evidence and may be outside the cut. |
| The window scorer ignored where the expert saw the moment. | `clip windows --queue` scores around the expert's `moment`, shows the expert's own cut scored the same way, and quotes the line at the hit instead of the longest sentence. |
| Slurs in the chat overlay are in the frame, and 640 px stills cannot be read for them. | Queues and candidates warn when chat typed a slur in the window; `--width 1280` fetches a still that can be read; the protocol says to read the whole frame. Another channel's chat shown on screen is still only caught by eye. |
| A queue id can stop resolving when the evidence changes (a new filter, more chat). | A verdict keeps a snapshot of its queue; a queue within 20 s of a judged one of the same kind counts as judged. |
| `--pending` printed the whole ledger; the coverage warning named no ranges; ids are the moment rounded to 5 s; `confidence ≥ 0.5` was stated but not enforced; the window check said 60 s and enforced 90. | All fixed. |
| The vocabulary and the engine changed under a running expert (my edits). It re-read and re-saved correctly. | A rule for the coordinator: change nothing the experts read while they run. |

**Checked afterwards on a scratch copy of the same data** (nothing written to the library): extracting the two confirmed meme moments. The prank was refused as a duplicate of the existing `c01`, as it should be. The misspeak was accepted as a new candidate with `kind: meme`, and drew a `score check:` because the cut ends on a question. A curator drop with "the virality score is low" as its reason was refused three ways (no ground, no weight, already a clip).

**The existing seven Lacy candidates, re-checked by the engine:** six of seven draw a `score check:` ("stop 8, but the first word is 9.2 s in", "payoff 8, but the last line is a question", "hold 7, but there is an 11.4 s stretch with no speech and no reaction"). Only `c01` draws risk warnings: a slur typed in chat during the clip, and the experts' `misleading`, `staged` and `privacy` flags.

## 4. Still open

**Needs you**

1. **`tw-2926144284-c01`** (the BMW prank): drop it, or recut it as the experts suggest (the meme cut is about 1:36:07–1:36:46, after the slur in the on-screen chat at 1:35:58; the story cut runs 1:36:31–1:37:25 and lands on the Ferrari line), titled as a prank, and decide about the order number on screen from 1:36:31. It is rendered, not submitted for review and not posted. Its QA report and its candidate now carry the warnings.
2. **Whether Sonnet's verdicts are good enough for you.** The experts now run on Sonnet 5.5 from a dossier, at about $1.40 per half hour of stream instead of about $46 (section 6). On the trial segment they gave the same verdict as the first run on every queue and found four of its five moments; the fifth was its weakest. If you want the next lever, it is the checkers: suggestion spikes and "shout to another room" still reach the experts as queues. To put the experts back on the session's model for a run, remove `model:` from the three files in `.claude/agents/`.
3. **How much edit every posted clip gets** (finding 35).
4. **The 15-second floor for gags.** Every clip is 15–60 s by a locked decision. A jumpscare is four seconds. `tw-2926144284-c04` is 15.7 s with 7.3 s of silence in it, and the editors now refuse to cut that silence because it would take the clip under 15 s. Either gags may be shorter (10 s would fit most), or a short gag needs an aftermath worth keeping. The engine follows the current rule; this is only a flag.
5. **The four new candidates** (`c08`, `c09`, `c11`, `c12`; section 6). The engine marks all four `skip`, and three carry slur warnings for the on-screen chat (`c11` has 15 chat messages with a slur typed during it). `/clip-curator tw-2926144284` is next, or pick by eye in the Studio.

**Not proven yet**

6. **Scores spread now** (section 6: funnel scores 4 to 8, virality 29 to 60 across four candidates). What is open is whether Sonnet scores too low: it put four confirmed moments at 52 to 63 of 100, and all four came out `skip`.
7. **Do the experts' confirms match what you would post?** The calibration set is nine clips. Rate the five confirmed moments 1–5 and compare with `confidence`.
8. **Chat lag is measured on 43 cases** from mostly "Just Chatting" streams. Competitive-game chat may react faster.
9. **Viewer-clip offsets** were settled statistically, not by aligning a clip's audio with the broadcast. One clip download would confirm it.
10. **The on-screen chat delay** (about 5 s) is measured on one stream. The slur warning assumes at least 3 s.
11. **The whole pipeline end to end.** The experts and the extractor have run on real data; curation only on a scratch copy; `/edit` not since its rewrite. Neither `/clip-curator` nor `/edit` has run on Sonnet.
12. **A second fresh stream.** Section 8 ran the whole process on one stream nobody had tuned for, and both the instructions and the engine changed during it (labelled stills, the watch-along rule, four stills for a story). A second stream is the first run of the process as it now stands.
13. **The two forked skills in a new session.** `/clip-extractor` and `/clip-curator` are set to run as their own Sonnet agents. This session had loaded them before the change and ran them inline, so the extraction went through a Sonnet agent started by hand. In a new session, check that `/clip-extractor <id>` comes back as an agent's report.

**Not built**

14. The unattended paths (`clip watch`, `clip batch`, the headless judge) still use the quick pass, not the three experts.
15. The Studio does not show the expert kind, `visual`, the curator's niche and fixes, or the verdict ledger. (`risk:` and `score check:` warnings do show, as candidate warnings.)
16. Per-channel emote meanings. Channels ban and substitute emotes; the lexicon is global.
17. A frame-level check for private information, and for another channel's chat shown on screen. The experts look; nothing detects either.
18. Suggestion spikes ("weed ×15, In-N-Out ×5" after "give me ideas") are not detected as answers; only yes/no votes are.
19. The existing `curation.json` for `tw-2926144284` uses the old free-text niches. It still displays; it was not rewritten.

## 5. What changed, by file

**New**

- `.claude/agents/meme-expert.md`, `virality-expert.md`, `story-expert.md`
- `.claude/skills/queue-check/SKILL.md`
- `agents/README.md`, `vocabulary.md`, `queue-expert.md`, `research.md`
- `src/core/vocabulary.ts`, `src/core/lock.ts`, `src/core/risk.ts`, `src/scan/review.ts`, `src/curate/index.ts`
- `test/candidates.test.ts`, `test/ledgers.test.ts`, `test/lenses.test.ts`
- (2026-11-14, section 6) `src/scan/dossier.ts`, `test/dossier.test.ts`; CLI: `clip queues --dossier [--queue <id>]`, `clip queue-review --evidence`, `clip candidates score --score`
- CLI: `clip vocab`, `clip queue-review`, `clip curate`; `clip queues --transcribe [regions|range]`; `clip windows --queue`; `clip subtitles --no-settings --enable`; `clip candidates add --no-footage`; `clip frames` reports stills it cannot trust

**Rewritten**

- `src/scan/queues.ts`, `src/edit/editors.ts`, `src/ingest/frames.ts`
- `.claude/skills/clip-extractor`, `clip-curator`, `edit`, `subtitle-expert`
- `docs/pipeline.md`, `test/queues.test.ts`, `test/editors.test.ts`

**Changed**

- `src/discover/chatAnalysis.ts` (lexicon, `readChat`), `src/discover/signals/audio.ts` (exported detector), `signals/clips.ts`, `src/ingest/twitch.ts` (`clipSpan`), `src/extract/window.ts`, `src/candidates/index.ts`, `src/candidates/virality.ts`, `src/core/schemas.ts`, `src/edit/subtitles.ts`, `src/review/index.ts`, `src/jobs/pipeline.ts`, `src/judge/index.ts`, `src/ingest/windowed.ts`, `src/ingest/chat.ts`, `src/cli/more.ts`
- `.claude/skills/clip/SKILL.md`, `lenses/*.md`, `CLAUDE.md`, `SCOPE.md`

**Written to your library during the audit**

- `library/tw-2926144284/queue-review.json`: the trial's 21 verdicts (5 confirmed moments).
- `library/tw-2926144284/transcript.json`: more of 1:28–2:02 transcribed (by the coordinator step and the experts' reads); `clips/tw-2926144284-c03` was re-saved each time, to move its one caption fix to the new word numbers.
- `library/tw-2926144284/candidates.json`: warnings and signals refreshed for the seven existing candidates (`clip candidates refresh`); ranks moved slightly because viewer clips now count either side of their offset. A copy from before is in the session scratchpad.
- `exports/tw-2926144284-c01.qa.json`: QA re-run, so the review page shows the two content warnings.
- `library/tw-2926144284/frames/`: stills, including replacements for the stale ones.
- The Studio was restarted to load the changed schemas.

Nothing is committed (the repo still has no commits).

## 6. Delegating to Sonnet 5.5: what it costs and what it keeps (2026-11-14)

The trial in section 3 found the moments and cost too much. This section is what was changed so the
same work runs on a smaller model, and what was measured before trusting it. Costs are at API list
prices (Fable 5.2: $8 in, $40 out, $0.20 cache read per million tokens; Sonnet 5.5: $2, $10, $0.10).
On a subscription they are a yardstick for how much of a usage limit a run takes, not a bill.

### Where the cost was

Read from the trial's own run logs. An agent re-reads its whole conversation on every turn, so a run
costs its turns times everything that has piled up. The three experts worked one command per turn.

| Trial expert (Fable 5.2) | Queues | Turns | Stills read | Cached tokens re-read | Cost |
|---|---|---|---|---|---|
| meme | 8 | 78 | 126 | 16.4 M | $11.89 |
| virality | 2 | 58 | 67 | 8.5 M | $7.16 |
| story | 10 | 133 | 130 | 38.7 M | $26.93 |
| **all three** | 20 | 269 | 323 | 63.6 M | **$45.98** |

That is 13 turns and 16 stills a queue. The "1.15 million tokens" in section 3 was the tool's summary
figure; the logs show what was actually re-read.

### What was changed

| Change | Where |
|---|---|
| **A dossier.** One call prints, for four queues, the evidence, the words (15 s before the region to 25 s after), the read-on (the two minutes after it, when chat asks, and always for a story), and saves stills across the region. | `clip queues --dossier` (`src/scan/dossier.ts`) |
| **The protocol rewritten around it.** Batches of four, every still read in one turn, a written order of decisions, base rates, a budget and a stop, verdicts saved batch by batch. | `agents/queue-expert.md` |
| **The model.** `model: claude-sonnet-5-5` on the three experts; `/clip-extractor` and `/clip-curator` run as their own Sonnet agents (`context: fork`). | `.claude/agents/*.md`, the two skills |
| **Evidence the CLI checks.** A cited frame must be a still that was fetched. A `said:` line must be in the transcript. | `src/scan/review.ts` |
| **A check of every confirm in two turns:** each claim printed next to the still or the line it stands on. | `clip queue-review --evidence`, `/queue-check` step 4 |
| **Anchors for the quality score** (30, 45, 60, 75, 90). It had only "under 60 is a skip". | `agents/vocabulary.md`, section 4 |
| **Chat's doubt on the candidate itself.** Three or more chatters calling a moment fake is a `risk:` warning whether or not an expert flagged it. | `chatDoubtWarnings` (`src/candidates/index.ts`) |
| **A sweep step for the story expert:** read the range once for a story nobody reacted to. | `.claude/agents/story-expert.md` |

### What was measured

The three experts were run again on the same half hour (`tw-2926144284`, 1:30:00–2:00:00) on Sonnet
5.5, each given only its definition file. They worked on a copy of the data, so the real ledger was
never touched: a folder whose `library/<id>/` links to everything in the real one except
`queue-review.json`, with `CLIP_DATA` pointing at it. Their verdicts were then compared with the
trial's, queue by queue.

| Run (Sonnet 5.5) | Queues | Turns | Stills read | Time | Cost |
|---|---|---|---|---|---|
| meme | 6 | 8 | 28 | 97 s | $0.38 |
| virality | 2 | 6 | 10 | 42 s | $0.26 |
| story | 7 | 10 | 41 | 137 s | $0.47 |
| **all three** | 15 | 24 | 79 | under 3 min, in parallel | **$1.11** |
| the story expert's sweep, run separately | – | 10 | 4 | 57 s | $0.31 |
| `/clip-extractor`, five moments | – | 9 | 6 | 72 s | $0.31 |

The segment has 15 queues now, not 20: vote detection removed five since the trial.

- **Cost:** about 40 times less for the segment, 31 times less per queue. Priced on one model, the dossier accounts for about 10 times (fewer turns, each re-reading less) and the model for the other 3.6.
- **Looking:** every still an expert was shown was read (79 of 79). The frame check and the quote check refused nothing. Every Bash call carried the copy's `CLIP_DATA`, and the real ledger's checksum did not change.
- **Verdicts, first pass:** the same verdict as the trial on 14 of the 15 queues both judged, and three of the trial's five moments confirmed (the prank, the confession, the misspeak).
- **The one disagreement** was the misspeak, which the meme expert rejected. Cause: the dossier's stills sat around the shout at 1:52:18 and stopped at 1:52:24; the hand over the mouth is at 1:52:27. The dossier now covers the whole region, edge to edge (up to nine stills, seven for a story). Run again on that queue alone, the meme expert confirmed it.
- **The moment with no queue** (the daylight-saving ramble) was not recorded in the first pass. The trial's story expert found it by initiative. It is now a step, the sweep. Run again, the story expert found it and cut it 1:53:26–1:54:21; the trial's cut was 1:53:26–1:54:22.
- **After both fixes:** the same verdict on 16 of 16, and four of the five moments. The fifth is the banter at 1:47:49, the trial's weakest confirm. Sonnet rejected its queue as chat answering a question, and when a Sonnet agent scored that cut it gave it 52 of 100.
- **Flags:** between them the Sonnet experts flagged the prank `misleading` (all three), `privacy`, `slur`, `profanity` and `harassment`. None flagged `staged`, and one of three saw the order number. Flags are now tied to the cut and to the queue's own warnings, and chat's doubt reaches the candidate from the engine.
- **Confidence runs lower:** 0.5 to 0.6 where the trial gave 0.6 to 0.85. The order is the same. The numbers are not comparable across models.

### The extraction

`/clip-extractor tw-2926144284`, on Sonnet: four new candidates, and the prank refused as a duplicate
of `c01`.

| Candidate | Moment | Window | Quality | Engine |
|---|---|---|---|---|
| `c08` | confession | 1:43:49.6–1:44:07.7 (18.2 s) | 61 | `skip` (virality 54) |
| `c09` | banter | 1:47:14.2–1:47:57.4 (43.2 s) | 52 | `skip` (29) |
| `c12` | misspeak | 1:52:14.6–1:52:35.9 (21.3 s) | 63 | `skip` (35) |
| `c11` | daylight saving | 1:53:25.9–1:54:22.6 (56.7 s) | 60 | `skip` (60) |

- Every window is the expert's cut, to within the 300 ms and 400 ms buffer. The quotes passed the validator. One candidate (`c10`) ended on a question, drew a `score check:`, and was replaced by `c12`, as the skill says.
- **The scores spread** (finding 27): funnel scores 4 to 8, virality 29 to 60. The engine marks all four `skip`. They are modest moments from a quiet half hour and none has a strong witness. `skip` is a ranking, not a drop; the curator decides.
- **The quality score** was first 55 to 60, on a scale with one anchor. With five anchors a second Sonnet reading gave 52 to 63 and the same order. I would put three of them nearer 70, where the engine says `recut`. Treat the number as one reader's judgment.
- It read 6 of the 15 stills it fetched, and said so. The skill now asks for the first frame of each window only, and requires it.
- One footage download failed (a network error on the fourth range of the job); it was fetched again and all four have footage on disk.

### What this does not show

- It is one half hour of one stream, compared with another model's verdicts and not with what performs.
- The two fixes were tested on the queues that exposed them. A fresh segment is the real test.
- `/clip-curator`, `/edit` and `/subtitle-expert` have not been run on Sonnet.
- The forked skills have not been seen forking (item 13 of "Still open").

## 7. The channel is an automated clipper (2026-11-14)

A positioning decision by the user: the channel "goes around and clips and posts content while
referencing the creators and where it's from and what content. Like a free discovery bot, or a content
promoter." It is labelled as an automated clipper. What that changes is built into the tool, so it does
not depend on anyone remembering.

| What | How | Where |
|---|---|---|
| **The creator is named on screen,** for the whole clip. | A `credit` marker (`🎥 twitch.tv/<login>`, a small pill: on the seam between camera and game in a split layout, near the top otherwise). It is a new marker property, `fill: 'clip'`: it draws for the whole clip whatever its own time, so a trim never leaves it short. Every new clip has one. | `markers/credit/`, `src/markers/define.ts`, `projectFromCandidate` |
| **An export without it does not go out.** | The render report records whether the credit was in the picture. QA fails an export without it, and `clip publish` and `clip tiktok upload` refuse one whatever an older QA report says; `--force` does not override it. `clip credit <clip>`, then a render, puts it on an older clip. To post without a credit, turn `creditOnScreen` off in `channel.json`, on purpose. | `renderClip`, `src/qa/index.ts`, `uncredited`, `setCredit` |
| **Every post says whose clip it is and where it is from.** | A `credit` part of the post, between the caption and the hashtags: the creator's channel, the source opened at the second the clip starts, the stream's title and game, a line saying the channel is automated and not affiliated, and how a creator asks for a change. An edited caption cannot lose it. | `creditBlock`, `postBody` (`src/core/post.ts`); `suggestedPost` |
| **The channel's own words are one file.** | `channel.json`: `name`, `disclosure`, `removal`, `creditOnScreen`, `doNotClip`. | `src/core/channel.ts` |
| **A creator who says no is not clipped again.** | `doNotClip`: scanning, clip-making, the YouTube upload and the TikTok upload all refuse. `--force` does not override it. | `optedOut`; `runPass`, `projectFromCandidate`, `publishYoutube`, `uploadTikTokInbox` |
| **The curator knows what the channel is for.** | A clip that only works by making the creator look bad, or is mostly someone else's programme, is `review`. | `.claude/skills/clip-curator/SKILL.md` |

**What it does not solve** is in `docs/pipeline.md` ("Automated clipper: what it does not solve"): a credit
is not permission; the platforms' rules on reused content apply to a channel that says it is
automated exactly as they apply to one that does not; a link in a Shorts description is not
clickable, so the on-screen credit is the pointer that works (`agents/research.md`, item 45); and the
TikTok integration's own terms (`legal/terms.html`) say the uploader has the rights to what is
uploaded.

**Left for the user:** the channel's About text and a real contact for removal requests (the default
says "message this channel"; nothing personal is put in a description by the tool); The older exports are decided (user, 2026-11-14): the
clips already in the review queue were rendered before the credit existed, they are not being
re-rendered, and neither publisher will take them. The channel posts fresh clips.

## 8. The whole process on a fresh stream (2026-11-14)

A stream the tool had never seen: CaseOh, `tw-2927311587`, 4 h 16 min, from the day before. Two half
hours, chosen from the chapters and the viewer clips: **A**, 1:15:00–1:45:00, where he restreams The
Streamer Awards with his camera in a corner; and **B**, 2:38:00–3:08:00, a horror game he plays
himself. Everything delegated ran on Sonnet 5.5, each agent given only its file.

| Stage | Who | What came out | Turns | Cost |
|---|---|---|---|---|
| Scan, transcribe once | engine | A: 54 queues (34 meme, 7 viral, 13 clip). B: 31 (11, 6, 14). About 10 minutes of machine time. | – | – |
| Experts on A | virality expert only | 7 queues: 1 confirm, 5 rejects, 1 merge. It rejected the show's own moments and confirmed the one about him (a joke trading card of him). | 8 | $0.56 |
| Experts on B | meme, virality, story | 31 queues: 8 confirms that were 7 moments, 8 merges, the rest rejects. The story expert confirmed nothing and its sweep found nothing: the words are the game's script. | 31 | $1.69 |
| Check of every confirm | the session | 11 `frame` lines compared with their stills: 9 matched, 2 described a still from another second. Two queues sent back (below). | – | – |
| Two queues re-judged | meme, virality | One confirm became a merge (it was the setup of the next gag); the other kept, with the right frames. 7 moments. | 14 | $0.50 |
| Extraction | `/clip-extractor` | 7 candidates, none refused. | 9 | $0.34 |
| Curation | `/clip-curator` | 3 keep, 4 review, 0 drop. | 4 | $0.18 |
| Edit | `/edit`, one agent a clip, in parallel | Trim, proposals accepted or rejected, captions, title. | 28 | $0.77 |
| Render, QA | engine | 3 exports, QA passed on all three, the credit on each. | – | – |
| **All delegated work** | 11 runs | | **94** | **about $4** |

**In the review queue:** `tw-2927311587-c06` (a wardrobe jumpscare, 19.7 s), `c02` (someone insults his
game daughter, who has his face, 23.5 s), `c07` (he has to share a bed with a talking horse, 42 s).
**Waiting for the user:** `c01` (the trading card: mostly the awards show's picture, flagged
`third-party`), `c04` (a dog that looks dead and is not: flagged `violence`), `c03` and `c05` (small).

**What the run found, and what was changed for it**

| Found | Change |
|---|---|
| **Two `frame` lines described the wrong second.** An agent reads a batch of stills and gets bare pictures back, so it matched them to their times by position. Three agents said so in their notes; the check of every confirm caught two cases, both on the strongest moment. | Every still now has its time in a strip under the picture (`stillLabelFilter`: drawn as a seven-segment display, because this ffmpeg has no text filter). Re-judged with labelled stills, both verdicts cite the right frames. |
| **A watch-along makes queues that are not the streamer's.** The awards show's crowd made 54 queues in half an hour. | `/queue-check` looks at two stills first and sends only the virality expert to a watch-along; protocol rule 12 says what to confirm there. |
| **"Nobody judged" fired three times on moments that had been judged** (a merge by the other expert; a `no-reach` from the meme expert). | `orphanedMoments` counts a merge and a merit reject as judgments. |
| **The story expert read 37 of the 100 stills it was shown,** and said so. | A story queue gets 4 stills, not 7: an instruction to read every still has to be one that can be followed. |
| **Game dialogue is not the streamer's story.** 7 of 14 story queues were passed on as `other-kind`. | A line in the story expert's file. |
| **A title named the wrong person,** and three said "Streamer" or "He". The extractor never read who the creator is. | The skill reads `meta.json` for the creator; `actionOf` puts the creator's name where a title has none; the wrong title was caught by the frame check and went to the curator as a fix. |
| **The post's first line was the extractor's note to itself** ("Setup: wardrobe flashlight build…"). | The caption is the expert's context line; the "from" line is the chapter the clip is in (the game), not the category the stream started in. |
| **The hook line and the credit sat on the creator's face** in the split layout. | The credit sits on the seam between camera and game; the editors put the hook line just under it (`hookYFor`). |
| **`candidates skip` was refused** for the extractor by the session's permission check. | The skill says to leave the candidate and report the corrected window. |

**What it does not show**

- **Whether the clips are good.** Nobody has watched them yet. That is the review queue's job.
- **Publishing.** Nothing was posted. And as scored, nothing could be: the engine marks six of the seven candidates `skip` and one `recut`, and `clip publish` wants `post`. Sonnet scores honest and low (section 6), and the scores are taken before the edit. Either an approved review should be what opens the gate, or the scores should be taken again on the edited cut. That is a decision, not a bug fix.
- **Captions over a game's own subtitles.** `c06` has them off for that reason; `c07` has them on although the game subtitles its characters. One rule is needed.
- **The forked skills.** As in section 6, the stages ran as Sonnet agents started by hand.


## 9. The first Sonnet-coordinated run: ohnePixel, 1:00:00–2:00:00 (2026-11-14)

The handover's "Next" was to run the whole pipeline on the stream that was scanned and waiting. The
stream was **still live** when the run started: the VOD was not published, and Twitch's live HLS
reached back only about 1 h 50 min, so `clip frames` and `downloadSections` returned a single frame
for 1:00–2:00. The run began at 1:05 with a seven-still look, a full transcription from the cached
audio, and the `--live-from-start` fix described below. All delegated work ran on **Claude Sonnet
5.5**; the coordinator ran on the session model.

### What happened

| Stage | Who | What came out | Turns | Cost |
|---|---|---|---|---|
| Look before sending | session | 7 stills: CS2 case opening (1:02), Fermi quiz (1:10, 1:20), Fortnite locker/settings/gameplay (1:28, 1:35, 1:45, 1:55). Both halves are ohnePixel's own content; no watch-along. | – | – |
| Transcribe | engine | 1:00–2:00 fully transcribed from the cached audio (the scan had 21 min of windows). | – | – |
| Experts, 1:00–1:30 | meme, virality, story | 19 queues: **2 confirms** (`clip@1:07:20`, `clip@1:15:00`, both story), 15 rejects, 2 merges. | 26 | $1.18 |
| Check every confirm | session | `queue-review --evidence`: 6 `frame` lines and 6 `said:` lines, **6/6 and 6/6 matched**. No still went back. | – | – |
| Experts, 1:30–2:00 | meme, story | 8 queues: **0 confirms**, 8 rejects after the tie-breaks. Two queues were passed between experts as `other-kind` and decided by fresh runs. | 16 | $0.51 |
| Orphans and tie-breaks | meme, story | 4 queues: `clip@1:20:00`, `clip@1:28:25`, the Crew reveal (`clip@1:40:45` + `meme@1:40:45`), the chest gamble (`clip@1:57:45`). All rejected; no queue left unjudged. | 19 | $0.42 |
| Extraction | `/clip-extractor` | 2 candidates, one per confirmed moment, none refused. | 6 | $0.21 |
| Curation | `/clip-curator` | 2 **review**, 0 keep, 0 drop. Niche `gaming-fail`, fit 55 (`c02`) and 45 (`c01`). | 4 | $0.05 |
| Dry-run edit of `c02` | `/edit` | 36.4 s, 1080×1920, credit on, QA passed; not submitted. | 29 | $0.67 |
| **All delegated** | 11 runs | | **100** | **$3.05** |

The 27 verdicts are 23 rejects, 2 merges and 2 confirms. The two confirms:

| Moment | Verdict | Confidence | Expert cut | What the stills show |
|---|---|---|---|---|
| 1:06:13 | `clip@1:07:20` | 0.5 | 1:05:55–1:06:49 | calculator `11,200,000/`, then the result card `YOU GUESSED 1,120 / ANSWER 360 / Too high`, then the hand-on-chin beat. |
| 1:15:28 | `clip@1:15:00` | 0.6 | 1:15:21–1:16:01 | calculator `12` beside `25m population`, then `148,809,500` vs `2,000,000,000 British pounds`, then the open chat panel. |

`c01` became 1:05:54.8–1:06:51.0 (56.2 s, score 60, viral 27, `skip`); `c02` became
1:15:20.0–1:16:01.4 (41.4 s, score 65, viral 37, `skip`). The expert's cuts were kept because the
scorer's best windows ended before the result cards. Both candidates carry the experts' `slur` flags;
`c02` also carries `privacy` (a pinned public PO box in the open chat panel). The curator left both
for the user, so **no kept clip, no export in the review queue, and the review queue stayed at 17**.

### The dry-run edit of c02

`./clip make tw-2928608594 c02` found a facecam bottom-left and set the split layout. The edit agent
(29 turns) changed the game box to x 0.385 to exclude the chat panel, added the hook
`HE GUESSED UK = 25M PEOPLE`, cut 3 s of silent reading and 2 s after "ah", added one push-in on
"they're as populated as Germany", kept captions on (bold, 78 px, y 0.72), and fixed the garbled
tail. The first render passed QA with the credit, but the frames showed the chat panel **behind the
transparent facecam** and the pinned PO box; the split layout cannot crop that out. The edit agent
said so rather than claiming the curator's fix was met.

A `reframe` crop at the clip start was then tried. It exposed two framing bugs:

- The mixed framing graph ended with `[o1],fps=30,format=yuv420p[v]`, an empty filter name, so
  ffmpeg failed with `No such filter: ''`. Fixed in `src/render/framing.ts`: the final label is
  followed by `fps=…` without the leading comma, and a zero-length span at the clip start is no
  longer pushed. Two tests now cover both.
- With the fix, the split base plus a crop key at the clip start renders. The first visible frame is
  the crop (the 1 s pre-roll is not in the output). The crop removes the chat, the PO box and the
  facecam; it also cuts the left edge of the guess card (`809,500`) and loses the face reaction.

The final dry-run export is 36.4 s, 1080×1920, 3.3 Mbps, `credit: true`, QA passed; four frames were
read. It is **not** in the review queue and nothing was submitted, posted or published. The project
title and the post title were aligned to `ohnePixel guesses 148M on UK dog food, it's 2 BILLION 😭`
(55 characters).

### What was fixed, and what was not

| Found | What was done |
|---|---|
| A live stream's VOD cannot be read beyond Twitch's live window, so stills and sections for the scanned hour come back as one frame. | Added `liveFromStart()` (`src/ingest/media.ts`), used by `clip frames` and every section/audio/full download. Manual check: a 5 s section at 1:05 and the 1:05 still both work while the stream is live. Typecheck and 193 offline tests pass. Caveat: `meta.live` is a snapshot; the flag is true after the stream ends until the meta is refreshed, and `--live-from-start` on an ended VOD was not tested. |
| The mixed framing graph emitted `[o1],fps=…` and no framing could render when a reframe key was inside the cut. | Fixed; two tests. |
| The auto-split cam band is the chat panel behind a transparent facecam. The clip can be made safe with a crop, but the facecam and the left edge of the card are lost. | Not fixed. A mask/background for the cam box, or a rule to use crop-only for streams with a chat overlay, is needed. |
| `clip frames` takes a video id, not a queue id; two experts lost a turn to this. | Not fixed; the protocol's `<id>` is ambiguous. |
| `clip post --title` changed the post title but not `project.title`, so the editor and the post disagreed. | Worked around with `clip set … title=…`; the code should write both, or the review page should read the post title. |
| `tools/agent-runs.py` found no runs: it reads Claude Code logs, and these agents ran in OpenCode sessions. | Measured from `~/.local/share/opencode/opencode.db` instead (cost and tokens below). The project's measurement tool does not cover this harness. |
| The edit agent used 29 turns for one 41 s clip, against 9–10 on CaseOh. | Not fixed; the edit skill has no budget. Its own notes name the chat/crop problem and the missing mask. |

### What it cost

| Measure | Value |
|---|---|
| Delegated runs | 11 |
| Turns | 100 (experts 61, extractor 6, curator 4, edit 29) |
| Cost at API list prices | **$3.05** |
| Tokens | 286 input · 63,799 output · 5,131,384 cache read · 528,245 cache write |
| Wall clock | about 35 min from the first still to the final render, plus the scan (224 s) and ~3 min of transcription |

The 100 turns are close to the CaseOh run's 94, but they produced two review candidates instead of
three review clips. The difference is the 29-turn edit and the four tie-break/orphan runs needed to
close queues two experts had passed to each other. The experts themselves were inside their budget;
the edit was not.

### The first Sonnet-coordinated run: the checklist

- **You looked at stills before sending the experts, and said whether each segment is the
  streamer's own content.** Yes. Seven stills; 1:00–1:30 is ohnePixel's Just Chatting (CS2 case
  opening, then the Fermi quiz), 1:30–2:00 is his Fortnite gameplay. No watch-along.
- **Every expert run stayed inside its budget, and you read each one's notes.** The expert runs did
  (6, 5, 15, 7, 9, 8, 5 and 6 turns). `tools/agent-runs.py` found nothing because it reads Claude
  Code logs, not OpenCode; the costs and token counts above are from the OpenCode database. The
  edit run did **not** stay near the measured 9–10 turns (29). Read every note: the recurring gaps
  are `clip frames` id ambiguity, the moving facecam position, unreadable chat in 640 px stills, and
  the missing mask for chat behind the facecam.
- **You ran `--evidence`, read every still, and say how many `frame` lines matched and what you did
  about the ones that did not.** Yes: 2 confirms, 6 `frame` lines, **6/6 matched**; 6 `said:` lines
  matched too. Nothing was sent back. Segment B had no confirms. `--evidence` prints only confirms,
  so the 23 rejects' `frame` lines were not re-read by the coordinator; that is a gap in the check.
- **Every title and hook line that reached the review queue was checked against a frame or a line,
  and you say which you changed.** No title reached the review queue: both candidates are `review`,
  and the dry-run clip was not submitted. The two candidate titles/hooks were checked against the
  result cards and the quiz question; both are true and name ohnePixel. The edit agent changed the
  `c02` post title to `ohnePixel guesses 148M on UK dog food, it's 2 BILLION 😭`; I aligned
  `project.title` to it. The old title's semicolon and 61-character length were the reason.
- **Each export was rendered with the credit, passed QA, and you looked at a frame of it.** The
  dry-run `c02` export: `credit: true`, 1080×1920, 36.4 s, 3.3 Mbps, QA passed, four frames read.
  The first split render also had the credit and passed QA, but its frames showed the chat behind
  the facecam; it was replaced. The export is **not** submitted, so the review queue is unchanged.
- **You list what you were not sure of, instead of deciding it.** Below.

### What I was not sure of

1. **The live-VOD fix.** `--live-from-start` works on the live stream today. Whether `meta.live`
   should be refreshed when the broadcast ends, and whether the flag is harmless on an ended VOD, is
   untested. It is also not in `npm run test:e2e`.
2. **The two candidates.** Both are `review`; the curator's fit (45/55) and the `slur`/`privacy`
   flags are the user's call. I did not decide keep/drop, and I did not submit them.
3. **The c02 layout.** The split layout shows chat behind the transparent facecam; the crop-only
   layout removes it but loses the face and the left edge of the guess card. Which is acceptable is
   a product decision, not a bug fix.
4. **The `c02` title.** `clip post` and `project.title` disagreed after the edit. I aligned them by
   hand; whether the publisher should read the post title or the project title is a code decision.
5. **The 1:40:45 Crew reveal.** The meme and story experts each passed it to the other; two
   tie-break runs rejected it on merit. It might still be a story if the setup at 1:40:07 is
   included; I did not cut it.
6. **The 1:57:45 chest gamble.** The story expert could not see the chest open in the stills; the
   meme tie-break rejected it as `no-visible-cause`. A viewer clip or a different second might show
   it.
7. **Transcript fixes.** The landing lines are Whisper small.en and were corrected from three model
   transcripts, not from listening. The "ah" vs "yes" at 1:15:33 is unresolved.
8. **The rejects.** `--evidence` only checks confirms. The 23 rejects could contain a confirm with a
   wrong frame or a missed moment; I did not re-read all their stills.
9. **The measurement.** The project's `tools/agent-runs.py` does not see OpenCode subagents. The
   $3.05 is the OpenCode database's list-price estimate, not a bill, and it excludes the
   coordinator session.
10. **The scan's transcript coverage.** It was partial before this run; the `--transcribe range`
    filled it from the cached audio. The audio chunks were downloaded at scan time, so this did not
    test transcribing a live window from scratch.

### What it does not show

- One stream, one hour, one model, one coordinator. There are only two confirmed moments and no
  kept clip, so the normal edit → render → submit path was exercised on a **dry run**, not on a
  kept candidate.
- The publish gate, captions-over-game-subtitles, the Lacy `c01` prank, the waiting Lacy/CaseOh
  candidates, the CaseOh review clips, the channel's About/contact, and the permission questions
  are untouched. They remain the user's decisions (docs/history/handover.md, "Open decisions").
- The live fix and the framing fix have offline tests. `npm run test:e2e` passes 3/3 after the
  change (Twitch API, a real scan pass, a section's real start), but its scan uses an ended
  broadcast, so it does not exercise `--live-from-start` on a live VOD.

## 10. Our process after the Fable/Sonnet runs (2026-11-14)

The user's decision: **do not use Sonnet.** The Sonnet/Fable process was built around Fable's
constraints (a strong, expensive session delegating to a cheaper model). Our process uses the session
itself or a **DeepSeek V4.1 Flash** agent, with a clear, detailed, measured brief.

### What the model change does to the cost

List prices per million tokens:

| Model | Input | Output | Cache read |
|---|---:|---:|---:|
| Claude Sonnet 5.5 | $2.00 | $10.00 | $0.10 |
| DeepSeek V4.1 Flash | $0.15 | $0.60 | $0.003 |

The 11 Sonnet runs in section 9 used 286 input, 63,799 output and 5.13 M cache-read tokens and cost
**$3.05**. The same token counts on DeepSeek V4.1 Flash cost about **$0.054**, roughly 56 times less.
That is not a measured DeepSeek run; it is the arithmetic that changes the constraint. Dollars are no
longer the reason to split work. **Turns, context and hand-offs are.** The model is cheaper, but it
still re-reads its whole conversation every turn, and a second agent still needs a brief, a ledger
and a check.

### The process we adopt

1. **Inline first.** The coordinator does the small stages itself: the range check, the evidence
   check, extraction for one or two moments, curation, the title/hook check and the final frames.
   Spawn an agent only for heavy, independent looking (the three experts, an edit) or when a fresh
   context is the point.
2. **One agent per kind for the range.** Three expert runs for a 60-minute range, not six for two
   half hours. The dossier already batches four queues a call; the agent keeps the same budget and
   saves the second start, the second brief and the second ledger pass. Split only when the context
   or a segment's content clearly demands it.
3. **No `other-kind` ping-pong.** If an expert believes a queue belongs to another kind, it must
   either decide it on merit or name the owner; the coordinator sends it once, with "final decision,
   do not pass it back". In section 9, three tie-break runs cost $0.42 and most of that was avoidable.
4. **Match the expert order to the content.** Talk/quiz segments: story first (it found both confirms
   in section 9 while meme and virality found none); gameplay: meme/virality first. Run the other
   experts on the remaining queues only where a confirm or a strong witness makes it worth it.
5. **Cap the edit.** 12 turns and 6 stills per clip, and choose the layout before placing anything:
   split only when the cam box is clean; crop-only when the facecam sits over chat or the game's own
   UI. Section 9's edit took 29 turns for one 41 s clip.
6. **Build the mask marker.** The split cam band cannot hide a chat panel behind a transparent
   facecam. A `mask`/`cover` marker (a rectangle over the chat in the cam box) keeps the face and
   removes the risk. This is the main quality lever from section 9, not a speed one.
7. **End every run with a preview page.** Both clips, scores, curator decisions, warnings and the
   title/hook check, in one HTML page, opened in the Review pane. The user asked for results first,
   not a wall of text. `ohne-preview.html` is the model.
8. **Make the cost meter harness-aware.** `tools/agent-runs.py` reads Claude Code logs and found
   nothing for section 9. Add an OpenCode-session query (or a `clip cost` command) that prints turns,
   tokens and list-price cost per run, so the next comparison is automatic.
9. **Pick the hour by event density.** Section 9's hour produced 2 confirms in 27 queues, and the
   whole Fortnite half produced none. Before sending experts, rank the candidate ranges by viewer
   clips, strong queue witnesses and chapter content; spend the hour where the stream is doing
   something, not merely where a scan already exists.

### The target for the next run

- Experts: 3 runs, 30–40 turns, about **$0.02–0.05** at DeepSeek list prices.
- Extractor and curator: inline or 2 runs, about **$0.01**.
- Edit: one agent, **12 turns or fewer**, about **$0.01**.
- Wall clock: under 20 minutes from the range check to the preview page, excluding the scan.
- Quality check: compare the DeepSeek verdicts with the Sonnet ones on the same queue set (or a
  fresh segment) and have the user rate the confirmed moments. A cheaper run is only better if the
  confirms still match what the user would post.

`tools/agent-runs.py` cannot measure these yet, so the next run should record the OpenCode session
costs the same way section 9 did.

## 11. The first self/DeepSeek run: HutchMF, ROB RUN (2026-11-14)

The first run under the no-Sonnet policy. The session did the range check, the evidence check,
extraction, curation and the edit inline; the only agents were the three queue experts (DeepSeek V4.1
Flash), one per kind for the whole range, plus one re-check after the evidence gate caught a bad
frame.

**The stream.** `./clip live` → HutchMF, `tw-2928592128`, 6 h 09 m live, ROB RUN. Scanned
`29:00–49:00` (20 min) in 100 s; 5 seeds, the strongest at `42:25–44:25` (chat 8.8×, a viewer clip,
a laugh). The stills were the streamer's own gameplay (no watch-along).

| Stage | Who | Result | Turns | Cost |
|---|---|---|---|---|
| Queues | engine | 18 queues (10 meme, 1 viral, 8 clip, plus the sweep's found moment) | – | – |
| Experts | 3 DeepSeek agents | 9 confirms → **5 moments**: 35:05 banter, 42:45 hostage, 44:55 kill list, 48:35 instant karma, 49:55 mooch. One `other-kind` ping-pong at 0:29:45/0:40:00/0:48:35 was left reported, not re-run. | 37 | ~$0.044 |
| Evidence re-check | 1 DeepSeek agent | The viral verdict's `frame 0:43:49` described a cuffed player; the still showed a distant orange-shorts player. Re-judged: corrected frames and cut `44:23–45:04`. | 7 | ~$0.007 |
| Extraction | session | 5 candidates, none refused: `c01` 60/46, `c02` 68/60, `c03` 78/69 (`recut`), `c04` 60/34, `c05` 55/48. | – | – |
| Curation | session | 1 **keep** (`c02`), 4 **review** (`c03` for harassment/violence; `c01`, `c04`, `c05` for fit). | – | – |
| Edit | session | `c02` full-frame blur-fit + hook + push-in + captions → 21.3 s, credit, QA passed, **in review**. `c03` full-frame blur-fit + hook “THE KILL LIST” + 8 s silent walk cut + boxed captions → 33.0 s, credit, QA passed, **not submitted**. | – | – |
| **All delegated** | 4 runs | | **44** | **~$0.05** |

**Cost.** 218,154 input, 22,462 output, 1,699,712 cache-read tokens; about **$0.051** at DeepSeek
V4.1 Flash list prices. The same expert work in section 9 cost **$1.60** on Sonnet (61 turns). The
turns are comparable; the dollars are about 30 times lower, and the edit/extraction/curation added no
agent at all.

**After the first preview.** The user asked to see all five before deciding. `c01`, `c04` and `c05` were rendered too: `c01`/`c04` first tried the split layout, which framed the roulette table rather than the face, so both were switched to blur-fit; `c05` is blur-fit over the static poster. The user then asked for the **full 16:9 picture in ratio**, not a split or a crop; `c02` and `c03` were re-rendered from split/crop to blur-fit, and all five now use it. All five are in `hutch-preview.html`; only `c02` is in the review queue. Nothing is decided for the user.

**Facecam headroom (user, 2026-11-15).** The split cam band was cover-cropped from the centre, so it cut the top of the streamer's hat/forehead. Added `camTopPad` to the split framing (default **0.04** of the source height) and top-aligned the cam crop in both the ffmpeg `splitChain` and the Studio's `FramedVideo`. Also added `canvasPad` (default **0.04**) to inset the whole split stack top/bottom: the shorter bands let both boxes widen for more horizontal FOV. 195 offline tests pass. All five clips were re-rendered. c02, c01, c03 and c04 now show the full cap/head with a little space above it. c05 is a static poster; its facecam box was widened to `0,0.45 0.25×0.35`, which shows the full head (the game's player list still overlays part of it).

**What the run found**

- **The evidence gate works on a smaller model.** The viral expert confirmed the right moment but
  cited a still that did not show what its line said. `--evidence` caught it; a fresh 7-turn run
  replaced the verdict with nine checked frame lines and the correct cut. This is the failure the
  gate exists for.
- **The notepad is at the right edge.** The kill-list proof (`kill list / friendlyplayer21`) is on the
  right of the 16:9 frame. A 0.72 crop keeps it readable at 18–21 s; a crop that centres the
  character loses it. The title and hook carry the name anyway.
- **The split band shows the game HUD, not chat.** The c02 facecam band has the game's player list
  behind the face, not the Twitch chat; it is the stream's own UI, not a privacy leak.
- **The strongest moment is a review, not a keep.** `c03` scores 78 and reads best, but the in-game
  threat names a player's gamertag and family. The curator left it for the user; the preview shows it
  as a dry run.
- **The 0:48:35 boast is outside the cut.** The "Middle 12, I've never lost" line is before the
  transcript's start; the hook carries it. Without the hook the instant-karma result has no setup.

**What it does not show**

- One stream, 20 minutes, one model. The five moments have not been rated by the user; the DeepSeek
  confirms have not been compared with the Sonnet verdicts on the same queues.
- `c03`'s harassment/violence call is unresolved. `c02` is in the review queue; nobody has watched it
  end to end yet.
- The 0:29:45, 0:40:00 and 0:48:35 `other-kind` warnings remain in the ledger. The 0:48:35 moment is
  covered by the meme confirm; the other two are weak and were left undecided rather than guessed.
- `tools/agent-runs.py` still cannot see these agents; the cost above is from the OpenCode session
  database.

## 12. Second self/DeepSeek run: SypherPK, Pirate Shop token (2026-11-15)

SypherPK was not live, so the run used his latest 4 h VOD `v2926212958` ("FINDING PIRATE SHOP TOKEN
TODAY!") and scanned `2:00:00–2:30:00`. Nine seeds; the strongest was `2:13:34–2:15:23` — a 140-view
viewer clip called “TOKEN RANT”, chat 6.5×, fast speech. The range is Fortnite gameplay with the
facecam bottom-left; no watch-along.

| Stage | Who | Result | Turns | Cost |
|---|---|---|---|---|
| Queues | engine | 18 queues (7 meme, 1 viral, 10 clip) | – | – |
| Experts | 3 DeepSeek agents | 9 confirms → **7 moments**: token rant, tangerine fail, thumbnail, squad-leave, numb confession, ten-years monologue, bot-lobby lesson | 37 | **~$0.04** |
| Evidence | session | Every confirm’s stills read; no frame line mismatch, no queue sent back | – | – |
| Extraction | session | 7 candidates; `c01` 78/69 (`post`), `c06` 70/63 (`recut`), the rest `skip` | – | – |
| Curation | session | 4 **keep** (`c02`, `c03`, `c05`, `c06`), 3 **review** (`c01` self-harm flag outside the cut, `c04` talky, `c07` informational) | – | – |
| Edit | session | all 7 rendered: split + 4% canvas padding + 4% cam headroom; c04 trimmed the YouTube intro and moved the hook; c06 cut the quiet middle | – | – |
| **All delegated** | 3 runs | | **37** | **~$0.04** |

**What the run found**

- **The split + padding defaults hold.** All seven clips use the facecam-top/game-below layout with
  the 4% canvas padding and 4% cam headroom. SypherPK's head is fully in frame; the game band is
  wider. The auto-split found the bottom-left cam on every clip.
- **A risk flag can outlive its cut.** The meme expert flagged `self-harm` for the “blast my head off”
  line at 2:15:08, but the chosen cut ends at 2:14:53. The candidate still carries the flag; the
  curator left `c01` for the user with that explanation rather than clearing it silently.
- **A late start can leave a hook behind.** `c04` originally began on a YouTube video, so it was
  trimmed to the lobby at 2:19:30. The hook marker was still at 2:19:20; it was moved to the new
  start before re-rendering. The clip now opens on the lobby with the hook visible.
- **Talk clip with a quiet middle.** `c06` had a 13 s stretch without speech; the editors cut it and
  the clip is 33.9 s. The landing “yeah, I got the token” is intact.
- **The strongest clip is a review, not a keep.** `c01` scores 78/69 and is the only `post`, but the
  self-harm flag (even though the line is outside the cut) is the user's call.

**Scheduled on YouTube (2026-11-15).** The user kept six SypherPK clips (`c01`–`c06`; `c07` discarded) and added the HutchMF kill-list clip (`tw-2928592128-c03`). All seven were uploaded private and scheduled by YouTube at **19:57:10Z, 20:07:10Z, … 20:57:10Z** (first +5 minutes, then 10-minute gaps). (The links are kept out of the repo.) The batch table is `scheduled-preview.html`. `c01` publishes with the expert's self-harm flag but the line itself is outside its cut; `c07` is not uploaded. **Correction:** the user wanted the uploads themselves spaced 10 minutes, not all uploads now with staggered publish times. `tools/youtube-drip.sh` now does that — one upload every `EVERY_MIN` (10), each `--publish-at` = upload + `LEAD_MIN` (5), skipping clips that already have a publish record; `--dry-run` prints the cadence. The existing seven were left as scheduled because their go-live times are identical to the drip's.

**What it does not show**

- One 30-minute range of one VOD; the user has not rated the seven moments.
- None of the seven was put in the review queue; seven were scheduled directly on YouTube (above).
- The auto-split cam boxes were correct on this stream; c01/c04 on HutchMF needed hand-set boxes, so
  the detector still needs a visual check per channel.

## 13. Trash Taste, YouTube quick pass (2026-11-16)

The user asked to check Trash Taste. The channel is a YouTube podcast, so the stream queue checkers do
not apply: no Twitch chat, no viewer clips. The run used the quick pass — `clip ingest` (1:48 episode,
21,690 caption words, 281 comments, 21 chapters), `clip discover` (20 seeds from comments, laughter
tags and the cold-open teaser), then an in-session read of the transcript and five candidate cuts.
No DeepSeek agents were needed; the engine and the session did the work.

| Stage | Result |
|---|---|
| Source | `YKgdD_eBteY` — “Stop Paying Your Taxes \| Trash Taste #334” (the flat playlist still said “Flying is a Scam”; the metadata title is the one used) |
| Seeds | 20; the strongest were the cold-open/teaser cut at 1:20:30, the YouTube Shorts rant at 49:11 and the MrBeast book story at 1:39:12 |
| Candidates | 5: MrBeast/Joey story (72/63), YouTube Shorts rant (68/59), airline points (65/59), wedding will (62/56), Zuckbot (60/54) |
| Curation | 4 keep (`c01`–`c04`), 1 review (`c05` Zuckbot) |
| Render | All 5 first rendered blur-fit, then re-rendered with `clip reframe --accept` to crop to the active speaker: 1080×1920, credit true, QA passed. c01/c04 open on a filler under the hook; the captions show `****` for a few YouTube-censored words while the audio is uncensored |
| Preview | `trash-preview.html`; nothing submitted or published |

**What the run found**

- **A podcast needs a different framing.** The stream split is wrong for a three-person podcast. The
  default blur-fit shows the whole table and the source's own close-ups; c02 and c04 are already
  close-ups, so they read better than the wide clips.
- **No chat means the signals are weaker.** Comments (281) and caption laughter gave the seeds; the
  strongest seed was the cold-open teaser, not a viewer-clip spike. The quick pass needs the
  transcript read more than a stream does.
- **The title and the chapters disagree.** The metadata title says “Stop Paying Your Taxes”; the
  chapters are weddings, flights, finance, AI, Fire Emblem, movies, Pokémon and the MrBeast book. The
  flat playlist had a different title again. Titles are claims; use the metadata title only as
  context, not as the clip's subject.
- **YouTube censors the transcript, not the audio.** The captions show `[__]`/`****`; the audio has
  the word. The subtitle engine kept the censor marks. If the user wants the audio muted or the
  captions hidden, that is a separate pass.

**Podcast crop (user, 2026-11-16).** The active-speaker crop was tried: `./clip reframe <clip> --accept` tracks faces and adds crop keyframes at the source's camera cuts. It followed the speaker correctly, but the user preferred the blur-fit version (the whole podcast table, with the source's own close-ups doing the work). All five Trash Taste clips were reverted to blur-fit and re-rendered; the reframe markers were removed. `clip reframe` remains available, but it is opt-in, not the podcast default.

**Packaging (2026-11-16).** The old credit was a small "🎥 Trash Taste" pill, and the post buried the full-episode link under the channel line. Changed to a marketer's order:
- on-screen source banner: platform badge + exact handle (`▶ YouTube youtube.com/@TrashTaste`, `🎮 Twitch twitch.tv/hutchmf`), platform colour, whole clip;
- post credit: full episode/stream at the clip's start first, then the creator's channel URL, then title/chapter, disclosure and removal;
- last 2.5 s end card on the Trash Taste clips: `FULL EPISODE · youtube.com/@TrashTaste`;
- cleaned titles (no "Trash Taste's Trash Taste", one emoji);
- `creditLine` uses `info.json` `uploader_url` for YouTube, so the handle is exact.
All five Trash Taste clips re-rendered; `packaging-preview.html` shows the banner, end card, title and description. 195 tests pass.

**Intro line (user, 2026-11-16).** A punchline hook ("OUT OF THE WILL") does not tell a cold viewer what the short is about. Added a separate **clip-intro** agent (`.claude/skills/clip-intro/`, DeepSeek) and `./clip intro <clip> --text "..."`; it reads the clip's words and frames and writes the premise in **4–8 words, max 9**, sentence case, without spending the payoff. The agent ran on the five Trash Taste clips: "OUT OF THE WILL" → "Joey's friends can't make it to his wedding"; "GHOSTED, THEN ASKED" → "MrBeast ghosted Joey's book interview"; "SHORTS ARE A PRISON" → "Connor can't close YouTube Shorts"; "AIRLINE POINTS = SCAM" → "Connor's airline points always get denied"; "ZUCKBOT 5000" → "Jeremy Strong plays an intense Zuckerberg". All re-rendered; the lines fit in two lines in the top band. The editor skill offers this as an **optional review pass**; the user does not want it checked on every clip, so it is not part of the default render step.

**Posted (2026-11-16).** The four kept Trash Taste clips (`c01`–`c04`) went through the new drip uploader; `c05` was left in review. The first upload, c01, is (link kept out of the repo) and is scheduled for 08:28:39Z. The uploader then sleeps 10 minutes between clips and schedules each 5 minutes after its own upload; the remaining links land in `.cache/youtube-drip-trash.log` and `exports/<clip>.publish.json`. This is the first real use of `youtube-drip.sh`.

**What it does not show**

- Five clips from one episode; the user has not rated them.
- The quick pass is not the full expert pipeline; there is no queue ledger or evidence gate for a
  YouTube podcast yet. The next step, if this becomes a regular channel, is a talk-format queue
  checker or a podcast lens with the same evidence checks.
