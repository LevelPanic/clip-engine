# Release plan: clip-engine as a public GitHub repo

2026-11-23. Goal (user): "a version of this that we should be able to put live", as a **public GitHub repo**: organized, following design and architecture principles and a design system, and good for git.

Sources: four read-only audits run in parallel (git and release safety, code architecture, the Studio's design system, docs and project layout), with the claims this plan rests on checked by hand.

## Status

**Phase 0 (2026-11-23, user: "Yes, start phase 0").** Everything is done except the commit itself.
- **`.gitignore`** keeps out scratch, previews, media, the operator's configs, `legal/`, and the report data and images. The report images are stills of creators' streams.
- **Example configs:** `channel.example.json`, `channels.example.json`, `client_secrets.example.json`.
- **Missing creator list:** `src/core/creators.ts` (`loadCreators`) means no `channels.json` gives no creators, not a crash. It is tested in `test/creators.test.ts`.
- **Personal data redacted:**
  - from `docs/history/context.md`: an email, the TikTok open_id, Telegraph links, and upload links and titles
  - links to the channel's uploads, from SCOPE.md and docs/history/audit.md
  - upload video ids, from docs/history/audit.md, SCOPE.md and the censorship report
  - posted titles, from SCOPE.md and the censorship report
  - in the title tests, the inputs were swapped for made-up ones that test the same behaviour
- **Channel name:** the default is now "Clip Engine", replacing the channel's real name. The operator's own `channel.json` still sets the real name.
- **Licence files:** `LICENSE` (MIT, "the clip-engine contributors"), `THIRD_PARTY.md`, `.nvmrc`, and `license`/`engines` in package.json.
- **The commit tree:** 293 files, 5.1 MB; the only media is the 14 sound effects in `assets/sfx/`.
- **Scan:** no emails, home paths, tokens, Telegraph links, or posted titles or video ids (all 76 logged uploads were checked).
- **Tests:** 341 pass.

**Committed:** `c0dfb5e`, the first local commit (293 files). It is authored with the GitHub noreply address `28920092+LevelPanic@users.noreply.github.com`, set for this repo only. The author name comes from the global git config, and can be changed with `git commit --amend --reset-author` before the first push. Nothing has been pushed; there is no remote yet.

**Phase 1 (2026-11-23, user: "Yes, start phase 1").** Docs and layout:
- **Docs moved into `docs/`:**
  - `PROCESS.md` → `docs/pipeline.md`.
  - `AUDIT.md`, `HANDOVER.md` and `CONTEXT.md` → `docs/history/`.
  - Every report → `docs/research/`. Their local-only data and images moved with them and stay ignored.
  - 131 citations in 48 files were rewritten. No relative links needed it.
- **SCOPE.md split:**
  - It went from 825 lines to 238: the idea, the key decisions, the roadmap, a new current-state summary, the backlog and the open questions.
  - The dated log moved to `docs/changelog.md`, newest first.
  - The reference sections moved to `docs/architecture.md`.
  - Checked line by line: nothing was lost.
- **New docs:**
  - `docs/architecture.md`: the flow and where each part lives, the design principles, and the known structural debt.
  - `docs/operations.md`: the daemons table, how to start and stop each one, and CLAUDE.md's long operational sections word for word.
- **README:** setup with the real requirements, the example configs and the logins; the real upload pace; the full review keys; a docs map; a "Use" section; the licence.
- **CLAUDE.md:** 68 KB down to 49 KB.
  - Its long operational bullets are now summaries that point to `docs/operations.md`.
  - The layout map gains `src/track`, `pipeline`, `publish`, `cli`, `docs/` and the example files.
  - The read-the-handover-first line is gone.
- **Code:**
  - The 11 dead exports and 4 unused types are removed, and so are the old JSON-queue importer and `src/demo`. `src/demo` is archived in `.cache/archive/`, with `demo-public/` and `tiktok-demo.mp4`.
  - The watchlist's status page is written to `library/`.
  - Presets live under the data folder.
- **Checks:** typecheck is clean, 341 tests pass, and the personal-data and upload-trace scans of the tree are clean.

**Phase 2 (2026-11-23, user: "Yes, start phase 2").** Built in a worktree so the running daemons were not disturbed, then merged. Five commits:
- **Layers** (`004fe26`). `test/layers.test.ts` orders the `src/` folders and fails on any import, static or dynamic, that goes up a layer. The 17-folder import cycle is gone:
  - `core/project.ts` → `src/project/`, and `setIntro` → `edit/hook.ts`.
  - `jobs/` keeps the queue and starting the worker; the downloads went to `ingest/`.
  - The handlers, batches and worker loop went to `pipeline/`.
  - The marker types' context and fonts went to `markers/`; `scan/rank.ts` → `track/`; `watch.ts` and `whisperJob.ts` → `pipeline/`.
  - `tools/` is typechecked now. It had never been, and it was clean.
- **CLI** (`44aba19`). The 1,615-line `more.ts` is nine command groups. `--help` and every subcommand's help are identical.
- **Daemon decisions** (`5e85038`). Each now lives in `src/` with tests:
  - what the upload scheduler sends, holds, defers or sets aside (`src/publish/scheduler.ts`);
  - what a failed watchlist job becomes (`src/track/runner.ts`);
  - what the cleanup may delete (`src/pipeline/cleanup.ts`). Its old and new dry runs on the live data matched.
- **Settings** (`9209642`).
  - All 58 environment settings are in `src/core/config.ts`, with strict parsing: `15m` for a number is an error, not NaN.
  - `./clip config` prints them, and `docs/operations.md` has the generated table.
  - A test fails on any direct `process.env` read.
- **Helpers** (`b9353d4`).
  - One `pidAlive`, `clamp`, `sleep` and database opener replace about 20 copies.
  - The heartbeats are written atomically.
  - `clip jobs` and `clip reviews` print the same on the live data as before.
- **Tests:** 364 pass (343 before phase 2). Typecheck is clean, with `tools/` included.
- **Left for later**, not blocking the release:
  - the watchlist's discovery and status page, and the observer's loop, which are still in `tools/`;
  - the Studio server's routers and the four big UI files;
  - merging the two job queues, and `core/retry.ts`;
  - tests for the worker, render, Whisper and the judge.

## Where it stands

**Healthy.**
- Typecheck is clean and all 338 tests pass.
- No browser code reaches a Node-only module.
- No literal secrets were found, and the secret files are already gitignored.

**Not safe to commit yet.** The project has never been committed.
- A commit today would hold **699 files / 102 MB**, 91 MB of it creator audio and frames in `tmp/` and `.qa-stills/`. With the ignores in phase 0 it is about **278 files / 4.8 MB**.
- Personal data sits in files that would be committed:
  - `docs/history/context.md`: the connected TikTok account's id, an email address, links to the channel's own uploads.
  - `legal/*.html`: the contact email (4 files) and a surname.
  - `docs/research/meme-edits-2026-11-22-data/BRIEF.md`: an absolute home path.
  - `scheduled-preview.html`: links to scheduled uploads.
  - `channel.json`: the channel identity and the removal incident.
  - `channels.json`, `channels.md`: the creator target list.
- The git author email is a personal address, not a GitHub noreply address, and every commit would publish it.
- There is no LICENSE.
- Third-party terms the repo has to state:
  - **Remotion:** free for individuals and companies of up to 3 people; a company licence above that.
  - **InsightFace `buffalo_l` models:** public non-commercial terms unless licensed. The hybrid face detector downloads and uses them.
  - **NudeNet 3.4.2:** MIT.
  - **The panel refinement:** ported from kiy0ni/auto-video-editor (MIT), so it needs that project's notice.
  - **yt-dlp and whisper.cpp.**
- A fresh clone crashes without `channels.json` (`tools/watchlist.ts:98`, `src/cli/more.ts:486`).

**Architecture.**
- **One import cycle spans 17 of the 22 `src/` folders.** The edges that close it:
  - `core` imports `markers` and `edit`.
  - `render`, `reframe`, `scan` and `ingest` import `jobs/downloads`.
  - `scan` ↔ `track`
  - `candidates` ↔ `qa`
  - `discover` ↔ `ingest`
  - `markers` ↔ `composition`
- **About 1,420 lines of daemon logic live in `tools/`**, where tests cannot import them. That includes the upload scheduler's decision function, which decides what goes public.
- **`src/cli/more.ts` is one 1,615-line function** holding 70 commands.
- **Configuration has no single home.** There are 60 environment variables, read 72 times, and 28 of them are undocumented. A value like `15m` silently becomes NaN.
- **Helpers are duplicated:**
  - clamp ×7, sleep ×6
  - SQLite open code ×3
  - the process-alive check ×6
  - two job queues with the same function names
- **Dead code:** 11 exports nothing uses, and `src/demo` is orphaned.

**Studio UI.**
- **Tokens:** 12 colour tokens and none for spacing, type size or radius.
- **161 inline styles.**
- **Almost no shared components:**
  - three back-link styles
  - an 18+ badge built six ways
  - tabs without tab semantics
- **Accessibility:**
  - no `aria`/`role` anywhere
  - the focus outline is removed
  - white text on the primary button is 4.35:1, under the 4.5:1 that WCAG asks for
- **Three palettes:** the Studio's and two more in the root preview pages.

**Docs.**
- Eight root markdown files, with the pipeline explained in six places.
- README is out of date. It says one upload every 20 minutes, and it covers none of these:
  - the observer and cleanup daemons
  - the 18+ check
  - OAuth setup
  - OpenCode/DeepSeek for the agents
- SCOPE.md is 825 lines, 74% of it session log.
- docs/history/handover.md is stale, yet CLAUDE.md says to read it first.

## Approach

- **Commit locally early, push publicly late.** The first commit is made only after phase 0, so nothing private ever enters history.
- **Each later phase lands as its own commits.** Git is the safety net for the moves.
- **The public push comes after phase 4's checks.**
- **Daemons:** the watchlist runs `./clip` commands as child processes, so the file moves in phases 1–2 happen with the watchlist paused between jobs, and every daemon is restarted after.

## Phase 0: safe to commit (about 1–2 hours, required before the first commit)

1. **`.gitignore`:** add
   - `tmp/`, `.qa/`, `.qa-stills/`, `demo-public/`, `presets/`
   - `/*-preview.html`, `/watchlist-status.html`, `*.mp4`
   - `*_secrets.json` with `!*.example.json`, `*-token.json`, `.env*`, `.claude/settings.local.json`
   - `*.sqlite`, `docs/research/*-data/`
   - `channel.json`, `channels.json`, `channels.md`
2. **Example configs:**
   - `channel.example.json`, `channels.example.json`, `client_secrets.example.json`. `topics.json` is generic and stays.
   - The code falls back to the example, or to an empty list, when the real file is missing (`tools/watchlist.ts:98`, `src/cli/more.ts:486`, `tools/classify-channels.ts`).
3. **Personal data out:**
   - `docs/history/context.md` is redacted or left out.
   - `legal/` stays out of the repo; it is already hosted.
   - The home path in BRIEF.md goes.
   - The preview pages are ignored.
4. **Licence and notices:**
   - `LICENSE`, plus `"license"` in package.json.
   - `.nvmrc` (22).
   - `THIRD_PARTY.md`, covering Remotion, the InsightFace models, NudeNet, the kiy0ni port, yt-dlp and whisper.cpp.
5. **Git identity:** a repo-local `user.email` set to your GitHub noreply address before the first commit.
6. **Check, then commit:**
   - `git ls-files --others --exclude-standard` lists only intended files.
   - A grep for emails, `/Users/` and token shapes comes back empty.
   - Then make the first local commit.

## Phase 1: layout and docs (about half a day)

- **`docs/`:**
  - **`pipeline.md`:** PROCESS.md.
  - **`architecture.md`:** the module map, the rules and the key decisions.
  - **`operations.md`:** the scheduler, daemons, OAuth and the careful period. CLAUDE.md's long bullets move here.
  - **`roadmap.md`:** SCOPE's "On the plate".
  - **`changelog.md`:** SCOPE's "Where we left off" and the build notes, newest first.
  - **`research/`:** the four reports code cites as the reason for a rule.
  - **`history/`:** AUDIT, HANDOVER, the redacted CONTEXT and the uncited reports.
- **README** is rewritten as the front door, covering:
  - what it is
  - requirements: Node 22, ffmpeg, yt-dlp, the whisper.cpp build, Xcode Command Line Tools, uv/Python for the sidecars, OpenCode for the agents
  - setup: configs, OAuth
  - the first run
  - the daemons
  - a short "Use" section on the platforms' terms and creators' wishes
- **CLAUDE.md** stays the working guide and points into `docs/`.
  - Its Layout map gains `cli`, `pipeline`, `publish` and `track`.
  - The read-HANDOVER-first line goes.
  - SCOPE.md keeps only "where we are" and the backlog.
- **Data out of the root:**
  - `watchlist-status.html` → `library/`
  - `presets/` → under the data folder
- **Removed:**
  - `src/demo`, `demo-public/` and `tiktok-demo.mp4`, archived outside the repo
  - the old JSON-queue importer
  - the 11 dead exports
- **References kept working:** the path citations are updated, and so are the tests that read doc paths (`test/lenses.test.ts:93`).

## Phase 2: architecture (about 2 days, one commit per step, tests green after each)

1. **Break the import cycle.**
   - **A boundary test first**, which fails on any import that goes up a layer.
   - **Then seven moves:**
     - `core/project.ts` → `src/project/`
     - the hook helpers → `edit/hook.ts`
     - `jobs/downloads.ts` → `ingest/`
     - `scan/rank.ts` → `track/`
     - `OPENING_FILLERS` → `core/vocabulary.ts`
     - `ingest/whisperJob.ts` → `jobs/`
     - `composition/context.ts` and `fonts.ts` → `markers/`
   - **Candidates and ingest** return their follow-up jobs instead of queueing them.
2. **Thin daemon entry points.**
   - The logic in `tools/watchlist.ts`, `upload-cron.ts`, `observer.ts` and `cleanup.ts` moves to `src/track/{discovery,runner,statusPage}.ts`, `src/publish/scheduler.ts` and `src/jobs/cleanup.ts`.
   - The files left in `tools/` handle arguments, timers and the loop.
   - New tests cover the upload scheduler's decision function and the watchlist's retry rule.
3. **`src/cli/more.ts` split** into nine files by command group: analyze, candidates, clips, markers, edit, batch, review, publish, studio.
4. **One config module, `src/core/config.ts`.**
   - One zod schema for all 60 environment variables, with defaults.
   - `clip config` prints the effective values.
   - A doc-sync test keeps the docs matching.
5. **Shared helpers:**
   - `core/sqlite.ts`
   - `core/proc.ts`: the alive check, opening a URL, a detached start
   - clamp, sleep and h:mm:ss in `core`
   - the atomic write at `tools/upload-cron.ts:65`

**Later, not blocking the release:**
- the Studio server split into routers
- the four big UI files split into components and hooks
- `scan/queues.ts`, `edit/editors.ts`, `candidates/index.ts` and `publish/youtube.ts` cut at their seams
- the two job queues merged behind one interface
- `core/retry.ts`
- tests for the worker, render, whisper and the judge

## Phase 3: Studio design system (about 1.5–2 days, checked in the browser page by page)

1. **`ui/tokens.css`**, with no other visible change:
   - **Colour:** the existing 12 plus the missing surface, line, tint, amber and signal tokens.
   - **Space:** 2–24.
   - **Type:** 10–20, with UI and mono font stacks.
   - **Radius, shadow and z-index.**
   - **A `:focus-visible` ring.**
   - **Contrast fixes** for the primary button and the field borders.
2. **`src/studio/web/ui/` primitives**, about 300 lines:
   - Button
   - Kbd and ShortcutLegend
   - Chip, with QaBadge and AdultBadge
   - Tabs
   - TopBar and BackLink
   - Page, Card and Callout
   - ListRow
   - Field
   - PageState
   - Row and Stack
3. **Migration, page by page:**
   - Jobs and Library as the pilot, adding their missing error states
   - Review
   - VideoPage
   - Editor and Inspector
   - Timeline, colours only
4. **Consistency:**
   - the two key clashes settled: E exports on one page and opens the editor on another; Enter does different things too
   - one nav bar instead of three back-link styles
5. **The watchlist status page** uses the same tokens.

## Phase 4: release checks (about 2 hours)

- **CI:** GitHub Actions runs `npm run typecheck` and `npm test`. The offline tests need no ffmpeg; this is to be confirmed on the runner.
- **Fresh-clone test:**
  - clone into a temp folder, then `npm ci`, typecheck, test and `./clip --help`
  - the Studio starts with the example configs
- **A final scan** of the committed tree for personal data and media, and a size check.
- **Sound origins:** riser, bass-drop, glitch, shutter and swish (`assets/sfx/`) have no recorded origin. Confirm they were made here, or replace them, then list them in THIRD_PARTY.md.
- **The push:** the public GitHub repo is created by you, or with your OK through `gh repo create`, and then pushed.

## Decisions (defaults in bold)

1. **Licence:** **MIT** / Apache-2.0 / source-available.
2. **Creator list and channel identity:** **examples only in the repo** / publish the real lists.
3. **Reports:** **keep the four cited ones in `docs/research/`** / keep none / keep all.
4. **When to push:** **after phase 4** / after phase 1 (push the cleaned baseline and refactor in public).
5. **Your GitHub noreply email** for the commit author (GitHub → Settings → Emails). Needed in phase 0.
