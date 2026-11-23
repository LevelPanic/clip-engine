# Lens: hot-takes

For interviews and business or advice podcasts, where the clip is an opinion, a claim or a lesson
rather than a joke (Diary of a CEO, Mark Cuban and similar). Use alongside `podcast-general` when a
show mixes both.

## Score each candidate

Two scores, not one:

1. **Quality** (`score`, 0–100): is this a good moment at all? **Keep 60 or more.**
2. **The funnel** (`scores`, each 0–10): will a stranger stop, stay and argue? This decides the order.

| Quality | Weight | What a 9 looks like |
|---|---|---|
| Stop | 15% | It opens on the claim or a sharp question, not on "so, yeah, I think…". A clear, quotable position people will agree with or argue about. |
| Hold | 25% | The proof lands in beats: a story, a number or the speaker's own experience, with no filler between. |
| Share | 25% | Someone would send it to a friend or argue about it in the comments. |
| Standalone | 15% | No setup needed beyond the first line. Numbers, names and the "who" are said in the clip. |
| Payoff | 20% | The proof or the sharpest sentence lands before the clip ends. |
| Delivery | gate | The claim the first line made is actually answered or proven. A bold question that ends before the answer is a cheat. |

**What the engine does with your scores** (`src/candidates/virality.ts`; you never do this yourself):

- Virality = the weighted scores × 10. For a talk lens the weights are in the table: a slow open is forgiven, a weak claim or a missing payoff is not.
- If `standalone` or `payoff` is under 5, or `delivery` under 4, virality is multiplied by 0.65. `stop` has no gate here.
- If `delivery` is under 4 and `stop` is 3 or more above it (a hook that goes nowhere), it is multiplied by 0.5 instead.
- Verdict: `post` needs virality ≥ 65, `delivery` ≥ 4, `payoff` ≥ 5 and `standalone` ≥ 6. Otherwise `recut` when quality is 70 or more, else `skip`. Quality under 60 is always `skip`.

**How to score:** rank the batch on each quality first, then give numbers that keep that order, using
the 2 / 5 / 9 anchors in `agents/vocabulary.md`. Do not aim for a verdict. The validator prints a
`score check:` when the transcript contradicts a score.

## Boundaries

- **Start on the claim or the question that triggers it.** Interviewers' long questions can be trimmed: start on the last sentence of the question.
- **End right after the proof lands**, or on the sharpest sentence. Don't run into "and that's why, you know, anyway".
- **Length:** aim for 25–55 s. Advice clips tolerate a bit more length than comedy, but over 60 s is risky for Shorts.
- **Find themes with search:** `./clip search <id> money rich poor` or `./clip search <id> fail failure mistake` finds every place a theme comes up. Teaser matches (the show's cold open) are the editors' own picks; check them first.

## Titles and hooks

- **title:** state the take: "Mark Cuban: money won't fix you if you're miserable". Avoid "SHOCKING" bait.
- **hook:** the claim in 8 words or fewer, as on-screen text.
- **reason:** the claim, the proof, and why it travels.
- **quote:** 5–20 words copied exactly from the transcript inside the clip.
