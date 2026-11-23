# Vocabulary

The words every agent in the pipeline uses, with one meaning each. If two agents use the same word for
different things, the hand-off between them breaks, so this file is the reference.

- The lists that are **checked by the CLI** (archetypes, share triggers, reject grounds, risk flags,
  niches, drop grounds) live in `src/core/vocabulary.ts`. Print them with `./clip vocab [section]`.
  A ledger entry that uses a word outside them is refused.
- Everything else here is **how to talk and reason**: what counts as evidence, the parts of a clip, the
  six scores and what a 2, a 5 and a 9 look like.
- Where a number comes from research or from this library, it says so. `agents/research.md` has the
  sources and how far to trust each.

## 1. Evidence

| Word | Meaning |
|---|---|
| **moment** | The instant the thing happens on stream. Not when chat reacts to it. |
| **witness** | Independent evidence that a moment happened. There are three: `chat`, `reaction`, `clips`. |
| `chat` witness | A chat spike: at least 6 distinct chatters in 10 s and at least 2.2× the channel's normal for the last 5 minutes. Bots, raids and sub bursts do not count. |
| `reaction` witness | A laugh, shout or cheer heard in the audio above the tuned thresholds (laugh ≥ 0.5, shout/cheer ≥ 0.6), or a caption `[laughter]` tag. Gasps, booing and "battle cry" are classifier noise and never count. |
| `clips` witness | A viewer clip whose offset is within one clip length of the moment. More views, more weight. |
| **context** (not a witness) | Fast speech and title words said here. They raise a score; they never make a queue on their own. |
| **chat lag** | Chat trails the moment. In this library the chat peak came a median 17.5 s after the laugh or scream it reacted to (middle half: 7.5–27.5 s, 43 cases). So the moment is *before* the spike. |
| **anchor** | What fixed the moment's time. `audio`: a reaction, exact. `clip`: a viewer clip offset, good to about one clip length either way. `chat`: estimated from the lag, good to about ±10 s. An estimated anchor means: find the moment in frames before cutting. |
| **queue** | A lead: a region around a moment, with its witnesses, evidence and risks. Id = kind + the moment's time rounded down to 5 s, e.g. `meme@1:46:25` for a moment at 1:46:27. A queue is not a clip. |
| **region** | The stretch of video a queue covers. It can be wider than a clip (up to 90 s). It is where to look. |
| **window** | A proposed clip: a start and an end, 15–60 s. `clip windows` scores several per queue. |
| **buffer** | 300 ms before the first word and 400 ms after the last. It is part of the clip; the validator keeps it. |
| **candidate** | A validated window with a title, hook, reason, quote and scores. Lives in `candidates.json`. |
| **visual candidate** | A candidate with no quote (`"visual": true`): nothing is said, or the words are not the point. It is accepted only if a witness is inside it. |
| **coverage** | What has been fetched for a range: chat, audio, transcript, viewer clips. Streams are only covered where they were scanned. |
| **blind** | A range with no chat and no audio coverage. "No queues" there means nobody looked. **Unknown is never quiet.** |
| **convergence** | 0–1: how many independent signals agree on a candidate's range. The engine computes it. |

## 2. What chat is saying

`clip queues` and `clip chat` report a **mood** for a spike when at least three people share it. The
mood is a lead for the expert, never a verdict: emote meaning is set by use and differs by channel.

| Mood | Chat is… | Typical tokens | What it tells you |
|---|---|---|---|
| `funny` | laughing | KEKW, LULW, OMEGALUL, ICANT, LMAO, 💀, 😭 | A gag landed. Find what they are laughing at; it must be visible or audible in the clip. |
| `hype` | cheering | POG, W, LETSGO, EZ Clap, GOATED | A play or a win. A highlight, not a gag. |
| `shock` | in disbelief | ???, WTF, HUH, "no way", NO (shouted) | Something unexpected. Could be a gag, a fail or a reveal. |
| `tension` | afraid | monkaS, monkaW, "oh no", "behind you" | A build-up. **The payoff has not happened yet: read on.** |
| `fail` | mocking a loss | L, o7, "cooked", "it's over", F, gg | A mistake or a death. Check the boast or the attempt is in the clip. |
| `rage` | watching a meltdown | "crashout", MALDING, Madge | The streamer is losing it. Start at the trigger. |
| `cringe` | wincing | Stare, "ayo", "pause", yikes, Erm | Awkwardness or innuendo. Check what was said before posting. |
| `irony` | ahead of the streamer, or not buying it | Clueless, Aware, COPIUM, pepeLaugh, "cinema", cap, LARP, "AI" | Chat knows something the streamer doesn't, or thinks it is fake. **Read on past the region, and do not title it as fact.** |
| `agree` | backing a take | TRUE, REAL, based, "W take" | An opinion landed. Evidence for a hot-take clip, not for a gag. |

Also reported:

- **event**: a raid (another channel arriving) or a burst of subs / a hype train. Busy chat, nothing on stream. Never a witness.
- **copypasta**: several people pasting one long message. Usually boredom or a chat meme.
- **doubt**: how many people call it fake, staged, a lie or AI. Three or more is a risk line on the queue.
- **clip requests**: people typing "clip it". Two or more is noted; it is viewers telling you.

Traps:

- Laugh tokens are background noise in big chats. What matters is the spike above *this channel's* normal, not the presence of KEKW.
- Some tokens flip meaning: "cinema" and "W" right after a fail are sarcasm; "gg" can be sincere; 💀 and 😭 mean laughing.
- A channel can ban an emote and laugh with another. If a channel's chat laughs with something not in the lexicon (`src/discover/chatAnalysis.ts`), the mood reads `neutral`: read the top messages yourself.
- Chat reacts to things the clip cannot show: a poll, a prediction, a donation message, another chatter. That is reject ground `chat-only`.

## 3. The parts of a clip

| Word | Meaning |
|---|---|
| **cold viewer** | Someone who has never seen this streamer. Shorts feeds show a clip to strangers first, so the cold viewer is who you cut for. |
| **lead-in** | Seconds from the first frame to the first thing that happens. Over ~2 s is a **slow open**; over 4 s with nothing at all is a **dead open**. |
| **cold open** | The first frame is already inside the moment. No greeting, no menu. |
| **peak-first open** | The payoff frame shown in second one, then the rewind to the setup. |
| **hook** | What makes a stranger stay past the first seconds. **Visual hook**: frame one reads on mute (motion, a target, a reacting face). **Verbal hook**: the first line states a claim, a stake or a question. **Text hook**: an on-screen line, 6 words or fewer, naming the premise. |
| **setup** | What the viewer must know for the payoff to mean something. |
| **turn** | Where the expected thing stops and the unexpected thing starts. |
| **payoff** | The single event the opening promised: the punchline, the fall, the answer. |
| **reaction beat** | One or two seconds of face or laughter confirming it landed. |
| **button** | The last line or laugh that closes the clip. |
| **hard out** | Cutting within about 2 s of the button. |
| **late out** | The clip keeps running after the peak. **Early out**: it stops before the reaction or the answer. |
| **open loop** | A question the clip has raised and not yet answered. Good until the end; fatal at the end. |
| **re-hook** | A new stake or escalation mid-clip that restarts attention. |
| **beat density** | Distinct things happening per 10 seconds. |
| **dead air** | 1 s or more between words with nothing audible in it. A laugh or a scream is not dead air. |
| **comic pause** | A silence that runs into a reaction. It is the timing of the joke. Never cut it. |
| **context debt** | Facts a cold viewer needs before the payoff makes sense. |
| **context line** | One line of on-screen text or title that pays that debt. If one line cannot pay it, the clip is fan-only. |
| **mute test** | Is it understandable with the sound off, from frames plus one caption line? |
| **loop** | The last frame flows into the first, so a replay feels like a continuation. |

## 4. The six scores (the funnel)

The judge and the extractor score every candidate 0–10 on six qualities. The engine turns them into a
0–100 virality number, a rank and a verdict (`src/candidates/virality.ts`). **You supply honest scores;
you never apply the gate, and you never nudge a score to reach "post".**

What a 2, a 5 and a 9 look like. These are anchors written from the research in `agents/research.md`;
they are judgment aids, not measured thresholds.

| Score | It asks | 2 | 5 | 9 |
|---|---|---|---|---|
| `stop` | Would a stranger stay past the first 2 s? | Opens on silence, a menu or filler; nothing readable for 3 s or more. | Something happens within ~2 s, but frame one does not show what is at stake. | Frame one is the peak or a face/target in motion, readable on mute, and it raises one clear question. |
| `hold` | Is there anywhere to leave before the payoff? | The setup fills over half the clip, with dead air or repetition. | It reaches the payoff with one 3–5 s sag and no escalation. | Every few seconds adds a beat on the same question; nothing could be cut. |
| `share` | Would someone send it? | Mildly amusing; no obvious person to send it to. | Lands for people who know the game or the streamer. | A strong, nameable reaction (disbelief, hilarity, outrage) plus an obvious recipient or an argument to have. |
| `standalone` | Does a cold viewer get it? | Needs lore: who they are, what happened earlier, chat memes. | Works once a one-line title or hook supplies the context. | Muted and untitled, a stranger can say who wanted what and what happened. |
| `payoff` | Does it land? | No single moment; it trails off, or the peak is outside the clip. | A real but small or predictable beat; the clip runs on after it. | One unmistakable beat that exceeds the setup, then at most 2 s of reaction and out. |
| `delivery` | Did it give what the opening promised? | The opening or the title promises something the clip never shows. | The promise is kept in kind, but late, diluted or smaller than teased. | Exactly what the first 2 s tee up happens, at full intensity, as the final beat. |

How to score so the numbers mean something:

