# Handover: clip-engine, 2026-11-14

This is the prompt for whoever takes the project over from the session of 12–14 November 2026. Read
it once, in full. `CLAUDE.md` (loaded for you) says how the code works. This file says what happened,
what state things are in, how the pipeline was actually run, what broke, and what is still open.

> **Model update (2026-11-14, user):** the Sonnet instructions and measurements in this file are
> historical. The active process uses the session or DeepSeek V4.1 Flash agents with measured briefs;
> see `AUDIT.md` section 10 and `agents/README.md` → “Which model runs what”.

## Start here

1. Run `npm run typecheck` and `npm test` (192 tests, about 2 s). Both passed when this was written, and `npm run test:e2e` passed 3 of 3 the same day.
2. Read `SCOPE.md` → "The idea", then → Roadmap → "Where we left off" and "On the plate". `AUDIT.md` sections 6, 7 and 8 are the detail behind this file; sections 1–5 are the audit behind those.
3. Do not commit, post, publish or upload anything unless the user asks. The repository has no commits at all, by the user's choice so far.
4. Keep `SCOPE.md` → "Where we left off" current as you work, and write what a run found into `AUDIT.md`.

## The user

- One person building this for their own channel, aiming at about 100 shorts a day. They write briefly, test little themselves, and expect you to test thoroughly (real renders, the Studio in the browser) and to find and fix bugs yourself.
- **They watch their usage limits.** They hit one mid-audit. Looking at stills and reading transcripts goes to subagents with complete, numeric briefs; you coordinate, check and decide. Measure every run: `python3 tools/agent-runs.py --hours 3`.
- **The channel is an automated clipper** (their decision, 14 Nov, their words): it "goes around and clips and posts content while referencing the creators and where it's from and what content. Like a free discovery bot, or a content promoter."
- **Older clips are not retrofitted** (their decision, 14 Nov). Do not offer to re-render them.

## What the project is now

A stream goes through seven stages. The engine does everything that can be computed; agents do the looking; the user decides what is posted.

| Stage | Who | Runs on | How |
|---|---|---|---|
| Scan, queues | engine | – | `./clip scan`, `./clip queues` |
| Verdict on each queue | meme, virality and story experts (`.claude/agents/`) | Sonnet 5.5 | one dossier call per four queues, verdicts through `./clip queue-review` |
| Coordination, check of every confirm | `/queue-check` | the session | `./clip queue-review --evidence` |
| One candidate per confirmed moment | `/clip-extractor` | Sonnet 5.5 | `./clip windows`, `./clip candidates add` |
| Keep, review or drop | `/clip-curator` | Sonnet 5.5 | `./clip curate` |
| Trim, edits, captions, title | `/edit` | the session; on 14 Nov one Sonnet agent per clip | `./clip trim`, `editors`, `accept`, `subtitles`, `post` |
| Render, QA, review queue, publish | engine, then the user | – | `./clip render`, `./clip review`, `./clip publish` |

## What happened, in order

**12 Nov: audit of the agents and the process** (`AUDIT.md` 1–5). The roles in `PROCESS.md` existed mostly as names. Found and fixed:
- The queue checker pointed at the aftermath of a moment: it looked 8 s back from a chat spike, and chat trails a moment by a median of 17.5 s (measured, 43 cases). It also counted raw audio-classifier events, 84% of which are noise. Rewritten (`src/scan/queues.ts`): moment time, witnesses, a gate per kind, coverage ("unknown is not quiet").
- The three experts had no definition. Now: `.claude/agents/*.md`, a shared protocol (`agents/queue-expert.md`), a checked vocabulary (`src/core/vocabulary.ts`, `./clip vocab`), and two checked ledgers (verdicts, curation).
- The editors placed effects at fixed fractions of a clip, overwrote the reviewer's note and turned captions back on; the subtitle engine turned captions off on spoken clips. Rewritten.
- The lens files stated other weights than the code. Docs that state engine numbers are now tested (`test/lenses.test.ts`).
- First trial, on Lacy `tw-2926144284` 1:30:00–2:00:00: 5 moments where the earlier run had 1. It also showed that the existing clip `c01` is a prank titled as a real purchase.

