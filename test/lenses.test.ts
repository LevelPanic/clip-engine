// The lens files tell the judge how its scores are used. If they drift from the engine, the judge
// reasons about a rubric that does not exist (this happened: the talk lenses listed the stream weights
// and post bar for weeks). These tests fail when a lens file and src/candidates/virality.ts disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FORMAT_RULES, formatOfLens, viralityScore, verdictOf } from '../src/candidates/virality';
import { VOCABULARY } from '../src/core/vocabulary';
import { QueueVerdictInputSchema } from '../src/scan/review';

const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const lenses = fs.readdirSync(path.join(root, 'lenses')).filter((f) => f.endsWith('.md') && f !== 'README.md');
const pct = (n: number) => `${Math.round(n * 100)}%`;
const title = (k: string) => k[0].toUpperCase() + k.slice(1);

test('every lens file states the weights its format really uses', () => {
  assert.ok(lenses.length >= 3);
  for (const f of lenses) {
    const rules = FORMAT_RULES[formatOfLens(f.replace(/\.md$/, ''))];
    const text = read(`lenses/${f}`);
    for (const [k, w] of Object.entries(rules.weights)) assert.ok(text.includes(`| ${title(k)} | ${pct(w)} |`), `${f}: ${k} should be ${pct(w)}`);
  }
});

test('every lens file states the post bar and the gate its format really uses', () => {
  for (const f of lenses) {
    const { post, gate } = FORMAT_RULES[formatOfLens(f.replace(/\.md$/, ''))];
    const text = read(`lenses/${f}`);
    assert.ok(text.includes(`virality ≥ ${post.virality}, \`delivery\` ≥ ${post.delivery}, \`payoff\` ≥ ${post.payoff} and \`standalone\` ≥ ${post.standalone}`), `${f}: post bar`);
    assert.ok(text.includes(`\`delivery\` under ${gate.delivery}`) || text.includes(`\`delivery\` is under ${gate.delivery}`), `${f}: delivery gate ${gate.delivery}`);
    assert.ok(!/capped at \d+/.test(text), `${f}: the engine multiplies, it does not cap`);
  }
});

test('the lens README table matches both formats', () => {
  const text = read('lenses/README.md');
  for (const format of ['stream', 'talk'] as const) {
    const { weights, post } = FORMAT_RULES[format];
    assert.ok(text.includes(Object.entries(weights).map(([k, w]) => `${k} ${Math.round(w * 100)}`).join(' · ')), `${format} weights`);
    assert.ok(text.includes(`virality ≥ ${post.virality}, delivery ≥ ${post.delivery}, payoff ≥ ${post.payoff}, standalone ≥ ${post.standalone}`), `${format} post bar`);
  }
});

test('the rules in the lens files are the rules the engine applies', () => {
  const s = { stop: 9, hold: 8, share: 8, standalone: 8, payoff: 8, delivery: 8 };
  assert.equal(viralityScore(s, 'stream-moments'), 84);
  assert.equal(viralityScore(s, 'podcast-general'), 82);
  // a slow open sinks a stream clip and not a talk clip
  const slow = { ...s, stop: 4 };
  assert.equal(viralityScore(slow, 'stream-moments'), 43, '66 × 0.65');
  assert.equal(viralityScore(slow, 'hot-takes'), 74, 'no stop gate for talk');
  assert.equal(verdictOf(slow, viralityScore(slow, 'stream-moments'), 80, 'stream-moments'), 'recut');
  assert.equal(verdictOf(slow, viralityScore(slow, 'hot-takes'), 80, 'hot-takes'), 'post');
  // a hook that goes nowhere is halved, in both formats
  const cheat = { ...s, delivery: 3 };
  assert.equal(viralityScore(cheat, 'stream-moments'), 42);
  assert.equal(viralityScore(cheat, 'podcast-general'), 41);
});

test('the agent files only use words the ledgers accept', () => {
  // every `backticked-term` listed after "`./clip vocab <section>`" in the vocabulary doc exists in code
  const doc = read('agents/vocabulary.md');
  for (const [section, { terms }] of Object.entries(VOCABULARY)) {
    const keys = new Set(terms.map((t) => t.key));
    const line = doc.split('\n').find((l) => l.includes(`\`clip vocab ${section}\``));
    assert.ok(line, `agents/vocabulary.md does not mention \`clip vocab ${section}\``);
    const listed = [...line!.split(`\`clip vocab ${section}\``)[1].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
    assert.ok(listed.length >= 5, `${section}: no terms listed`);
    for (const k of listed) assert.ok(keys.has(k), `agents/vocabulary.md lists "${k}" under ${section}, but the CLI does not know it`);
    for (const k of keys) assert.ok(listed.includes(k), `\`clip vocab ${section}\` has "${k}", but agents/vocabulary.md does not list it`);
  }
  // and the expert definitions name moments, triggers and grounds only in words the CLI knows
  const archetypes = new Set(VOCABULARY.archetypes.terms.map((t) => t.key));
  const known = new Set(Object.values(VOCABULARY).flatMap((v) => v.terms.map((t) => t.key)));
  for (const f of ['meme-expert', 'virality-expert', 'story-expert']) {
    const text = read(`.claude/agents/${f}.md`);
    const block = text.split('## Name it')[1]?.split('\n## ')[0] ?? '';
    const fields = new Set(Object.keys(QueueVerdictInputSchema.shape)); // `cut`, `context`, `reason`… are field names, not terms
    const named = [...block.matchAll(/`([a-z]+(?:-[a-z]+)*)`/g)].map((m) => m[1]).filter((k) => !fields.has(k));
    const triggers = new Set(VOCABULARY.triggers.terms.map((t) => t.key));
    assert.ok(named.filter((k) => archetypes.has(k) || triggers.has(k)).length >= 4, `${f}: names no archetypes or triggers`);
    for (const k of named) assert.ok(known.has(k), `${f}.md uses "${k}" as a term, which \`clip vocab\` does not have`);
  }
});

test('every hyphenated term in the agent and skill files is one the CLI knows', () => {
  // `no-visible-cause`, `instant-karma`, `chat-answer`: a hyphenated word in backticks is a vocabulary key
  // (or one of a few names). A typo, or a ground an expert is told to use that the ledger would refuse, fails here.
  const known = new Set(Object.values(VOCABULARY).flatMap((v) => v.terms.map((t) => t.key)));
  const names = new Set(['meme-expert', 'virality-expert', 'story-expert', 'stream-moments', 'podcast-general', 'hot-takes', 'queue-check', 'clip-extractor', 'clip-curator', 'subtitle-expert', 'clip-engine', 'blur-fit', 'push-in', 'punch-in', 'self-contained', 'peak-first']);
  const files = ['agents/vocabulary.md', 'agents/queue-expert.md', 'agents/README.md', 'docs/pipeline.md', ...['meme-expert', 'virality-expert', 'story-expert'].map((f) => `.claude/agents/${f}.md`), ...['queue-check', 'clip-extractor', 'clip-curator', 'edit', 'subtitle-expert', 'clip'].map((f) => `.claude/skills/${f}/SKILL.md`)];
  for (const f of files) {
    for (const m of read(f).matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)) assert.ok(known.has(m[1]) || names.has(m[1]), `${f} uses \`${m[1]}\`, which \`clip vocab\` does not have`);
  }
});

