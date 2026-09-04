import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlocked } from '../server/lib/remote/proxy.js';

test('remote policy blocks both local log endpoints', () => {
  assert.equal(isBlocked('GET', '/api/log'), true);
  assert.equal(isBlocked('GET', '/api/log/download'), true);
});

test('remote policy keeps ordinary read-only endpoints available', () => {
  assert.equal(isBlocked('GET', '/api/health'), false);
});
