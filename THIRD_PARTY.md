# Third-party software and terms

clip-engine is MIT-licensed (see `LICENSE`). It builds on the projects below. Most are installed by
`npm ci` or on first use and are not part of this repository. Check their terms against how you use the
engine, especially before you run it for a business.

## Read these before you use it commercially

- **Remotion** (`remotion`, `@remotion/*`): renders every clip and runs the Studio player. It has its own
  licence, not MIT. It is free for individuals, non-profits and companies of up to 3 people, and other
  companies need a company licence. See https://www.remotion.dev/license.
- **InsightFace pretrained models** (`buffalo_l`): the hybrid face detector (`CLIP_FACE_DETECTOR`, the
  default) fills the frames Apple Vision misses with InsightFace. That runs from `tools/insightface/`,
  which downloads the models on first use. The `insightface` Python package is MIT. Its pretrained
  models fall under InsightFace's non-commercial terms unless you license them, see
  https://github.com/deepinsight/insightface. To leave them out, run with `CLIP_FACE_DETECTOR=vision`.

## Code adapted into this repository

- **auto-video-editor** by Sacha (KiyOni), https://github.com/kiy0ni/auto-video-editor. MIT License,
  Copyright (c) 2025 Sacha (KiyOni). `src/reframe/panel.ts` ports its `refine_overlay` (temporal-variance
  border refinement) to Node. The MIT permission notice in `LICENSE` applies to that code as well.

## Installed on first use or run as external tools

| What | Used for | Licence |
|---|---|---|
| NudeNet 3.4.2 (`tools/nudity/`) | the 18+ check's nudity detector (model bundled in the package) | MIT |
| whisper.cpp, via `@remotion/install-whisper-cpp` | transcripts | MIT |
| Whisper models (`small.en`, `small`) | transcripts | MIT |
| yt-dlp | downloading video, captions and metadata | Unlicense |
| ffmpeg | cutting, framing, loudness | LGPL/GPL, depending on your build |
| Apple Vision and SoundAnalysis (`tools/faces`, `tools/audio-events`) | faces and laughter, macOS only | Apple system frameworks |
| ONNX Runtime, OpenCV (Python sidecars) | running the models above | MIT, Apache-2.0 |

## Fonts

The caption looks load Barlow Condensed, Luckiest Guy, Poppins and Montserrat from Google Fonts through
`@remotion/google-fonts`. All four are under the SIL Open Font License 1.1.

## Sounds

`assets/sfx/` holds the short sound effects the `sfx` and `bleep` markers play. All 14 were made for this
project and are covered by its MIT licence: air-horn, bass-drop, bleep, boing, boom, ding, glass-break,
glitch, pop, record-scratch, riser, shutter, swish and whoosh.

## The footage you clip

The engine downloads public streams and videos and posts clips of them. The footage belongs to its
creators. The engine puts the creator's name on screen and links back in every post, and it honours a
do-not-clip list (`channel.json`). Following the platforms' terms and the creators' wishes is up to
whoever runs it.
