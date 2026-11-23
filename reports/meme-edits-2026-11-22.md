# The meme edits clip channels use, and the easy ones to add — 2026-11-22

**The question (user):** "we need to expand our vocabulary on meme edits. can you get a large sample set we can study and take out
easy edits with examples so we can add those in?"

**The answer in one line:** the top streamer-clip Shorts use about 11 edits each. Most of them are ones we already have. Ten
easy ones are missing or only half there:
- a premise box at the open;
- a tilt paired with the zoom-punch;
- a zoom-out reveal;
- black-and-white with a freeze for a fail ending;
- a colour-tint beat;
- a repeat counter in the captions ("SIT DOWN X3");
- a time-skip card;
- a real Twitch chat message as a card;
- an arrow or circle with a label;
- a counter or stopwatch.

Each is a few hours' work in the marker system. Section 4 has what to build, the rule the meme editor would place it by, and
linked examples.

**Built (2026-11-22, the same day):** rows 1–11 of section 4: the premise box, tilt, zoom-out reveal, black and white
(`mono`), tint beats, the caption repeat counter, time-skip cards, chat cards from real chat, the pointer, the counter and four
synthesized sounds. The meme editor places them by the rules at the end of section 4 (see SCOPE.md). Row 12 (cam only / game only)
was built on 2026-11-23 (the `solo` marker). Row 13 (the ranking board) is still to do.

## 1. The sample

| | |
|---|---|
| Shorts | **175** from **38** channels, median **2.3M** views (156k – 219M), median 31.8 s long |
| Labelled edit by edit | **120** (the 3 most-watched per channel, then by views); **1,483** edits in all |
| Channels | fan clip channels (AMPYRG, Speedy Boykins, Ludwin, CouRage Gaming, Moist Charlie Clips, QTCinderella Clips, Kai Cenat Live, Jynxzi Live, Nmplol Clips, KSIClips, …) and streamers' own Shorts channels (IShowSpeed, Ludwig, Jynxzi, Agent 00, summit1g, Nick Eh 30 Shorts) |
| Formats (labelled) | single moment 61 · story 23 · reaction 18 · ranking 9 · compilation 6 · other 3 |

**How the sample was built.**
1. YouTube searches for 30 streamers, plus 6 "meme edit" queries, collected the channels that appeared.
2. From each channel's Shorts tab I took its 5 most-watched Shorts with 150k+ views.
3. Off-topic channels the searches swept in were removed: kids' shows, LEGO, BBC, music, a stand-up comedian.

**How each Short was studied.**
1. **Automatic measures on all 175:** cuts, flashes, freezes, black-and-white, zooms, shakes, tilts, sudden loud sounds, Apple's
   sound labels, and Whisper word times.
2. **Contact sheets:** one still a second plus one at each detected event, each labelled with its time.
3. **Labelling:** 24 Sonnet agents labelled every edit in the 120 Shorts from the sheets, the events and the words. They used one
   shared list of edit names, so the counts add up (`meme-edits-2026-11-22-data/BRIEF.md`).
4. **Shared sounds:** sudden loud sounds were compared across all 175 Shorts to find sound effects that several channels reuse.

The labels, tallies and scripts are kept next to this report (section 8).

## 2. What they use

Share of the 120 labelled Shorts that use each edit at least once.

