---
name: clip-extractor
description: Turn the moments the queue experts confirmed into clip candidates. For each confirmed moment it reads the weighted windows, checks the words and frames at the edges, picks the start and end that make sense for that kind of moment, scores it and adds one validated candidate. No moment is dropped for a low score. Use after /queue-check and before /clip-curator.
argument-hint: <videoId>
allowed-tools: Bash(./clip:*), Read, Write
context: fork
agent: general-purpose
model: opencode-go/deepseek-v4.1-flash
background: false
---

# /clip-extractor: confirmed moments → one candidate each

Arguments: `$ARGUMENTS` is a video id. Run from the project root. Read `agents/vocabulary.md` first if
you have not this session: the scores and their anchors are defined there.

Your job is the cut and the packaging: where the clip starts and ends, what it is called, how it
scores. The experts already decided *whether* it is a moment. **Every confirmed moment becomes a
candidate.** A low score is information for the curator, not a reason to leave it out.

## How to work: every moment at once

This skill runs as its own agent, on its own. You re-read your whole conversation on every turn, so a
run costs its turns times everything that has piled up by then. Do each step for **all the moments
together**, never one moment at a time. A **turn** is one message of yours with all its tool calls.

| Step | How |
|---|---|
| Read `agents/vocabulary.md` and the moments (step 1) | One turn. |
| The windows for every moment (step 2.1) | One command: repeat `--queue` for each moment. |
| The words at both edges of every chosen window (step 2.4) | One Bash call: one `./clip transcript` per moment, `;` between them. |
| The stills for every moment (step 2.4) | One `./clip frames` call with all the times, then read every path in one turn. |
| Add, fix, list (steps 4 and 5) | One call each. |

Use the Read tool to read files and the Write tool to write `extract.json`. Use Bash only for
`./clip` commands, chained with `;`: any other shell command may need the user's approval, and the
run waits for it.

Five moments took 9 turns in the first measured run. At 30, stop: add the candidates you have, and
report which moments are left and why.

## 1. Read the confirmed moments

```bash
./clip queue-review <videoId> --json; ./clip candidates list <videoId>
```

`moments` is the list: one entry per moment, however many experts flagged it. Each has a `primary`
verdict (the most confident expert) and `also` (the others, and queues merged into it). `./clip
queue-review <videoId>` prints the same thing to read: each moment, its cut note, and every second
reading with its own window. A moment marked "found by the expert" had no checker queue; it is
extracted the same way.

- **A moment job's window** (the watchlist scans one moment: a few minutes) usually has one or two moments. That is the normal size, not a thin result.
- **No moments?** Stop and say so. Either the experts confirmed nothing, or `/queue-check` has not run. Do not extract raw queues: unchecked queues include raids, noise and chat laughing at chat.
- **A moment that already has a candidate** (its `moment` is inside an existing candidate's window): do not extract it again. Put it in your table as "already c0x", and compare that candidate with the verdict. If the experts flagged the moment (`misleading`, `staged`, `privacy`, `slur`…), or their cut differs from the candidate's window by more than a few seconds, say so in the warnings column: that candidate was made before the experts looked.
- Work through the other moments in time order.

## 2. For each moment, choose the window

1. **See what the scorer proposes,** for every moment in one command. Pass each moment's `primary.queueId`. Add a verdict from its `also` list only when that verdict is a `confirm` of a different `kind` from the primary: that is a second reading with its own cut (a meme cut and a story cut of one moment are different windows). Merged and rejected queues in `also` are not passed.
   ```bash
   ./clip windows <videoId> --queue <id1> --queue <id2> --queue <id3> --limit 5
   ```
   Each window is 15–60 s and already includes the buffer (300 ms before the first word, 400 ms after the last). If it says the region is not transcribed, run the command it prints, then this one again.
   - The windows are scored around the moment the expert saw (`moment … (expert)`), not the checker's estimate.
   - `the expert's cut` is the verdict's own `start`–`end`, scored the same way, so you can compare.
2. **Start from the expert's cut** when the verdict has one, and read its `cut` note (`./clip queue-review <videoId>` prints it as "the cut:"): what must be inside, which pause not to remove, where the clean out is. The expert looked at the frames. Use the scorer's windows to tighten the edges to words, or to choose when the expert gave none. When the scorer's best window is shorter than the expert's cut, check what it leaves out before taking it: the scorer cannot know that the lie has to be inside a prank.
3. **Pick the window that:**
   - contains the expert's `moment` (the `seen` lines are the expert's evidence and may be outside the cut: the lie before a prank, the admission after it);
   - opens within about 2 s of the first thing that happens (a word, a scream). The scorer writes `dead open` when it does not;
   - includes what the archetype needs (`./clip vocab archetypes`: the boast for `instant-karma`, the prompt for `deadpan`, the question for `reveal`);
   - ends on the landing line or one beat after the reaction: not on a question, not on "anyway", and not before a reaction the scorer says `follows … after the end`;
   - is as short as it can be and still do all of that.
