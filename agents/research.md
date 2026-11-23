# What the experts are built on

Research done 2026-11-12 for the virality expert and the meme expert, and what was measured on this
library the same day. Every line says how far to trust it:

- **[official]** a platform's own help or policy page
- **[staff]** a platform employee, usually reported through the press
- **[paper]** peer-reviewed or a preprint
- **[data]** third-party numbers; **[lore]** what practitioners say, with no data behind it
- **[here]** measured on this project's library

The rubrics in `agents/vocabulary.md`, the lenses and the three expert definitions follow from this
file. When one of these findings stops being true, change it here first.

## 1. What the feeds reward

1. YouTube's Shorts hook metric is **"Stayed to watch"**: the share of times viewers stayed past the initial seconds. Average percentage viewed is computed from engaged views. [official] https://support.google.com/youtube/answer/12220281
2. Public Shorts views count every play or replay (since 31 March 2025); earnings still use engaged views. Loops raise the public number only. [official] same page · https://support.google.com/youtube/answer/10059070
3. YouTube says relative watch time matters more for short videos, tags are "not important", and publish time is not known to matter. [official] https://support.google.com/youtube/answer/141805
4. Shorts product lead (2023): no ideal length, hashtags optional, thumbnails barely matter, the first few hundred to few thousand views are exploratory. In January 2025 (paraphrased): retention and "valued watch time" outrank likes and shares. [staff, via press] https://www.searchenginejournal.com/youtube-explains-how-shorts-algorithm-works/494953/ · https://ppc.land/youtube-shorts-product-lead-discusses-strategy-and-metrics/
5. One 2023 sample of 5,400 Shorts: under 60% viewed-vs-swiped rarely performed, winners sat at 70–90%, most ran 20–40 s, likes and comments barely correlated. Preliminary. [data] https://threadreaderapp.com/thread/1646898356419981315.html
6. TikTok: finishing a longer video is a strong signal; follower count is not a direct factor; duplicates are not recommended. [official, 2020] https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you/
7. Instagram: the top Reels predictions are reshare, watch to the end, like; watermarked, low-res or already-posted reels are demoted. Its head (January 2025): watch time, likes and sends matter most, and **sends per reach weighs more with non-followers**. [official] https://about.instagram.com/blog/announcements/instagram-ranking-explained · [staff, via press] https://www.socialsamosa.com/news-2/instagram-reveals-key-factors-for-boosting-reach-8646916

**What we did with it:** `stop` is the stay rate, `hold` is relative watch time, `share` is the send. Titles and hashtags stay "frosting". No official numeric threshold exists for any of them; every number above is third-party.

## 2. Why people share

8. High-arousal emotion (awe, anger, anxiety) predicted sharing of news articles; sadness reduced it. [paper] https://doi.org/10.1509/jmr.10.0353 — **contested**: later replications found incidental arousal did not raise sharing, and the evidence is articles, not video. https://www.psychologicalscience.org/journals/psychological-science/09567976241257255/
9. On YouTube ads, amusement, excitement, inspiration and warmth raised sharing; information-heavy content lowered it. [paper] https://doi.org/10.1177/0022242919841034
10. People say they share to entertain or inform, to define themselves, to bond, to feel involved. [industry survey, 2011] https://www.businesswire.com/news/home/20110713005971/en/New-York-Times-Completes-Research-%E2%80%98Psychology-Sharing%E2%80%99
11. Curiosity is the discomfort of a perceived gap in knowledge. A hook should open **one specific gap the clip then closes** (our application). [paper] https://doi.org/10.1037/0033-2909.116.1.75
12. Across 2 million Twitch viewer clips, **what chat said (content and emotes) separated popular clips better than how much chat there was** or the visuals. [paper, read at abstract level] https://doi.org/10.1140/epjds/s13688-021-00295-6
13. Clip audiences are mostly not fans: one large streamer averages ~33,000 live viewers but 700,000+ views per clip. Platforms boost clips and suppress duplicate clip pages. [data, press] https://www.kpbs.org/news/science-technology/2026/05/12/the-clipping-economy-how-short-form-video-clippers-are-overrunning-the-internet

**What we did with it:** the share trigger list (`clip vocab triggers`), the "cold viewer" as who a clip is cut for, and reading chat mood rather than only chat speed.

## 3. Hooks and retention (practitioner lore unless marked)

