// TikTok upload framing: chunk plan and PKCE challenge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkPlan, codeChallenge } from '../src/publish/tiktok';

test('a small clip is one chunk', () => {
  const p = chunkPlan(4 * 1024 * 1024);
  assert.equal(p.total, 1);
  assert.equal(p.chunkSize, 4 * 1024 * 1024);
});

test('a normal clip is one chunk, a large one is split evenly', () => {
  const one = chunkPlan(25 * 1024 * 1024);
  assert.equal(one.total, 1);
  assert.equal(one.chunkSize, 25 * 1024 * 1024);
  const big = chunkPlan(150 * 1024 * 1024);
  assert.equal(big.total, 3);
  assert.ok(big.chunkSize <= 64 * 1024 * 1024);
  assert.ok(big.chunkSize * (big.total - 1) < 150 * 1024 * 1024);
  assert.ok(big.chunkSize * big.total >= 150 * 1024 * 1024);
});

test('the PKCE challenge is a 64-character hex SHA-256', () => {
  const c = codeChallenge('test-verifier');
  assert.match(c, /^[a-f0-9]{64}$/);
  assert.notEqual(c, codeChallenge('test-verifier-2'));
});
