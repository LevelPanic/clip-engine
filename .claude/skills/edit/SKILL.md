---
name: edit
description: Edit clips like a short-form editor and send them for review. It fixes the in and out points first, sets the 9:16 layout, runs the meme and expert editors as proposals, checks every proposed edit against the words and the screen, settles captions, renders, reads QA, fixes what fails, checks the post text is true, and submits to the review queue. Use when the user wants clips edited, polished or prepared for review, or after /clip-curator has kept candidates.
argument-hint: <clipId...> | <videoId> | all
allowed-tools: Bash(./clip:*), Read
---

# /edit: clips → edited, rendered, in the review queue

Arguments: `$ARGUMENTS`.

- **Clip ids** (`tw-123-c04`): edit those clips.
- **A video id** (`tw-123`): make a clip for every candidate the curator kept, then edit them.
  ```bash
  ./clip curate <videoId>            # the decisions; take the ones marked keep
  ./clip make <videoId> <candidateId>     # the engine sets the layout (step 3); --no-split only for events with no facecam
  ```
- **`all`**: every clip without a review status (`./clip clips` lists them).

Run everything from the project root. Marker times are source-video times; `+3.2` means 3.2 s after
the clip's in-point. Rendering launches headless Chrome: run `./clip render` with the sandbox disabled.

**Order matters: structure first, then decoration, then captions.** Do not place a zoom on a clip whose
in-point is about to move.

**Budget.** Aim for 12 turns and 6 stills per clip; 15 turns is the hard stop: stop there with what you have and report what is left, do not keep exploring. The engine sets the layout (step 3); do not spend turns on it. **If the brief gives a clip cap** ("at most N clips this pass"), edit only that many, the strongest fit first, and leave the rest as candidates. The
measured CaseOh edit used 9–10 turns a clip; this cap leaves room for one hard layout problem without
turning it into a 29-turn investigation.

For each clip:

## 1. Read the brief

```bash
./clip show <clip>
./clip curate <videoId>
./clip queue-review <videoId>
```

- The clip's in and out, markers, captions and `review.note`. **A clip marked `changes` has the reviewer's note: do what it says first.**
- The curator's `fixes` for this candidate.
- What the expert saw: the archetype (it says how the moment should be cut: `./clip vocab archetypes`), the context line, the risk flags.

## 2. Fix the structure

Read the words and look at the first frame and the moment:

```bash
./clip transcript <videoId> --from <in − 0:03> --to <out + 0:03>
./clip frames <videoId> <in> <moment> <out>
```

Then trim until all of these are true (`./clip trim <clip> --in <time> --out <time>`):

- Something happens within about 2 s of the first frame: a word, a scream, a face. No dead open.
- The first frame is not a menu, a loading screen or black, and shows nothing private (a document, an order or account number, an address, a phone).
- The archetype's setup is inside (the boast before the fail, the prompt before the deadpan reply, the question before the reveal).
- The clip ends on the landing line or one beat after the reaction. Not on a question, not on "anyway".
- It is 15–60 s, and no longer than it needs to be.

