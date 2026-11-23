// The Studio's design system (src/studio/web/ui/): pages take colours from the tokens, and every token a
// page or stylesheet uses exists. A misspelt var(--x) fails silently in the browser; here it fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.join(import.meta.dirname, '..', 'src', 'studio', 'web');
const read = (f: string) => fs.readFileSync(path.join(WEB, f), 'utf8');
const pages = fs.readdirSync(WEB).filter((f) => f.endsWith('.tsx'));

test('pages write no raw colours (they use the tokens)', () => {
  const found = pages.flatMap((f) => [...read(f).matchAll(/['"`](#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))['"`]/g)].map((m) => `${f}: ${m[1]}`));
  assert.deepEqual(found, [], 'add a token to ui/tokens.css (or ui/tokens.ts for canvas) and use it');
});

test('every var(--token) the Studio uses is defined in tokens.css', () => {
  const defined = new Set([...read('ui/tokens.css').matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const sources = ['styles.css', 'ui/ui.css', 'ui/index.tsx', ...pages];
  const used = new Set(sources.flatMap((f) => [...read(f).matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1])));
  assert.deepEqual([...used].filter((v) => !defined.has(v)).sort(), []);
});