**14 Nov: the delegated roles moved to Sonnet 5.5** (`AUDIT.md` 6). Read from the run logs, the trial's three experts took 269 turns and 323 stills for 20 queues (about $46 at API list prices), one command per turn. Changes: a one-call dossier (`./clip queues --dossier`), the protocol rewritten around it (batches of four, a written order of decisions, a budget and a stop), `model: claude-sonnet-5-5` on the experts, and evidence the CLI checks (a cited frame must be a still that was fetched; a quoted line must be in the transcript). Re-run on the same half hour on Sonnet: 24 turns, 79 stills, about $1.10, the same verdict as the trial on 14 of 15 queues and on 16 of 16 after two fixes, and four of its five moments.

**14 Nov: the channel became an automated clipper** (`AUDIT.md` 7). Built in: a `credit` marker on every new clip (`🎥 twitch.tv/<login>`, on the seam of a split layout); a credit block under every post (creator's channel, source at the clip's first second, stream title and chapter, a line saying the channel is automated and not affiliated); `channel.json` for the channel's own words and a `doNotClip` list; QA and both publishers refuse an export that was not rendered with the credit, even with `--force`.

**14 Nov: the whole process on a fresh stream** (`AUDIT.md` 8). CaseOh `tw-2927311587`, two half hours, everything delegated on Sonnet: 11 runs, 94 turns, about $4. Three clips went to the review queue. The run found and fixed: `frame` lines that described the wrong second (stills now carry their time under the picture), a watch-along segment that made 54 queues from an awards show's crowd, false "nobody judged" alarms, a title that named the wrong person, text over the creator's face in the split layout.

**14 Nov: a second fresh-stream session was started and stopped by the user.** It got as far as scanning ohnePixel `tw-2928608594`, 1:00:00–2:00:00. The scan finished cleanly. Nothing was judged.

## What changed, by place

- **CLI, new or changed:** `queues --dossier [--queue <id>]` and `--transcribe [regions|range]`; `queue-review [file|-]` with `--pending` and `--evidence`; `windows --queue <id>` (repeatable); `vocab [section]`; `curate`; `credit <clip> [--text] [--remove]`; `candidates score --score <n>`; `candidates add --no-footage`; `subtitles --no-settings --enable`; `frames` prints `(no still)` instead of a path it cannot trust.
- **New modules:** `src/core/vocabulary.ts`, `lock.ts`, `risk.ts`, `channel.ts`; `src/scan/review.ts`, `dossier.ts`; `src/curate/index.ts`; `markers/credit/`; `tools/agent-runs.py`.
- **Rewritten:** `src/scan/queues.ts`, `src/edit/editors.ts`, `src/ingest/frames.ts`.
- **Changed:** chat lexicon and reaction detector, window scoring, the candidate validator (visual candidates, score checks, risk and doubt warnings), post text (`creditBlock`, the expert's context line as the caption, the creator's name in titles), the composition (`fill: 'clip'` markers, `seam` in `ClipContext`), the render report (`credit`), QA and both publishers.
- **Agents and docs:** `.claude/agents/` (three experts), `.claude/skills/` (`queue-check` new; `clip-extractor`, `clip-curator`, `edit`, `subtitle-expert` rewritten; the first two are `context: fork` on Sonnet), `agents/` (README, protocol, vocabulary, research), `PROCESS.md`, `AUDIT.md`, `SCOPE.md`, `CONTEXT.md`, `CLAUDE.md`.
- **Tests:** 99 before the audit, 192 now. New suites: `queues`, `editors`, `candidates`, `ledgers`, `lenses` (doc-sync), `dossier`, `credit`.

## State of the data

| Stream | Scanned | Verdicts | Candidates | Clips |
|---|---|---|---|---|
| Lacy `tw-2926144284` | 1:30:00–3:00:00 and four short ranges | 21, in 1:30:00–2:00:00 only: 5 moments | `c01`–`c07` made before the audit (all scored `post`). `c08`, `c09`, `c11`, `c12` added 14 Nov, scored `skip`, not curated. `c10` skipped. | 7 older clips |
| CaseOh `tw-2927311587` | 1:00:00–2:00:00, 2:38:00–3:08:00 | 38: 7 moments | `c01`–`c07`. Curator: keep `c02`, `c06`, `c07`; review `c01`, `c03`, `c04`, `c05`. | `c02`, `c06`, `c07`: rendered, QA passed, credited, in review |
| ohnePixel `tw-2928608594` | 1:00:00–2:00:00 | none | none | none |

