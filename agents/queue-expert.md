# The queue expert protocol

Three experts read every segment of a stream: the **meme expert**, the **virality expert** and the
**story expert**. Each has its own definition of "worth a clip" (`.claude/agents/<name>.md`). This file
is what all three do the same way: the steps, the commands, the verdict format and when to stop.

Read `agents/vocabulary.md` once before your first verdict. Use its words.

## What you are given

- A video id (`tw-…` or a YouTube id), a range (`--from`, `--to`) and your kind: `meme`, `viral` or `clip`.
- Sometimes a list of queue ids. Then judge only those (`--queue` in step 1), whether or not the list marks them `✔`: you were sent to look again, and your verdict replaces the earlier one. Otherwise judge every queue of your kind in the range that has no verdict yet, and leave the ones that have one alone.

## What you produce

One **verdict per queue**, saved with `./clip queue-review`, plus a verdict for any moment of your kind
you find that has no queue ("A moment with no queue", below). Nothing else: you do not add candidates,
make clips, edit, render or post. The extractor turns confirmed moments into clips.

| Verdict | Means | Needs |
|---|---|---|
| `confirm` | You saw the moment and it is your kind of clip. | `archetype`, at least one `seen` line that starts `frame <time>:`, `confidence` ≥ 0.5, `reason`. Story: also a `seen` line that starts `said:`. Viral: also `trigger`. |
| `reject` | It is not a clip of your kind. | `rejected` (a ground from `./clip vocab rejects`), at least one `seen` line, `confidence`, `reason`. |
| `merge` | It is part of another queue's moment: its setup, its tail, a second angle on it. | `mergeInto` (that queue's id), `confidence`, `reason`. The extractor ignores a merged queue. |

## Rules

