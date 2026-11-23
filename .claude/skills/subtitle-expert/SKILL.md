---
name: subtitle-expert
description: Review a clip's subtitles as a subtitle editor. Decide whether captions belong at all, choose the style and position for the frame, and fix misheard words, loops, non-speech tags and overflow. The engine proposes from the words and sounds; this skill adds what only frames show (burned-in captions, a facecam or scoreboard in the way, a text-heavy screen, non-English audio) and has the final say. Use when a clip is edited or rendered and the captions need a professional pass.
argument-hint: <clipId...>
allowed-tools: Bash(./clip:*), Read
---

# /subtitle-expert: captions on/off, style, place, words

Arguments: `$ARGUMENTS`. These are clip ids. Run everything from the project root. Word numbers are
transcript indices (`#123`); times are source-video times.

**Who owns what:** captions are yours. The meme and expert editors never change them; they leave a
note instead. The engine (`./clip subtitles`) decides from words and sounds only. It cannot see the
frame, so anything a frame shows is your call, and your call stands.

For each clip:

## 1. Engine review first

```bash
./clip subtitles <clip> --review
```

Read-only. It prints:

- `engine says`: captions ON or OFF, style, position, case, size, and why.
- `risk` lines: what it could not check.
- Notes on words: `#index time "text" → "fix" [kind] why`. An empty fix hides the word.

The engine turns captions **off** when: fewer than 5 words; under 5 s; a few words over crowd,
laughter or music; mostly music. It judges only what is inside the clip.

## 2. Look at the frames

```bash
./clip frames <videoId> <start> <middle> <end>
```

Read all three. You are checking what the engine cannot:

| You see | Decision |
|---|---|
| **Burned-in captions** already in the footage | Ours are duplication: **off**. |
| A **facecam, scoreboard, chat box or HUD** where the caption band sits | Raise to y 0.68, or to the other band of a split layout. If nothing is free: **off**. |
| A **text-heavy screen** (a document, a chat, a map, a menu) that is the point | Captions would cover the content: **off**, or boxed and small above it. |
| A **busy background** (gameplay, IRL, crowds) | `street` (thick outline), never `native`. |
| **Non-English** speech | **Off** (English only for now). Do not translate. |
| The **joke prop or the face** near the caption band | Move the captions; never cover it. |

## 3. Read the words

```bash
./clip transcript <videoId> --from <in> --to <out>
```

Check, against the title, the hook and the viewer-clip titles:

- **Names, brands, places:** the usual Whisper misses.
- **Homophones and dropped words.**
- **Repeated phrases:** a Whisper loop, or real emphasis ("swim swim swim")? The engine flags three in a row and does not hide them. You decide from the meaning.
- **Non-speech tags** (`[music]`, `[laughter]`, `[__]`): never shown as words.
- **Profanity:** masked by default (`captions.censor`, 2026-11-22): strong swears show as `f***ing`, `s***`, and slurs are starred out whole, with no fix needed. Turn it off only for a clip that needs the word on screen (`./clip set <clip> captions.censor=false`). The captions are only the text: a word that must not be **heard** needs `./clip censor <clip>` (a bleep).
- **The punchline word.** If the joke turns on one word, that word must be right.

## 4. Decide

- **OFF** when: no or almost no speech; music, crowd or laughter only; burned-in captions; non-English audio; a text-heavy screen; an unreliable transcript (loops, nonsense); under about 5 s.
- **ON** when: spoken English, and the words add the joke, the context or search value.
- **Style and place:**
  - Gaming, stream, IRL, busy background: `street` (the default): 2–3 word phrases, heavy italic caps with a thick outline, a shouted phrase in yellow; 96 px.
  - Talk, podcast, commentary: `commentary`, sentence-case italic, 68 px.
  - A playful or rapid-fire clip: `comic` (a colour per phrase), 84 px.
  - Calm, static shot where a loud look would fight the mood: `native`, plain, 60 px.
  - `bold`, `boxed` and `clean` are the old auto-captioner looks, kept for clips that already use them; do not choose them for new clips.
  - Split layout: over the game band, not the facecam; y 0.72.
  - Crop: y 0.74, inside the bottom safe zone.
- **Words:** fix only what you can verify. When unsure, hide the word (empty fix) instead of inventing one.

## 5. Apply

```bash
./clip subtitles <clip>
```

Applies the engine's word fixes and its look, and prints exactly what changed
(`changed style street → commentary, position 0.74 → 0.72`).

- It **never turns captions back on** when they are off: off is always someone's decision. `--enable` allows it.
- It does not overwrite a word fix that is already there. `--force` does.

Then make your own decisions from steps 2–4:

```bash
./clip set <clip> captions.enabled=false
./clip set <clip> captions.style=street captions.position=0.68 captions.uppercase=true captions.fontSize=96
./clip caption-fix <clip> '#123' "correct text"      # or by time: 14:50.2 ; "" hides the word
```

**After any decision made from the frames, later runs use `--no-settings`**, so the engine's look does
not replace yours:

```bash
./clip subtitles <clip> --no-settings
```

## 6. Re-render only if needed

If the clip was already rendered and you changed a caption setting or a word, render again and read QA:

```bash
./clip render <clip>
```

Finish with a table: clip, captions on or off and why, style and position, word fixes applied, and
risks seen in the frames (burned-in text, facecam overlap, non-English, profanity).