- **Review queue:** 17 clips. 3 are the credited CaseOh clips. 14 are older and have no credit.
- **All exports:** 49 MP4s, 3 rendered with the credit. The other 46 cannot be published as they are, and by the user's decision they are not being re-rendered.
- **`channel.json`:** the channel's own name, the default disclosure and removal lines, `creditOnScreen: true`, `doNotClip: []`.
- **Posted today:** nothing. The last upload batch is in `CONTEXT.md` (12 Nov, five clips, before the credit existed).
- **Studio:** `./clip open` at http://localhost:4400. It was running when this was written.

## How the pipeline was run

This is the sequence that worked on CaseOh. `/queue-check`, `/clip-extractor`, `/clip-curator` and `/edit` are the documented entry points and say the same thing in more words.

1. **Pick the stream.** `./clip live --limit 30`. English only. Not a broadcast already in `library/`.
2. **Scan an hour,** in the background: `./clip scan <channel> --from 1:00:00 --to 2:00:00` (about six minutes).
3. **Look before sending anyone.** Read the chapters in `library/<id>/meta.json` and the seeds the scan printed, fetch two stills (`./clip frames <id> <time> <time>`) and read them. If someone else's programme fills the frame, the segment is a watch-along: send only the virality expert and tell it so. Choose half-hour segments that are the streamer's own content.
4. **Transcribe each segment once:** `./clip queues <id> --from <A> --to <B> --limit 20 --transcribe range` (two minutes or so).
5. **Start the three experts in parallel,** one agent each. Brief, word for word: "Work in `<project root>` and run every command from that folder. Read the file `.claude/agents/<name>.md` and follow it exactly as your instructions. It tells you which two files to read next. Video `<id>`, range `<A>`–`<B>`, kind `<meme|viral|clip>`. Review every `<kind>` queue in the range. After the table your instructions ask for, add a short section 'Notes on the instructions': the number of turns you used, and at most three lines on anything that was unclear, wrong, or that you had to guess." Starting them by name (`meme-expert`, `virality-expert`, `story-expert`) should do the same in a new session; that has not been seen yet.
6. **Wait on the ledger,** not on the agents' logs: `./clip queue-review <id> --pending --from <A> --to <B>`.
7. **Check every confirm:** `./clip queue-review <id> --evidence --from <A> --to <B>`, then read every still it lists and compare it with the line above it. A still that does not show what its line says goes back to its expert: a new agent, the same brief, "Judge only this queue: `<queueId>`".
8. **Extract, then curate.** `/clip-extractor <id>`, then `/clip-curator <id>`. If a skill loads into your own context instead of coming back as an agent's report, do not run it yourself: start a general-purpose agent with `model: opencode-go/deepseek-v4.1-flash` and tell it to read the skill file and follow it for the video id. Pass the curator anything you verified from frames that the text does not show.
9. **Make the kept clips:** `./clip make <id> <candidateId>`, then wait for the split job (`./clip jobs --active`).
10. **Edit, one agent per clip.** Brief: follow `.claude/skills/edit/SKILL.md` for the clip, steps 1 to 6 and 8 only; do not render or submit; the creator's name; leave the `credit` marker.
11. **Render yourself, with the sandbox disabled:** `./clip render <clip>`. Read QA. Pull a frame from the export and look at it (`ffmpeg -ss 1 -i exports/<clip>.mp4 -frames:v 1 -vf scale=432:-2 <scratch>/frame.jpg`). Check the title and the hook line against a frame or a line: are they true, and do they name the creator?
12. **Submit:** `./clip review <clip> submit`.
13. **Measure and write it down:** `python3 tools/agent-runs.py --hours 3`, a section in `AUDIT.md`, `SCOPE.md` → "Where we left off".

What it cost on CaseOh: experts 8 to 12 turns and $0.50 to $0.70 each; extractor 9 turns; curator 4; edit 9 or 10 a clip; about an hour of wall-clock with scans and renders.

## What will bite you

