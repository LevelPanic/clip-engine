---
name: clip-intro
description: Write the one-line premise that sits in a clip's hook text. It reads the clip, finds the subject, the action and the stake, and writes the fewest words (4–8, max 9) that make the moment legible to a cold viewer. It is not a title and it does not give away the punchline. Use only when the user asks for an intro-line review; it is not part of the default pipeline.
argument-hint: <clipId...>
allowed-tools: Bash(./clip:*), Read
context: fork
agent: general-purpose
model: opencode-go/deepseek-v4.1-flash
---

# /clip-intro: the premise in the fewest words

This is an **optional review pass** — run it when the user asks for it, not on every clip. You write
the line that appears in the first two seconds of the short, under the source banner.
A viewer sees it before they hear anything. It has to answer one question: **what is this about?**

It is not a title. The title can tease. The intro sentence has to explain the setup so the clip
clicks, without spending the punchline.

## The line

- **4–8 words. Nine is the hard maximum.**
- **Sentence case**, not ALL CAPS. One clear sentence, no full stop.
- **Subject + action + stake.** A person, what they are doing, and why it matters.
- **Explain, do not tease.** "Out of the will" is a punchline. "His friend skipped the wedding"
  is the premise. The second one makes the first one land.
- **No bare pronouns.** He/she/his/her/they is a hole. Name the person or the show. Use the frames,
  the source's close-ups and the transcript to identify who is speaking; if you cannot tell, use the
  show name or rewrite the line. "Connor can't close YouTube Shorts," not "He can't
  close…"; "Joey's friends can't make it to his wedding," not "His friends…".
- **Fit under the banner.** The intro sits below the source banner; at the hook's size (78 px in the `street` look, 66 px in the others) it should fit
  in two lines. If it wraps to three, cut a detail (the platform, the qualifier) or name the person and
  drop the rest. The banner must stay visible.
- **Name the creator or show only when a cold viewer needs it.** "MrBeast ghosted his book
  interview" is clearer than "He got ghosted."
- **Do not spoil the payoff.** Say what the setup is, not what the joke turns into.
- **No claim the clip does not support.** No "furious", "destroyed", "exposed" unless the frames or
  words show it.
- **No quotes, no profanity, no hashtags, no emoji.** The banner and title already carry the brand.

Examples:

| Moment | Not this | This |
|---|---|---|
| A friend can't fly to the wedding; the hosts joke about the will | OUT OF THE WILL | Joey's friend skipped the wedding |
| MrBeast ghosts a book interview, then asks to come on the show | GHOSTED, THEN ASKED | MrBeast ghosted his book interview |
| The Android YouTube app won't let Connor close Shorts | SHORTS ARE A PRISON | Connor can't close YouTube Shorts |
| Airline points never get Connor an upgrade, until the gate | AIRLINE POINTS = SCAM | Connor's airline points always get denied |
| He opens his own reacts channel to an unhinged thumbnail | ZUCKBOT 5000 | His own thumbnail is unhinged |

## Work

One clip at a time, or a batch in the same run. For each:

1. **Read the clip.** `./clip show <clipId>` — title, source, segments, existing hook, captions.
   The hook is the `text` line at the clip's opening, in the style the caption look gives it (`street`, `comment` or the older `hook`). If there is none, say so; `./clip intro` adds one.
2. **Read the words.** `./clip transcript <videoId> --from <in − 5s> --to <out + 5s>`. Identify the
   subject, what happens, and the stake. If the clip is visual, read the frames next.
3. **Look at the frame.** `./clip frames <videoId> <in> <mid> <out>` — read every still. The line
   must be true to what is on screen.
4. **Write the line.** Count the words. If it is over 9, cut it. If it is under 4, add the subject.
5. **Apply it.** `./clip intro <clipId> --text "Joey's friend skipped the wedding"` — this updates the
   hook marker in place; it does not add a second one. Do not render.

## Finish

A table: clip, old line, new line, word count, and one line on why it explains the moment. If a clip
already has a line that passes the test, say "kept" and do not change it.

Budget: about 2 turns per clip. At 20 turns, save what you have and report the rest. Do not use
Sonnet.
