# The agents

Who does what between a stream and a posted clip, what each one reads and writes, and where one hands
over to the next. `PROCESS.md` is the pipeline in order; this file is the cast and the contracts.

## The cast

| Stage | Agent | Defined in | Reads | Runs | Writes |
|---|---|---|---|---|---|
| Moments (watchlist) | the engine | `src/scan/moments.ts`, `src/track/db.ts`, `tools/watchlist.ts` | viewer clips and chat laughter over the whole broadcast | `clip moments`, `clip streams`, `clip track` | `library/tracking.sqlite`; one moment job at a time through the stages below |
| Scan | the engine | `src/scan/` | the broadcast | `clip scan`, `clip watch` | chat, viewer clips, audio events, transcript windows, seeds |
| Queues | the engine (three checkers) | `src/scan/queues.ts` | everything a scan fetched | `clip queues` | nothing: queues are computed, never stored |
| Verdicts | **meme expert**, **virality expert**, **story expert** | `.claude/agents/*.md` + `agents/queue-expert.md` | queues, transcript, frames, chat | `clip queues --dossier`, then `clip frames`, `clip transcript`, `clip chat` where needed | `queue-review.json` via `clip queue-review` |
| Coordination | `/queue-check` | `.claude/skills/queue-check/` | coverage, the ledger | `clip scan`, `clip queues --transcribe`, the three experts, `clip queue-review --evidence` | a report |
| Extraction | `/clip-extractor` | `.claude/skills/clip-extractor/` | confirmed moments, windows, transcript, frames | `clip windows`, `clip candidates add` | `candidates.json` |
| Scoring | the engine | `src/candidates/virality.ts` | the six scores, the signals | on every load | virality, convergence, rank, verdict |
| Curation | `/clip-curator` | `.claude/skills/clip-curator/` | the ranked field, the experts' notes | `clip curate` | `curation.json` |
| Edit | `/edit`, with the **meme editor** and **expert editor** engines | `.claude/skills/edit/`, `src/edit/editors.ts` | the clip, the curator's fixes, the words, the frames | `clip trim`, `clip editors`, `clip marker …`, `clip accept`, `clip render` | `project.json`, the export, QA |
| Captions | `/subtitle-expert`, with the subtitle engine | `.claude/skills/subtitle-expert/`, `src/edit/subtitles.ts` | the clip's words and frames | `clip subtitles`, `clip set`, `clip caption-fix` | caption settings and word fixes |
| Intro line (optional, on request) | `/clip-intro` | `.claude/skills/clip-intro/` | the clip, its words and frames | `clip intro` | the 4–8 word hook text that explains the premise |
| Review | the user | the Studio | everything | Studio, `clip review` | `review`, `feedback.jsonl` |
| Publish | the engine | `src/publish/` | an approved, QA-passed export | `clip publish`, `clip tiktok upload`, `clip tiktok post` | `<clip>.publish.json` |
| Upload scheduler | the engine | `tools/upload-cron.ts` | approvals in `reviews.sqlite` | at most 8 approvals in 24 hours, 3 hours apart (a careful period holds the riskier ones) | the upload, or a refusal on the clip |
| Quick pass | `/clip` (one judge, seeds) | `.claude/skills/clip/` | seeds, transcript, frames | `clip scan`, `clip candidates add` | `candidates.json` |

The quick pass and the full process end in the same place (candidates) and can be mixed: the validator
refuses a second candidate for a moment that already has one.

## Which model runs what

**Active policy (2026-11-14, user): no Sonnet.** The session and every delegated agent run on
**DeepSeek V4.1 Flash** (`opencode-go/deepseek-v4.1-flash`). The session does the small stages
inline; a subagent is for independent, parallel work and gets a written, measured brief: video id,
range, kind, the exact commands, the output format, a turn/still budget and a stop condition. The
Sonnet rows below are the historical Fable-era measurements: they set a quality floor and a turn
budget, not the model to use.

Three tiers. Work goes to the cheapest one that does it reliably.

