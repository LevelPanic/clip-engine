# Lenses

A lens is a markdown rubric for one kind of content:
- `podcast-general`: comedy and conversation.
- `hot-takes`: business, advice and interviews.
- `stream-moments`: livestreams and gaming, where the judge also looks at stills.

The judge (the `/clip` skill) reads the transcript and the signal seeds through a lens and proposes candidates.

To add one, copy `podcast-general.md`, rename it (for example `podcast-hot-takes.md` or `gaming-clutch.md`),
and change what earns points and where clips start and end. Use it with `/clip <url> <lens-name>`.

Every lens keeps the same output fields (title, hook, reason, quote, score, scores, start, end), because
the validator and the Studio depend on them.

## Two formats, two sets of weights

The lens name picks how the engine weighs the six funnel scores (`src/candidates/virality.ts`):

| | Stream (`stream-moments`) | Talk (`podcast-general`, `hot-takes`, any other lens) |
|---|---|---|
| Weights | stop 35 · hold 25 · share 20 · standalone 10 · payoff 10 | stop 15 · hold 25 · share 25 · standalone 15 · payoff 20 |
| Multiplied by 0.65 when | stop < 6, standalone < 6, payoff < 5 or delivery < 6 | standalone < 5, payoff < 5 or delivery < 4 |
| Multiplied by 0.5 when | delivery < 6 and stop is 3+ above it | delivery < 4 and stop is 3+ above it |
| `post` needs | virality ≥ 70, delivery ≥ 7, payoff ≥ 7, standalone ≥ 7 | virality ≥ 65, delivery ≥ 4, payoff ≥ 5, standalone ≥ 6 |

A talk clip may open slowly because the viewer came for the conversation; a gameplay clip loses them in
one second. Nine clips the user rated by hand are why the two differ (SCOPE.md, "In test: virality ranking").

**The judge supplies honest scores and never applies these rules itself.** What a 2, a 5 and a 9 look
like for each score is in `agents/vocabulary.md`, and it is the same for every lens. Any lens other than
`stream-moments` gets the talk weights; to give a new lens the stream weights, add its name to
`formatOfLens`. `test/lenses.test.ts` fails when a lens file and the engine disagree.

## Delivery vs payoff

They sound alike but answer different questions:

- **Payoff** is about the ending: does the clip land on an outcome, reveal or punchline, or does it
  trail off into the next topic?
- **Delivery** is about the promise: the first line makes a specific promise, and the clip fulfils
  *that* promise. A clip can have a strong payoff and still fail delivery if the promise was
  something else.

Examples:
- “He explains why he left the company” → the clip must actually say why. Cutting after “I left
  because…” is no delivery, even if the line is dramatic.
- “The $500k race starts now” → the clip must show the race or its result. Ending on “what do you
  mean by that?” is a recut.
- “She reveals the name” → the name must be said. A reaction to the name is not the reveal.

When the promise and the payoff are not the same moment, the clip is a **recut**, not a post.
