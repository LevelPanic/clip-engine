# Content risk and censorship review — 2026-11-22

Review only: nothing in the code, data or YouTube was changed. The measurements were taken 2026-11-22 between
12:30 and 13:10 UTC, from the library on disk plus read-only YouTube calls (2 `videos.list`, 1 `channels.list`, 4 Analytics
reports). "Data" means measured here; "inference" means a reading of the data that YouTube does not confirm.

## Top findings

1. **The drop is channel-wide, not clip by clip** (data). The 25 clips that went live from Nov 18 to 09:10 UTC Nov 21
   have a median of **1,149** views. The 22 that went live after that, through the end of Nov 21, have a median of
   **3**. Clean clips (no flag, no swearing) after the drop also got 2–10 views. Clips with f-words before it got a median of 1,267.
   So the content of each new clip does not explain its views. Something changed for the channel between 08:58 and 09:18 UTC
   on Nov 21.
2. **The two gone videos are the two riskiest uploads the channel made** (data). One is a nude-shower clip:
   in-game rear nudity in most of its 40 s, "nude" in the title, flagged `sexual` by all three experts. The other is a
   GTA 6 cutscene in which the creator is a corner avatar, with "fuck yourself" and a brawl. It went live at 08:23 UTC on Nov 21,
   about an hour before the drop.
3. **Risk is measured but never stops anything** (data). Expert flags, the 18+ check and slur warnings all end as
   QA *warnings*. Since today, QA does not hold an upload either. Swearing is not measured at all on Twitch clips: the only
   profanity check looks for YouTube's `[__]` caption mark, which Whisper never writes. So **61 of the 62 clips with an f-word
   in the audio** got no warning; the one that did is a Trash Taste clip whose YouTube captions carried `[__]`.
4. **The pipeline is drawn toward sexual moments** (data). The moment ranker follows viewer clips, and the most-viewed
   viewer clips on these streams are the sex and nudity scenes. "Emily watches Jason take a shower" has 1,837 views and
   "Emily reacts to Jason and Lucia in bed" has 1,775. **23 of the 111 clips waiting for review are flagged `sexual`**, and
   at least 6 show nudity or a sex scene as their subject.
5. **There is no way to censor in an edit today** (data). There is no bleep, mute or blur; the editor agent's prompt
   says so (`src/pipeline/full.ts:412`). The tools can hide a word from captions but not from the audio. In
   `tw-2936074636-c06` the editor hid an explicit in-game rap verse from the captions, and the verse still plays in full.
6. **Upload volume rose 2.6×** the day of the drop (data): 10 on Nov 19, 10 on Nov 20, **26 on Nov 21**. Every Nov 21 title ends
   in 💀, 😭 or 🔥, and about 20 of the 26 are GTA 6. In the three days before, the uploader made **62 upload calls YouTube refused**
   for the channel's or the project's daily limit.

---

## 1. What likely caused the flags and the drop

### What the data shows

**The two videos that are gone** (missing from `videos.list` and from the uploads playlist; the channel's `videoCount` is
69 = 71 uploaded − 2):