| Tier | Who | Model | Why here |
|---|---|---|---|
| The engine | scan, the queue checkers, the dossier, window scoring, the validators, editor placement, QA | none | Whatever can be computed is. It costs nothing and gives the same answer twice. |
| Delegated | the three experts, `/clip-extractor`, `/clip-curator` | DeepSeek V4.1 Flash (`opencode-go/deepseek-v4.1-flash`), named by `model:` in each file's frontmatter | Independent, parallel work with a written test and a measured brief. One run per kind for the range, not one per 30 minutes, unless context says otherwise. |
| The session | `/queue-check` (coordination, and the check of every confirm), `/edit`, `/subtitle-expert`, `/clip` | DeepSeek V4.1 Flash (the session) | Small stages and the last look before a person; running them inline avoids a second context and a hand-off. |

**What keeps a delegated run reliable.** None of it depends on the model being clever:

1. **The dossier.** `clip queues --dossier` gathers the words, the read-on and the stills for four queues in one call. The expert's turns go to looking and deciding, and it cannot skip a step the engine did for it.
2. **A written order of decisions,** and a test per expert with numbers in it (`agents/queue-expert.md`, "Decide in this order"; each expert file).
3. **Stills that say which second they are.** The time is printed under every still, so an agent that reads twenty at once cannot attach a description to the wrong one.
4. **Evidence the CLI checks.** A `frame` line must be a still that was fetched. A `said:` line must be in the transcript. Every word must be in the vocabulary. A confirm needs confidence 0.5 or more.
5. **A budget and a stop** (`agents/queue-expert.md`, "Budget"), and verdicts saved batch by batch: a run that is cut off loses four queues at most.
6. **A second look by the session.** `clip queue-review --evidence` puts every confirm next to the stills and lines it stands on, and `/queue-check` reads them all.
7. **No verdict beats a guess.** An expert that cannot decide leaves the queue open and says what was missing.

**Measured on the Fable/Sonnet process (historical).** These are a quality floor and a turn budget,
not the active model. On DeepSeek V4.1 Flash the same token counts cost about $0.05 at list prices;
the target for a 30-minute segment is **one agent per kind**, about 8–12 turns, measured on the next
run. `AUDIT.md`, section 6, has the detail.

| | Model | How it worked | Queues | Turns | Stills read | Cost |
|---|---|---|---|---|---|---|
| Three experts, first trial | Claude Fable 5.2 | one command per turn | 20 | 269 | 323 | about $46 |
| Three experts, Sonnet | Claude Sonnet 5.5 | the dossier, batches of four | 15 | 24 | 79 | about $1.10 |
| The story expert's sweep | Claude Sonnet 5.5 | one read of the range | – | 10 | 4 | about $0.30 |
| `/clip-extractor`, five moments | Claude Sonnet 5.5 | every moment at once | – | 9 | 6 | about $0.30 |

The Sonnet experts gave the same verdict as the first trial on 14 of the 15 queues both judged, and
on 16 of 16 after two fixes (stills across the whole region; the sweep). They found four of its five
moments. Most of the saving is the dossier (about 10 times: fewer turns, each re-reading less); the
model is the other 3.6. The DeepSeek move is a cost and speed decision, not a quality claim: the
dossier and the CLI checks are what make a smaller model reliable, and they are unchanged.

**To change the model:** edit `model:` in the three expert files and the two skills. `npm test` fails
when they disagree or when this section names another model. The measurements in `AUDIT.md` (section
6) are for the model named here; run that calibration again before trusting another one.

## The hand-overs

Every hand-over is a file the CLI checked, not a paragraph one agent wrote for the next.

```
scan ──► queues ──► verdicts ──────► candidates ──► curation ────► clips ──► exports ──► review
         (computed)  queue-review.json  candidates.json  curation.json  project.json   *.mp4 + qa.json
                     clip queue-review  clip candidates  clip curate    saveProject    clip render
                                        add
```

| File | Written by | Checked for |
|---|---|---|
| `library/<id>/queue-review.json` | `clip queue-review` | The queue id resolves to a real queue. A confirm names an archetype, cites a frame (a story also cites words, a viral queue names a trigger) and has confidence 0.5 or more. A cited frame is a still that was fetched; a quoted line is in the transcript. A reject names a ground and what was checked. Every word is in the vocabulary. One writer at a time. |
| `library/<id>/candidates.json` | `clip candidates add` | Inside the video, 15–90 s, not muted or a sponsor read, not a duplicate. The quote is in the transcript, or the clip is `visual` and has a witness inside. Scores are cross-checked against the transcript. |
| `library/<id>/curation.json` | `clip curate` | The candidate exists. A drop has a ground, a removal weight and a reason; a low score is not a ground. Niches are in the vocabulary. Every candidate is covered. |
| `clips/<id>/project.json` | `saveProject` | The project schema; marker parameters against each marker type. |

