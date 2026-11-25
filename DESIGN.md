# Clip Studio design

The visual system of the Studio (`./clip studio`, `src/studio/web/`). The values live in
`src/studio/web/ui/tokens.css`, the components in `src/studio/web/ui/index.tsx` and `ui.css`.
`test/studio-tokens.test.ts` checks that pages use tokens only and that the palette keeps WCAG AA. This file
records why the values are what they are; change the tokens and this file together.

## Product

- **Who:** one operator, at a desk, often in a dark room, reviewing around 100 vertical clips a day and
  fixing some of them in the editor.
- **The job:** operate, not persuade. Watch a clip, decide with one key, move to the next. Everything
  frequent is one keystroke or one click away and on the first screen.
- **What leads:** the video. The interface is quiet so the clip, and the state colours (approved, careful,
  failed), carry the colour.
- **Principles:** calm by default; one primary action per view; status before detail; nothing important
  below the fold on the Review page at 1440 × 900.

## Colour

A neutral graphite with one interactive blue. Colour means something; it is never decoration.

| Role | Token | Value | Use |
|---|---|---|---|
| Page | `--bg` | `#0b0c0f` | the background, field wells |
| Surface | `--panel` | `#121419` | cards, side panels |
| Raised | `--panel2` | `#181b21` | buttons, chips, the current nav link |
| Hover | `--hover` | `#1f232b` | a row or button under the pointer |
| Selected | `--surface-sel` | `#172133` | the selected row (the accent's hue, barely) |
| Text | `--text` / `--text-2` / `--muted` | `#eceef2` / `#c3c8d1` / `#8f96a3` | body, secondary, meta (5.2:1 or more everywhere) |
| Accent | `--accent` / `--accent2` | `#4d8dff` / `#8ab4ff` | focus, the current tab, selection; links and accent text |
| Primary | `--primary` / `--on-primary` | `#eceef2` / `#0b0c0f` | the one main action of a view (16.8:1) |
| States | `--good`, `--warn`, `--bad` | `#3ccf7f`, `#eab24c`, `#f0564f` | approved/passed, careful/held, failed/rejected |
| Tints | `--good-tint`, `--warn-tint`, `--bad-tint`, `--accent-tint` | | a chip's or callout's background in that tone |

- No purple, no gradients, no glow. Tone is shown by a tinted surface, never a coloured stripe or a thick
  coloured border.
- The primary button is near-white, not the accent: one per view (Approve on Review, Export selected on a
  video, Start batch on the Library, Re-export in the editor). A proposal's Accept is the exception inside
  its own box.
- Signal colours (`tokens.ts`) are data colours for the signal strip and candidate chips.

## Type

- **Instrument Sans** for the interface and **JetBrains Mono** for ids, timecodes and key hints, loaded
  through `@remotion/google-fonts` (`ui/fonts.ts`); the system fonts take over offline.
- Scale: 11 (timeline ticks only), 12 (meta, chips), 13 (secondary, dense panels), 14 (body), 15 (list
  titles), 16 (section), 18 (a panel's title), 26 (page). Weights 400, 500 (labels, buttons), 600
  (headings, the primary button). Headings tighten by 0.015 em; nothing is set in tracked capitals.
- Body line height 1.5, headings 1.25. Long text stops at 70 to 80 characters (`max-width: 80ch`).
- Numbers that line up (durations, scores, the job table) use tabular figures.

## Space and shape

- A 4 px scale: 2, 4, 6, 8, 12, 16, 20, 24, 32, 48, 64 (`--s-1` to `--s-11`). Related items sit 4 to 8
  apart, groups 16 to 24, sections 48. A heading is nearer its own content than the block above it.
- Pages centre their content at 1120 (Library), 1240 (Jobs) or 1440 (Review, a video) with 32 px gutters;
  the nav bar runs edge to edge and stays at the top.
- Radius: 3 (timeline marks), 5, 7 (controls), 10 (cards), 14 (video), and a pill for chips.
- Depth by surface, not shadow: cards are a surface and a 1 px line. Shadows are only for things that
  float: menus, the toast, the editor's player.
- No card inside a card: inside a panel, sections are separated by space and a hairline.

## Components

| Component | Notes |
|---|---|
| `Nav` | sticky, 56 px, the brand mark, the sections, the watchlist's switch at the right end (`NavEnd`); resting on a section shows its one-line description in a popup |
| `PageHead` | the page's title, one line on what it is for, and the page's own actions (Library, Jobs, a video; the Review page has none, so the clip gets the height) |
| `Popover` | a button that opens a small panel under it, fixed to the screen so a scrolling panel cannot clip it; Esc or a click elsewhere closes it (Shortcuts, Regenerate title and description) |
| Editable text | text you can change shows a quiet surface under the pointer (`.editable`); a click or Enter turns it into a field with the text selected; Enter (⌘↵ for longer text) saves, Esc cancels |
| `Button` | 32 px; default (raised), `primary` (near-white), `danger` (red text, red tint on hover), `ghost`; presses scale to 0.98 |
| `Tabs` | an underline under the current tab; the count in a small pill |
| `Chip` | 24 px pill (20 small); tones are tinted backgrounds |
| `Callout` | a tinted surface for a state that needs reading (a held upload, a still-image source) |
| `Field` | the label above, tied to its control; an aside on the label's right; a hint under it |
| `PageState` | loading, empty and error, the same everywhere |
| `rowKeys` | a selectable row the keyboard reaches; Enter and Space stop at the row |

## The Review page

No page heading: the nav, then the tabs line (with **Shortcuts** at its far right, a popup; `?` opens it
too), then three panes on one screen: the queue (280 px at most, scrolls on its own), the clip, and the
details. The clip is exactly 9:16 and as tall as the row: its width comes from its height
(`aspect-ratio` on the player box), so it is never a wide black frame. The details column shrinks
first: on Approved and Uploaded the upload line's state is one 40 px line at its top ("6 of 8 up in 24 h ·
next at … · 52 in line · careful until …", red when uploads are on hold); resting on it or focusing it
opens the whole of it in place, over the details (the pace, the careful period, the hold, the log), and
it closes when the pointer leaves; the details' body scrolls (title, post, checks, why this clip,
hand-over) and their footer stays put (the note, 18+, Approve, Make changes, Reject). Under 1180 px the
queue moves below and the page scrolls; under 760 px everything stacks.

## Motion and focus

- 120 ms for hover and press, 200 ms for larger changes, one ease-out curve, no bounce. Reduced motion
  turns both to 0.
- Keyboard focus is always visible: a 2 px blue ring with a 2 px gap.

## Not used

Purple or cyan-on-dark palettes, gradient text, glass, glows, side-stripe accents, nested cards, icon
tiles above headings, numbered section labels, uppercase section labels, pulsing dots, decorative stripes
(a cut on the timeline is a dimmed span, not hatching).
