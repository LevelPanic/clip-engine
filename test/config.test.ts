// The settings (src/core/config.ts): read through one place, parsed strictly, and documented in
// docs/operations.md → "Settings" exactly as the code has them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS, defaultText, setting, type Name } from '../src/core/config';

const ROOT = path.join(import.meta.dirname, '..');

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};

test('numbers, flags and choices are parsed; a value that cannot be read is an error, not NaN', () => {
  withEnv({ UPLOAD_MIN: undefined, TOPICS: undefined, SOURCE_DELETE: undefined }, () => {
    assert.equal(setting('UPLOAD_MIN'), 180);
    assert.equal(setting('TOPICS'), true);
    assert.equal(setting('SOURCE_DELETE'), 'media');
  });
  withEnv({ UPLOAD_MIN: '90', TOPICS: '0', SOURCE_DELETE: 'all' }, () => {
    assert.equal(setting('UPLOAD_MIN'), 90);
    assert.equal(setting('TOPICS'), false);
    assert.equal(setting('SOURCE_DELETE'), 'all');
  });
  withEnv({ UPLOAD_MIN: '15m' }, () => assert.throws(() => setting('UPLOAD_MIN'), /UPLOAD_MIN=15m is not a number \(min\)/));
  withEnv({ TOPICS: 'maybe' }, () => assert.throws(() => setting('TOPICS'), /1 or 0/));
  withEnv({ SOURCE_DELETE: 'everything' }, () => assert.throws(() => setting('SOURCE_DELETE'), /one of media, all/));
  withEnv({ UPLOAD_MIN: '  ' }, () => assert.equal(setting('UPLOAD_MIN'), 180, 'blank is unset, not 0'));
});

test('an old name still works, and a setting can default to another', () => {
  withEnv({ HOLD_RETRY_MIN: undefined, QUOTA_MIN: '30' }, () => assert.equal(setting('HOLD_RETRY_MIN'), 30));
  withEnv({ HOLD_RETRY_MIN: '45', QUOTA_MIN: '30' }, () => assert.equal(setting('HOLD_RETRY_MIN'), 45));
  withEnv({ CLIP_PIPELINE_MODEL: undefined, CLIP_JUDGE_MODEL: 'x/model' }, () => assert.equal(setting('CLIP_PIPELINE_MODEL'), 'x/model'));
  withEnv({ CLIP_PIPELINE_MODEL: undefined, CLIP_JUDGE_MODEL: undefined }, () => assert.equal(setting('CLIP_PIPELINE_MODEL'), 'opencode-go/deepseek-v4.1-flash'));
});

test('no code reads the environment except through setting() (PATH aside)', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'tools'));
  const reads = files
    .filter((f) => !f.endsWith(path.join('core', 'config.ts')))
    .flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z_0-9]+)|process\.env\[/g)].filter((m) => m[1] !== 'PATH').map((m) => `${path.relative(ROOT, f)}: ${m[0]}`));
  assert.deepEqual(reads, [], 'read it with setting() and add it to SETTINGS (src/core/config.ts)');
});

test('docs/operations.md lists every setting with its default, and nothing else', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'operations.md'), 'utf8');
  const rows = new Map([...doc.matchAll(/^\| `([A-Z_0-9]+)` \| ([^|]+) \|/gm)].map((m) => [m[1], m[2].trim()]));
  const names = Object.keys(SETTINGS) as Name[];
  assert.deepEqual([...rows.keys()].sort(), [...names].sort(), 'regenerate the Settings table from src/core/config.ts');
  for (const n of names) assert.equal(rows.get(n), defaultText(n), `${n}'s default in docs/operations.md`);
});
