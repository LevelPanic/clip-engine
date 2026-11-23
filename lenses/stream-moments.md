# Lens: stream-moments

For livestreams and gaming videos: one creator reacting to a game, chat or other players, where half
of the moment is on screen. Tested on KreekCraft's "Rec Room is dead" stream.

## Score each candidate

Two scores, not one:

1. **Quality** (`score`, 0–100): is this a good moment at all? The reaction, the event and how
   readable it is decide this. **Keep 60 or more.**
2. **The funnel** (`scores`, each 0–10): will a stranger who has never seen this stream stop, stay and
   send it? This decides the order.

| Quality | Weight | What a 9 looks like |
|---|---|---|
| Stop | 35% | The first 1–2 s: a face mid-reaction or an on-screen event, plus a line that opens a question, a threat or a bet. "Yo, chat" is a 2. |
| Hold | 25% | The event escalates and the reaction builds; there is no safe place to swipe away before the payoff. |
| Share | 20% | A big genuine reaction (shock, rage, panic, hysterical laugh) or a line someone would send to a friend. |
| Standalone | 10% | A newcomer understands what is happening in 3 s, or the creator's words explain it. No chat-only context. |
| Payoff | 10% | It ends on the reaction peak or the outcome, not on the creator moving on. |
| Delivery | gate | It delivers what the first 2 s promised. A huge hook that ends on "what happened?" feels like a cheat; score it low even if the reaction was big. |

**What the engine does with your scores** (`src/candidates/virality.ts`; you never do this yourself):

- Virality = the weighted scores × 10. A stream clip lives or dies in its first second, so `stop` weighs most.
- If `stop` or `standalone` is under 6, `payoff` under 5 or `delivery` under 6, virality is multiplied by 0.65.
- If `delivery` is under 6 and `stop` is 3 or more above it (a hook that goes nowhere), it is multiplied by 0.5 instead.
- Verdict: `post` needs virality ≥ 70, `delivery` ≥ 7, `payoff` ≥ 7 and `standalone` ≥ 7. Otherwise `recut` when quality is 70 or more, else `skip`. Quality under 60 is always `skip`.

A 9/10 event behind a 3/10 opening still dies, and so does a 9/10 hook with no payoff. In an hour with
a few hits, posting the weak ones costs the audience's trust.

**How to score:** rank the batch on each quality first, then give numbers that keep that order, using
the 2 / 5 / 9 anchors in `agents/vocabulary.md`. Do not aim for a verdict. The validator prints a
`score check:` when the transcript contradicts a score.

### The hook test (do this before adding a candidate)

- Mute the first 1.5 s. Is there a face or an event, not a menu or a calm gameplay shot?
- Read the first line. Would a stranger stop for it with no stream context?
- If not, start on the strongest line or use a cold open: peak first, then rewind into the setup.

## How streams differ from podcasts

- **Look at the screen.** The transcript is blind. For every candidate, run `./clip frames <id> <time> <time>` at the setup and the peak, read the images, and adjust `start`/`end` to what you see.
  - Facecam reactions often lead the words by half a second.
- **Audio signals matter most.**
  - Shouts and laughs heard in the audio, and the Most Replayed peaks, beat comment timestamps.
  - Streams rarely get caption [laughter] tags.
- **Boundaries:**
  - Start 1–2 s before the event. A scare may take up to 3 s of calm; more than 4 s with nothing happening is a dead open.
  - Start on the setup, before chat reacts: chat peaks 5–25 s after the moment.
  - End 1–2 s after the reaction peaks.
  - Streams are long and loose; 15–40 s is usually better than 50.
- **No words?** A scare, a fall or a face is added with `"visual": true` instead of a quote. It then needs a reaction heard in the audio, a chat spike or a viewer clip inside it.
- **Content risk:** other players' voice chat is uncensored. When the creator says someone said something, or the validator warns about slurs or censored words, say so in `reason`, so the reviewer listens before posting.
- **Countdowns and endings** (servers shutting down, final bosses, last games) are strong when the build-up is clear. Start at a line that names what's about to happen.

## Titles and hooks

- **title:** the event, not the game's name alone: "Bonnie neighs at KreekCraft and spams slurs", not "Rec Room moment".
- **hook:** on-screen text of 6 words or fewer that frames what's coming: "Wait for the shutdown…".
- **reason:** what happens on screen, and why the reaction is good.
- **quote:** 5–20 words copied exactly from the transcript inside the clip (or `"visual": true` when nothing is said).
