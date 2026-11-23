# Lens: podcast-general

For podcasts, interviews and talk shows: two or more people talking, where the moment lives in the words.
The rubric is adapted from claude-shorts (MIT), rewritten for this engine.

## Score each candidate

Two scores, not one:

1. **Quality** (`score`, 0–100): is this a good moment at all? **Keep 60 or more.**
2. **The funnel** (`scores`, each 0–10): will a stranger stop, stay and send it? This decides the order.

| Quality | Weight | What a 9 looks like |
|---|---|---|
| Stop | 15% | The first 1–2 s make a stranger stop: a sharp question, a bold claim, a surprising line or obvious tension. "So, um, yeah" is a 2. |
| Hold | 25% | The story or argument pulls forward, with a new beat every few seconds and no place to leave before the payoff. |
| Share | 25% | A big laugh, anger, surprise or vulnerability, or one quotable line someone would send to a friend. |
| Standalone | 15% | Makes sense with zero context. No "like I said earlier", no "he" or "that thing" introduced off-clip. Names are said or obvious. |
| Payoff | 20% | It ends on the punchline, the reveal or the conclusion, not trailing off. |
| Delivery | gate | It pays off what the first line promised. A big hook that ends on "anyway" or a new question feels like a cheat. |

**What the engine does with your scores** (`src/candidates/virality.ts`; you never do this yourself):

- Virality = the weighted scores × 10. For a talk lens the weights are in the table: a slow open is forgiven, a weak claim or a missing payoff is not.
- If `standalone` or `payoff` is under 5, or `delivery` under 4, virality is multiplied by 0.65. `stop` has no gate here.
- If `delivery` is under 4 and `stop` is 3 or more above it (a hook that goes nowhere), it is multiplied by 0.5 instead.
- Verdict: `post` needs virality ≥ 65, `delivery` ≥ 4, `payoff` ≥ 5 and `standalone` ≥ 6. Otherwise `recut` when quality is 70 or more, else `skip`. Quality under 60 is always `skip`.

**How to score:** rank the batch on each quality first, then give numbers that keep that order, using
the 2 / 5 / 9 anchors in `agents/vocabulary.md`. Do not aim for a verdict. The validator prints a
`score check:` when the transcript contradicts a score.

### The hook test

- Read the first line on its own. Does it create a question or a claim a stranger needs answered?
- If it opens on "so", "yeah", a laugh, or a name that was only introduced earlier, recut to the
  strongest line. The setup can come after the hook instead of before it.

## Boundaries

- **Start** on the first word of the setup, usually the question or the sentence that frames the moment.
  - Comments and laughter point at the *payoff*; the setup is usually 10–40 s earlier.
  - Read back from the hotspot until the moment makes sense without context.
- **End** right after the payoff. If the room laughs, end on the laugh: the validator extends the end to include a `[laughter]` tag that comes just after it.
- Never end on the next question or the start of a new topic. Never start mid-sentence.
- **Length:** aim for 20–59 s. 15–90 s is allowed, but over 60 s is risky because YouTube blocks claimed Shorts over a minute.
- Never include `⛔` ranges (sponsor reads, intros, the cold-open montage). For a teaser moment, clip the full version later in the episode, not the montage.

## Using the signals

- Seeds are leads, not answers. Read every seed window and judge it yourself.
- **Strongest evidence:** a comment with many likes that quotes the line. Next is a cold-open teaser match, since the show's own editors picked that moment. Then a cluster of laughs.
- **Signals can mislead:**
  - Timestamps on a song, a sponsor read or the intro.
  - Laughter at an in-joke that needs context.
  - A title that promises the sponsor's product.
- Good moments also hide where no signal fired, especially on new videos with few comments. Look beyond the seeds when you have room.

## Titles and hooks

- **title:** 60 characters or fewer. Specific and true, using names: "50 Cent on whether he's worried about Diddy getting out", not "You won't BELIEVE what he said".
- **hook:** the line the clip opens on, or a short on-screen text (8 words or fewer) that frames it, e.g. "Is a documentary worse than a diss track?"
- **reason:** one or two sentences on why this works, naming the setup and the payoff.
- **quote:** 5–20 words copied exactly from the transcript inside the clip. Copy the caption text even when it's misheard; the validator checks the quote against the captions.