- **Only the session can render.** `./clip render`, `./clip studio`, `./clip worker` need the sandbox off; a subagent's shell cannot do it. To restart the Studio: `kill $(lsof -ti tcp:4400); ./clip open --no-browser`, sandbox off. A websocket error in the browser console right after a restart is harmless.
- **A subagent can be refused a command outside its brief** by the session's permission check (`candidates skip` was). Do not work around it for the agent. Fix the thing at a later stage, or decide it yourself as part of your own task.
- **A session keeps the skills and agents it loaded.** A file changed after the session started is not picked up. Use a general-purpose agent with `model: opencode-go/deepseek-v4.1-flash` that reads the file.
- **Change nothing an agent reads while it runs:** `src/`, `agents/`, `.claude/agents/`, the vocabulary, the skill it was given.
- **Wait on a real condition** (the ledger, a file, `pgrep` of a command), in an `until … do sleep 5; done` loop. Do not grep an agent's log for a tool name: the name is in every log.
- **The shell is zsh:** an unquoted `$var` is not split into words, and an unquoted `*.ts` that matches nothing is an error. Write arguments out and quote globs.
- **A title is a claim.** The extractor once named the wrong person, and titles used to say "Streamer". Check each against a frame before the clip goes to review. The same for a hook line that says who did something.
- **Sonnet scores low and honestly.** Six of seven CaseOh candidates came out `skip`, one `recut`. That is a ranking, not a drop. But `./clip publish` wants `post` (or `--force`), so nothing from the new process can be published until the user decides what opens the gate.
- **Agents sometimes do less looking than the brief says, and say so.** The story expert read 37 of 100 stills; two edit agents left stills unread. `tools/agent-runs.py` shows stills read against stills shown. Read the "Notes on the instructions" every agent returns: every real gap this session was first named there.
- **A watch-along makes dozens of queues that are not the streamer's.** So does any stream with a crowd. Look at stills first.
- **Twitch footage has holes:** muted ranges (a candidate cannot overlap one), and a live broadcast whose newest minutes return the same still for different seconds.
- **Docs that state engine numbers are tested.** Change `agents/queue-expert.md`, `agents/vocabulary.md`, the lens files and the model lines together with the code, or `npm test` fails.
- **The unattended paths** (`clip watch`, `clip batch`, the headless judge) still use the quick pass, not the experts, and the bundled `claude` CLI they need is not logged in.

## Open decisions, all the user's

1. **What opens the publish gate:** an approved review, or scores taken again on the edited cut.
2. **Captions over a game's own subtitles:** `c06` has them off for that reason, `c07` has them on.
3. **Lacy `c01`:** a prank titled as a real purchase, with an order number and a slur on screen. Rendered, status `editing`, not posted.
4. **Candidates waiting:** Lacy `c08`, `c09`, `c11`, `c12`; CaseOh `c01` (mostly the awards show's picture), `c04` (flagged `violence`), `c03`, `c05` (small).
5. **The three CaseOh clips in the review queue:** nobody has watched them. Frames were checked, not audio or playback.
6. **The channel's own words:** a real contact for removal requests, and the About text.
7. **Permission and platform rules** (`PROCESS.md`, "Automated clipper: what it does not solve"): a credit is not permission, and the TikTok integration's own terms say the uploader has the rights to what is uploaded.

## Not proven

1. **A Sonnet session as the coordinator.** Every delegated stage has run on Sonnet. The coordinator's part has only been done by the stronger model: choosing segments, spotting the watch-along, the check of every confirm, catching the false title, rendering and looking at the export. See the checklist below.
2. **The two forked skills forking.** In the session that set them up they loaded inline, because it had the old versions.
3. **The process as it now stands, on a second stream.** Instructions and engine both changed during the CaseOh run.
4. **Changing the engine on Sonnet.** Routine changes have `npm test`, the doc-sync tests and the e2e run as a net. The redesigns in this session (the queue checker, the dossier, labelled stills) were made on the stronger model.

## Next

Run the whole pipeline on the stream that is scanned and waiting: ohnePixel `tw-2928608594`, 1:00:00–2:00:00. Its chapters are Just Chatting until 1:24:22, then Fortnite. Start at step 3 of "How the pipeline was run".

**The first Sonnet-coordinated run: what would show it works.** Report on each line.

- You looked at stills before sending the experts, and said whether each segment is the streamer's own content.
- Every expert run stayed inside its budget (`tools/agent-runs.py`), and you read each one's notes.
- You ran `--evidence`, read every still, and say how many `frame` lines matched and what you did about the ones that did not.
- Every title and hook line that reached the review queue was checked against a frame or a line, and you say which you changed.
- Each export was rendered with the credit (`credit: true` in `exports/<clip>.json`), passed QA, and you looked at a frame of it.
- You list what you were not sure of, instead of deciding it. A miss you report is worth more here than a clean-looking run.

---

**Run update (2026-11-14):** this run has now been done. The stream was still live; the run used
`--live-from-start` to read the scanned hour, produced 27 verdicts and 2 candidates (both `review`),
and dry-rendered `c02` without submitting it. See `AUDIT.md` section 9 for what happened, what it
cost and the checklist answers; `SCOPE.md` → "Where we left off" has the current state.
