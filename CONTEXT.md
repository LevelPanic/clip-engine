# Context — 2026-11-12 03:05 UTC

## What we are doing

English Twitch/YouTube stream → full-VOD queue review → clip extraction → 9:16 edit → editor passes →
subtitle expert → user review → scheduled YouTube posts.

The end-to-end pipeline is in **PROCESS.md** (TL;DR: stream → segments → 3 queue checkers → 3 experts give
verdicts → extract/rank → curate → trim, 9:16 + meme/expert edits → subtitle expert → render/QA → review → schedule).

## Agent audit — 2026-11-12 (later the same day)

The agents, the hand-offs and the engines behind them were audited and reworked. **`AUDIT.md`** has every
finding, what was fixed and what is still open; `agents/README.md` has the cast and contracts.

- The three queue experts are now defined (`.claude/agents/`: `meme-expert`, `virality-expert`, `story-expert`),
  coordinated by `/queue-check`.
- Hand-offs are checked ledgers: `clip queue-review` (verdicts) and `clip curate` (decisions). `clip vocab`
  prints the words they accept.
- The full process in a session: `/queue-check <id> --from … --to …` → `/clip-extractor <id>` →
  `/clip-curator <id>` → `/edit <id>`. `/clip` stays as the quick pass.
- **Needs a decision:** `tw-2926144284-c01` ("Lacy buys a BMW X6M…") is a prank he admits at 1:38:39; an
  order-number page is on screen two seconds in and a slur is in the on-screen chat at 0:18. It is rendered,
  not submitted and not posted. The experts' suggested cut is about 1:36:07–1:36:46, titled as a prank.
- A trial of the three experts on `tw-2926144284` 1:30:00–2:00:00 wrote `library/tw-2926144284/queue-review.json`:
  5 confirmed moments (the earlier run had 1 in that half hour). Four are new and not extracted yet:
  `/clip-extractor tw-2926144284` is the next step. `./clip queue-review tw-2926144284` prints them.
- The trial cost about 1.15M tokens for the half hour. AUDIT.md "Still open" lists ways to bring that down.

## Current upload batch

Five clips are scheduled as **private until `publishAt`**; YouTube flips them public automatically.
The sixth is rendered and QA-passed but blocked by YouTube's daily upload limit.

| Clip | Title | URL | Goes live (UTC) |
|---|---|---|---|
| xQc | (title kept out of the repo) | (uploaded; link kept out of the repo) | 03:08 |
| Peanut | (title kept out of the repo) | (uploaded; link kept out of the repo) | 03:13 |
| Peanut | (title kept out of the repo) | (uploaded; link kept out of the repo) | 03:18 |
| Peanut | (title kept out of the repo) | (uploaded; link kept out of the repo) | 03:23 |
| Peanut | (title kept out of the repo) | (uploaded; link kept out of the repo) | 03:28 |
| Ron | (title kept out of the repo) | *not uploaded* | retry after limit reset |

The Ron clip is ready at `exports/tw-2926145084-c01.mp4` (59s, QA passed). YouTube returned
`uploadLimitExceeded` ("The user has exceeded the number of videos they may upload.") after five uploads.
Retry it after the daily limit resets (24h); use `./clip publish tw-2926145084-c01`.

## Decisions locked in

- **English only for now.** The eliasn97 German Icon League clips stay in review, not posted.
- **Weighted extraction** (`./clip windows <id> --queue <queueId>`, `/clip-extractor`): for every moment the experts confirmed, score start/end windows for that queue kind — all **15–60 s**, 300 ms before + 400 ms after buffer included. Weights favor meme tight reaction, viral peak+reaction, clip setup→payoff. Add **one candidate per confirmed moment**; low scores are never dropped at this stage. A moment with no words is a `visual` candidate.
- **Curation** (`/clip-curator`, saved with `./clip curate`): after all extraction, review the ranked field, assign a niche + niche fit, then keep/review/drop. A drop needs a ground (no niche + no standalone use, duplicate, muted, broken, unsafe, not English), with a `removalWeight` and reason in `library/<videoId>/curation.json`. Low score alone is not a drop.
- **Three queue checkers** (`./clip queues <id> --from … --to … --kind meme|viral|clip|all`):
  - meme: short/loud/chat/laugh/loopable
  - viral: viewer clips, chat velocity, shareable emotion
  - clip: setup → payoff, spoken context
  Every segment runs all three. Queue evidence includes chat rate/mood/top messages, reactions heard, viewer clips/views,
  transcript, title match and risks. Then the three **experts** (meme, virality, story) look at frames and words and
  save a verdict per queue (`./clip queue-review`): confirm, reject or merge.
