# Layout strategy: streamer window, content window and canvas

## 1. Why the current shorts look wrong

The current layout is mostly geometric, not perceptual:

- `src/reframe/cam.ts` detects a facecam from the first 30 seconds, clusters faces near an edge,
  grows the face box into a webcam rectangle, and optionally snaps it to a detected panel. It does
  not check the rest of the clip, scene changes, active speaker, or whether the cam crop contains
  game/chat/UI around the face.
- `src/reframe/split.ts` runs that detection once per clip and stores one `SplitLayout`.
- `src/render/framing.ts` builds the 9:16 frame:
  - `bandBox` expands a box to the target band aspect.
  - `splitChain` stacks cam and game bands and fills the remainder with **black** padding
    (`canvasPad` 4% top and bottom).
  - The game band is a cropped window that avoids the cam box, which can cut HUD, scoreboards,
    minimaps or the actual action.
  - The cam band can include game/chat around the facecam because the box is expanded to the band
    aspect instead of cropping the cam panel itself.
- `src/qa` checks loudness, black frames and the hook, but **not the layout of the rendered short**.
- The fixed `camShare` (0.35) and fixed constants (`CAM_GROW_W/H`, `CAM_MAX_*`) are one-size-fits-all.

So the common failures are:

1. a facecam crop that includes game/chat around it, crops the head, or sits at the wrong scale;
2. a game/content crop that cuts the HUD or the action;
3. black bars / a canvas that is not filled, or source letterboxing shown inside the short;
4. no validation of the actual rendered 1080×1920 output.

## 2. The fix: three layout judges, not one

Each judge has a different input and a different question.

### 2.1 Streamer-window judge

**Input:** 5–7 stills from the clip (start, early, middle, late, end) with the proposed cam box
drawn, plus the cam crop alone at those times. Optionally the source frame with face landmarks.

**Checks:**

- the whole face is visible: hat/forehead, eyes, chin, shoulders; nothing clipped;
- eyes in the upper third, 5–10% headroom, face not tiny or huge;
- the crop contains the **cam panel**, not game/chat/UI around it;
- the cam panel is the same panel throughout the clip; no scene change or moved webcam;
- the face is the active speaker when there are several faces;
- the cam window aspect and position are stable;
- no burned-in captions, alerts, chat or private information inside the cam crop.

**Output JSON:**

```json
{
  "pass": false,
  "confidence": 0.82,
  "issues": ["head cropped at 0:03", "game visible on the left of the cam band"],
  "camBox": { "x": 0.62, "y": 0.55, "w": 0.28, "h": 0.32 },
  "headroom": 0.08,
  "camShare": 0.38,
  "action": "recrop | move | no-cam | keep"
}
```

If the judge says `no-cam`, the clip falls back to blur-fit or a full-frame layout for those spans.

### 2.2 Content/gameplay-window judge

**Input:** full-source stills with the proposed game box, the game crop alone, and the rendered short
frame. For HUD-heavy games, include frames with the minimap/scoreboard/objective visible.

**Checks:**

- the action and the important HUD are inside the crop;
- minimap, scoreboard, objective, ammo, health, subtitles and chat are not cut;
- no duplicated cam content in the game window;
- the game keeps its aspect; no stretched or squeezed image;
- the crop is not mostly a menu, loading screen, map or dead space;
- if the game cannot fit a split band without losing HUD/action, use **PiP** (full 16:9 game with a
  small cam overlay) or **full-frame** instead of forcing split.

**Output JSON:**

```json
{
  "pass": false,
  "confidence": 0.78,
  "issues": ["minimap cut on the right", "killfeed above the crop"],
  "gameBox": { "x": 0.0, "y": 0.0, "w": 1.0, "h": 0.62 },
  "mode": "pip | split | full | blur",
  "zoom": 1.0,
  "action": "recrop | pip | full | keep"
}
```

### 2.3 Rendered-short judge (canvas)

**Input:** 3–5 frames from the actual rendered 1080×1920 MP4, not the source.

**Checks:**

- no black bars or unfilled canvas above a small tolerance;
- no stretched or letterboxed source;
- the cam/game seam is clean; no duplicated frame;
- captions do not cover the face, HUD, scoreboard or safe zone;
- credit/banner does not cover the face or action;
- the short looks intentional at phone size: readable, filled, framed.

**Output JSON:**

```json
{
  "pass": false,
  "confidence": 0.9,
  "issues": ["2.5% black bar at the bottom", "caption overlaps the cam chin"],
  "action": "rerender | fallback-blur | fallback-pip | human-review"
}
```

This judge is the safety net: the source judges can be right and the output still be wrong.

## 3. Deterministic checks before the judges