| Edit | Shorts | Channels | Per Short (when used) | We have it |
|---|---|---|---|---|
| Captions | 59% | 27 | – | ✅ (`street` and others) |
| Jump cut | 58% | 30 | 2 | ✅ `cut` |
| Zoom punch (fast, on a face) | 42% | 23 | 2 | ✅ `zoom` snap |
| Caption highlight (a word or phrase in colour, bigger) | 37% | 25 | 1 | ½ (`street` turns a shouted phrase yellow) |
| Title bar / premise box at the open | 36% | 20 | 1 | ½ (`text` `title` is white on red; no white premise box) |
| Zoom-out reveal | 34% | 22 | 1 | ❌ (`zoom` only goes in) |
| Sound effect | 34% | 28 | 1 | ✅ `sfx`, 10 sounds |
| Music under it | 32% | 24 | 1 | ❌ (Content ID risk, see 5) |
| Slow push-in | 29% | 22 | 1 | ✅ `zoom` smooth |
| Split screen (stacked panels) | 28% | 23 | 1 | ✅ the engine's layout |
| **Tilt** (the frame rotates) | **27%** | 19 | 1 | ❌ (`shake` rotates a little) |
| Action line (*TASTES IT*) | 26% | 16 | 1 | ✅ `text` `street`, written by hand |
| Freeze frame | 24% | 18 | 2 | ✅ `freeze` |
| Commentary text (the channel's own words) | 22% | 19 | 1 | ✅ `text` `comment` |
| **Cam only** (the facecam fills the frame) | **21%** | 14 | 1 | ❌ (B4 in the censorship review) |
| Sticker / cut-out picture | 21% | 17 | 1 | ❌ |
| Emoji | 20% | 13 | 1 | ✅ `emoji` |
| Meme picture cut in | 19% | 14 | 1 | ❌ (rights, see 5) |
| Zoom onto a detail (chat, a HUD number) | 18% | 17 | 1 | ✅ `zoom` with focus |
| **Colour tint on a beat** | **18%** | 13 | 1 | ✅ `tint`, but no editor places it |
| Flash | 18% | 14 | 1 | ✅ `flash` |
| **Game only** (the content fills the frame) | **16%** | 12 | 1 | ❌ (B4) |
| End card (SUBSCRIBE, WHO WINS?) | 15% | 15 | 1 | ½ (🔔 Subscribe quick effect) |
| **Counter / countdown / ranking board** | **14%** | 11 | 1 | ❌ |
| **Black and white** | **14%** | 12 | 1 | ❌ |
| Censor (starred swears, bleep) | 12% | 12 | 1 | ✅ (change 3) |
| Shake | 12% | 12 | 1 | ✅ `shake` |
| **Chat message as a card** | **9%** | 9 | 2 | ❌ |
| Meme video cut in | 7% | 7 | 1 | ❌ (rights) |
| **Arrow / circle callout** | **7%** | 6 | 1 | ❌ |
| Blur | 5% | 6 | 1 | ✅ (change 3) |
| Glitch | 3% | 4 | 1 | ✅ |
| Loop ending | 2% | 2 | 1 | ❌ |

Slow motion, replays and rewinds were almost absent (one Short).

## 3. What the numbers say

1. **Few edits, each on purpose.**
   - Median **11 edits** per Short (middle half 6–18). Cuts: 3.1 a minute (all 175, measured).
   - The heaviest are Jynxzi Live (24 a Short), CouRage Gaming (23), AMPYRG (19) and Speedy Boykins (18).
   - Moist Charlie Clips uses about 4, and the most-viewed IShowSpeed Shorts (110M average) are mostly jump cuts.
   - A zoom punch appears twice per Short when used, a sound effect once. Our old "hype" style (a boom, a shake and an emoji
     on every laugh) is still far busier than the channels that do it most.
2. **They land on words, and about half on a sudden sound.** For nearly every edit the most common landing is "a word or line",
   and many sit within 0.3 s of a sudden loud sound:

   | Edit | Within 0.3 s of a sudden loud sound |
   |---|---|
   | Sound effects | 57% |
   | Cam-only switches | 50% |
   | Caption highlights | 45% |
   | Meme pictures | 45% |
   | Tints | 43% |
   | Tilts | 37% |

   The punch word and the shout are the trigger, the same moments `clipMetrics` already finds.
3. **Edits come in stacks.** The common pairs within 0.4 s are:
   - zoom punch + tilt;
   - tint + action line;
   - tint + cut;
   - flash + cut;
   - title + emoji;
   - captions + sticker.

   A punch is rarely a zoom alone. It is a zoom with a 4–9° tilt, and the channels that tint put an action line on the
   tinted beat.
4. **The open is text.** In the first 3 s:
   - captions start in 60 Shorts;
   - a title or premise box opens in 43;
   - music starts in 35;
   - an emoji appears in 18.

   The premise box is nearly always TikTok's own text style: each line on its own white rounded strip, black bold text, one or
   two emoji at the end. It reads
   "When Lil Baby caught Kai Cenat LYING 😂", sits on the lower third or on the seam, and is held 3–5 s or for the whole Short.
5. **Captions.**
   - None at all in 27%.
   - 2–4-word phrases are the most common style (45%); one word at a time 23%.
   - Outlined 68%, all caps 38%, sitting mid-frame or on the seam 48%.
   - A yellow emphasis word 27%, starred swears 17%, one colour per speaker 11%.
   - Our `street` look matches the majority.
6. **Layout switching is an edit.** Clip channels cut to the facecam alone on the laugh (21%), to the game alone for "look at
   this" (16%), and zoom out to reveal (34%). Our engine sets the layout once for the whole clip.

## 4. The easy edits to add, in order

"Effort": XS is an editor rule only, S is a new marker or param (about a day), M touches both framing sides. Every row
plugs into the existing marker system: one folder per type, no type names special-cased.

| # | Edit | Use | Build | Effort |
|---|---|---|---|---|
| 1 | **Premise box at the open** | 36%, 20 ch | `text` style `box` (TikTok's text style: each line on its own white rounded strip, black heavy text, an emoji allowed); the meme editor puts the candidate's premise in it for 0–3.5 s, on the seam (`hookYFor`) | S |
| 2 | **Tilt with the zoom punch** | 27%, 19 ch | camera marker `tilt` (degrees, snap/smooth, scaled up to cover the corners); the meme editor adds 4–8° to a snap zoom on a shout, alternating sides | S |
| 3 | **Zoom-out reveal** | 34%, 22 ch | `zoom` gains `direction: in|out` (out starts at `scale` and eases to 1); used to open tight on the face, or after the reaction to show its cause | S |
| 4 | **Black and white, for a fail ending** | 14%, 12 ch | a `filter` hook for camera markers, like change 3's `gain` (CSS `grayscale()` on the video in the composition, so the preview and the export match); a `mono` span marker; recipe: freeze 0.8 s + mono on a fail or elimination at the end | S |
| 5 | **Colour tint on a beat** | 18%, 13 ch | `tint` exists: the meme editor proposes 0.3–0.6 s washes, red on a shock or anger word, green on a win, pink on affection, with the action line on the same beat | XS |
| 6 | **Repeat counter in the captions** | 6 Shorts, 4 ch | captions collapse a word or phrase said 3+ times in a row into one page with "X3" (`captionTokens`), optionally growing each time | S |
| 7 | **Time-skip card** | 9 Shorts | `text` `street` "*20 MINUTES LATER*" over a cut that skips more than 30 s of source; the cut marker knows the skip | XS |
| 8 | **Real chat message as a card** | 9%, 9 ch | `text` style `chat` (dark rounded card, the chatter's name in their colour, emotes as text); the meme editor picks a quotable message from the moment's own chat (`readChat`, the replay we already fetch). No other tool can do this, because it needs the chat replay | S |
| 9 | **Arrow or circle with a label** | 7%, 6 ch | overlay marker `pointer` (arrow or circle, x/y, angle, a short label); placed by the editor agent from a still, or on a face box | S |
| 10 | **Counter / stopwatch / countdown** | 14%, 11 ch | overlay marker `counter` (a number that steps at given times, or a running stopwatch from the marker start); "3, 2, 1", a points tally, a stopwatch proving "2 SECONDS" | S |
| 11 | **More sounds** | 34% use a sound | assets only (`sfx` exists): air horn, record scratch, glass break, cartoon quack/honk, slap, a sustained "vine-style" boom; royalty-free files with a licence we keep | XS |
| 12 | **Cam only / game only for a span** | 21% / 16% | a framing mode for a span, read by `splitGeometry` and both framing sides (this is B4 of the censorship review) | M |
| 13 | **Ranking board that fills in** | 9 ranking Shorts | overlay marker `list` (title + rows revealed at times) | M |

### Examples to watch, per edit

Each link opens at the second (a second before the edit).

1. **Premise box**
   - [AMPYRG, 47M](https://www.youtube.com/watch?v=gDcF236PMhk&t=0s): white box at the bottom, "When You ACCIDENTALLY Feed Your
     Muslim Friend Pork 🐷😭".
   - [AMPYRG, 18M](https://www.youtube.com/watch?v=K0ollvdLPVk&t=0s): "When Lil Baby caught Kai Cenat LYING 😂".
   - [AMPYRG, 21M](https://www.youtube.com/watch?v=Fqdw_hrDFWA&t=0s): "IShowSpeed Gets PRESSED By Kai Cenat 😂", held about 5 s.
   - [Jynxzi, 44M](https://www.youtube.com/watch?v=tfiLeyu02oo&t=0s): a "green light" quote on the seam for the whole Short.
   - [Nmplol Clips](https://www.youtube.com/watch?v=kvXlDGSvyuQ&t=0s): "Why Are Men Like This 😂" held for the whole Short.
2. **Tilt + zoom punch**
   - [Speedy Boykins, 29M](https://www.youtube.com/watch?v=R-4yG_e_DU0&t=0s): about 9° on the opening punch-in.
   - [IShowSpeed, 68M](https://www.youtube.com/watch?v=FHz4x6ewFWg&t=12s): on the sliding tackle at 13.25 s.
   - [Jynxzi Live](https://www.youtube.com/watch?v=XxkRMVpdxCE&t=0s): three snap zooms (12%, 20%, 40%) with a tilt as he yells,
     again at 7.2 s and 11.4 s.
   - [ClipsTycoon](https://www.youtube.com/watch?v=AWYCyzWhb1E&t=15s): ±5° tilts alternating on the speaker at 16.9 s.
3. **Zoom-out reveal**
   - [Kai Cenat Live, 16M](https://www.youtube.com/watch?v=9AQ5P2_BRfU&t=0s): opens tight and pulls back 33% to the room.
   - [AMPYRG](https://www.youtube.com/watch?v=Fqdw_hrDFWA&t=26s): a snap zoom-out reveals Speed alone in the room, at 27.3 s.
4. **Black and white**
   - [IShowSpeed, 75M](https://www.youtube.com/watch?v=W7UZztocu0Q&t=51s): the last frame freezes and drains as the car drives
     off.
   - [IShowSpeed, 64M](https://www.youtube.com/watch?v=qHoc0lmF8uY&t=28s): a zoom punch on the scream, then a black-and-white
     freeze and a red SUBSCRIBE.
   - [Speedy Boykins](https://www.youtube.com/watch?v=TRG58mooOps&t=27s): a skull sticker with sparks and black-and-white on
     the ending.
   - [Nick Eh 30 Shorts](https://www.youtube.com/watch?v=2Hvx8gAL_cM&t=34s): black and white with an arrow labelled
     "BRITE BOMBER" and a sting.
5. **Tint beat**
   - [Jynxzi, 44M](https://www.youtube.com/watch?v=tfiLeyu02oo&t=0s): red and green washes following red light / green light.
   - [Speedy Boykins](https://www.youtube.com/watch?v=7wgyAf3xf3I&t=4s): a pink wash with "*KISSES*".
   - [Speedy Boykins](https://www.youtube.com/watch?v=R-4yG_e_DU0&t=10s): red on the cut at 11.1 s.
   - [Adin Live](https://www.youtube.com/watch?v=KcMInk0DlC4&t=3s): a red tint on each cut with slap and boom sounds, and
     the story told in action lines (*PREPARES*, *SLAPS*, *MAD*, *SCARED*).
6. **Repeat counter**
   - [Speedy Boykins](https://www.youtube.com/watch?v=4Aj5Z8odhpc&t=16s): "SIT DOWN X3".
   - [DaleExe](https://www.youtube.com/watch?v=Z8Kcr-1jmgk&t=32s): "oh my god (x3)", then "I'm on it (x5)".
   - [Ludwin](https://www.youtube.com/watch?v=BL21sDBfGYc&t=3s): "What" repeated, bigger each time.
7. **Time-skip card**
   - [Kai Cenat Shorts](https://www.youtube.com/watch?v=2skgEG-bnxs&t=7s): "*gets idea*", then "*20 minutes later*" at 12.2 s.
8. **Chat card**
   - [Ludwig, 14M](https://www.youtube.com/watch?v=4TzXy62qbto&t=17s): a chatter's "Greenland is crazy" as a dark card.
   - [Ludwin, 17M](https://www.youtube.com/watch?v=fLqVuujsUYQ&t=0s): the chat question as a white card at the open.
   - [SypherPKVODs](https://www.youtube.com/watch?v=R--J3WcoY4c&t=9s): two Twitch chat boxes shown big.
   - [summit1g](https://www.youtube.com/watch?v=4e1QCnWP-Do&t=0s): chat lines with emote faces carry the whole dialogue.
9. **Arrow / circle**
   - [Nick Eh 30 Shorts](https://www.youtube.com/watch?v=bGTkfSEzOa0&t=3s): "0.1% CHANCE" label with an arrow at the target.
   - [Stable Ronaldo Live](https://www.youtube.com/watch?v=T_RoJxfMY6Q&t=16s): a red circle and arrow on a laughing face.
   - [AMPYRG](https://www.youtube.com/watch?v=DJhsiLuXL2I&t=0s): a red circle on one person in a group photo as he is named.
10. **Counter**
    - [Speedy Boykins](https://www.youtube.com/watch?v=TRG58mooOps&t=22s): huge "3, 2, 1" in yellow, red, green.
    - [Chess.com](https://www.youtube.com/watch?v=y4JdKi2cMOw&t=3s): a running stopwatch proving the "2 SECONDS" title.
    - [CouRage Gaming](https://www.youtube.com/watch?v=Deys-JPSArs&t=0s): a points tally per player.
    - [DaleExe](https://www.youtube.com/watch?v=hcnnHGUV_Ss&t=31s): "ROACH COUNTER" going from 2 to 10.
11. **Sounds**
    - [summit1g](https://www.youtube.com/watch?v=rACd-f8NKD0&t=25s): an air horn on "HE DIDN'T MISS A SINGLE SHOT".
    - [Fanum Live](https://www.youtube.com/watch?v=js40WGp8Vjw&t=11s): quack and record-scratch hits on the swears.
    - [Canooon](https://www.youtube.com/watch?v=H056T2ghiko&t=41s): a boom and a whoosh as he falls out of frame.
    - [JasonTheWeen](https://www.youtube.com/watch?v=BKdWhr3LLuI&t=5s): a foghorn on a tinted cut.
12. **Cam only**
    - [Ludwig, 40M](https://www.youtube.com/watch?v=pXOPh-RZzDc&t=9s): the facecam fills the frame on his laugh.
    - [Jynxzi Live](https://www.youtube.com/watch?v=18Fv56wSzaI&t=3s): flips between split and cam only on each loud moment.
    - [summit1g](https://www.youtube.com/watch?v=4e1QCnWP-Do&t=20s): a tight cam laugh at 21.95 s, back to the split at
      23.65 s.
13. **Ranking board**
    - [Speedy Boykins](https://www.youtube.com/watch?v=cSEfwwZsDAw&t=1s): "iShowSpeed's Favorite Fried Chicken" fills in as he
      names each one.
    - [ClipsTycoon](https://www.youtube.com/watch?v=rlLaGv2NkGE&t=0s): a Top 5 list that fills in as each moment plays.

### Rules for the meme editor, from the study

The editors already find the moments (`clipMetrics`: the punch word, the reaction, the shout). What to place on them:

- **On a shout or a laugh:** a snap zoom 1.2–1.5× **plus a 4–8° tilt**, alternating sides; at most one every 5 s (median 2 per
  Short).
- **At the open:** the premise box with one emoji, 0–3.5 s, or for the whole Short when there are no captions.
- **When the reaction comes before its cause is shown:** a zoom-out reveal.
- **On a shock, a win or a kiss:** a 0.3–0.6 s tint (red / green / pink) with an action line on the same beat.
- **A fail, a death or an elimination at the end:** freeze 0.8 s + black and white, then end.
- **A line said 3+ times:** one caption with "X3".
- **A cut that skips more than 30 s:** "*N MINUTES LATER*".
- **Chat exploded and one message says it best:** that message as a chat card for 2 s.

## 5. Common, but not easy (or not safe) for this channel

- **Meme pictures, meme videos and cut-outs of people** (19% / 7% / 21%). They need an image library and the rights to it: a
  celebrity cut-out, a film clip, the SpongeBob "A few minutes later" card. That is Content ID and copyright risk on a channel that
  just lost two videos. Emoji, our own text cards and the stream's own frames do the same job safely.
- **Music under the Short** (32%; it starts at the open in 35 Shorts). It is a retention tool, but a commercial track is a Content
  ID claim, and YouTube blocks a claimed Short over a minute. Only royalty-free tracks with a licence we keep; no automatic music
  until that library exists.
- **Captions coloured per speaker** (11%). These need to know who is speaking; Whisper does not tell speakers apart, and Twitch
  streams have no captions.

## 6. The sounds clip channels reuse

Of 2,914 sudden loud sounds in 168 Shorts, only a few recur near-identically across channels. Most "hits" are voices, and an effect
mixed under speech rarely matches exactly. The groups that do recur:

| Heard in | Sounds like | Nearest of ours | Listen |
|---|---|---|---|
| 12 channels, 14 Shorts | a short mid "swish" | `swish.wav` (0.86) | [1](https://www.youtube.com/watch?v=bGTkfSEzOa0&t=48s) [2](https://www.youtube.com/watch?v=YtjYE0G8fLE&t=36s) [3](https://www.youtube.com/watch?v=TlxsFjeSRag&t=23s) |
| 7 channels | a digital blip | `glitch.wav` (0.86) | [1](https://www.youtube.com/watch?v=AWYCyzWhb1E&t=34s) [2](https://www.youtube.com/watch?v=OPoZPR7XrXk&t=26s) [3](https://www.youtube.com/watch?v=DJhsiLuXL2I&t=42s) |
| 5 channels | a low sustained boom (Apple: "boom") | `boom.wav` (0.81) | [1](https://www.youtube.com/watch?v=nxiUS7Nj-ks&t=28s) [2](https://www.youtube.com/watch?v=YOy33891IIQ&t=138s) [3](https://www.youtube.com/watch?v=H056T2ghiko&t=41s) |
| 4 channels | a low boom | `boom.wav` (0.90) | [1](https://www.youtube.com/watch?v=AWYCyzWhb1E&t=5s) [2](https://www.youtube.com/watch?v=T_RoJxfMY6Q&t=0s) [3](https://www.youtube.com/watch?v=rlLaGv2NkGE&t=39s) |

From the labels, the effect kinds named most often:
- booms (10);
- bells and dings (5);
- beeps and bleeps (5);
- air horns (5);
- glass breaks (3);
- record scratches (3);
- "bruh"-style voices (3);
- risers (3);
- cartoon quacks and honks (3).

We have booms, dings, risers and swishes. Air horn, record scratch, glass break and a cartoon sound are the gaps (row 11).

## 7. Each channel's signature

| Channel | Labelled | Avg views | Edits a Short | Most used |
|---|---|---|---|---|
| IShowSpeed | 5 | 111M | 11 | jump cut, zoom punch, sticker, zoom-out reveal, black and white, music |
| AMPYRG | 4 | 26M | 19 | jump cut, tilt, zoom punch, action line, premise box |
| Ludwig | 3 | 21M | 9 | cam only, zoom onto detail, split, flash |
| Speedy Boykins | 5 | 20M | 18 | zoom punch, caption highlight, tilt, action line, zoom-out reveal, tint |
| Jynxzi | 5 | 20M | 13 | jump cut, zoom punch, tint, flash, title, sound |
| Ludwin | 5 | 13M | 13 | jump cut, countdown, caption highlight, split, freeze, commentary |
| CouRage Gaming | 5 | 13M | 23 | game only, cam only, split, jump cut, zoom punch, flash |
| Kai Cenat Live | 4 | 12M | 12 | action line, zoom-out reveal, tilt, jump cut, music |
| Moist Charlie Clips | 3 | 11M | 4 | captions, highlight, one sound |
| Jynxzi Live | 3 | 9M | 24 | zoom punch, tilt, zoom-out reveal, jump cut, shake, cam only |
| Nick Eh 30 Shorts | 3 | 6M | 16 | jump cut, caption highlight, arrow/circle, cam only, freeze, tilt |

Two styles both work: **plain** (IShowSpeed, Moist, about 4–11 edits) and **punched** (AMPYRG, Speedy Boykins, Jynxzi Live,
18–24 edits). Even the punched ones put each edit on a word or a reaction.

## 8. The study set

The videos, audio, contact sheets, automatic measures and Whisper words (1.3 GB in `.cache/edit-study/`) were deleted on
2026-11-23 to free disk space. The study's results are kept in `reports/meme-edits-2026-11-22-data/` (under 1 MB):

| File | What it is |
|---|---|
| `annotations/<id>.json` | every edit in the 120 labelled Shorts: time, name, what it looks like, what it lands on, the sound |
| `catalog.json` | the tally behind sections 2–4 |
| `sfx.json` | the recurring sound groups and their example links |
| `sample.json` | the 175 Shorts: id, title, channel, views |
| `BRIEF.md` | what the labelling agents were told |
| `*.py`, `words.sh` | the scripts: `sample.py`/`tabs.py` build the sample, `measure.py` and `words.sh` measure a Short, `aggregate.py` tallies, `cluster2.py` and `match_assets.py` group the sounds |

To repeat or grow the study: rebuild the sample (`tabs.py`), download the Shorts with yt-dlp into `video/`, run `measure.py` (with
`.cache/face-py/bin/python`) and `words.sh`, label with agents from `BRIEF.md`, and run `aggregate.py`. The scripts expect to sit
in one folder with those subfolders.

## 9. What to keep in mind

- **The agents read stills, not motion or sound.**
  - Speed changes and sound effects are under-counted. Many sound entries say "unsure", since a sudden loud sound can be the
    streamer's own voice.
  - A zoom or tilt the game's camera made can pass for an edit. The agents were told to skip those, and a few flagged their own
    labels as weak; I removed those.
- **The stills missed the end of 15 long Shorts** (3–75 s): the 50-still cap thinned from the start. The 17 edits labelled after
  the last still an agent saw were left out of every count, and `measure.py` now spreads the stills over the whole Short.
- **The sample leans on a few streamers** (IShowSpeed, Kai Cenat, Jynxzi, Ludwig) because the searches did, and it is English
  only. The labels describe what the channels do, not what made each Short do well: there is no comparison of edits against views.
- **24 of the 120 labelled Shorts come from streamers' own channels or produced shows** (IShowSpeed, Ludwig, Jynxzi, summit1g,
  Agent 00, the CouRage game shows). Paid editors cut these, and they are kept as the upper end of what is possible. The rest are
  fan clip channels like ours.