14. Hook in under ~3 s, clear on mute, foreshadowing the payoff; end right after delivering it. [lore, second-hand] https://rosetta.to/u/vidiq/how-jenny-hoyos-actually-makes-viral-shorts
15. The opening must confirm the title's promise. [lore, with data from long-form] https://simonwillison.net/2024/Sep/15/how-to-succeed-in-mrbeast-production/
16. A vendor's 34,635 clips (Q1 2026): top-10% median 41 s vs 50 s overall; 80% had burned-in captions; result-first hooks did about twice as well as the weakest type. Correlational. [data, vendor] https://www.opus.pro/blog/anatomy-of-a-viral-tiktok-2026
17. Gaming clips: start 1–2 s before the peak, not 3–5; frame one shows motion, a target or a reacting face; text hook of five words at most. [lore] https://blog.eklipse.gg/beginner-guide-2/stream-hook-strategy-first-two-seconds.html
18. TikTok's ad guidance: the proposition in the first 3 s, with captions or overlays. [official, for ads] https://ads.tiktok.com/help/article/creative-best-practices?lang=en

**What we did with it:** the window scorer places a gag about a third of the way in and penalises 4 s of nothing at the open; hook text is 6 words or fewer and leaves the screen before the hit.

## 4. Humour and memes

19. **Incongruity-resolution:** amusement comes from resolving a violated expectation, so the clip must hold both the expectation and the snap. [reference] https://plato.stanford.edu/entries/humor/ — "incongruity" has four meanings and none alone separates funny from unfunny, so name which one. [paper] https://experts.arizona.edu/en/publications/differentiating-what-is-humorous-from-what-is-not/
20. **Benign violation:** something is funny when it is a violation and reads as harmless at the same time. Name the violation and the safety cue. Disputed by a 2024 account. [paper] https://journals.sagepub.com/doi/abs/10.1177/0956797610376073
21. **Superiority** is neither necessary nor sufficient, but mirth grows with dislike of the victim: keep the boast before the fail. [reference] same as 19
22. Laughter is a social signal, far more frequent in company, and mostly not a response to jokes. **A detected laugh needs a visible cause.** [reference] https://www.apa.org/monitor/jun06/laughing
23. Memetic videos share ordinary people, flawed masculinity, humour, simplicity, repetitiveness and whimsy; and a viral becomes a meme only when people alter it. Score reusability separately from shareability. [paper] https://cris.huji.ac.il/en/publications/an-anatomy-of-a-youtube-meme/ · [reference] https://www.enculturation.net/memes-in-digital-culture

## 5. Chat as evidence

24. In esports, chat-only highlight detection scored far below video (F≈43 vs 72; 75 combined), and the best chat window was the seconds *after* the frame. **Chat lags and is weak alone.** [paper] https://arxiv.org/abs/1707.08559
25. Reactions to events are mostly one word or one emote, in bursts; copy-paste cascades mark boredom. [preprint] https://arxiv.org/abs/1801.02862
26. Big chats collapse into a few voices: count distinct chatters, not messages. [paper] https://www.artifex.org/~bonnie/CHI_twitch-final-2017.pdf
27. The median Twitch comment is 3 words; English sentiment lexicons fail and an emote lexicon helps most. With millions of emotes, **lists go stale**. [paper/preprint] https://github.com/konstantinkobs/emote-controlled · https://arxiv.org/abs/2108.08411
28. Emote meaning is set by usage; channels ban and substitute emotes. [reference] https://knowyourmeme.com/editorials/the-twitch-emote-cycle
29. One week in September 2026: LUL 2.9M uses, KEKW 738k, Kappa 620k, xdd 515k, o7 431k. Laugh tokens are background; score against the channel's own baseline. [data] https://streamer.guide/guides/twitch-emotes · https://stats.streamelements.com/c/global
30. Ironic or knowing emotes: Kappa (sarcasm), Clueless (streamer misses the obvious), Aware (ominous realisation), COPIUM (mock denial), pepeLaugh (anticipation). [reference] https://www.streamladder.com/emotes/clueless · https://www.own3d.tv/en/blog/dictionary/pepelaugh
31. Slang: crash out = lose control; aura = coolness; glazing = over-praise; rage bait = content built to anger; "chat is this real" is usually ironic; clip farming = staging moments to be clipped. [reference] https://merriam-webster.com/slang/crash-out · https://www.dictionary.com/culture/slang/glaze · https://knowyourmeme.com/memes/chat-is-this-real
32. Hype trains and raids spike chat with no content cause. [reference] https://streamlabs.com/content-hub/post/what-are-twitch-hype-trains

Measured **[here]** on the library's scanned broadcasts (2026-11-12):

