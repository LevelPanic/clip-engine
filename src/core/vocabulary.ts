// The shared vocabulary of the pipeline's agents: the words a queue expert, the extractor, the curator
// and the editors use for a moment, why it would travel, where it belongs and what could go wrong.
//
// It lives in code so the ledgers can be validated against it (`clip queue-review`, `clip curate`) and
// so there is one list: `clip vocab` prints it, and agents/vocabulary.md explains how to use it.
// Browser-safe (no Node imports).

export interface Term {
  key: string;
  /** How you recognise it in a clip. One line, operational. */
  means: string;
  /** Where the clip should start and end for it, when that is specific to the term. */
  cut?: string;
}

/** What kind of moment it is. The first group is the meme expert's, the second the story expert's. */
export const ARCHETYPES: Term[] = [
  // ---- gags: the reaction or the image is the point
  { key: 'jumpscare', means: 'a sudden threat and a scream', cut: 'open 1–3 s of calm before it; end on the scream or the first line after it' },
  { key: 'fail', means: 'a visible mistake at a moment that mattered', cut: 'open on the attempt; end one beat after the impact' },
  { key: 'instant-karma', means: 'a boast or a taunt, then the opposite happens at once', cut: 'the boast must be inside; end on the consequence' },
  { key: 'rage', means: 'someone on stream loses it at a trigger (a crashout)', cut: 'open on the trigger; end at the peak, not the cooldown' },
  { key: 'deadpan', means: 'a flat one-line reply to something absurd', cut: 'the prompt must be inside; hold half a second after the line' },
  { key: 'caught-lacking', means: 'caught off guard: hot mic, wrong tab, someone walks in', cut: 'open just before the reveal; end on the realisation' },
  { key: 'awkward-silence', means: 'a social misfire and the silence after it', cut: 'keep the pause whole; end before anyone recovers' },
  { key: 'chat-roast', means: 'a chat message or donation lands on someone on stream', cut: 'the message must be on screen or read aloud; end on the reaction' },
  { key: 'interruption', means: 'a pet, a parent or a bystander breaks the scene', cut: 'open seconds before the entry; end on the reaction' },
  { key: 'glitch', means: 'the game or the world does something it should not', cut: 'show the normal state first; end on the reaction to it' },
  { key: 'pop-off', means: 'a clutch play, then the freak-out', cut: 'open on the play; end at peak volume' },
  { key: 'misspeak', means: 'a slip of the tongue or a brain-fart', cut: 'open on the sentence; end when they realise' },
  { key: 'reaction-face', means: 'the face is the joke: a stare, a wince, disbelief', cut: 'what they react to must be inside or named in the hook' },
  { key: 'absurd', means: 'a sight or a line that makes no sense, played straight', cut: 'open on the image; end before it is explained' },
  { key: 'prank', means: 'someone on stream is tricked, and their reaction to the trick is the point', cut: 'the reaction must be inside, and the lie too when it fits; when it cannot, the context line states it. The hook or title says it is a prank, never the lie as fact' },
  // ---- stories: the words carry it
  { key: 'anecdote', means: 'a short true story with a turn', cut: 'open on the sentence that sets the scene; end on the turn\'s landing line' },
  { key: 'confession', means: 'something admitted that costs the speaker', cut: 'open on the admission or the question that draws it out; end on the reaction to it' },
  { key: 'hot-take', means: 'a claim people will agree or argue with', cut: 'open on the claim; end on the sharpest line of the proof' },
  { key: 'argument', means: 'two people disagreeing, with a winner or a walk-off', cut: 'open on the line that starts it; end on the last word, not the change of subject' },
  { key: 'reveal', means: 'information the viewer was made to wait for', cut: 'the question and the answer must both be inside' },
  { key: 'banter', means: 'a quick back-and-forth that builds to a laugh', cut: 'open on the first jab; end on the laugh, not the next topic' },
  { key: 'lesson', means: 'advice or an explanation with a concrete example', cut: 'open on the problem; end when the example lands' },
  { key: 'wholesome', means: 'kindness, gratitude or a sincere emotional beat', cut: 'open on what prompts it; end on the feeling, not the thanks' },
];

/** Why a stranger would send it to someone. The virality expert names one; "none" is a real answer. */
export const SHARE_TRIGGERS: Term[] = [
  { key: 'hilarity', means: 'a strong laugh, not mild amusement: you would show it to someone to watch them laugh' },
  { key: 'disbelief', means: '"no way that happened": the viewer wants a second opinion' },
  { key: 'awe', means: 'skill, luck or scale beyond what was expected' },
  { key: 'outrage', means: 'something that looks unfair, wrong or rude' },
  { key: 'debate', means: 'a judgment call people will take sides on in the comments' },
  { key: 'relatable', means: '"this is you": there is an obvious person to tag' },
  { key: 'warmth', means: 'it makes the sender look kind: a wholesome or generous beat' },
  { key: 'drama', means: 'conflict between people the audience knows about' },
  { key: 'news', means: 'first sight of something people will ask about: a reveal, an announcement' },
  { key: 'useful', means: 'a tip or a fact the receiver can use' },
  { key: 'none', means: 'good for fans, but no reason to send it to someone who is not one' },
];