- **Two editors** (`./clip editors <id>`; applies to the clip by default as proposed markers):
  - meme: hook text, punch-in on the punch word, emoji and flash on the reaction, dead-air cuts, speed
  - expert: intro trim, dead-air cuts, context hook, push-in on the quoted line; notes on the ending and length
  `--review` is read-only; `--accept` commits; they never stack on an existing edit, and never touch captions
  or the review note (captions belong to the subtitle expert).
- **Subtitle expert** (`./clip subtitles <id>`; skill `.claude/skills/subtitle-expert/SKILL.md`):
  decides captions **on/off**, style (bold/boxed/clean), position (0.68–0.74 safe zone), uppercase/font and word fixes.
  OFF for no speech, music/crowd-only, burned-in captions, non-English, text-heavy screens, unreliable transcripts,
  or under ~5 s. It does **not** auto-hide intentional repetition ("swim swim swim") or auto-censor profanity.
  The engine never turns captions back on once they are off; `--no-settings` applies word fixes only.
- **Viral titles** (`src/core/post.ts`): short nickname + action + one all-caps word + 1–2 reaction emojis, under ~60 chars,
  no colon. Five options: bold name+action (default), quote, curiosity, chat-aware, searchable context.
- **YouTube scheduling:** private until `publishAt`; first upload +5 min, then +10, +15, … measured from the first upload
  in the batch. `--now` and `--publish-at` override.
- **No commits.** The repo still has no commits; every file is untracked.
- **The channel is an automated clipper (user, 2026-11-14).** It clips and promotes other creators' content and says so: the creator on screen for the whole clip, a credit under every post (channel, source at the clip's first second, stream title and game), a line saying the channel is automated and not affiliated. Neither publisher takes an export that was rendered without the credit. `SCOPE.md` → "The idea"; `AUDIT.md`, section 7.
- **Older clips are not retrofitted (user, 2026-11-14: "nah fresh").** The 14 clips in the review queue that were rendered before the credit existed stay as they are, and stay unposted: the channel posts fresh clips, made from now on. Do not offer to re-render them again. If one is wanted after all: `clip credit <clip>`, then `clip render <clip>`.

## TheBurntPeanut full-VOD test

- Old last-15-min window: **1 clip**.
- Full-VOD viewer-clip map + 3 segment agents + queue checkers: **4 clips** — yacht heist, undercover Austin,
  Cloakzy veterans, weenie dog.
- The agents caught TOS/crude/UI-only risks; the three checkers ranked different moments.
- Full 0:00 scan hangs on Twitch live-VOD audio; the practical path is full-VOD viewer clips + targeted segment scans.
  Times over 59 minutes must be written `h:mm:ss` (`1:59:30`, not `119:30`).

## Lacy VOD test (2026-11-12)

- Stream `tw-2926144284`, slice 1:30–3:00 split into three 30-minute segments.
- Three queue agents (meme / viral / clip) reviewed the segment queues.
- 7 distinct moments extracted through the weighted 15–60s windows with the 300/400ms buffer:
  BMW X6M / Ron crashout, mom dated Train, Fortnite chair, "Did I scare ya", bulletproof vest,
  "the dagger" dribble, UK guy LA uniform.
- All 7 became candidates and were scored/ranked; **none were dropped at extraction**.
- Curator ledger `library/tw-2926144284/curation.json`: 6 keep, 1 review (Fortnite chair), 0 drops.
- Edits: 9:16 blur, meme + expert proposed markers, subtitle expert settings/fixes; five clips got
  tighter hook/ending trims after QA; all render and pass QA.
- Preview: `lacy-preview.html`.

## TikTok app review demo

- `tiktok-demo.mp4` — 30s, 1920×1080, H.264, 0.9 MB. Motion graphic of the Clip Engine UI: app opens, Connect TikTok (Login Kit), OAuth scope consent (`user.info.basic`, `video.upload`, `video.publish`), connected account, clip preview, caption/hashtags, privacy `SELF_ONLY`, interactions/commercial toggles off, Music Usage consent, private direct post progress/success, inbox draft, and scope summary.
- The demo shows only the three scopes the app actually uses. Remove `minis.public.upsert`, `user.info.profile`, `user.info.stats`, `video.list`, and `video.manage` from the app before review unless they are implemented and demonstrated.
- App description (109 chars): "Clip Engine turns your livestreams into short vertical clips and publishes them to TikTok with your approval."

## TikTok app form — legal URLs

Public pages (Telegraph):
- Terms of Service: (hosted on Telegraph; link kept out of the repo)
- Privacy Policy: (hosted on Telegraph; link kept out of the repo)
- Website/home: (hosted on Telegraph; link kept out of the repo)