1. **Look before you confirm.** A queue is built from chat speed and sounds. Only frames and words show what happened. No frame looked at, no confirm. The CLI holds you to it: it refuses a `frame <time>:` line for a second no still was fetched for, and a `said:` line that is not in the transcript.
2. **The cause must be in the clip.** If chat is laughing and nothing on screen or in the words explains it, that is `no-visible-cause` or `chat-only`, however big the spike.
3. **Unknown is not quiet.** The `⚠` lines at the top of `clip queues` say what was never fetched, with the ranges. Report them; never write "nothing happened" about a range nobody scanned.
4. **Every queue gets a verdict.** No silent skips. If you cannot decide (stills will not load, the transcript failed), leave it without a verdict and say so in your reply. Do not guess.
5. **You read; you do not scan, or touch candidates and clips.** The coordinator transcribes the whole range (and two minutes either side) before you start, so normally your reads change nothing. Two side effects are expected and fine: the dossier and `clip frames` save the stills they show you, and if you read a part of a stream nobody has transcribed, it is transcribed first (about 20 s, it may fetch a few seconds of audio, and it renumbers the transcript, which moves caption fixes in that video's existing clips to the new numbers). Read as far as your job needs inside the transcribed range; outside it, stay within two minutes of a queue's region.
6. **Times** are `h:mm:ss` or `m:ss`. Past 59 minutes always write the hour (`1:59:30`, never `119:30`).
7. **An estimated moment is a place to search, not a fact.** When the anchor is `chat` or `clip`, find the real moment in frames and write it in `moment`. For a viewer clip the queue's `⚠` line says which side of the offset to look first.
8. **You cannot hear the audio.** Who says a line is inferred from frames and context. When a cut depends on who spoke, say so in `cut`.
9. **The range has soft edges.** A moment inside your range can have its setup just before `--from` and its reaction, or its reveal, just past `--to`. You may look up to two minutes either side. A queue whose moment is outside the range is not yours.
10. **A queue is a place to look, not a claim.** Its own witness may turn out to be nothing (a vote, a shout to another room) while a real moment of your kind sits within a minute of the region. Confirm that moment with `moment`, and say in `reason` what the queue's witness was.
11. **Kinds overlap, and that is fine.** Any expert may use any archetype. A spoken gag (a misspeak, a deadpan line, a prank) can be both the meme expert's and the story expert's; when both confirm it, the two verdicts are grouped into one moment. Use `other-kind` only when you are sure it is not yours, and name the expert you think owns it in `reason`. The coordinator sends it to that expert **once**; do not pass it back.
12. **A watch-along is not the streamer's content.** When someone else's programme fills the frame (an awards show, a match, a video being watched) and the streamer is in a corner, the programme's own moments are not theirs: reject them (`no-reach` for a viral queue; `other-kind` or `nothing-happened` otherwise) and flag `third-party`. Confirm only what is about the streamer: their reaction carrying the clip, a mention of them, their win. Then say in `cut` that the corner camera needs room.

## Steps

Work in **batches of up to four queues**: get the dossier, look, decide, save, then the next batch. A
run that is cut off then loses one batch, not the segment.

1. **Get the dossier.** One command gathers everything for the next four queues that have no verdict:
   ```bash
   ./clip queues <id> --from <A> --to <B> --kind <kind> --dossier
   ```
   If you were given queue ids, ask for exactly those, up to four a call:
   ```bash
   ./clip queues <id> --kind <kind> --dossier --queue <id1> --queue <id2>
   ```
   If it stops with "nothing has been scanned", reply with that line and stop.

   What it prints, top to bottom:
   - **`⚠` lines:** what was never fetched for the range, with the times (rule 3).
   - **`Stream:`** whose stream it is, its title, and the chapter it was in. Use the creator's name in `context`, `reason` and `cut`, never "the streamer": `context` goes under the post, where a viewer reads it. A chapter that is someone else's programme (an awards show, a tournament) means rule 12.
   - **The list:** every queue of your kind in the range, in time order. `✔` has a verdict, `·` has none, `← below` is in this dossier. Read it first: two queues a few seconds apart are usually one scene ("Merging").
   - **One block per queue:**
     - The header has the id, the region, the **moment** and what fixed its time (`audio` is exact; `chat` and `clip` are estimates), the **witnesses the moment itself has** (`chat`, `reaction`, `clips`) and the score.
     - `in the region:` is everything found anywhere in the region, which can be more than the witnesses (a cheer 20 s after the moment is in the region, not at the moment).
     - `chat:` is the most repeated messages over the region, spike or not. `viewer clips:` are their titles: what the people who clipped it thought it was.
     - Every `⚠` line is something to check or to do.
     - `words` is the transcript from 15 s before the region to 25 s after it. `[1:36:25.0]` is when a line starts; `»` is a new speaker, where the transcript knows; `⋯` was never transcribed.
     - The read-on is the two minutes after the region. It is printed when chat calls the moment fake, is ahead of the streamer or is tense, and always for a story. The retraction, the reveal or the better landing is there if there is one. **Read it before you confirm.**
     - `stills` are image paths at the seconds that matter: for an exact moment, 3 s before it, the moment, and 2 s and 6 s after; and for every queue the rest of its region, edge to edge, every few seconds (up to 9 stills a queue, 4 for a story). The moment is where somebody reacted. What they reacted to can be earlier in the region, and what it turned into later.
   - **Last:** the command for the next batch, or a line saying there is none.

2. **Look.** Read **every** still of the batch in one turn: one Read call per path, all in the same message. Every one: a still you did not read is a second you did not look at, and a `frame` line may only describe a still you read.
   - **Each still has its time printed in the black strip under the picture.** A batch comes back as bare pictures, in no order you can rely on: take the time for a `frame` line from the strip, never from the picture's position in the batch. Any still you read counts, whichever queue it was fetched for.
   - `(no still)`, or a `⚠` about identical stills, means you were **not** shown that second. Do not describe it.
   - **Read the whole frame,** not only the person: what is on the monitor (documents, order pages, messages), and the chat overlay if the stream shows chat on screen. A slur in an on-screen chat is in the clip. Chat appears on screen about 5 s after the time `clip chat` gives it.
   - Stills every few seconds do not catch every chat line: in a fast chat a line is on the overlay for about a second. For this channel's own chat, trust the queue's `⚠` about slurs over your stills. Another channel's chat shown on screen (a second stream on a monitor) is covered by nothing but your eyes.

3. **Decide** each queue of the batch, in the order under "Decide in this order", with your own definition (your agent file). Note the risk flags you saw.

4. **Look again only where the first look did not settle it.** At most **two more commands for a queue**. Put the commands for the whole batch in **one** Bash call, `;` between them, then read the new stills in one turn.
   - Another look, at up to four seconds you choose. For an estimated moment you have not found, go to the side the `⚠` line names. Add the first second of your cut when what is on screen there matters.
     ```bash
     ./clip frames <id> <t1> <t2> <t3> <t4>
     ```
   - Small text a flag depends on (an order page, the chat overlay at the second a `⚠` names): up to two wide stills.
     ```bash
     ./clip frames <id> <t1> <t2> --width 1280
     ```
   - More words, when the setup starts before the dossier's words or your cut ends after them:
     ```bash
     ./clip transcript <id> --from <t> --to <t + 2:00>
     ```
   - More chat, when the `chat:` line does not explain what people reacted to:
     ```bash
     ./clip chat <id> --from <moment − 0:10> --to <moment + 0:40>
     ```
   A queue that is still undecided after that gets no verdict: say what was missing in your reply (rule 4). Do not keep looking.

5. **Save the batch.** One JSON array, piped in:
   ```bash
   ./clip queue-review <id> - <<'JSON'
   [
     {
       "queueId": "meme@2:32:15",
       "verdict": "confirm",
       "archetype": "jumpscare",
       "moment": "2:32:16",
       "start": "2:32:14",
       "end": "2:32:30",
       "seen": [
         "frame 2:32:13: a dark room, he is leaning toward the door",
         "frame 2:32:16: a figure with a teddy bear jumps out, he recoils",
         "said: Did I scare ya"
       ],
       "context": "He is checking a noise in the house",
       "cut": "Open no more than 2 s before the scare. The laugh after 'Did I scare ya' is the button; nothing after it is needed.",
       "risks": ["profanity"],
       "confidence": 0.85,
       "reason": "A real startle with the scream on camera and a two-word button. It reads on mute with one line of context."
     },
     {
       "queueId": "meme@2:16:30",
       "verdict": "reject",
       "rejected": "chat-only",
       "seen": ["frame 2:16:28: he is talking calmly", "chat: 'cap' x3, 'LARP' x3 — they are doubting the story, not laughing at a gag"],
       "confidence": 0.8,
       "reason": "Chat is heckling a long story; nothing happens on screen in this region."
     }
   ]
   JSON
   ```
   The command checks every verdict and prints what it refused and why. Fix the refused ones and send **only those** again. Saving a queue again replaces its earlier verdict.
   Then run the next-batch command the dossier printed and go back to step 2. Do not hold verdicts back to save them all at the end: a run that is cut off loses whatever was not saved.

6. **Check nothing is left.**
   ```bash
   ./clip queue-review <id> --pending --from <A> --to <B> --kind <kind>
   ```
   It prints one line: every queue of your kind has a verdict, or the ones that do not. A `⚠ nobody judged …` line under it names a moment every expert passed to another: put it in your reply. The coordinator sends it to the expert who should decide; you do not re-judge it yourself.

7. **Reply** with a short table and nothing else: queue id, verdict, archetype or ground, one line. Then, if any: coverage gaps, queues left without a verdict and why, and risk flags a person must see.

## Decide in this order

Take the first line that applies.

| # | Question | Then |
|---|---|---|
| 1 | **Were you shown it?** A still is missing after a second try, or a story queue has no words. | No verdict. Report the queue and what was missing. |
| 2 | **Is the busy chat an event, or an answer?** The queue says raid, subs or vote; or the streamer asked chat something and chat is answering (a list of suggestions counts). | Reject: `event-not-moment` or `chat-answer`. First check rule 10: is a real moment of your kind within a minute of the region? |
| 3 | **Can you say what happened in one sentence,** from a still or a line you were shown? | If not, reject: `nothing-happened` (nothing stands out on screen or in the words), `no-visible-cause` (people react, and the cause is not in the frames or the words), `chat-only` (chat reacts to chat, a poll or a donation). |
| 4 | **Is it the setup, the tail or a second angle** of another queue of your kind? | Merge into that queue ("Merging"). |
| 5 | **Is it your kind of clip?** Apply the test in your agent file. | If not, reject with the ground your file names. |
| 6 | **Can a 15–60 s cut hold it** and leave out what must not be shown? The nude body or the sex scene **is** the moment → no. | If not, reject: `broken`, `muted`, `not-english` or `unsafe`. |
| 7 | Otherwise | Confirm, with the confidence from the table below. |

**Most queues are not clips.** On the first measured segment the three experts judged 20 queues: 11
rejects, 2 merges, and 7 confirms that were 5 moments. If you are about to confirm everything in a
batch, look at your weakest confirm again before you save.

**Before you save a confirm, check it against what you were shown:**

- Every `frame <time>:` line is a still you read, and says what is in that still.
- Every `said:` line is copied from the words as transcribed, not written from memory.
- `start` to `end` is 15–60 s, contains `moment`, and contains what your archetype needs.
- If the dossier printed a read-on, you read it, and `reason` or `cut` says what it changed, if anything.

## Budget

You re-read your whole conversation on every turn, so a run costs its turns times everything that has
piled up by then. A **turn** is one message of yours with all the tool calls in it. On the first trial
the experts ran one command per turn: 269 turns and 323 stills for 20 queues, which is 13 turns and 16
stills a queue. The dossier exists so that does not happen again.

| | Budget |
|---|---|
| Your instructions | One turn: this file and `agents/vocabulary.md` (and your agent file, if you were told to read it), all in the same message. The word lists are in the vocabulary file; run `./clip vocab` only when a word is refused. |
| A batch of up to four queues | One dossier call. One turn reading its stills. At most one Bash call of follow-ups and one turn reading what it fetched. One save, two if something is refused. |
| Stills | The dossier's (up to 9 a queue, 4 for a story), and at most 4 more a queue, of which at most 2 wide. |
| A whole range | About 2 turns a queue, plus 5. Ten queues: about 25 turns. |
| The stop | At twice that (ten queues: 50 turns), save what you have decided and report the rest as undecided, with what each still needed. |

What wastes turns: one command per message; reading stills one at a time; listing the queues again to
check; reading words the dossier already printed; saving one verdict at a time.

## Fields

| Field | When | What |
|---|---|---|
| `queueId` | always | Copied from `clip queues`, e.g. `viral@1:36:10`. |
| `verdict` | always | `confirm`, `reject` or `merge`. |
| `archetype` | confirm | One of `./clip vocab archetypes`. They describe anyone on stream, not only the streamer. |
| `trigger` | viral confirm | One of `./clip vocab triggers`. `none` is not allowed on a confirm: that is a reject with `no-reach`. |
| `rejected` | reject | One of `./clip vocab rejects`. |
| `mergeInto` | merge | The id of the queue this one belongs to. |
| `moment` | when you found it | Where the moment really is. Must be within a minute of the queue's region, or it is a different moment. The extractor scores its windows around it. |
| `start`, `end` | when you can tell | Where the clip should start and end. The extractor compares them with the window scorer. Story confirms always give them. |
| `seen` | confirm, reject | What you looked at and what it showed. `frame <time>: …`, `said: …`, `chat: …`. A `frame` line names a second you fetched a still for (within a second of it); a `said:` line is words from the transcript, from about 3 minutes before the moment to 4 minutes after it, copied as transcribed (`a … b` quotes two parts). The CLI checks both. It is your evidence, not the clip: a line may be outside the cut (the lie before a prank, the admission after it). Say so: `said (after the cut): I tricked you guys`. |
| `found` | a moment with no queue | `true`. See "A moment with no queue". |
| `reason` | always | **Why** it is, or is not, your kind of clip: one to three sentences naming what happens, in the vocabulary's words. |
| `cut` | when the extractor needs to know | **How** to cut it: what must be inside, what fills the time, which pause not to remove, where a clean out is, what the transcript mishears. |
| `context` | when needed | The one line a cold viewer must be told. Leave it out when nothing is needed. |
| `visual` | when true | Nothing is said, or the words are not the point. The extractor will add it without a quote. |
| `risks` | always (may be empty) | Flags from `./clip vocab risks`. Flagging is not rejecting. |
| `confidence` | always | 0–1: how sure you are of this verdict. See below. |

## Merging

A merge says "this queue is the same moment as that one". Use it for a setup that has its own chat
spike, a tail, or a second queue of your kind on one scene.

- Widen `start` or `end` on the queue you merge into only if the whole clip still fits in 60 s.
- When the part you merge holds something the clip needs but cannot contain (a setup 90 seconds
  earlier, an admission two minutes later), put it in the target's `context` (what the viewer must be
  told) or `cut`, and say in the merge's `reason` what the clip will be missing.
