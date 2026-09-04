import test from 'node:test';
import assert from 'node:assert/strict';
import * as proxy from '../server/lib/remote/proxy.js';

function responseRecorder() {
  return {
    status: null,
    body: null,
    headers: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(raw) { this.body = raw ? JSON.parse(raw) : null; },
  };
}

test('pair POST requires JSON from the exact request origin', () => {
  assert.equal(proxy.isPairRequestAllowed?.({
    headers: {
      host: 'demo.example:8443',
      origin: 'https://demo.example:8443',
      'content-type': 'application/json; charset=utf-8',
    },
  }), true);
  for (const headers of [
    { host: 'demo.example', origin: 'https://evil.example', 'content-type': 'application/json' },
    { host: 'demo.example', origin: 'https://demo.example.evil', 'content-type': 'application/json' },
    { host: 'demo.example', origin: 'https://demo.example', 'content-type': 'text/plain' },
    { host: 'demo.example', 'content-type': 'application/json' },
  ]) {
    assert.equal(proxy.isPairRequestAllowed?.({ headers }), false, JSON.stringify(headers));
  }
});

test('pair nonces are source-bound, expiring, and one-time', () => {
  let now = 1000;
  let sequence = 0;
  const store = proxy.createPairNonceStore?.({
    ttlMs: 100,
    now: () => now,
    generate: () => `nonce-${sequence += 1}`,
  });
  assert.ok(store);
  const first = store.issue('source-a');
  assert.equal(store.consume(first, 'source-b'), false);
  assert.equal(store.consume(first, 'source-a'), true);
  assert.equal(store.consume(first, 'source-a'), false);
  const expired = store.issue('source-a');
  now += 101;
  assert.equal(store.consume(expired, 'source-a'), false);
});

test('five failures lock one source while the global limit is independent', () => {
  const limiter = proxy.createPairRateLimiter?.({
    sourceLimit: 5,
    globalLimit: 50,
    windowMs: 60_000,
  });
  assert.ok(limiter);
  for (let i = 0; i < 5; i += 1) limiter.recordFailure('source-a', 1000 + i);
  assert.equal(limiter.check('source-a', 2000).sourceLocked, true);
  assert.equal(limiter.check('source-b', 2000).locked, false);
  for (let i = 0; i < 45; i += 1) limiter.recordFailure(`source-${i + 10}`, 2000 + i);
  assert.equal(limiter.check('fresh-source', 3000).globalLocked, true);
  assert.equal(limiter.check('fresh-source', 61_100).locked, false);
});

test('a locked source is rejected before its request body is read', async () => {
  let reads = 0;
  const handler = proxy.createPairHandler?.({
    pairing: {},
    readRequestBody: async () => { reads += 1; throw new Error('must not read'); },
    nonceStore: { consume: () => true, issue: () => 'next' },
    rateLimiter: { check: () => ({ locked: true, sourceLocked: true }), recordFailure() {} },
    now: () => 1000,
  });
  assert.ok(handler);
  const res = responseRecorder();

  await handler({ headers: {}, socket: { remoteAddress: 'source-a' } }, res);

  assert.equal(res.status, 429);
  assert.equal(reads, 0);
});

test('cross-site and oversized requests do not count as code guesses', async () => {
  let failures = 0;
  let reads = 0;
  const limiter = {
    check: () => ({ locked: false, sourceLocked: false, globalLocked: false }),
    recordFailure: () => { failures += 1; return { locked: false }; },
    resetSource() {},
  };
  const nonceStore = { consume: () => true, issue: () => 'next-nonce' };
  const handler = proxy.createPairHandler?.({
    pairing: { readPairCode: () => '12345678' },
    readRequestBody: async () => { reads += 1; return { __tooLarge: true }; },
    nonceStore,
    rateLimiter: limiter,
    now: () => 1000,
  });
  assert.ok(handler);

  const crossSite = responseRecorder();
  await handler({
    headers: { host: 'demo.example', origin: 'https://evil.example', 'content-type': 'text/plain' },
    socket: { remoteAddress: 'source-a' },
  }, crossSite);
  assert.equal(crossSite.status, 403);
  assert.equal(reads, 0);

  const oversized = responseRecorder();
  await handler({
    headers: {
      host: 'demo.example',
      origin: 'https://demo.example',
      'content-type': 'application/json',
      'x-neko-pair-nonce': 'valid',
    },
    socket: { remoteAddress: 'source-a' },
  }, oversized);
  assert.equal(oversized.status, 413);
  assert.equal(reads, 1);
  assert.equal(failures, 0);
});