## Who owns what

One owner per decision. When two agents could change the same thing, the second one leaves a note.

| Decision | Owner | Everyone else |
|---|---|---|
| Is it a moment? | the three experts | The extractor does not second-guess a confirm, and does not extract what was not confirmed. |
| Where the clip starts and ends | the extractor, then `/edit` (trim) | The experts suggest `start`/`end`; the curator lists fixes. |
| The six scores | the extractor or the judge | Nobody applies the gate by hand. The engine computes virality, rank and verdict. |
| Keep, review or drop | the curator | Only `clip curate` changes a candidate's status. The user can reverse any drop. |
| Captions on/off, look, word fixes | the subtitle expert | The editors never change captions; they leave a note. The subtitle engine never turns captions back on by itself. |
| The review note | the user | No agent or engine overwrites it. |
| What gets posted | the user | The upload scheduler posts only what the user approved (5–60 s, passing QA, a real title). `clip publish` by hand needs a `post` verdict and a passing QA, or `--force`. Neither posts an uncredited export or a `doNotClip` creator. |
| Anything flagged `privacy`, `minor`, `slur`, `sexual`, `self-harm`, `misleading`, `staged` | the user | Every agent passes the flag on, word for word, to the next stage and to its reply. |

## Rules every agent follows

1. **Look before you decide.** Chat speed and sounds say where to look. Frames and words say what happened.
2. **Unknown is not quiet.** A range that was not scanned has no result, not a negative result.
3. **Evidence or nothing.** A quote from the transcript, a frame you opened, a witness in range. If you cannot cite it, you did not see it.
4. **Use the vocabulary.** `./clip vocab` and `agents/vocabulary.md`. The ledgers refuse other words.
5. **Fix what the CLI refuses.** A refusal says exactly what is wrong. Resubmit only the fixed entries.
6. **Nothing silent.** No queue without a verdict, no candidate without a decision, no drop without a ground. When you could not do something, say so.
7. **Stay in your stage.** Hand over; do not do the next agent's job.
8. **Say what is true.** A title, a hook or a reason never states a prank, a bit or a retracted claim as fact.

## When a result looks wrong

- **The same clip gets 7–8 on everything:** the batch note from `clip candidates add` says so. Rank first, then score (`agents/vocabulary.md`, section 4).
- **A queue is on the reaction, not the moment:** its anchor is `chat` or `clip`, an estimate. The expert writes the real `moment`.
- **Three near-identical queues:** one moment seen by three checkers. `clip queue-review` groups confirmed verdicts within 20 s into one moment.
- **Zero queues:** read the `⚠` lines. Missing chat or audio means scan; real zero means a quiet segment.
- **A still does not match the ones around it** (the on-screen chat runs backwards, the same picture for two seconds): `clip frames` replaces stills that are older than the local footage and refetches identical ones, and prints `(no still)` when it cannot show a second. A still it prints a path for is the second it names.
- **Chat is huge but nothing happened:** a raid, a sub burst or a yes/no vote. The queue names it and it is not a witness. Suggestions ("weed ×15, In-N-Out ×5") are not detected: that is reject ground `chat-answer`.
- **A slur warning on a clip with clean audio:** chat typed it, and this stream may show chat in the frame. Look at the overlay about 5 s after the time given.
- **Captions came back on, or a note vanished:** that was the old behaviour. The editors and the subtitle engine no longer do it; if it happens, it is a bug.
- **The lens file and the engine disagree:** `npm test` fails (`test/lenses.test.ts`). Change them together.

## Adding or changing an agent

- A **word** the ledgers should accept: add it to `src/core/vocabulary.ts` with a one-line meaning, then to `agents/vocabulary.md`.
- A **chat token**: `LEXICON` in `src/discover/chatAnalysis.ts`, with a test in `test/chat.test.ts`.
- An **expert's judgment**: its file in `.claude/agents/`. Shared steps go in `agents/queue-expert.md`, not in all three.
- A **rule the CLI should enforce**: `checkVerdict` (`src/scan/review.ts`), `checkDecision` (`src/curate/index.ts`), `addCandidates` (`src/candidates/index.ts`), each with a test.
- If a session does not list the three experts by name (some only pick up a new `.claude/agents/` folder after a restart), start a general-purpose agent and tell it to read the definition file.