- A queue that is another expert's kind of moment is not a merge. Reject it with `other-kind`, name the owner in `reason`, and leave it; the coordinator sends it once, with "final decision, do not pass it back".
- You may merge into a queue you rejected. It says "the same moment, the same verdict".

## A moment with no queue

The checkers only see witnesses. A story nobody laughed at, or a line chat liked without spiking, has
no queue. If you find one of your kind while reading, inside your range, record it:

```json
{ "queueId": "clip@1:54:05", "verdict": "confirm", "found": true, "archetype": "anecdote",
  "moment": "1:54:06", "start": "1:53:26", "end": "1:54:18",
  "seen": ["frame 1:53:26: he is talking to a handheld camera, alone", "said: the clouds block off the sunlight ray beams"],
  "confidence": 0.6, "reason": "A confident wrong explanation of daylight saving that keeps building; chat calls him out without spiking." }
```

- The id is your kind and the **moment's** time, rounded down to 5 s. Not the cut's start: a moment at 1:54:12 in a cut that starts at 1:53:26 is `clip@1:54:10`.
- It needs `moment`, `start` and `end`, and everything else a confirm needs: you are doing the checker's job as well as your own.
- If a queue already exists there, the CLI says so: give your verdict on that queue instead.
- The story expert looks for these as a step of its own, once its queues are done (its file, "After the queues"). The other two record one when they come across it.

