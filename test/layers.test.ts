// The module layers. Every folder of src/ has a place in LAYERS, lowest first, and a file may import only
// from its own folder or one below it, never from above: that is what keeps the code free of import cycles.
// Static imports, re-exports and dynamic `import()` all count (a dynamic import still ties the two together).
// docs/architecture.md describes the layers; change both together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

/** Lowest first. `markers` covers src/markers/ and the marker folders in markers/. */
export const LAYERS = [
  'core', // types, schemas, time, paths, processes: depends on nothing else
  'jobs', // the SQLite job queue and starting its worker: anyone may queue work
  'markers', // the marker contract and the marker types
  'project', // clip projects: load, save, edit
  'composition', // the Remotion composition (preview and export)
  'ingest', // sources, footage, transcripts, chat
  'discover', // signals and seeds
  'scan', // stream passes, queue checkers, moments, the experts' ledger
  'extract', // start/end windows
  'candidates', // validation, virality, ranking
  'review', // review decisions and the learning loop
  'curate', // the curator's ledger
  'reframe', // faces, facecam, framing
  'qa', // export checks, 18+, never-post
  'edit', // autoedit, editors, captions, censoring
  'render', // the export
  'judge', // the unattended judge
  'track', // the watchlist's tracker, job table and ranking
  'pipeline', // the unattended full process, the Studio's job handlers and runner, batches
  'publish', // YouTube, TikTok, upload pace and status
  'studio', // the Studio server and web app
  'cli', // the ./clip commands
  'tools', // the daemons and scripts
];

/** Upward imports that existed when the rule was written and are being removed. Must only shrink. */
const KNOWN: string[] = [];

const layerOf = (file: string): string => {
  const rel = path.relative(ROOT, file).split(path.sep);
  if (rel[0] === 'markers') return 'markers';
  if (rel[0] === 'tools') return 'tools';
  if (rel[0] === 'src') return rel[1];
  return rel[0];
};

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : [];
  });

/** The file a relative import resolves to, or null (a string in a template, a path that is not there). */
function resolve(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

const IMPORT = /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;

/** Every import that goes up a layer, as `from-file -> spec (layer -> layer)`. */
export function upwardImports(): string[] {
  const rank = (l: string) => LAYERS.indexOf(l);
  const out: string[] = [];
  const files = [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'markers')), ...fs.readdirSync(path.join(ROOT, 'tools')).filter((f) => f.endsWith('.ts')).map((f) => path.join(ROOT, 'tools', f))];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec?.startsWith('.')) continue;
      const target = resolve(file, spec);
      if (!target) continue;
      const a = layerOf(file);
      const b = layerOf(target);
      if (rank(b) > rank(a)) out.push(`${path.relative(ROOT, file)} -> ${spec} (${a} -> ${b})`);
    }
  }
  return [...new Set(out)].sort();
}

test('every src/ folder has a place in the layers', () => {
  const folders = fs.readdirSync(path.join(ROOT, 'src'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.deepEqual(folders.filter((f) => !LAYERS.includes(f)), [], 'add the new folder to LAYERS (test/layers.test.ts) and docs/architecture.md');
});

test('no import goes up a layer (no import cycles between folders)', () => {
  const found = upwardImports();
  const fresh = found.filter((x) => !KNOWN.includes(x));
  assert.deepEqual(fresh, [], 'an import goes up a layer: move the code down, or pass it in from above');
  const fixed = KNOWN.filter((x) => !found.includes(x));
  assert.deepEqual(fixed, [], 'these are fixed: take them out of KNOWN');
});
