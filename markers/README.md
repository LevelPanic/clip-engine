# Marker types

A marker type is one folder here. The Studio palette, the timeline, the inspector, the CLI and the renderer
all discover it, so adding a type never touches editor code.

```
markers/<type>/
  schema.ts    what it is: kind, layer, colour, and its parameters (zod) with defaults
  render.tsx   how it looks or sounds: a React component, or a camera transform
```

## Add a type

1. `cp -r markers/_template markers/whoosh`
2. In `whoosh/schema.ts`, set `type: 'whoosh'` (it must match the folder name), a label, the kind and the layer, and edit the params.
3. In `whoosh/render.tsx`, draw it. What you implement depends on the `layer`:

   | layer | you implement | example |
   |---|---|---|
   | `overlay` | `Component`: return JSX (frame 0 is the marker start) | `text/`, `flash/`, `tint/` |
   | `audio` | `Component`: return `<Html5Audio>`; optionally `gain()` in `schema.ts` to turn the clip's own sound down for the span (0 mutes it) | `sfx/`, `bleep/` |
   | `camera` | `camera()`: return a CSS transform for the frame; or `filter()` in `schema.ts`: a CSS filter on the picture | `zoom/`, `shake/`, `tilt/`, `mono/` |
   | `time` | `time()` in `schema.ts`: return `{ effect: remove \| speed \| hold }` | `cut/`, `speed/`, `freeze/` |
   | `framing` | `framing()` in `schema.ts`: return `{ mode, cropX, easeMs }`; add `untilEnd: true` on a span marker to frame only its span | `reframe/`, `solo/` |

   For `time` and `framing` markers, `render.tsx` is just `defineRender({})`; the core time map and framing do the drawing.
4. That's it. The Studio picks it up on the next reload (`markers/index.generated.ts` is regenerated automatically), and `./clip marker types` lists it.

## Rules

- **Whole-clip overlays:** an overlay that must cover the clip whatever its own time (a credit, a watermark) sets `fill: 'clip'` in its schema (`credit/`). Trimming the clip never leaves it short.
- **Kind:** `span` markers have a start and an end. `point` markers are a single moment, and `renderMs` says how long their effect runs.
- **Times:** markers are stored in source-video milliseconds, so they stay on the content when you trim.
- **Params:** every param has a default. Ranges (`min`/`max`) become sliders, and enums become dropdowns. `.meta({ ui: 'color' })` gives a colour picker and `.meta({ ui: 'sfx' })` a sound picker.
- **Shared code:** keep the schema free of React, because the CLI loads it in Node to validate edits.
- **The clip's own sound:** an audio marker's `gain(params, tMs)` sets it for the span (0–1, multiplied when spans overlap). The composition applies it to the video's volume, so the Studio and the export match, and `wordsThatPlay` (`src/qa/adult.ts`) counts a word under a gain below 0.5 as not heard. Never test for a type's name to mute: give the type a `gain`.
- **Assets:** use `useAsset()('sfx/boom.wav')` from `src/composition/context`, so the file resolves both in the Studio and when rendering.

## Built in

| # | type | kind | what it does |
|---|---|---|---|
| 1 | `zoom` | span | Push in on a focus point, smooth or snap; `direction: out` starts zoomed and pulls back (the reveal) |
| 2 | `shake` | span | Camera shake that decays |
| 3 | `flash` | point | Full-frame flash that fades |
| 4 | `sfx` | point | Plays a sound from `assets/sfx/` |
| 5 | `text` | span | On-screen text: hook, outline, highlight, street, comment, title, `box` (the premise box: black on white strips) and `chat` (a Twitch chat card, "name: message") |
| 6 | `cut` | span | Remove the span (jump cut); transition none, crossfade, whip, flash or zoom |
| 7 | `speed` | span | Play faster or slower (pitch kept) |
| 8 | `freeze` | point | Hold the frame (silent), with an optional push-in |
| 9 | `reframe` | point | Move the 9:16 crop: a cut, or a pan over `easeMs` |
| – | `tint` | span | Colour wash (made from the template as a test) |
| – | `bleep` | span | Mutes the clip's sound (its `gain` is 0) and plays a bleep tone or nothing; `./clip censor` places it over slurs and the f-words in the open. A word under it is not "said" for the never-post and careful checks |
| – | `blur` | span | Blurs or blacks out a box of the 9:16 frame (`backdrop-filter`), under the captions and the credit |
| – | `tilt` | span | Rotates the frame ±N° (snap or eased), scaled so no corner shows; the meme editor pairs it with a snap zoom on a shout |
| – | `mono` | span | Black and white through the `filter` hook (the video only, never captions or overlays); with a `freeze` it is the fail ending |
| – | `counter` | span | A big number stepping from one value to another (3, 2, 1; a tally) or a running stopwatch, with a label |
| – | `solo` | span | Facecam only or game only for the span, then back to the split (`untilEnd` framing; does nothing outside a split) |
| – | `pointer` | span | An arrow or a circle at x/y in the frame, drawn on, with a short label |

Markers can be **proposed** (`proposed: true`, plus a `source` such as `autoedit`, `silence` or `auto-reframe`).
They show dashed in the Studio and the preview shows them, but the export skips them until they're accepted (`A` in the Studio, or `./clip accept`).

Captions and the base framing (blur-fit or crop) are clip-level settings, not markers.