## Confidence

How sure you are of the verdict, whichever verdict it is.

| | For a confirm |
|---|---|
| **0.9** | You saw the cause in a frame, the words or the sound confirm it, and two or more witnesses agree. |
| **0.7** | You saw it; one witness. |
| **0.5** | It is probably there, but the frame is ambiguous or the moment is only heard. |
| below 0.5 | The CLI refuses the confirm. Reject with the ground that fits, or leave it without a verdict and say why. |

Doubt about whether it is true or staged lowers a confirm too: a moment you saw clearly but suspect
was set up is not a 0.9. For a reject or a merge, the number is simply how sure you are that you are
right.

**Confidence also decides whose cut leads.** When two experts confirm the same moment, the more
confident verdict is the one the extractor starts from; the other is shown to it as a second reading,
with its window and its `cut` note. Nothing is lost, but do not mark yourself down out of modesty: if
your cut is the right one for the moment, say so with the number.

## Risk flags

Flag what you actually saw or heard, from `./clip vocab risks`. The common ones on streams:

A flag is about **your cut** (`start` to `end`), or about the whole region when you give no cut. What
you saw outside the cut goes in `cut`, as something the cut must not reach.

- `privacy`: an address, an order or account number, a document, a phone screen, a bystander's face, in any still inside your cut. Look at what is on the monitor, not only at the streamer.
- `misleading`: the stream later shows it was a joke, a prank or wrong. Say what it really was in `reason`, put the true version in `context`, and quote the admission as `said (after the cut): …`. It is often minutes later and does not have to fit in the clip.
- `staged`: the queue has a `⚠ … chatters call it fake, staged or AI` line, or the frames look set up. Flag it whenever that line is there, unless what you read shows chat was wrong; then say so in `reason`.
- `slur`: said in your cut, or **typed in a chat that is on screen** during it. The queue's `⚠` gives the time it was typed; the overlay shows it from about 5 s later, for about 10 s. Inside your cut: flag it. Outside: do not flag it, and say in `cut` which side of it the cut must stay on.
- `profanity`: swearing, said or readable in an on-screen chat. `harassment`: an insult aimed at a person, by name or appearance, said or readable on screen.
- `third-party`: most of the frame is someone else's video being watched.
- `music`: a song is audible for more than a few seconds.
- `drugs`, `sexual`, `minor`, `self-harm`: flag and say where.

A flag does not change your confidence. Flags say what a person must check; confidence says how sure
you are that the moment is there and is your kind. Doubt about whether it is *true* is different: see
"Confidence".

Reject as `unsafe` only when no cut can avoid the problem. Otherwise confirm, flag it, and say in
`cut` what the cut must avoid. **When the nude body or the sex scene is the moment** (a shower, a strip
club, a bed scene: the thing chat is reacting to), no cut avoids it: reject `unsafe`. This channel lost
videos to YouTube for exactly that (2026-11-21), and nudity, a slur said and a minor are never posted,
whatever a reviewer decides.

## When to stop and report instead of deciding

- `clip queues` says nothing has been scanned in the range.
- `clip frames` gives no usable still for a queue twice. (Leave that queue without a verdict.)
- The transcript command fails. (You can still judge a visual moment from frames; a story queue you cannot.)
- A queue's evidence disappears when you list it again ("no queue near … any more"): the data changed. List the range again and judge what is there now.
- You have used twice your budget ("Budget"): save what is decided and report the rest.
- The instructions or the vocabulary change while you work (a word you used is refused, a new one appears in `./clip vocab`): read them again and re-save what the change affects.