| | `tw-2932651985-c06` | `tw-2932226282-c10` |
|---|---|---|
| Title as posted | the creator's name, "CAN'T watch", the scene, 💀 | the creator's name, the prompt, "ENDED in a brawl", 💀 |
| Live | 2026-11-20 03:10 UTC | 2026-11-21 08:23 UTC |
| What is on screen (12 stills checked) | Jason's bare buttocks and back in the shower in **11 of 12** stills, filling the game band, captions over the body; Emily's cam on top | A dark GTA 6 cutscene in a small band inside a blurred frame; the creator is the peanut avatar in a corner; an in-game brawl at the end |
| Words | "dick" at 0:33 | "fuck yourself" kept unbleeped as the punchline (editor's hand-over) |
| What the pipeline knew | 18+ check: 13 points (nudity in 11/19 stills, 3 experts `sexual`, 14 lewd chatters). The curator's hand-over: "needs a person's sign-off before it is posted" | Curator's open question: "a clip carried by the game's writing, with the creator in a corner" |
| Approved | 2026-11-19 18:04 | 2026-11-20 11:25; uploaded on try 21 after the daily limits held it from 01:38 to 08:18 |

**Views per upload** (live counts at 12:30 UTC Nov 22):

| Went live | Clips | Median views | Under 100 | Notes |
|---|---|---|---|---|
| Nov 18 → Nov 21 09:10 UTC | 25 | 1,149 | 2 | 7 of them have an f-word: median 1,267 |
| Nov 21 09:10 → 24:00 UTC | 22 | **3** | 18 | Only 4 over 100: 1,174 (Emily, `tw-2934173613-c04`), 574, 217, 112. The 6 with no flag and no swearing: median 3 |

The last two clips before the drop (live 08:43 and 09:03) got 1,149 and 963. The next three (09:23, 09:43, 10:03) got 0, 0, 0.

**Channel standing** (`channels.list`): `longUploadsStatus: allowed`, not monetized, 5 subscribers, 40,323 lifetime views.
The API grants long uploads only to a channel in good standing (no Community Guidelines strike and no worldwide Content ID
block). Uploads kept succeeding after the drop, and one went up today at 12:57. A Community Guidelines *strike* freezes uploads
for a week, so **there is no active strike**. A first-time *warning* does not freeze uploads, so a warning is not ruled out.
No live video carries an age restriction or a region block.

**Analytics** (daily views, lagging 2–3 days, so they stop at Nov 19): Nov 15 9,841 · Nov 16 3,254 · Nov 17 971 ·
Nov 18 9,419 · Nov 19 10,386. On Nov 19, 9,360 of the views came from the Shorts feed. Analytics has no rows yet for either gone video.
Signed-in viewers: 16.9% are 13–17 (from this morning's pull).

**Volume:** uploads per UTC day: Nov 15 7 · Nov 18 3 · Nov 19 10 · Nov 20 10 · **Nov 21 26**. Refused upload calls in
`library/upload-log.jsonl`: Nov 19 14 · Nov 20 26 · Nov 21 22. Clips made per day: Nov 20 31 · Nov 21 64 · Nov 22 38 by 13:00.

### What the data cannot show

- Whether YouTube removed the two videos or someone deleted them. If YouTube removed them, under which policy, and whether
  that came with a warning. Only YouTube Studio and the channel's email can say (section 3c, C1).
- When each video disappeared. The drop's start time fits the Peanut clip going live an hour earlier. It fits the shower clip
  being acted on at any time in its 30 hours just as well.

### Inference: what most likely happened

From most to least likely; they can all be true at once.

1. **A YouTube action on the nude-shower clip.** Its subject is a nude body for most of its length, and its title says
   "nude". YouTube's nudity policy covers video games and weighs "whether the body is the focal point". Three experts flagged
   it, and the 18+ check gave it 13 points. A first removal normally comes with a warning, not a strike. That matches what we
   see: uploads still work, and the API still reports good standing.
2. **A removal of the Peanut clip.** It is the closest thing the channel has posted to "scraped content": a game cutscene with
   nothing of the creator except an avatar. It also has a stated f-word punchline and violence in a dark, tiny picture. A
   copyright notice from the game's owner over a story cutscene on launch week is also possible. I could not read Rockstar's
   video policy (the page timed out).
3. **Volume and sameness.** 26 uploads in a day from a 5-subscriber channel, in one title template and mostly one game, right
   after 62 refused upload calls. YouTube's spam policy lists repetitive, templated and mass-produced content. Its monetization
   policy now calls this "inauthentic content". A distribution limit triggered by this would also be channel-wide.

The common thread: the drop follows the channel's two riskiest uploads and its biggest upload day. Making each clip safer
lowers the chance of a second action (a second violation of the same policy within 90 days of a warning becomes a strike).
It will not by itself bring the feed back.

### YouTube policies that apply

| Policy | What it says that matters here | Where it bites this channel |
|---|---|---|
| [Nudity and sexual content](https://support.google.com/youtube/answer/2802002) | Applies to "video games"; what does not reach removal may be age-restricted; weighs whether the body is the focal point | Shower, bed-scene, lingerie and strip-club clips (23 waiting are flagged `sexual`) |
| [Violent or graphic content](https://support.google.com/youtube/answer/2802008) | Game violence is generally allowed when the fiction is apparent; focusing on the most violent part of a game, or a title meant to shock, leads to age restriction | "beats an NPC with a bat", "kneecaps", "f-bomb brawl" titles |
| [Vulgar language](https://support.google.com/youtube/answer/10072685) | Age restriction, removal or a strike; names heavy profanity in titles, thumbnails and metadata, and clips that focus on profanity | 62 clips with f-words, 71 with profanity shown in captions; "f-bomb" in a live title |
| [Hate speech](https://support.google.com/youtube/answer/2801939) | Slurs that promote hatred, in speech, text or imagery; context must be in the video itself | Possible slur said in `tw-2935679784-c02`; slurs in on-screen chat (8 waiting clips flagged `slur`) |
| [Spam, deceptive practices and scams](https://support.google.com/youtube/answer/2801973) | Repetitive or templated content; mass-produced content; re-posting others' material without adding anything; misleading titles | 26 a day in one template; cutscene clips with the creator barely present |
| [Community Guidelines strikes](https://support.google.com/youtube/answer/2802032) | First violation is usually a warning; policy training makes it expire after 90 days; a strike freezes uploads for a week; 3 strikes in 90 days can end the channel | What to do if Studio shows a warning |
| [Age-restricted content](https://support.google.com/youtube/answer/2802167) | Not viewable by under-18s or signed-out users | An 18+ upload reaches a small part of a Shorts audience (16.9% of signed-in viewers are 13–17) |
| [Channel monetization](https://support.google.com/youtube/answer/1311392) and [Shorts monetization](https://support.google.com/youtube/answer/12504220) | Reused content without significant original commentary; "inauthentic content … repetitive or mass-produced"; re-uploads are ineligible | Not monetized today; this is what a future YPP review will read |
| [Advertiser-friendly guidelines](https://support.google.com/youtube/answer/6162278) | Profanity at the start or throughout limits ads; strong profanity in a title means no ads; bleeping or muting counts as obscured | The case for bleeping, and for keeping f-words out of the first seconds and the title |
| [Copyright strikes](https://support.google.com/youtube/answer/2814000) and [appeals](https://support.google.com/youtube/answer/185111) | Copyright strikes expire after 90 days with Copyright School; warnings and strikes can be appealed within 6 months, removals within 1 year | Section 3c |

---

## 2. Where risky content gets through today, stage by stage

| Stage | What it does with risk | The gap | Example from the library |
|---|---|---|---|
| **Moment ranking** (`src/scan/moments.ts`, `src/scan/rank.ts`) | Ranks by viewer-clip views, clippers and laughter | Nothing reads what a moment *is*. Viewers clip sex and nudity scenes the most, so those rank first | `tw-2932651985`: top viewer clips "Emily watches Jason take a shower" (1,837 views), "Emily gets a private dance at the GTA strip club" (1,261). `tw-2934173613`: "Emily reacts to Jason and Lucia in bed" (1,775) |
| **Queue experts** (`agents/queue-expert.md` § Risk flags) | Flag 13 kinds of risk; reject as `unsafe` "only when no cut can avoid the problem" | When the nudity *is* the moment, they confirm and flag instead of rejecting | Shower clip: confirmed by all three with `sexual`. NickEh30 song: the viral expert confirmed it, writing "the lyrics must be bleeped throughout", which no tool can do |
| **Candidate warnings** (`src/candidates/index.ts:152–271`) | Turns expert flags, slurs in chat and chat's doubt into `risk:` lines | `profanity` is dropped on purpose (line 238). `riskWarnings` only counts `[__]`, YouTube's caption censor mark, which Whisper transcripts never contain | 62 clips have an f-word in the audio; the QA reports of 61 of them never mention swearing (the exception, `HZL1TdrmrGM-c01`, is a YouTube source with `[__]` captions) |
| **Curation** (`.claude/skills/clip-curator/SKILL.md`, `src/curate/`) | A risk flag → `review`, not `keep`. `unsafe` is a drop ground | `pickForEdit` (`src/pipeline/full.ts:284`) hands the best `review` candidate to the editor when nothing is kept, so a moment whose only candidate is risky still becomes a clip | The shower clip reached the editor as a `review` pick with the curator's "needs a person's sign-off" |
| **Editor** (`.claude/skills/edit/SKILL.md`, `reviseClip`) | Cuts, zooms, crops; passes flags to the reviewer word for word | No bleep, mute or blur. Swearing in captions is "flagged, not censored" (`subtitle-expert` SKILL line 63). The title rule (edit SKILL line 216) asks for one word in capitals and a reaction emoji, and says nothing about bait words | `tw-2936074636-c06`: the rap verse ("Fuck me 'til my coochie's…") hidden in captions, still in the audio. `tw-2935679784-c02`: a word that may be a slur hidden from captions only ("the audio is untouched") |
| **Captions** (`src/edit/subtitles.ts:23, 111`) | Detects 8 swear words; suggests censoring only "if you need it" | Off by default | 71 clips show profanity in their captions, 34 of them waiting |
| **QA** (`src/qa/index.ts`, `src/qa/adult.ts`) | Shows `risk:` lines as `content` warnings; the 18+ check runs NudeNet on a still every 2 s | Every risk is a warning. The 18+ check runs **after** the render, so the editor never sees where the nudity is. NudeNet's boxes are thrown away (`tools/nudity/main.py` keeps the label and score only) | 13 of 209 rendered clips tick 18+; 3 of them were uploaded, none age-restricted |
| **Review page** (`src/studio/web/Review.tsx`) | Lists QA issues; 18+ check box (pre-ticked from QA) | Risk is one line among QA's length, loudness and hook notes; nothing asks the reviewer to confirm a `sexual`, `slur` or `minor` flag before A | The shower clip was approved with three experts' `sexual` flag and the curator's sign-off request in the note |
| **Uploader** (`tools/upload-cron.ts:148–152`, `src/core/channel.ts`) | Since today, a failed QA is logged and uploaded anyway. Only a missing credit and `doNotClip` refuse | No content rule at all after approval. 20-minute pacing all day; a held clip is retried every 60 minutes (it was every 20 minutes until Nov 21) | 26 uploads on Nov 21; 62 refused upload calls on Nov 19–21 |
| **Titles** (`suggestTitles`, `src/core/post.ts`) | Five options from a viral-channel template | No word list | Live: "nude shower scene" (gone), "f-bomb brawl", "kneecaps … kills", "INTERVIEWED a killer". Waiting: "nude shower minigame", "stripper", "Strip Club Trip", "sex scene", "gooner pics" |

**In numbers** (214 clips with projects; "waiting" = the 107 in To review plus the 4 sent back for changes):

| | Uploaded (71) | Waiting (111) |
|---|---|---|
| f-word in the audio | 23 | 29 |
| profanity shown in captions | 25 | 34 |
| expert flag other than profanity | 17 | 66 |
| flagged `sexual` | 5 | 23 |
| flagged `slur` (said, or typed in chat during the clip) | 1 | 8 |
| flagged `violence` | 6 | 21 |
| 18+ check ticked (4+ points) | 3 | 10 |

There are no Approved clips waiting to upload: the only approval today went up at 12:57 (`tw-2931374441-c35`, scheduled
for 13:02).

---

## 3. Suggestions, ranked

Effort: **S** = under a day, **M** = 1–3 days, **L** = more. "Effect" is what the change would have done on this
library; anything about reach is inference.

### (a) Gates: what should stop or hold a clip, and where

| # | Gate | Evidence | Where | Effort | Expected effect |
|---|---|---|---|---|---|
| **A1** | **A short never-post list, enforced at upload the way the credit is:** nudity in frames (the 18+ check's frame reason at full weight: 2+ stills, or one ≥ 0.7), a `slur` said in the cut, a `minor` flag, a title with an explicit word. QA otherwise keeps not blocking | The shower clip went up with 13 points and a written sign-off request; the reviewer is one person approving ~100 a day | Add an `unsafe` refusal next to `uncredited` in `src/core/channel.ts`; `publishYoutube` / `uploadTikTokInbox` refuse it; `upload-cron` sets it aside with **Retry upload** (existing path). Store a structured `nudity: { stills, best }` in `AdultCheck` (`src/qa/adult.ts`) instead of parsing reasons. Only a new render that no longer trips it clears it | S | Would have kept the shower clip off YouTube; blocks 4 waiting clips. **This narrows today's "QA does not hold an approval" rule, so it is the user's call** |
| **A2** | **Risky picks stop at curation.** `sexual` from 2+ experts, `slur` inside the cut, or `minor` → `drop: unsafe` unless the reason says how the cut avoids it. `pickForEdit` must not fall back to a `review` candidate whose concern is one of those flags | 23 of 111 waiting are `sexual`; the shower and bed clips came in as `review` picks | `src/pipeline/full.ts:284` (`pickForEdit`); `src/curate/index.ts` (refuse `keep`/`review` for those flags without an "avoids it by …" reason); curator SKILL table; queue-expert.md step 6: "the nude body or sex scene **is** the moment → reject `unsafe`" | S | Fewer risky clips reach the reviewer, and no editor time is spent on them |
| **A3** | **Rank down sexual moments.** A moment whose viewer-clip titles or chat are mostly sexual is demoted or skipped | Top viewer clips on two streams were the shower and the bed scene | `rankAndStore` (`src/scan/rank.ts`) using `riskTerms` (`src/core/risk.ts`) on clip titles and `lewdChat` (`src/qa/adult.ts`) on chat; record the skip as `skipped` with why, like `NEVER_CLIP` | S | The watchlist stops spending jobs on them at all |
| **A4** | **Measure swearing** (warn, never fail): strong-profanity count in the words that play, any in the first 3 s, any in captions, any in the title | 61 of 62 f-word clips not warned | Move `PROFANITY` from `src/edit/subtitles.ts:23` into `src/core/risk.ts`; use it in `riskWarnings` (`src/candidates/index.ts:152`) and as a `language` check in `src/qa/index.ts` | S | The reviewer and the bleep pass (B2) see where it is |
| **A5** | **Title lint.** Sexual words fail (nude, naked, sex, stripper/strip club, fetish, gooner, horny); violent or shock words warn (kill, kneecap, f-bomb, brawl, body) | 22 uploaded and 21 waiting titles hit the word list | `suggestTitles` (`src/core/post.ts`) stops proposing them; a QA `title` check; edit SKILL line 216 gains "no sexual or shock words; say what happened" | S | Removes the metadata signal the vulgar-language and violence pages name |
| **A6** | **Find nudity before the edit,** not after the render | The editor never saw the shower clip's nudity spans | Run `checkAdult`'s frame pass on `cut.mp4` (the 16:9 cut `renderClip` makes first) or on the candidate window at curation; add NudeNet's `box` to `tools/nudity/main.py` output | S–M | Makes B3/B4 automatic |
| **A7** | **Risk first on the review page.** A strip above the player: flags, NudeNet hit stills as thumbnails, swear count, title words. A clip with `sexual`, `slur` or `minor` needs one extra key ("checked") before A | The shower clip's flags were one QA line among many | `src/studio/web/Review.tsx` | M | Fewer approvals on autopilot |
| **A8** | **18+ only for borderline language or innuendo, never for nudity.** Age-restricted Shorts are not shown to under-18s or signed-out viewers, so an 18+ upload gets little reach and the nudity policy still applies to it | 16.9% of signed-in viewers are 13–17 | Wording on the review page's 18+ line and in CLAUDE.md; with A1, a nudity clip cannot be approved as 18+ | S | Stops using 18+ as a way to post what should not be posted |

### (b) Editing techniques that make a risky moment postable

All of these fit the marker system: one folder per type in `markers/<type>/`, plugging in by layer, with no type name
special-cased anywhere. They should be added by an editor pass as **proposed** markers (`source: editor:censor`), so the
reviewer sees them dashed and accepts them.

| # | Technique | How it fits | Effort | Use it for |
|---|---|---|---|---|
| **B1** | **Mask swearing and slurs in captions** (`f***`, `s***`; slurs fully starred) by default | Caption fixes already exist (`captions.fixes`, word-numbered, survive merges via `remapCaptionFixes`). `subtitles.ts` writes `****` fixes instead of an info note; flip subtitle-expert SKILL line 63 to "censor by default". The 18+ check already reads the fixed words | S | All 34 waiting clips with profanity in captions; on-screen text is what the vulgar-language policy names |
| **B2** | **`bleep` marker: a tone or plain mute over a word** | New `markers/bleep/` (span). The tone is an `audio`-layer `Component` (`<Html5Audio>` of `assets/sfx/bleep.wav`, like `sfx/`). Silencing the source needs one new optional hook in `src/markers/define.ts`, say `gain(params, tMs) → 0..1`, applied where `ClipComposition.tsx:156` already passes a per-frame `volume` function for fades. Studio and render share the composition, so preview and export match. A `clip censor <clip> [--slurs] [--fwords all\|open]` command places spans from the transcript's word times (± 80 ms) | M | Slurs said in the audio (always), f-words in the first 3 s, explicit lyrics (mute the whole span), `tw-2936074636-c06`, `tw-2935679784-c02` |
| **B3** | **`blur` marker: a soft or pixelated box over part of the picture** | Cheapest form: `markers/blur/` as an `overlay` span with a box in canvas 0–1 coordinates, keyframes and strength. Its `Component` draws a `backdrop-filter: blur()` box. Overlays are drawn over the framed video in both the Studio and the export, so `framing.ts` and `FramedVideo.tsx` do not change. **First check** that `bin/headless-shell` (with `--in-process-gpu`) applies `backdrop-filter` over `OffthreadVideo` frames; if not, draw a solid or pixelated box. A blur in source coordinates is the alternative: a crop → `boxblur` → overlay stage with an `enable` expression in `framingFilter` (`src/render/framing.ts:114`), mirrored as a clipped CSS `filter: blur()` copy in `FramedVideo.tsx`. The split spans already use that pattern, and both sides must change together. Tracking a moving body means keyframes from NudeNet's boxes (A6) | M for a static box, L tracked | Incidental nudity (an NPC in the background), an on-screen chat with a slur, a bystander's face or a document. **Not** a fix for a clip whose subject is the nude body: a blurred shower scene is still a shower-scene clip |
| **B4** | **Cut or cut away from the nude seconds** | `cut` markers exist: propose them over NudeNet spans (A6). A "camera only" framing for a span (the reaction fills the frame while the scene plays) needs a new framing mode in `FramingSchema` / `splitGeometry` (`src/core/layout.ts`), read by both sides | S for cuts, M for camera-only | A moment where the reaction is the joke and the nudity is a few seconds of it |
| **B5** | **Crop or blur the chat overlay** when a slur was typed during the clip | `chatSlurWarnings` already gives the time; a reframe or a B3 box over the chat region for those seconds | S with B3 | `tw-2933861646-c02`, `tw-2935613960-c01` |
| **B6** | **Softer titles:** say what happened, not the bait word | Title lint (A5) plus the edit skill | S | "nude shower minigame" → no post; "Strip Club Trip" → "ohnePixel loses his GTA 6 wife in a club"; "f-bomb brawl" → "Nick's family-friendly stream lasts 10 seconds" |
| **B7** | **Mute explicit music** | B2 with a mute span over the song; or cut | with B2 | In-game songs with explicit lyrics |

### (c) Channel-level steps

| # | Step | Why | Who / where |
|---|---|---|---|
| **C1** | **Look in YouTube Studio before anything else goes up.** Check the Content list for the two videos and any restriction label, the Copyright section, the channel-violations area on the dashboard, and the channel account's email for "removed" or "warning" messages. If the videos are not in Studio at all, someone deleted them: check who has access | The API cannot say what happened; everything below depends on it | The user, by hand (10 minutes) |
| **C2** | **If there is a Community Guidelines warning:** take the policy training (the warning then expires after 90 days). Post nothing near the same policy for 90 days, because a repeat becomes a strike and a 1-week upload freeze | [Strike basics](https://support.google.com/youtube/answer/2802032) | The user, in Studio |
| **C3** | **Appeal only what looks wrong.** The Peanut clip, if it was removed under the violence policy (the fiction is apparent). Do not appeal the shower clip. Removals can be appealed within 1 year, warnings and strikes within 6 months, each once | [Appeals](https://support.google.com/youtube/answer/185111) | The user, in Studio |
| **C4** | **Slow down.** Cap uploads at 6–8 a day, 2+ hours apart, never above the day before's allowance. On `uploadLimitExceeded`, wait until 24 h after the day's first upload instead of retrying every hour | 26 on Nov 21; 62 refused upload calls on Nov 19–21 | A daily cap and a limit-aware wait in `tools/upload-cron.ts` (S) |
| **C5** | **For the next 1–2 weeks, post only the cleanest clips:** no `sexual` flag, no f-word in the first 3 s, the creator visible and reacting, not a cutscene | Inference: it gives YouTube nothing new to act on while the channel's standing is unknown, and it is the content that earned views before | Review discipline, and A2/A5 |
| **C6** | **Less sameness.** Vary the title template (all 26 Nov 21 titles end in 💀, 😭 or 🔥), mix creators and games, and make the channel's own part visible: the context line and a reaction-first cut. Keep cutscene-only clips out | The spam policy's "repetitive or templated"; a future YPP review reads reused content | Edit skill and `suggestTitles` |
| **C7** | **Two live clips the 18+ check marks:** `tw-2932209302-c04` ("GTA 6's first bed scene", underwear, no nudity in the stills checked) and `tw-2934132437-c02` ("have sex" said in a fake ad). Both are borderline. Look at them; leave them, or age-restrict them yourself in Studio. Do not delete by reflex | Deleting does not remove a strike; neither clip is clearly over the line | The user |

---

## 4. The riskiest clips waiting now

To review: 107. Changes: 4. Approved but not uploaded: none. Ranked by what was seen in stills (12 per clip, for the
ones marked 👁) and by the experts' and 18+ check's evidence.

| # | Clip | Title | What is wrong | Do |
|---|---|---|---|---|
| 1 | `tw-2932651985-c13` 👁 | ExtraEmily covers her face at GTA 6's bikini reveal | Lingerie-clad body as the subject in most stills; NudeNet exposed breasts in 2 of 15; lewd lines in the on-screen chat; same creator and kind of scene as the removed video | **Reject** |
| 2 | `tw-2933650141-c06` 👁 | NickMercs scrubs Lucia in GTA's nude shower minigame | Rear nudity in half the clip; "nude" in the title | **Reject** |
| 3 | `tw-2933650141-c05` | NickMercs defends GTA shower to chat, then the mirror | Nudity in 7 of 19 stills; 3 experts `sexual`; swearing in captions | **Reject** |
| 4 | `tw-2934173613-c07` 👁 | Emily reacts to Jason and Lucia's GTA6 bed scene | A sex-scene cutscene for most of the clip | **Reject** (camera-only, B4, would be the only recut) |
| 5 | `tw-2936368149-c01` 👁 | GTA cop busts Joe's stripper for a concealed weapon | A stripper undressing on stage; "jerking off" said; "stripper" in the title | **Reject** |
| 6 | `tw-2936074636-c06` 👁 | NickEh30: 'I'm so sorry I exposed that' | Explicit in-game rap verse plays for about 15 s, hidden from captions only; flagged `sexual`, `music`, `slur`; NickEh30 is a family-friendly creator | **Reject now**; postable later only with the verse muted (B2) |
| 7 | `tw-2935679784-c02` | yourragegaming asks a dead GTA NPC: 'you still alive?' | Beats a woman NPC with a bat; "Bitch, you still alive?"; a word hidden from captions that may be a slur ("tardy"); 4 f-words in 48 s; insults readable in the chat column | **Reject** |
| 8 | `tw-2936934156-c01` 👁 | Fanum's GTA 6 pool boy skips to the lotion scene | Porn-parody scene; the game is a small band in a blurred frame | **Reject** |
| 9 | `tw-2931602699-c02` (Changes) | moistcr1tikal reads a poop-fetish claim about a stranger | `sexual`, `harassment` of a private person, `misleading`, `third-party` | **Reject** |
| 10 | `tw-2936814907-c05` | xQc's GTA 6 phone gallery is 32/32 full of gooner pics | 2 experts `sexual`; 12 lewd chatters; "gooner" in the title | **Reject**, or retitle and check the frames |
| 11 | `tw-2934862154-c01` | ohnePixel's GTA 6 Strip Club Trip: 'Where's My Wife?' | 3 experts `sexual`; `staged`; "Strip Club" in the title | **Reject**, or retitle and check the frames |
| 12 | `tw-2936814907-c03` | xQc calls GTA 6's relationship plot trash | Someone else's Facebook reel fills the frame; flagged `minor` and `third-party` | **Recut** to xQc's camera, or reject |
| 13 | `tw-2932380541-c10` | NickEh30 hides GTA 6 sex scene on family-friendly stream | "sex scene" in the title; 2 experts `sexual` | **Retitle** and check the frames |
| 14 | `tw-2935613960-c01` | KaiCenat jokes his GTA 6 crew are all cocaine addicts | `drugs`; a slur typed in chat during the clip; 5 chatters call it staged | **Retitle** away from "cocaine addicts" and check the chat overlay at 0:00–0:10; or reject |
| 15 | `tw-2933861646-c02` | Jynxzi's 'big one' is a tiny fish | A slur in the on-screen chat around 0:22–0:32; the editor reports it is not readable in the export | **OK after one look** at 0:16–0:30 |

Other sexual-flagged clips at 3 points without nudity in stills (`tw-2931602699-c04`, `-c05`, `tw-2932380541-c04`,
`tw-2934077549-c05`, `tw-2934876295-c04`, `tw-2935101396-c01`, `tw-2935398393-c04`, `tw-2935787599-c05`,
`tw-2936814907-c04`) should wait until A2 and C1 are settled. Most are innuendo; none should go up in the next two weeks (C5).
Heavy swearing, with nothing else flagged: `tw-2932305259-c20` (5 profanities in captions), `tw-2933599748-c02` (4 f-words),
`tw-2931374441-c38` (3): mask the captions (B1) before approving.

---

## The three changes to make first

**Before any of them:** look in YouTube Studio (C1). Whether there is a warning, a strike or nothing decides how careful the next two weeks must be.

1. **Stop sexual content at both ends.** At the start, the moment ranker demotes sexual moments (A3) and curation drops `sexual`/`slur`/`minor` picks instead of handing them to the editor (A2). At the end, a never-post refusal for nudity in frames, a spoken slur and a minor (A1), next to the credit rule. Then reject clips 1–11 above. Effort: S + S + S. This is the change most likely to prevent a second removal, and a second same-policy removal within 90 days of a warning is a strike.
2. **Slow the uploader down** to 6–8 a day, 2+ hours apart, and stop retrying against the channel's daily limit (C4). For two weeks, post only clips with no flag and the creator on screen (C5). Effort: S.
3. **Give the editor censoring tools,** in this order: caption masking by default (B1, S), swearing measured in QA (A4, S), the `bleep`/mute marker with a source-gain hook (B2, M), then the `blur` marker (B3, M). The first two make every clip's text clean within a day. The bleep turns clips like NickEh30's song or a stray slur into postable ones instead of rejects.

---

### Method

- Library: 214 `clips/*/project.json`, 211 `exports/*.qa.json`, `library/reviews.sqlite`, `library/upload-log.jsonl`,
  `.cache/upload-cron.log`, `library/*/queue-review.json`, `library/*/viewer-clips.json`, `library/*/transcript.json`.
- Words counted are the words that play: inside the segment, outside `cut` markers. Profanity list: fuck*, shit*,
  bitch*, cunt*, dick*, cock*, pussy, asshole*, bastard, whore*, slut*. "f-word" = fuck*, motherfuck*, cunt*.
  Slurs in the transcripts: none found by the `slurIn` patterns. A misheard slur, like the possible one in clip 7, is not
  caught by any pattern.
- Expert flags: any verdict whose moment is inside the clip or within 5 s of it (the same window `expertRiskWarnings` uses).
- Stills: 12 evenly spaced frames from each export for the 9 clips marked 👁 in section 4, plus the two gone videos and one live
  clip (`tw-2932209302-c04`).
- YouTube: `videos.list` (snippet, statistics, status, contentDetails) on the 71 uploaded ids; `channels.list` (status,
  statistics); Analytics daily views, traffic sources, and per-video rows for the two gone ids (none yet).
- Not done: Rockstar's video policy page timed out, so nothing here relies on it. YouTube Studio was not opened (C1).