/** Why a queue is not a clip. A reject must name one. */
export const REJECT_GROUNDS: Term[] = [
  { key: 'no-visible-cause', means: 'laughter or noise with nothing in the frames or words that explains it' },
  { key: 'chat-only', means: 'chat is reacting to chat, a poll, a prediction or an alert the clip cannot show' },
  { key: 'event-not-moment', means: 'a raid, subs, a hype train or a giveaway made chat busy' },
  { key: 'chat-answer', means: 'chat is answering a question the streamer asked (a yes/no vote, suggestions), not reacting to something that happened' },
  { key: 'lore', means: 'only makes sense with channel history; no one-line hook can fix it' },
  { key: 'nothing-happened', means: 'looked at the frames and the words: ordinary stream, the signal was noise' },
  { key: 'no-reach', means: 'it makes sense, but there is nothing a stranger would stop for or send' },
  { key: 'other-kind', means: 'a real moment, but not this expert\'s kind (a story, not a gag; a gag, not a story): the expert whose kind it is decides' },
  { key: 'duplicate', means: 'the same moment as another queue (use the merge verdict when the other one is in this review)' },
  { key: 'muted', means: 'inside a muted or excluded stretch' },
  { key: 'unsafe', means: 'cannot be posted: see the risk flags' },
  { key: 'not-english', means: 'the words that matter are not in English (English only for now)' },
  { key: 'broken', means: 'the footage or audio is unusable here: frozen, black, wrong scene' },
];

/** Things a person must check before a clip is posted. Flagging is not rejecting. */
export const RISK_FLAGS: Term[] = [
  { key: 'privacy', means: 'an address, a full name, a phone number, a document, a face of a bystander or a leak is visible or said' },
  { key: 'minor', means: 'someone who looks under 18 is the subject' },
  { key: 'sexual', means: 'nudity, sexual content or innuendo that carries the clip' },
  { key: 'slur', means: 'a slur or hate speech is said or shown, by anyone, in any tone' },
  { key: 'harassment', means: 'the joke is at the expense of a private person, or mocks a protected group' },
  { key: 'self-harm', means: 'self-harm or suicide is joked about or shown' },
  { key: 'violence', means: 'real-world violence, weapons or injury (not gameplay)' },
  { key: 'drugs', means: 'drug use, or jokes about hard drugs, carry the clip' },
  { key: 'music', means: 'copyrighted music is audible for more than a few seconds' },
  { key: 'third-party', means: 'the clip is mostly someone else\'s video, show or broadcast being watched' },
  { key: 'profanity', means: 'heavy swearing: fine on most feeds, limits brand-safe placement' },
  { key: 'misleading', means: 'cut this way it suggests something that did not happen' },
  { key: 'staged', means: 'chat or the frames suggest it was set up to be clipped (clip farming)' },
];

/** Where a clip belongs. The curator assigns one; `angle` (free text) says what it is about. */
export const NICHES: Term[] = [
  { key: 'reaction-meme', means: 'a loopable reaction, scare, fail or face that works on mute' },
  { key: 'funny-banter', means: 'a spoken joke, roast or exchange between people' },
  { key: 'story', means: 'an anecdote or confession with a setup and a landing' },
  { key: 'hot-take', means: 'an opinion, argument, politics or advice' },
  { key: 'gaming-highlight', means: 'a play, a clutch, a win' },
  { key: 'gaming-fail', means: 'an in-game fail, glitch or rage' },
  { key: 'irl-moment', means: 'IRL, an event, sport or atmosphere' },
  { key: 'drama', means: 'conflict, a callout or a crashout between known people' },
  { key: 'wholesome', means: 'kindness or a sincere emotional beat' },
  { key: 'useful', means: 'a tip, a fact or an explanation' },
  { key: 'none', means: 'no niche fits (only valid on a drop)' },
];

/** The only reasons a curator may drop a candidate. A low score is not one of them. */
export const DROP_GROUNDS: Term[] = [
  { key: 'no-niche', means: 'no niche fits AND it does not make sense to a cold viewer' },
  { key: 'duplicate', means: 'the same moment as a stronger candidate (name it in duplicateOf)' },
  { key: 'muted', means: 'the audio is muted or missing' },
  { key: 'broken', means: 'the setup or the payoff is outside the clip and no recut can reach it, or the footage is unusable' },
  { key: 'unsafe', means: 'a risk that cannot be edited out: privacy, a minor, a slur, sexual content' },
  { key: 'not-english', means: 'the words that matter are not in English' },
];

export const VOCABULARY = {
  archetypes: { title: 'Moment archetypes (what kind of moment it is)', terms: ARCHETYPES },
  triggers: { title: 'Share triggers (why a stranger would send it)', terms: SHARE_TRIGGERS },
  rejects: { title: 'Reject grounds (why a queue is not a clip)', terms: REJECT_GROUNDS },
  risks: { title: 'Risk flags (check before posting)', terms: RISK_FLAGS },
  niches: { title: 'Niches (where a clip belongs)', terms: NICHES },
  drops: { title: 'Drop grounds (the only reasons to drop a candidate)', terms: DROP_GROUNDS },
} as const;
export type VocabSection = keyof typeof VOCABULARY;

export const keysOf = (terms: Term[]): [string, ...string[]] => terms.map((t) => t.key) as [string, ...string[]];