The `credit` marker (the creator's name) covers the whole clip however you trim. Leave it where it is.

## 3. Set the layout

**The engine sets the layout. Do not change the framing mode or the split boxes.** Layouts chosen per
clip by an agent were the main cause of bad shorts (an IRL shot split in two, another player's cam in
the camera band, a website cut to its middle half), so the choice is no longer an editing step:

- **Twitch:** `clip render` finds the facecam over the whole clip and splits the picture: the camera
  band is sized to the cam panel (never widened into the game beside it), and the band under it either
  crops the game (`fill`, for a game) or shows the whole frame (`fit`, for Just Chatting, websites,
  IRL and other non-game categories). Everything sits on a blurred cover of the frame; nothing is black.
- **The render checks the framed picture before rendering** (`src/qa/layout.ts`): if a face is in the
  camera band for less than 80% of the clip, the clip is switched to blur-fit and framed again; if a
  part of the picture is black for the whole clip, QA fails with `layout`.
- **YouTube, podcasts, events:** blur-fit. `./clip reframe <clip>` is opt-in; the user tried it on
  Trash Taste and preferred blur-fit, so do not switch a podcast to crop unless asked.
- **If the layout still looks wrong in your stills,** say so in your reply (what is wrong, at which
  second) and leave it for the reviewer. Do not set boxes by hand.

## 4. Get the first pass as proposals

```bash
./clip editors <clip>
```

Both editors write **proposed** markers (dashed in the Studio, not rendered until accepted) and print
notes (lines starting `→`) for things that are not a marker.

- **Meme editor** (`editor:meme`): the vocabulary measured on 175 top clip Shorts (`reports/meme-edits-2026-11-22.md`).
  - **The open:** a premise box (`text` `box`: black on white strips, one emoji) that leaves 0.3 s before the hit. On a silent open (no word for 0.8 s), a zoom-out reveal (`zoom` `direction: out`).
  - **The reactions:** a snap zoom on up to 3 reactions 5 s apart, with a `tilt` (±6°, alternating) when the reaction is a shout. An emoji and a flash on the first.
  - **Beats:** one `tint` beat (green on a win word, pink on affection), and a `counter` when "three, two, one" is said.
  - **Chat and cuts:** a chat card (`text` `chat`) with the line chat echoed about the moment, placed clear of cuts. A time-skip card on a cut that skips 20 s or more.
  - **A fail ending** (died, lost, eliminated… in the last 5 s): a `freeze` on the last frame and `mono` (black and white) over it.
  - **In a split:** the first laugh is the facecam alone (`solo` `show: cam`, about 1–2.4 s) instead of a zoom; "look at this" / "watch this" is the stream alone for 2 s (`solo` `show: game`).
  - **Also:** cuts on dead air, and a speed-up in the middle of a long run-up. It never cuts the pause before a laugh.
- **Expert editor** (`editor:expert`): a cut to the first word, cuts on dead air, a context line, a slow push-in on the quoted line.
- They do not touch captions or the review note, and they do not stack an edit on one that is already there.

Which proposals to lean on: for a gag (`reaction-meme`, `gaming-fail`), the meme editor's. For a story
or a take (`story`, `hot-take`, `funny-banter`), the expert editor's. A clip rarely wants all of both.

If the user asked for a named style ("make it hype", "clean, no sounds"), use
`./clip autoedit <clip> --style clean|punch|hype|story` for the first pass instead (`./clip styles`).

## 5. Check every proposal

```bash
./clip marker list <clip>
```

Go through them one by one. Keep an edit only if you can say what it is for.

| Device | It is for | Keep it when | Remove or move it when |
|---|---|---|---|
| **Hook text** (`text`; near the top, or just under the seam in a split layout, where the editors put it) | Supplying the setup a cold viewer lacks | The premise is unclear in the first 2 s; 6 words or fewer; gone before the hit. When the setup is outside the cut, the hook is where it goes | It repeats the first spoken line, gives away the punchline, covers a face or the facecam, or says who did something when no frame or line shows who |
| **Punch-in** (`zoom`, snap) | Pointing the eye at one thing | It starts on the punch word or the hit, on a clear face or detail (check the frame for `focusX`/`focusY`) | It lands on a filler word, the framing is already tight, or there is more than one per 30 s |
| **Push-in** (`zoom`, smooth) | Weight on a key line | It covers the line it is for | It drifts over a cut or a different speaker |
| **Flash / boom** (`flash`, `sfx`) | Punctuating a reveal or a hit | Once, on the first frame of the hit, when a quiet beat follows | The scene is already loud, or there are more than two: stacked effects read as irony |
| **Emoji** (`emoji`) | Marking the reaction | One or two per clip, on the laugh or scream, away from the face | It explains the joke, or sits on the subject |
| **Freeze** (`freeze`) | Isolating a face | The face is the joke; hold 0.5–1.5 s | Motion or the ongoing sound is the joke |
| **Cut** (`cut`) | Removing dead air | Only silence is removed: read the words either side | It clips a word, or removes **the pause before a laugh or a deadpan line**: that pause is the timing of the joke |
| **Speed-up** (`speed`) | Shortening a run-up | It is in the middle of the setup and the words stay intelligible | It touches the two seconds before the hit, or garbles a line that matters |
| **Premise box** (`text` style `box`) | The setup in the first second, in the look top clip channels open with | It names the premise in 6 words or fewer and is gone before the hit | It gives away the punchline or repeats the first line |
| **Tilt** (`tilt`, with a snap zoom) | Hitting a shout harder | It rides a zoom on a shout; ±4–8° | The clip is calm, or there are more than 3 |
| **Zoom-out reveal** (`zoom`, direction out) | Motion in a silent open; showing the cause of a reaction | The open is silent, or the wide shot shows what they reacted to | It pulls back to nothing new |
| **Tint beat** (`tint`, 0.3–0.6 s) | Colour on a win (green), affection (pink), shock (red) | One per clip, on the word | It sits on a sad or sincere moment |
| **Black and white + freeze** (`mono` + `freeze` at the end) | A fail, a death or a loss as the ending | The clip ends on the loss | The ending is a win, or the clip goes over 60 s with the hold |
| **Chat card** (`text` style `chat`) | What chat said about it, as chat said it | The line is readable and on topic; it appears after the moment | It is a slur, sexual, a dox, or names a private person; it covers a face |
| **Facecam only / game only** (`solo`) | The laugh in the face; the thing on the stream they point at | The cam shows a face (check a still at the span) or the stream shows what is talked about; 1–2.5 s | The cam band is someone else, a logo or empty; it hides what the joke is about |
| **Counter** (`counter`) | "3, 2, 1", a tally, a stopwatch proving a time | The numbers match what is said or shown | It contradicts the screen |
| **Arrow / circle** (`pointer`) | Pointing at a detail a viewer would miss | Placed on the thing (check a still), with a 1–3 word label | The thing is already obvious, or it covers the face |
| **Glitch, shake** | Emphasis in a loud, ironic edit | The user asked for a hype or meme style | Any calm, sincere or story clip |

Restraint: one or two emphasis moments per 30 s. Timings above are editors' practice, not measured
rules; when an edit looks wrong in the frame, trust the frame.

Fix what is off:

```bash
./clip marker update <clip> <id> --at <time> --to <time> --param key=value
./clip marker rm <clip> <id>
./clip marker add <clip> text --at +0 --to +2.6 --param 'text=WAIT FOR IT' --param style=street   # the hook style matches the caption look: street (street, comic) or comment (commentary, native)
./clip marker add <clip> sfx --at <time> --param sound=boom.wav    # also air-horn, record-scratch, glass-break, boing, whoosh, ding, pop, riser…
./clip marker add <clip> pointer --at <time> --to <time> --params '{"x":0.5,"y":0.62,"angle":300,"label":"NEW CAR"}'   # x/y = the thing, from a still
./clip marker add <clip> counter --at <time> --to <time> --params '{"mode":"stopwatch","label":"2 SECONDS?"}'
```

`./clip marker types` lists every type and its parameters. Sounds are in `assets/sfx/`.

Then accept what you keep and reject the rest. Nothing proposed is rendered.

```bash
./clip accept <clip>                      # all proposals
./clip accept <clip> <id> <id> --reject   # remove these
```

## 6. Settle captions

Captions belong to the subtitle expert. Follow `/subtitle-expert` for the clip: the engine pass, the
frame check, the decision, the word fixes. In short:

```bash
./clip subtitles <clip>          # engine fixes and look; it never turns captions back on by itself
./clip frames <videoId> <in> <middle> <out>   # burned-in captions? facecam or scoreboard under them?
./clip subtitles <clip> --no-settings         # later runs, after any decision made from the frames
./clip set <clip> captions.enabled=false      # off: the game or the stream already burns its own subtitles into the picture
./clip caption-fix <clip> "#<word id>" ""      # hide one word: game babble, a mishearing with no right spelling
```

### The look, and lines the transcript cannot give

The default captions are **street**: 2–3 word phrases, a heavy italic with a thick outline, a shouted
or exclaimed phrase turned yellow as a whole. That is what the top streamer-clip Shorts use; the old
**bold** look (every word lighting up in turn) is the auto-captioner default and makes a clip look
unedited. Talk clips get **commentary** (sentence-case italic, a line at a time), countdowns and
compilations **comic** (each phrase its own colour), calm clips **native**. `./clip subtitles` picks
street or commentary; change it in the Studio or with `./clip set <clip> captions.style=<look>`. The
research behind this is `reports/edits-research-2026-11-18.md`.

The best clip channels also write what the transcript cannot. Do it where it helps, never more than
three times a clip, and only what the frame shows:

| Line | When | How |
|---|---|---|
| **Action line** | Something happens that nobody says: a bite, a jumpscare, someone walking in, chat going silent | A `text` marker, style `street`, the action in asterisks and capitals, 4 words or fewer (`*TAKES A BITE*`, `*STARTS CHEWING*`), 1–1.5 s, where the captions sit or just above, never over a face |
| **Commentary line** | The reaction a viewer would type, said for them | A `text` marker, style `comment`, one sentence-case line in a viewer's voice with at most one emoji (`Ayo why is the whole room flooded 😭`), 1.5–2.5 s, at the reaction |
| **Title bar** | A compilation or a running joke | A `text` marker, style `title` (white on red), at the top, for the first 2–3 s |

The hook line takes the caption look's text style by itself (street → `street`, commentary →
`comment`). Fewer effects, not more: the top clips have 1–4 cuts and almost no stacked effects. One
strong effect on the payoff beats a boom, a shake and an emoji on every laugh.

