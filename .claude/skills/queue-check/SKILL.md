---
name: queue-check
description: Run the three queue experts (meme, virality, story) over a range of a stream and collect their verdicts. It checks what has been scanned, transcribes the range once, sends one agent per kind over the whole range (in parallel), verifies what they saved, and reports the confirmed moments ready for extraction. Use after a stream range has been scanned and before /clip-extractor, or when the user asks for the full process on a stream ("check the queues", "run the experts on 1:30 to 3:00").
argument-hint: <videoId|twitch-link> [--from 1:30:00] [--to 3:00:00]
allowed-tools: Bash(./clip:*), Read
---

# /queue-check: a range of a stream → confirmed moments

Arguments: `$ARGUMENTS`. A library id (`tw-…`) or a Twitch link, and a range. Run everything from the
project root. Times past 59 minutes are written `h:mm:ss`.

You are the coordinator. The three experts do the looking; you make sure they can, check what they
saved, and report. The experts are defined in `.claude/agents/` (`meme-expert`, `virality-expert`,
`story-expert`) and share `agents/queue-expert.md`.

## 1. Make sure the range can be seen

```bash
./clip queues <id> --from <A> --to <B> --limit 12
```

- **"nothing has been scanned"** or a `⚠` line saying chat or audio is missing for part of the range: scan that part first (about a minute per 15 minutes of stream), then run the command again.
  ```bash
  ./clip scan <id> --from <A> --to <B>
  ```
- **Chat replay turned off:** carry on; say so in the report. Audio and viewer clips still work.
- **Is the segment the streamer's own content?** Look at two stills from it (`./clip frames <id> <time> <time>`) and at the chapter the scan printed. If someone else's programme fills the frame (an awards show, a sports broadcast, a video being watched) with the streamer in a corner, its crowd makes dozens of queues that are the programme's moments, not the streamer's. The stills are the test, not the count: an awards-show restream made 54 queues in 30 minutes, but a horror game the streamer was playing himself made 31, against 15 for a quiet half hour of talk. For a watch-along segment send only the virality expert (the queues viewers clipped are the ones worth a look), tell it in one line that the segment is a watch-along, and say in the report what was skipped and why.
- **A range longer than 30 minutes:** default to **one agent per kind for the whole range**. The dossier batches four queues at a time, so a 60-minute range is a handful of calls, not six agents. Split only when the context would grow too large or one segment is a different kind of content (a watch-along inside an otherwise normal stream); if you split, split by kind, not by half hour. Do steps 2–4 for each piece.

- **A moment window of a few minutes** (what the watchlist's moment jobs send) is normal: it holds a handful of queues. A scanned range with no queues is a real result; say so, and the story expert still reads the words once for a story nobody reacted to.

Unknown is not quiet. Never report a range as empty when it was never scanned.

## 2. Transcribe the range, once

```bash
./clip queues <id> --from <A> --to <B> --limit 20 --transcribe range
```

This transcribes the whole range and two minutes either side (about 4 minutes of Whisper per 30
minutes of stream), then prints the queues. Do it here, before the experts start:

- The experts read around every queue and two minutes past it. Left to themselves they transcribe the same windows piecemeal, one small Whisper run at a time, and each run renumbers the transcript.
- The story checker needs words to know where a story could be. With the segment transcribed, "not transcribed" stops meaning "unknown".
- `--transcribe regions` does only the queue regions and their margins. Use it when the segment is quiet and you want speed over coverage.

If the header still says `(+N weaker not shown)`, run it again without `--transcribe` and with the limit it suggests.

If there are **no queues of any kind** in the range, that is a real result: say "scanned, no
queues" and move on.

## 3. Send the range to the three experts, in parallel

Start all three in one message so they run at the same time. Give each the **whole range**, not a
half-hour slice:

- `meme-expert`: "Video `<id>`, range `<A>`–`<B>`, kind meme. Review every meme queue in the range."
- `virality-expert`: the same, kind viral.
- `story-expert`: the same, kind clip. It also does the read-on sweep for the whole range.

If the named agents are not available in this session (some sessions only pick up a new
`.claude/agents/` folder after a restart), start three general-purpose agents instead, each with: "Read
`.claude/agents/<name>.md` and follow it as your instructions. Video `<id>`, range `<A>`–`<B>`, kind
`<kind>`. Review every `<kind>` queue in the range." Pass
`model: opencode-go/deepseek-v4.1-flash`; do not use Sonnet.

Give them nothing else. Do not tell them which queues you think are good: they must look for themselves.

**The experts run on DeepSeek V4.1 Flash.** Each expert file names its model (`model:` in its
frontmatter); when you start a general-purpose agent in this harness, pass
`model: opencode-go/deepseek-v4.1-flash`. Do not use Sonnet. If the named agents are available, start
them by name; otherwise the general agent reads the file.

**While they run, change nothing they read:** not the expert files, `agents/`, the vocabulary, or
anything in `src/`. A queue id is the moment's time; an edit that moves a queue or renames a word
makes an expert's verdict fail to save. Wait for all three before touching anything.

**What it costs.** The historical Sonnet measurement was 24 turns for 15 queues (about $1.40 for the
three experts, `AUDIT.md`, section 6). On DeepSeek V4.1 Flash the same tokens cost about $0.05; the
constraint is now **turns and context**, not dollars. An expert works in batches of four queues from
one dossier call (`agents/queue-expert.md`, "Budget"). For a range, default to **one agent per kind
for the whole range**, not one per 30 minutes; split only when the context or a segment's content
clearly demands it. Tell the user the number of agents before you start, and measure the turns.

## 4. Check what came back

A reply is a report, not proof. The ledger is the record.

```bash
./clip queue-review <id> --pending --from <A> --to <B>
```

1. **Queues without a verdict, and moments nobody judged:** the command prints a `⚠ nobody judged …` line when every expert passed a moment to another with `other-kind`. Send one of them back to decide it. For queues without a verdict, send the expert of that kind back once with exactly those ids. If they are still undecided, list them in your report with the reason the expert gave. An expert that was cut off (a limit, an error) keeps its context: send it a message to continue rather than starting a new one.
2. **Check every confirm, in two turns.** One command puts each claim next to what it stands on:
   ```bash
   ./clip queue-review <id> --evidence --from <A> --to <B>
   ```
   It prints every confirm with the path of the still under each `frame` line, and where each `said:` line is in the transcript. Read all the stills in one turn (one Read call per path, all in the same message) and compare each with the line above it.
   - **A still that does not show what its line says:** the expert did not look. Send that expert back with exactly that queue id, and say so in the report.
   - **A `✖` under a `said:` line:** the words are not in the transcript there. Same.
   - **Then one more look at the weakest points:** any confirm with confidence under 0.6, and the reject whose queue scored highest. `./clip queues <id> --kind <kind> --dossier --queue <that id>` shows you exactly what the expert was shown.
3. **Risk flags:** every `privacy`, `minor`, `slur`, `sexual`, `self-harm`, `misleading` or `staged` flag goes in your report word for word. The user decides those, not the pipeline.

## 5. Report and hand over

```bash
./clip queue-review <id>
```

Reply with:

- Per range: queues listed, confirmed, rejected (by ground), merged, undecided.
- The confirmed moments: time, queue id, archetype, trigger, which experts confirmed it, the one-line reason, and the `cut` note when there is one.
- Coverage gaps and anything an expert could not do.
- Risk flags, word for word.

Then hand over: `/clip-extractor <id>` turns each confirmed moment into one candidate.

Do not add candidates, make clips or edit here.