test('the delegated roles all name one model, and the agents README says which', () => {
  // the delegated roles name the model they run on. A file that loses its `model:` line falls back
  // to the session's model without a word, and the cost or the brief with it.
  const roles = [...['meme-expert', 'virality-expert', 'story-expert'].map((f) => `.claude/agents/${f}.md`), ...['clip-extractor', 'clip-curator'].map((f) => `.claude/skills/${f}/SKILL.md`)];
  const front = (f: string) => read(f).split('\n---')[0];
  const models = roles.map((f) => /^model:\s*(\S+)\s*$/m.exec(front(f))?.[1]);
  for (const [k, m] of models.entries()) assert.ok(m, `${roles[k]} has no \`model:\` in its frontmatter`);
  assert.equal(new Set(models).size, 1, `the delegated roles disagree on the model: ${roles.map((f, k) => `${f} → ${models[k]}`).join(', ')}`);
  assert.ok(read('agents/README.md').includes(`\`${models[0]}\``), `agents/README.md ("Which model runs what") does not name ${models[0]}`);
  // a skill only gets its own model when it runs as its own agent
  for (const f of roles.filter((r) => r.includes('/skills/'))) assert.match(front(f), /^context:\s*fork\s*$/m, `${f} names a model but is not \`context: fork\``);
});

test('the expert protocol describes the dossier the engine builds', async () => {
  const { DOSSIER_BATCH, DOSSIER_BEFORE_MS, DOSSIER_AFTER_MS, READ_ON_MS, DOSSIER_STILLS, MOMENT_OFFSETS_MS } = await import('../src/scan/dossier');
  const text = read('agents/queue-expert.md');
  const word = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
  assert.ok(text.includes(`batches of up to ${word[DOSSIER_BATCH]} queues`), `the protocol's batch size is not ${DOSSIER_BATCH}`);
  assert.ok(text.includes(`from ${DOSSIER_BEFORE_MS / 1000} s before the region to ${DOSSIER_AFTER_MS / 1000} s after it`), 'the protocol states other margins for the words than the dossier uses');
  assert.ok(text.includes(`The read-on is the ${word[READ_ON_MS / 60_000]} minutes after the region`), 'the protocol states another read-on length than the dossier uses');
  const o = MOMENT_OFFSETS_MS;
  assert.ok(text.includes(`${-o[0] / 1000} s before it, the moment, and ${o[2] / 1000} s and ${o[3] / 1000} s after`) && o[1] === 0, 'the protocol states other stills for an exact moment than the dossier takes');
  assert.ok(text.includes(`up to ${DOSSIER_STILLS.meme} stills a queue, ${DOSSIER_STILLS.clip} for a story`) && DOSSIER_STILLS.viral === DOSSIER_STILLS.meme, 'the protocol states other still counts than the dossier takes');
});

test('the vocabulary states the quality bars the engine uses', async () => {
  const { QUALITY_SKIP, QUALITY_RECUT, verdictOf } = await import('../src/candidates/virality');
  const text = read('agents/vocabulary.md');
  assert.ok(text.includes(`under ${QUALITY_SKIP} \`skip\``), `agents/vocabulary.md does not say that a score under ${QUALITY_SKIP} is a skip`);
  assert.ok(text.includes(`at ${QUALITY_RECUT} or more that misses the post bar \`recut\``), `agents/vocabulary.md does not say that ${QUALITY_RECUT} or more is a recut`);
  const weak = { stop: 5, hold: 5, share: 5, standalone: 5, payoff: 5, delivery: 5 };
  assert.equal(verdictOf(weak, 40, QUALITY_SKIP - 1, 'stream-moments'), 'skip');
  assert.equal(verdictOf(weak, 40, QUALITY_RECUT - 1, 'stream-moments'), 'skip');
  assert.equal(verdictOf(weak, 40, QUALITY_RECUT, 'stream-moments'), 'recut');
});