## 6.4 Bleep what must not be heard

Captions mask strong swears (`f***ing`) and slurs by themselves (`captions.censor`, on by default); the
**sound** needs a bleep. Run this on every clip before the render:

```bash
./clip censor <clip>                 # a bleep over every slur said, and over the f-words in the first 3 s
./clip censor <clip> --swears all    # every strong swear (a clip that swears all the way through)
./clip censor <clip> --mute          # silence without the tone (explicit lyrics: mute the whole span)
```

A slur said is never posted and an f-word in the open is held through the careful period; a bleep
clears both, because a word under it is not heard. Re-running replaces the last pass. Listen to the
render where a bleep sits: if it eats the next word, trim the bleep (`./clip marker update`).

**A blur** hides part of the picture for a span: incidental nudity in the background, a slur in an
on-screen chat, a bystander, a document. The box is in the 9:16 frame's coordinates (0–1), under the
captions and the credit; `look: black` for a solid box:

```bash
./clip marker add <clip> blur --at +4 --to +9 --params '{"x":0.08,"y":0.45,"w":0.84,"h":0.3}'
```

Check the box against a still of the render. A blur is **not** a fix when the nude body is the moment:
a blurred shower scene is still a shower-scene clip; cut it, or do not submit it.

## 6.5 The intro line (only when requested)