The judges should not be the first line of defence. Add cheap measurements:

### Canvas

- black-pixel ratio per frame; fail above ~2%;
- source letterbox/pillarbox detection; crop to content before layout;
- content area fill; no stretched aspect;
- caption/credit overlap with face/HUD boxes.

### Cam

- face confidence and landmark completeness;
- face box vs cam box containment; headroom; edge clipping;
- temporal IoU of the cam box across samples;
- panel-ness (visible border/rectangle) vs face-grown box;
- non-cam content in the crop (game/chat/UI) via edge/entropy or a classifier.

### Content

- HUD/UI detection or OCR (minimap, scoreboard, killfeed, ammo);
- motion/optical-flow action centre inside the crop;
- crop coverage of the game region; no menu/loading screen;
- duplicate-frame check against the cam band.

### Captions

- subtitle box vs face/HUD/credit boxes; safe-zone check.

These can live in a new `clip layout audit <clip>` command and a post-render `layout` QA section.

## 4. Layout modes and profiles

Add explicit modes instead of one split:

| Mode | Use |
|---|---|
| `split` | clean facecam + HUD-light gameplay; cam band top, game band below |
| `split-16x9` | cam top, full 16:9 game plate at full width, background fill; no side crop |
| `pip` | HUD-heavy game full 16:9 with a small cam overlay in a corner |
| `blur` | podcast, IRL, events, no clean cam |
| `crop` | single-speaker close-up, opt-in |
| `full` | full-screen content, no cam |

Per-creator profiles store the measured cam panel, game region, HUD zones, preferred mode,
camShare, padding and background. They are set once and reused; the judges only verify.

The canvas should be filled by a blurred cover of the same frame or a brand background, not black
padding. `canvasPad` should become a background style, not a black `pad` filter.

## 5. Where to put the judges in the pipeline

Keep the edit order: structure → layout → decoration → captions → render.

1. After `clip make`, run deterministic `layout audit` on the proposed cam/game boxes.
2. Run the **streamer-window judge** and **content-window judge** in parallel on those boxes.
3. Apply their `camBox`, `gameBox`, `camShare`, `mode` fixes; re-audit.
4. Run the edit/meme/caption steps.
5. Render.
6. Run the **rendered-short judge** on the actual MP4.
7. If it fails, apply the fallback (blur/PiP/full), re-render once, then either pass or mark
   `layout review` for the human.

Do not submit a clip to review if the deterministic canvas check or the rendered-short judge fails.
A fallback is better than a bad vertical.

## 6. Feedback loop

Add review flags: `bad cam`, `bad game`, `bad canvas`, `caption overlap`. Store them with the clip
and creator. Use them to:

- update the creator's layout profile;
- add the failure to a layout benchmark set;
- tune judge prompts and deterministic thresholds;
- prevent the same creator/device error from repeating.

## 7. Implementation order

### Phase 1 — deterministic audit and output gate (highest value, no LLM)

- `clip layout audit <clip>`: source/canvas/cam/game metrics and a pass/fail report.
- Add layout checks to `clip qa` for the rendered MP4: black bars, aspect, face/HUD/caption overlap.
- Make `render` refuse to submit if structural layout checks fail.
- Replace black canvas padding with a blurred cover background.

### Phase 2 — the two source judges

- `layout-cam-judge` and `layout-content-judge` via OpenCode/DeepSeek vision, structured JSON.
- Run after `make`/before decorations; apply fixes and re-audit.
- Add `pip` and `split-16x9` modes so the content judge has a safe alternative to cropping.

### Phase 3 — rendered-short judge and profiles

- `layout-output-judge` after render.
- Per-creator layout profiles (`layout-profile.json` in the library or `channels.json`).
- Studio layout panel: draw cam/game boxes on a frame; save profile.

### Phase 4 — feedback and benchmark

- Review flags and a small labeled set of good/bad layouts.
- Measure judge precision/recall and false auto-submits.

## 8. Acceptance criteria

- canvas: <2% black bars, no stretched source, filled frame;
- cam: full face in ≥95% of sampled frames, 5–10% headroom, panel-only crop, stable box;
- content: HUD/action inside the crop; no duplicate cam; no menu/loading screen;
- captions: no overlap with face/HUD/credit;
- no clip reaches review with a failed structural layout check;
- human layout-rejection rate drops after Phase 1, then again after Phase 2/3.

## 9. What not to do

- Do not use one monolithic layout judge; cam and content need different frames and criteria.
- Do not judge only the source; always judge the rendered short.
- Do not force split on every Twitch clip; HUD-heavy games need PiP or a full game plate.
- Do not trust a face box as a cam panel; use panel/landmarks and temporal stability.
- Do not let black padding stand in for a canvas.
