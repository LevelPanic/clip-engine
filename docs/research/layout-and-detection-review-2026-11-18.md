# Layout and detection review — 2026-11-18

A second opinion on `docs/research/layout-strategy.md`, plus a look at why weak moments reach review.

**What this is based on:**

- **Renders:** all 36 Twitch renders in review, approved or rejected. Three frames of each were viewed.
- **Expert verdicts:** the 418 verdicts in `queue-review.json` across 13 streams. For each judged moment, the chat and viewer clips were recomputed from the stream's own data.
- **Your decisions:** the approve/reject rows in `library/feedback.jsonl` and `reviews.sqlite`.

## 1. Layout: what is actually failing

Of the 36 renders, about 17 look right. Ignore the black strips for that count; they are on every split render, covered below. The failures fall into five kinds, and most come from three creators' setups.

| Failure | Renders | Cause in the code |
|---|---|---|
| Black strip at the top and bottom | every split render (26) | `canvasPad` 0.04 is a black `pad` (77 px each end) |
| Cam band shows the game or website next to the cam | ~13: NickEh30 (borderless cutout) c01 c07 c19 c20 c22, xQc c01 c02, Ludwig c04 c05 c06, Nickmercs c17 | `bandBox` widens the cam box **outward** to the band's aspect, pulling in whatever sits beside the cam |
| Content band keeps the middle half of a website, survey or menu | 5: xQc c01 c02, Ludwig c04 c05 c06 | the game window is a ~0.87:1 slice of a 16:9 frame (49% of its width) for every kind of content |
| Split used where there is no facecam | 3: SypherPK IRL c11 (both bands are room footage), Nickmercs c05 (the "cam" is other players' cams, a torso, then an empty box), NickEh30 c09 (a phone video with black sides) | detection reads only the first 30 s; the editor agent picks the mode from a one-line instruction in `src/pipeline/full.ts` |
| Layout changes mid-clip, framing does not | 3: Ludwig c12 (game band goes black, then a launcher), Nickmercs c18, NickEh30 c13 | one layout per clip; nothing looks for scene cuts |

Clip ids are `tw-<vod>-cNN`. NickEh30 is `tw-2931365250`, Ludwig `tw-2931875711`, xQc `tw-2932113307`, Nickmercs `tw-2931374441` (c18 roulette) and `tw-2927580517` (c01, older), SypherPK `tw-2931627858`.

**What works today:**

- Nickmercs's GTA clips: the cam panel with its overlay bar, and the game below.
- CaseOh.
- Ludwig's crop and Valorant clips.
- moistcr1tikal's character creator.
- SypherPK's IRL clips in blur-fit. They are acceptable, if small.

### What I'd change in the other model's plan

**Where it's right:**

- The diagnosis is right.
- Phase 1, the deterministic audit and output gate, is right.
- Replacing the black pad is right.

**Where I disagree:**

- **No judges that output boxes.** Two LLM judges per clip that return `camBox`/`gameBox` coordinates add cost and variance. Language models are poor at exact coordinates.
- **Profiles first.** The failures above repeat per creator. The watchlist has about 12 creators, each with one to three stable setups. Store each setup once and make the detector **verify** it on every clip. That fixes most failures without any judge.
- **A vision model, if used, only answers yes/no on the rendered short.** For example: is a whole face in the top band, is any text cut, is there an empty area. It never chooses the geometry.

### The layout plan, in order

1. **Background, not black.** The split stack sits on the same blurred cover that blur-fit already draws (`blurChain`). `canvasPad` stays as a margin.
2. **The cam band follows the cam panel.**
   - The band's height comes from the panel's aspect: `camShare = 1080 / panelAspect / 1920`, clamped to 0.25–0.45.
   - If the panel needs more height than that, crop **into** the panel (zoom on the face). Never widen out of it.
   - For a borderless cutout (NickEh30), use a tight head-and-shoulders box. The game behind him is his own layout and is fine when the box is tight.
3. **Two content fits.**
   - `fill` keeps today's centre crop, for shooters and third-person games.
   - `fit` shows the whole 16:9 frame at full width, on the blurred cover. Use it for Just Chatting, websites, desktops, menus, videos in the stream, and HUD-heavy games.
   - The default comes from the Twitch category at the clip, which the chapters already give: Just Chatting is `fit`, a game is `fill`.
4. **Creator layout profiles.**
   - Store mode, cam box and content fit in `layouts.json` (or `channels.json`), per creator and per category.
   - The detector proposes a profile on the creator's first clip. You confirm it once in the Studio. After that it is reused.
5. **Verify across the whole clip, not the first 30 s.**
   - Sample every 2 s.
   - If the face is inside the cam box in under 80% of samples, that span falls back to blur-fit. Reframe keys already switch modes mid-clip.
   - ffmpeg's scene detection marks the cuts where a span starts.
6. **Render gate in `clip qa`.**
   - On the rendered MP4, sample 6 frames.
   - Fail if more than 2% of rows are black.
   - On a split, also fail if a face is in the top band in fewer than 5 of 6 frames. The Vision face tool already runs on files.
   - On a fail: fall back to blur-fit and re-render once. If it still fails, flag "layout" in review.
7. **Take the layout decision away from the editor agent.** The engine sets it from the profile and the category. The agent can flag a layout but not choose one.

## 2. Detection: why weak moments get through

### Findings

1. **The queue score does not predict anything.**
   - Queues scored 15–29 were confirmed 39–41% of the time. Queues scored 30–44 were confirmed 28–37%.
   - Viral queues scored 45+ were confirmed 24%.
   - Only the gate matters; the ranking is noise.
2. **Chat laughter is the strongest signal, and nothing gates or ranks on it.** It is measured as two or more different chatters typing a laugh (lol, lmao, KEKW, LUL…) in the moment's 10 s.

   | Kind | With chat laughter | Without |
   |---|---|---|
   | Meme | 65% (n=68) | 27% (n=44) |
   | Viral | 50% (n=30) | 18% (n=33) |
   | Chat spike only | 64% (n=53) | 35% (n=62) |
3. **An audio reaction on its own is the weakest witness.**
   - A laugh or shout with no chat laughter: confirmed 22% (n=32).
   - Today one detected laugh or shout passes the meme gate.
4. **Viewer clips are strong.**
   - Two or more clips within 45 s: 80% (n=15).
   - Clips with 100+ views: 64% (n=28).
5. **Low-chat channels produce spikes out of noise.**
   - NickEh30's fetched chat averages 2 messages a minute.
   - Nickmercs's "normal" is 2–3 chatters per 10 s, so 7 chatters counts as a 3.5× spike. Over an 8.5 h stream, chance alone produces dozens of those.
   - Nickmercs's broadcast has **224 meme queues**. The experts judged 102 of its queues, of all three kinds, and rejected 67.
6. **What reaches you is decided by agent-written scores that don't track your decisions.**
   - Three of the full-pipeline clips you rejected had almost no measured evidence, yet the agents scored them virality 67–70:
     - Nick c19: 8 chatters vs 7 normal, no laughter.
     - NickEh30 c20: 3 vs 0.
     - SypherPK c22: 7 vs 2, no laughter.
   - Your approvals scored virality 28, 59, 65 and 66. Rejections went up to 75.
   - Six clips that reached review carried the engine's own `skip` verdict. You rejected five of them and approved one (CaseOh's horse, virality 28).
