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

test('every var(--token) the Studio uses is defined (in tokens.css, or as a layout variable in the stylesheets)', () => {
  // tokens.css holds the design tokens; ui.css may declare a layout variable on a component (.page's --gutter)
  const defined = new Set(['ui/tokens.css', 'ui/ui.css', 'styles.css'].flatMap((f) => [...read(f).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])));
  const sources = ['styles.css', 'ui/ui.css', 'ui/index.tsx', ...pages];
  const used = new Set(sources.flatMap((f) => [...read(f).matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1])));
  assert.deepEqual([...used].filter((v) => !defined.has(v)).sort(), []);
});

test('the palette keeps WCAG AA: text 4.5:1 on every surface, field borders 3:1, the primary button 4.5:1', () => {
  const tokens = Object.fromEntries([...read('ui/tokens.css').matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(tokens[a]), lum(tokens[b])].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const surfaces = ['--bg', '--panel', '--panel2', '--hover', '--surface-sel'];
  const low: string[] = [];
  for (const fg of ['--text', '--text-2', '--muted', '--accent2', '--good', '--warn', '--bad-text']) for (const bg of surfaces) if (ratio(fg, bg) < 4.5) low.push(`${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  for (const bg of surfaces) if (ratio('--line-field', bg) < 3) low.push(`--line-field on ${bg}: ${ratio('--line-field', bg).toFixed(2)}`);
  if (ratio('--on-primary', '--primary') < 4.5) low.push('--on-primary on --primary');
  if (ratio('--good-text', '--good-tint') < 4.5) low.push('--good-text on --good-tint');
  if (ratio('--warn', '--warn-tint') < 4.5) low.push('--warn on --warn-tint');
  assert.deepEqual(low, []);
});