Local copies: `legal/terms.html`, `legal/privacy.html`, `legal/index.html`. They name Clip Engine, the TikTok data collected (open ID, tokens, uploaded video, publish status), local storage, retention, revocation, and contact (contact email); governing law Pakistan. Edit the local files and re-publish if the app name/contact/jurisdiction changes.

## TikTok

- **Connected** on 2026-11-12: open_id (kept out of the repo), scopes `user.info.basic,video.upload`. Token is in `.cache/tiktok-token.json`; app credentials in `tiktok_secrets.json` (sandbox, Desktop redirect `http://127.0.0.1:8080/tiktok/callback/`).
- **Test upload:** `tw-2926144284-c07` → publish id `v_inbox_file~v2.7707146610417092630`; status `PROCESSING_UPLOAD` at upload time. Check TikTok → Inbox notifications to finish/post. The uploader now uses one chunk for files ≤64 MB (TikTok rejected the previous 10 MB split).
- The app is in **Sandbox**; Default Upload is on, Direct Post off. Inbox drafts are the intended path.
- **Direct Post research (2026-11-12):** Direct Post is real but has three gates: app approval, the `video.publish` scope, and a separate Content Posting API Direct Post audit. Our token currently has only `user.info.basic,video.upload` (inbox drafts). An unaudited Direct Post client can only use `SELF_ONLY`, only to an account set to private, max 5 users/24h; a public request returns 403 `unaudited_client_can_only_post_to_private_accounts`. TikTok will not audit a personal/internal-only tool, so automatic public posting to your own account is not available through this app without passing an audit. Inbox drafts remain the working path.
- **Processing can be slow:** both test uploads sat at `PROCESSING_UPLOAD` for a long time, then both reached `SEND_TO_USER_INBOX`. Do not treat a long processing state as a failure; the draft is delivered to TikTok's inbox once processing finishes. No production switch was required for the inbox draft flow.

- `./clip tiktok auth` + `./clip tiktok upload <clipId>` implemented. It uses the TikTok inbox draft flow (`video.upload`), so public posting in the app does not need the unaudited Direct Post restriction. The account is **not connected yet**: needs a TikTok developer app (Login Kit + Content Posting API Upload, Desktop redirect `http://localhost:8080/tiktok/callback/`) and `tiktok_secrets.json` with the client key/secret.
- Public auto-post would need TikTok Content Posting API audit + `video.publish`; not required for inbox drafts.
- **TikTok app config:** keep **Upload to TikTok** on; leave **Direct Post off** (we use `video.upload` inbox drafts, not `video.publish`). Domain verification is only for `PULL_FROM_URL`; our uploader uses `FILE_UPLOAD`, so it is not needed.
- **Stay in Sandbox for personal use.** Production requires app review and TikTok does not approve personal/internal-only tools. Sandbox supports test users and the inbox draft flow, where the creator taps Post in TikTok; that is the intended path. Direct API posts from sandbox are private only, which is why the app uses inbox drafts.

## State

- 6 ready clips (all 1080×1920, QA passed): xQc, Peanut ×4, Ron.
- 5 scheduled; Ron blocked by the upload limit.
- 169 tests pass; typecheck passes; the real-Twitch end-to-end tests pass.
- Analytics outcomes will lag 2–3 days; then `./clip analytics` and `./clip stats`.

## Key files

- `PROCESS.md` — the full production pipeline.
- `SCOPE.md` — roadmap, build notes, "Where we left off".
- `CLAUDE.md` — how to work in the code, commands, queue/editor/subtitle rules.
- `AUDIT.md` — the agent audit: findings, fixes, what is open.
- `agents/` — cast and contracts, vocabulary, the experts' shared protocol, research sources.
- `.claude/agents/` — the meme, virality and story experts.
- `src/scan/queues.ts` — three queue checkers; `src/scan/review.ts` — the experts' verdict ledger.
- `src/edit/editors.ts` — meme + expert editors.
- `src/edit/subtitles.ts` — subtitle expert.
- `src/core/post.ts` — viral title generator.
- `.claude/skills/subtitle-expert/SKILL.md` — the subtitle expert agent.
- `review-preview.html` — current clips with updated titles.

## Next

1. Retry `./clip publish tw-2926145084-c01` after the YouTube limit resets.
2. Watch the five scheduled uploads go public at 03:08–03:28 UTC.
3. After 2–3 days: `./clip analytics` then `./clip stats`; compare outcome against the queue/edit scores.
4. Use the feedback to tune the meme/viral/clip weights and title defaults (`clip stats` now has a row per queue expert and per niche).
5. Run the full process on a fresh stream (SCOPE.md → On the plate → item 0).
6. Decide `tw-2926144284-c01` (the BMW prank).