7. **No reject reason is recorded.** Every reject note is empty. Nothing can tell a layout reject from a boring-moment reject, so no stage can be tuned against your taste.
8. **A hint, not a finding:** 3 of your 4 approvals are GTA 6 talk (Ludwig c04, Nick c24, SypherPK c13). The topic of the week may matter more than any score. Four clips is too few to build on.
9. **Small bug:** `library/clip@1:20:00` and `library/meme@1:40:45` are empty folders. An agent passed a queue id where a video id goes (`clip frames`). The command should refuse an id that isn't in the library.

### The detection plan, in order

1. **Reject reasons in the review page.** One tap each:
   - boring / no payoff
   - layout
   - cut wrong
   - title wrong
   - needs context

   Store them in `feedback.jsonl` and report them in `clip stats`. This is small, and everything below gets measured against it.
2. **Gate and rank on measured evidence.**
   - Add distinct laughing chatters to the queue evidence, using the `funny` words already in `LEXICON`.
   - New meme gate: chat laughter ≥ 2, **or** a viewer clip, **or** an audio reaction **with** a chat spike.
   - On the 338 judged queues, this keeps 95% of the confirmed meme moments, cuts 18% of meme queues, and lifts precision from 50% to 58%. That is a modest gain, and an honest one.
   - Rank queues by an evidence score built from laughter, viewer clips, views and spike size, in place of today's weights.