1. **Rank first, then score.** For each quality, order the batch from best to worst. Then give numbers that keep that order. If every clip gets 7–8 on everything, the scores cannot rank and the batch note from `clip candidates add` will say so.
2. **One observation per score.** For any score of 8 or more, or 4 or less, the `reason` says what you saw: a time, a line, what is on screen.
3. **Use the range.** Most real moments in an ordinary hour are 5–7. A 9 is the best thing in the stream. A 2 is allowed.
4. **Score the cut you are adding**, not the moment in your head. If the window ends on a question, `payoff` and `delivery` are low even if the answer exists ten seconds later; fix the window or score what is there.
5. **The engine checks you.** `score check:` warnings appear when the transcript contradicts a score (stop 8 on a 3 s silent open, payoff 8 ending on a question, share 8 with no witness, hold 8 over a 5 s gap). Fix the window or the score; do not ignore them.

`score` (0–100) is separate: is this a good moment at all, before packaging? The engine marks a
candidate under 60 `skip`, and one at 70 or more that misses the post bar `recut`. Score it by these
anchors, not by feel:

| `score` | Means |
|---|---|
| **90** | The best thing in the stream. People were already clipping it. |
| **75** | A clear moment: a cause you can point at and a reaction to it, or a line people would repeat. |
| **60** | A real but modest moment: it has a point and a stranger gets it, but nobody on stream or in chat reacted much. |
| **45** | Something happens, and it does not land unless you were there. |
| **30** | Nothing happens. |

A moment the experts confirmed is a real moment, so it is 60 or more, unless the cut you can make
loses what they saw (the setup does not fit, the payoff is outside the window). Then score what the
cut holds, and say in `reason` what it lost.

## 5. Naming a moment, and what can go wrong

All of these are printed by `./clip vocab` with a one-line meaning each.

- **Archetype** (`clip vocab archetypes`): what kind of moment it is, with where it should be cut. Gags: `jumpscare`, `fail`, `instant-karma`, `rage`, `deadpan`, `caught-lacking`, `awkward-silence`, `chat-roast`, `interruption`, `glitch`, `pop-off`, `misspeak`, `reaction-face`, `absurd`, `prank`. Stories: `anecdote`, `confession`, `hot-take`, `argument`, `reveal`, `banter`, `lesson`, `wholesome`.
- **Share trigger** (`clip vocab triggers`): why a stranger would send it: `hilarity`, `disbelief`, `awe`, `outrage`, `debate`, `relatable`, `warmth`, `drama`, `news`, `useful`, or `none`.
- **Reject ground** (`clip vocab rejects`): why a queue is not a clip: `no-visible-cause`, `chat-only`, `event-not-moment`, `chat-answer`, `lore`, `nothing-happened`, `no-reach`, `other-kind`, `duplicate`, `muted`, `unsafe`, `not-english`, `broken`.
- **Risk flag** (`clip vocab risks`): what a person must check before posting: `privacy`, `minor`, `sexual`, `slur`, `harassment`, `self-harm`, `violence`, `drugs`, `music`, `third-party`, `profanity`, `misleading`, `staged`. Flagging is not rejecting.
- **Niche** (`clip vocab niches`): where a clip belongs: `reaction-meme`, `funny-banter`, `story`, `hot-take`, `gaming-highlight`, `gaming-fail`, `irl-moment`, `drama`, `wholesome`, `useful`, and `none` (only on a drop).
- **Drop ground** (`clip vocab drops`): the only reasons to drop a candidate: `no-niche`, `duplicate`, `muted`, `broken`, `unsafe`, `not-english`. A low score is not on the list.

Failure modes, by name (use these words in a `reason`):

| Name | What it is |
|---|---|
| **hook/payoff mismatch** | The opening promises more than arrives. Wins the first seconds, loses the rest. |
| **slow open** | Over ~2 s before anything happens. |
| **buried lede** | The best moment is mid-clip and nothing teases it. |
| **over-long setup** | The setup is longer than the payoff repays. |
| **late out / early out** | Runs on after the peak / stops before the reaction or the answer. |
| **flat line** | Constant energy; no escalation. |
| **fan-only** | The payoff is a callback or an in-joke. |
| **had-to-be-there** | The tension lived in chat or the live moment and is not in the clip. |
| **told as fact** | The clip or its title states something the stream later shows was a joke, a prank or wrong. |

## 6. Verdict words, by stage

| Stage | Who | Words | Where it is written |
|---|---|---|---|
| Queue | the three experts | `confirm`, `reject`, `merge` | `library/<id>/queue-review.json` via `clip queue-review` |
| Candidate | the engine, from the scores | `post`, `recut`, `skip` | `candidates.json` |
| Curation | the curator | `keep`, `review`, `drop` | `library/<id>/curation.json` via `clip curate` |
| Edit | the editors | proposed markers, accepted or rejected | the clip's `project.json` |
| Review | the user | `approved`, `changes`, `rejected` | the clip's `review` + `library/feedback.jsonl` |