4. **Check both edges,** for all the moments in one Bash call. Read the words 5 s either side of each window, and fetch the first frame of every window, plus the last frame of any window whose end you moved away from the expert's `end`:
   ```bash
   ./clip transcript <videoId> --from <start1 − 0:05> --to <end1 + 0:05>; ./clip transcript <videoId> --from <start2 − 0:05> --to <end2 + 0:05>; ./clip frames <videoId> <start1> <start2> <end2>
   ```
   Then read **every** still path it prints, in one turn. The first frame is not optional: if it is a menu, a loading screen or a black frame, move that start. Look at the whole frame: an order page, a document or a slur in an on-screen chat at the open is a reason to move the start, or a flag to carry into `reason`. You do not need the moment's own frame: the expert looked at it, and the `seen` lines say what it shows.

One moment, one candidate. When two experts confirmed the same moment, start from the primary
verdict's cut, read the second reading's cut too, and choose: a 20 s gag and a 50 s story of one
scene are different clips, and the stronger one is not always the more confident expert's. Mention
the other reading in `reason` ("also a story: the argument runs on to 1:37:25 and lands on the
Ferrari line"). The validator refuses a second candidate that overlaps the first by half.

## 3. Write the candidate

| Field | Rule |
|---|---|
| `start`, `end` | Strings like `"2:17:39.6"`. A bare number means milliseconds. |
| `title` | 60 characters or fewer. Says what happens, with names: the creator's own name (`channel` in `library/<videoId>/meta.json`; read that file in step 1), never "the streamer" or "he". Name another person only when a frame or a line you were shown says who it is. **True**: if the expert flagged `misleading`, the title says what it really was ("Lacy pranks Ron with a fake BMW order", not "Lacy buys a BMW"). |
| `hook` | On-screen line that names the premise without giving away the punchline: 6 words or fewer for `stream-moments`, 8 or fewer for the talk lenses (`podcast-general`, `hot-takes`). Use the expert's `context` line when the moment needs one. |
| `reason` | What the setup is and what the payoff is, the archetype and the trigger, and an observation for every score of 8 or more or 4 or less. Carry over the expert's risk flags in words. |
| `quote` | 5–20 words copied exactly from the transcript inside the clip, even where it is misheard. |
| `visual` | `true` instead of a quote when the verdict says `visual`, or nothing is said. The validator then requires a witness inside the clip (a reaction heard, a chat spike, a viewer clip). |
| `score` | 0–100: is this a good moment at all? By the anchors in `agents/vocabulary.md`, section 4 (30, 45, 60, 75, 90). A confirmed moment is 60 or more unless your cut loses what the expert saw. |
| `scores` | `stop`, `hold`, `share`, `standalone`, `payoff`, `delivery`, each 0–10, by the anchors in `agents/vocabulary.md`. |
| `lens` | `stream-moments` when the face or the event on screen is half the moment. `podcast-general` when it is banter or a story told in words. `hot-takes` when it is a claim, advice or politics. The lens picks the weights. |
| `kind`, `queueId` | From the primary verdict (`meme`, `viral` or `clip`; e.g. `"meme@2:32:15"`). They are kept so results can be traced back to the expert. |

**Scoring.** Do the whole batch together, after every window is chosen:

1. For each of the six qualities, order the moments from best to worst.
2. Give numbers that keep that order and use the range. Most real moments are 5–7. A 9 is the best thing in the range.
3. Score the cut you are adding. If it ends on a question, `payoff` and `delivery` are low.
4. Do not apply a gate and do not aim for "post". The engine computes virality, rank and the verdict.

## 4. Add and fix

Write the list to `library/<videoId>/extract.json` (a JSON array, one object per candidate, with the fields of the table above), then:

```bash
./clip candidates add <videoId> library/<videoId>/extract.json
```

Read everything it prints.

- **`✖ rejected`**: fix the cause and add *only the fixed ones* from a new file (`extract-2.json`).
  - *quote not found*: copy the words from the transcript inside the window.
  - *lasts … after snapping*: the validator snaps edges to sentence boundaries; widen the window. Snapping can also move an end *later*, onto the end of the next sentence: read the window each accepted candidate prints, not the one you sent.
  - *overlaps muted* or a sponsor read: move the window off it. If the moment is inside it, it cannot be a clip: say so in your reply.
  - *duplicates c0x*: the moment already has a candidate. That is fine; note it.
  - *visual candidate with no evidence*: the window is not on the moment. Move it onto the reaction.
- **`⚠ score check:`** on an accepted candidate: the transcript contradicts a score. Either the window is wrong (fix it: skip the candidate with `./clip candidates skip`, add a corrected one) or the score is (`./clip candidates score <videoId> <id> --stop … --hold … --share … --standalone … --payoff … --delivery …`; `--score …` corrects the quality score).
- **A command is refused** (`candidates skip` can be, when the session's permissions do not cover it): do not look for another way. Leave the candidate, and put the corrected window in the warnings column of your table so the editor trims to it.
- **The batch note** ("all N candidates are within 1 point"): your scores did not discriminate. Rank the batch again and correct them with `clip candidates score`.

## 5. Check the count and hand over

```bash
./clip candidates list <videoId>
```

Every confirmed moment has a candidate, or a stated reason why it cannot (muted, already a candidate).
Reply with a table: moment time, queue id, candidate id, window and length, verdict the engine gave,
warnings. A candidate you skipped and replaced goes in the warnings column of its replacement. Then hand over to `/clip-curator <videoId>`.

Do not make clips, edit or drop anything here.