3. **A spike test for quiet chats.**
   - Where normal is under about 5 chatters per 10 s, require the count to clear the noise: at least 4 standard deviations above normal and at least 6 chatters, on top of the 2.2× ratio.
4. **An evidence floor before edit.**
   - The editor only gets a moment with measured evidence: chat laughter ≥ 2, a viewer clip, or a spike of 4 or more standard deviations.
   - This is an engine check, not an agent's score.
   - On the full-pipeline clips you decided, it would have stopped 3 of the 10 rejected (Nick c19, NickEh30 c20, SypherPK c22) and none of the 3 approved.
   - Rank what is left by evidence, not by the curator's "strongest fit".

## 3. Suggested order

1. Reject reasons (detection plan step 1).
2. Layout plan steps 1, 2, 3, 6 and 7. All deterministic, with tests; this fixes the black strips, the cam band and the cropped websites.
3. Profiles and whole-clip verification (layout plan steps 4 and 5) for NickEh30, Ludwig, xQc and SypherPK first.
4. Detection plan steps 2–4.
5. After about 50 decisions with reasons, measure again: per stage, which signal tracks your approvals.

## 4. Built on 2026-11-18

**Reject reasons:**

- On the review page, R opens the reasons, and 1–5 picks one: boring, layout, cut, title, context. R again rejects with no reason.
- The reasons are saved in `feedback.jsonl`.
- `clip stats` prints "why … were rejected".
- From the CLI: `clip review <clip> reject --reason layout,boring`.

**Layout plan steps 1–3 and 6–7:**

- **Blurred cover:** the split now sits on a blurred cover of the frame. Nothing is padded with black.
- **The cam band follows the panel:**
  - The band is sized to the cam panel's shape (`camShareFor`, 0.26–0.42).
  - The panel is cropped into, never widened out of (`src/core/layout.ts`).
  - The ffmpeg chain, the Studio preview, the credit's seam and the hook line all read this one geometry.
- **Cam fit:** a panel near the band's shape fills the width, cut around the face. A tall or small cam is shown whole in a centred window, enlarged at most 2.6×.
- **Whole-frame mode:** `content: 'fit'` shows the whole frame at full width under the cam. Non-game categories get it by default (`contentFitFor`, chosen from the chapter at the clip). The Studio inspector has a switch for it.
- **Detection over the whole clip:** facecam detection reads the whole clip, not the first 30 s.
- **Check before the render:** `src/qa/layout.ts` checks the framed picture before the render.
  - It looks for black bars for the whole clip, and for a face in the camera band (hybrid detector).
  - A whole-clip split with no face in its camera band becomes blur-fit and is framed again.
  - Black that is in the source is reported, not switched.
  - QA fails `layout` on what is still wrong.
- **The engine owns the layout:** the edit skill and the pipeline prompt say so.

**Not built yet:**

- Per-creator profiles (layout plan step 4).
- Detection plan steps 2–4.

**Known gap:** another player's face in the camera band passes the face check. Nickmercs c05 scored 0.65.

**Verified on six test copies of rejected clips** (rendered, then deleted; before/after in `docs/research/layout-before-after-2026-11-18.png`):

- **xQc, Just Chatting:** split with the whole website under the cam. The face is in the camera band 97% of the clip.
- **SypherPK's IRL coffee shop:** no facecam found over the whole clip, so it is blur-fit. It was wrongly split before.
- **NickEh30 Fortnite:** 100%, with a tighter cam band.
- **NickEh30's phone video:** the cam is shown whole in a window. 97% after the face-centred fit; it was 78% when the panel was cropped from the top.
- **Nickmercs:** 100%.
- **Ludwig:** the scene changes a third of the way in, so the face is in the band 67% of the clip. It fell back to blur-fit.

**The face bar is 80%.** At 60%, Ludwig's clip passed with the sponsor logo and a wall in the band.

**Not yet:** switching the layout per scene, which would keep Ludwig's split for the website part.