**This is an optional review pass, not a step on every clip.** When the user asks for an intro-line
review, start a separate **clip-intro** agent (`.claude/skills/clip-intro/SKILL.md`, DeepSeek) for the
clip(s); it reads the clip's words and frames and applies the line with
`./clip intro <clip> --text "..."`. It is **4–8 words, max 9**, sentence case, names the person instead
of using "he", and explains the premise without giving away the punchline. Check it against the words
and the frame before the render. If the user did not ask, leave the existing hook alone.

## 7. Render and read QA

```bash
./clip render <clip>
```

About 1.5–2× the clip length. Exports are normalised to −14 LUFS. QA prints after the render.

| QA says | Do |
|---|---|
| `✖ length` (fails) | Over 60 s: YouTube blocks a claimed Short over a minute and the scheduler refuses it. Trim (step 2) and render again. Under 5 s is a broken export: report it. |
| `✖ black frames` (fails) | Trim them out and render again. |
| `hook: opens with … silence`, `first word at …`, `opens on filler` | Trim the in-point (step 2) and render again. A scream or a visual open is not a problem: say so in your reply. |
| `payoff: ends on a question` / `unfinished line` | Move the out-point to the landing or extend to the answer. |
| `dead air` | Cut it, unless it is the pause before the reaction. |
| `captions: shrunk a lot` | Shorten or hide the word (`./clip caption-fix`). |
| `edits: N proposed edits aren't in this render` | Accept or reject them, then render again. |
| `· layout: rendered blur-fit instead of split` | The engine fell back on its own. Say so in your reply; do not switch it back. |
| `✖ layout` (fails) | Part of the picture is black for the whole clip (the source's own bars, a phone video's sides) or a split has no face in its camera band. Do not fix it by hand: report it word for word for the reviewer. |
| `✖ credit` (fails) | The creator is not named on screen. `./clip credit <clip>`, then render again. Never remove a credit to make room for something else: move the other thing. |
| `✖ unsafe` (fails): `never posted: …` | Never uploaded, whoever approves it. **A slur said**: `./clip censor <clip>` (step 6.4) or cut it, and render again; a caption fix hides a word from the captions only, the audio still plays it. **Nudity**: cut or trim it out (step 2), or blur it when it is incidental (step 6.4), and render again. **A sexual title**: retitle (step 8). **A minor**: nothing in an edit clears it; report it word for word. If the nude body, the slur or the minor is the moment, say so and do not submit. |
| `language: …` | Swearing, measured (a warning). An f-word heard in the first 3 s: `./clip censor <clip>` and render again (the careful period holds it otherwise). Swears unmasked in the captions: `./clip set <clip> captions.censor=true`. A swear in the title: retitle (step 8). |
| `content: …` | Do not guess. Put it in your reply and in the hand-over for the reviewer. |
| `loudness` more than 2 LUFS off | Render again; if it repeats, report it. |

## 8. Check the post text

```bash
./clip post <clip>
```

- **The title must be true.** If the expert or curator flagged `misleading` (a prank, a bit, a retracted claim), the title says what it really was. Fix with `--title`.
- Titles: the streamer's short name, an action, one word in capitals, one or two reaction emojis, under 60 characters, no colon.
- **No sexual words in a title** (nude, naked, sex, stripper, strip club, lap dance, gooner, fetish, horny, porn and the like): the scheduler holds a clip whose title has one until it is edited. Say what happened instead.
- The description gives context first; 3–5 hashtags. Its first line is generated from the expert's context line. If it does not name the creator, or is not something a viewer would want to read, replace it with `--caption`.
- **The credit is there and right.** `./clip post` prints it under the caption: the creator's channel, the source link at the clip's first second, the stream's title, and the line saying this channel is automated. Check the creator's name and that the link's time is the clip's start. It is generated; do not rewrite it into the caption.

## 9. Submit

```bash
./clip review <clip> submit
```

The clip appears at http://localhost:4400/#/review.

Finish with a short table: clip, length, what you changed (trim, edits kept and removed, captions on or
off and why), QA result, and anything the reviewer must look at (risk flags, content notes) word for word.
