// The creator list is the operator's own file (channels.json, not in the repo): a fresh clone without it
// follows no creators instead of crashing, and the example file has the shape the watchlist reads.
import './helpers/sandbox';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCreators } from '../src/core/creators';

test('no channels.json: no creators, and a hint to copy the example', () => {
  const heard: string[] = [];
  const missing = path.join(os.tmpdir(), `no-such-dir-${process.pid}`, 'channels.json');
  assert.deepEqual(loadCreators((w) => heard.push(w), missing), []);
  assert.match(heard[0], /copy channels\.example\.json to channels\.json/);
});

test('the example creator list reads as creators', () => {
  const list = loadCreators(() => assert.fail('the example exists'), path.join(import.meta.dirname, '..', 'channels.example.json'));
  assert.ok(list.length >= 2);
  for (const c of list) {
    assert.ok(c.name && c.handle, JSON.stringify(c));
    assert.ok(c.platform === 'twitch' || c.platform === 'youtube');
  }
});

test('every committed example config parses as JSON', () => {
  const root = path.join(import.meta.dirname, '..');
  for (const f of fs.readdirSync(root).filter((f) => f.endsWith('.example.json'))) JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
});