33. From a laugh or scream to the chat peak: median 17.5 s, middle half 7.5–27.5 s (43 cases). The old queue checker looked only 8 s before the chat peak, so it often missed the moment it was pointing at.
34. Of 2,369 raw classifier events, 386 (16%) are reactions by the tuned thresholds. The most frequent label was `booing` (865), which is noise. The old queue checker counted every event.
35. A viewer clip's offset is **not** reliably its start or its end: 42% of 291 clips were created sooner after the offset than their own length, and title words were said before the offset about as often as after it (11 vs 9 of 25). It is an anchor, good to about one clip length.
36. Chat in this library says "sob" and "geeg" next to LOL and gg; "cap", "LARP" and "AI" when it does not believe the streamer. No outside source for the first two.

**What we did with it:** the lexicon and its nine moods in `src/discover/chatAnalysis.ts`; chat evidence shifted to moment time in `src/scan/queues.ts`; one tuned reaction detector used everywhere; `clipSpan` for viewer clips.

## 6. Meme editing (all timings are lore)

37. A "vine boom" marks shock; overuse made it ironic by 2020–21. Stacked airhorns and hitmarkers were parody by 2011–12. **Heavy stacking reads as irony.** [reference] https://knowyourmeme.com/memes/vine-boom-sound-effect · https://knowyourmeme.com/memes/montage-parodies
38. Freeze-and-card formats (to be continued, we'll be right back, mock credits, record scratch) freeze at or just before the climax. All lean on commercial songs. [reference] https://knowyourmeme.com/memes/to-be-continued · https://knowyourmeme.com/memes/well-be-right-back
39. Editors say a couple of frames can ruin a joke and that the length of a hold alone changes a gag. Nobody publishes fixed seconds. [lore] https://www.televisual.com/?p=1141

**What we did with it:** the edit device table in `.claude/skills/edit/SKILL.md`; the editors place one punch-in on the punch word, never stack, and never cut the pause before a laugh.

## 7. Rules that decide whether a clip channel survives

40. YouTube monetisation: reused content needs "significant original commentary, substantive modifications, or educational or entertainment value", **even with permission**, and it is judged channel-wide. "Inauthentic content" (15 July 2025) targets templated mass production. [official] https://support.google.com/youtube/answer/1311392
41. Shorts revenue sharing excludes "unedited clips", re-uploads and compilations with nothing original added. [official] https://support.google.com/youtube/answer/12504220
42. TikTok: unoriginal or reused material with nothing new is ineligible for the For You feed; reposting copyrighted material without permission is prohibited (effective 24 September 2026). [official] https://www.tiktok.com/community-guidelines/en/integrity-authenticity
43. Instagram (April 2024): originals replace duplicates in recommendations; accounts that repeatedly post content they "didn't create or materially enhance" lose recommendations; meme edits, new voiceover and reaction remixes are exempt. [official] https://creators.instagram.com/recommendations-and-originality
44. Twitch bars slurs (even untargeted), harassment, glorifying self-harm, endangering under-18s and revealing personal information; its music rules cover clips. [official] https://safety.twitch.tv/articles/en_US/Knowledge/Community-Guidelines

45. YouTube: "URLs placed in YouTube Shorts comments and Shorts descriptions are non-clickable", to reduce spam. Channel profile links and Related Video links in Shorts stay clickable. [official] https://support.google.com/youtube/answer/13748639

**What we did with it:** the risk flags (`clip vocab risks`), and a standing note for the user: about 100 clips a day made by one template is exactly what items 40–43 describe. The edit pass (hook text, captions, cuts, framing) is what makes a clip "materially enhanced", so "export as is" is the risky path, not the safe one. This is a judgment about policy text, not legal advice.

## 8. Looked for and not found

- Any official numeric threshold for stay rate, retention or completion on any platform.
- Anything official from TikTok on first-seconds retention or rewatch weighting (its support page would not load).
- Independent data on typical lengths, first frames or title conventions for streamer clips: only vendor advice.
- Data behind open loops, pattern interrupts, beat density, loop endings or comment triggers: lore only.
- A source that measures typical meme-clip length or effect timing.
- Sources for "son", "sob", "rt" and the NAHHH and Cinema emotes in Twitch chat.
- Shifman's "six Ps" (book chapter not retrievable), so they are not used.
- Some citations were read through summaries or press, not the original: the 2025 staff statements, Hoyos, Suls, Zillmann & Cantor, and the Loewenstein DOI.
