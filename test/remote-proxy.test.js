import test from 'node:test';
import assert from 'node:assert/strict';
import * as proxy from '../server/lib/remote/proxy.js';

test('canonicalizes a raw backslash force-stop path before checking policy', () => {
  const pathname = proxy.canonicalPathname?.('/api/sessions/demo\\force-stop?source=test');
  assert.equal(pathname, '/api/sessions/demo/force-stop');
  assert.equal(proxy.isBlocked('POST', pathname), true);
});

test('keeps ordinary paths available and blocks local-only balance', () => {
  assert.equal(proxy.isBlocked('POST', '/api/media/generate'), false);
  assert.equal(proxy.isBlocked('GET', '/api/balance'), true);
});

test('returns null for an invalid absolute URL', () => {
  assert.equal(proxy.canonicalPathname?.('http://['), null);
});
