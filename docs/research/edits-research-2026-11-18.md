# What good streamer-clip Shorts do differently — 2026-11-18

**The question:** our edits look generic, and the subtitles look like default settings. What do the Shorts that get millions of views actually do?

**How:**

- Ten streamer-clip Shorts were pulled from the clip channels with the most views in a YouTube search (2025–26).
- Each was downloaded at low resolution and looked at frame by frame (eight stills each).
- Hard cuts were counted with ffmpeg scene detection.

The files were study copies in a scratch folder and are not kept.

## The sample

| Short | Channel | Views | Length | Hard cuts | Text on screen |
|---|---|---|---|---|---|
| Bro Eats Anything | SpeedUniverse (iShowSpeed clips) | 9.1M | 24 s | 2 | Phrase captions plus action lines |
| Jynxzi predicting lines in GTA5 | Jynxzi (his own) | 8.5M | 32 s | 2 | Title bar plus a numbered list |
| This Duck Got CaseOh GOOD | MoreCaseOh | 423k | 53 s | 10 | None |
| CaseOh Reacts To Winning … Award | MoreCaseOh | 358k | 55 s | 3 | None (the show's own lower thirds) |
| Top 5 Rakai Funny Moments | ClipsTycoon | 198k | 61 s | 8 | Title plus a countdown list |
| Unc Scared Rudiger | SpeedUniverse | 189k | 11 s | 3 | Phrase captions plus action lines |
| xQc gets got | xQc Clips | 78k | 19 s | 1 | One word ("YOU") |
| Kai's whole booty was outside | Kai Cenat Shorts | 38k | 19 s | 2 | Commentary lines with emoji |
| Two 2023 iShowSpeed clips | Speedy Boykins | 24M each | 26–34 s | 2–4 | None (raw 16:9) |

## What they do

1. **Short phrases, not a running transcript.**
   - SpeedUniverse shows 1–4 words at a time.
   - The text is a heavy condensed italic in white, with a thick black outline and a soft shadow.
   - It sits in the middle of the picture, over the subject's chest, not near the bottom.
2. **A whole phrase turns yellow when it is the beat.** "CHEW IT" and "IT'S NOT GOOD" are yellow; most phrases are white. Nobody lights up each word as it is spoken. That karaoke effect is what auto-captioners ship by default, and it is what our default looked like.
3. **They write what the transcript cannot.**
   - Action lines: *\*STARTS CHEWING\**, *\*SIPS IT\**, *\*RUDI DISTRACTED\**.
   - Commentary in a viewer's voice: "Ayo why Kai's whole BOOTY OUTSIDE???" with 😂 under it.
   - These carry the clip for a viewer with the sound off.
4. **Many top clips have no captions at all.** MoreCaseOh puts the cam on top, the game below, and no text. The moment carries itself.
5. **Formats are retention devices.**
   - Jynxzi has a red title bar ("Jynxzi predicting lines in GTA5 compilation") and a numbered list that fills in as the clip plays: "1. Who tf is this · 2. Daddy's Home · 3. There he is".
   - ClipsTycoon has a countdown in a chunky comic font in lime, pink and cyan.
   - The viewer stays to see the next line.
6. **Few cuts and few effects.**
   - Single moments have 1–4 hard cuts; compilations have 8–10.
   - No stacked booms, shakes or emoji showers are visible in the stills.
   - Our "hype" style (a boom, a shake and an emoji on every laugh, glitch jump cuts) is the opposite.
7. **Layout is not the differentiator.**
   - SpeedUniverse leaves black bars above and below a centred crop.
   - xQc Clips uses the cam on top with the whole tweet below, which is our new whole-frame split.
   - Two 24M-view clips are raw 16:9.
   - A layout that shows the moment clearly is enough.

## What changed in the engine

**New caption looks** (`src/core/captionLooks.ts`, rendered by `src/composition/Captions.tsx`):

| Look | What | Where it is used |
|---|---|---|
| **street** (the new default) | 2–3 word phrases, Barlow Condensed ExtraBold Italic in caps, thick outline, soft shadow; a shouted or exclaimed phrase in yellow; snaps in | Gameplay, memes, IRL |
| **commentary** | Sentence-case Montserrat ExtraBold Italic with an outline, up to 6 words a line, rises in | Talk, Just Chatting, stories |
| **comic** | Luckiest Guy in caps, each phrase its own colour, hard shadow | Countdowns, compilations, memes |
| **native** | Poppins SemiBold in sentence case, a thin outline, no highlight | Calm clips |
| bold / boxed / clean | The old looks, kept for the clips that use them | — |

**Other changes:**

- The subtitle engine picks commentary for a talk clip and street for everything else.
- The edit styles use the new looks: clean → native, punch → street, hype → street, story → commentary.
- **Text lines match the captions.** The text marker has three new styles:
  - `street`, an action line;
  - `comment`, a commentary line;
  - `title`, a red title bar.
  The editors' hook line takes the style that matches the caption look.
- **Edit skill:** step 6 says when to write action lines, commentary lines and title bars (at most three a clip, only what the frame shows), and asks for one strong effect on the payoff instead of stacked ones.

## Rendered

Four clips in review were copied and rendered in the new looks, then the copies were deleted:

- Nickmercs and Kai Cenat in **street**.
- Ludwig in **commentary**.
- MoistCr1tikal in **comic**.

The frames are in `docs/research/caption-looks-before-after-2026-11-18.png`: the old renders are on the left, the new looks on the right. At full resolution, the street phrases have the same letter size as the 9.1M-view reference.

## How to keep learning what works

- **Our own numbers are the real test.** `./clip analytics` pulls views, engaged views, average view % and shares for posted clips into `performance.jsonl`, and `./clip stats` shows what tracks them. With a few dozen posts in each look, the comparison is ours, not borrowed.
- **The review reasons:** "boring", "title" and "cut" rejects say whether the edit or the moment failed.
- **Repeat this study every few weeks.** Pull the top Shorts from the clip channels for the streamers we post, then look at eight stills each and count the cuts. Trends move, and the countdown formats in particular change often.
