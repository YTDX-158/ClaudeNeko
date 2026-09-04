import test from 'node:test';
import assert from 'node:assert/strict';
import * as exportRoute from '../server/routes/export.js';

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: null,
    on() {},
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

test('export preparation rejects the whole archive above the session limit', () => {
  assert.throws(
    () => exportRoute.prepareSessionExport?.(
      [{ id: '1' }, { id: '2' }],
      () => [],
      { maxSessions: 1, maxBytes: 1000 },
    ),
    (error) => error?.status === 413 && error?.code === 'EXPORT_SESSION_LIMIT',
  );
});

test('export preparation rejects the whole archive above the byte limit', () => {
  assert.throws(
    () => exportRoute.prepareSessionExport?.(
      [{ id: '1', title: 'large' }],
      () => [{ text: 'this message is deliberately over the tiny limit' }],
      { maxSessions: 2, maxBytes: 10 },
    ),
    (error) => error?.status === 413 && error?.code === 'EXPORT_SIZE_LIMIT',
  );
});

test('export size errors include the configured MiB unit', () => {
  assert.throws(
    () => exportRoute.prepareSessionExport?.(
      [{ id: '1', title: 'large' }],
      () => [{ text: 'x'.repeat(1024 * 1024) }],
      { maxSessions: 2, maxBytes: 1024 * 1024 },
    ),
    (error) => error?.code === 'EXPORT_SIZE_LIMIT' && /1MB/.test(error.message),
  );
});

test('normal export preparation contains every session', () => {
  const result = exportRoute.prepareSessionExport?.(
    [{ id: '1', title: 'same' }, { id: '2', title: 'same' }],
    (id) => [{ text: id }],
    { maxSessions: 2, maxBytes: 10_000 },
  );
  assert.equal(result.files.length, 2);
  assert.deepEqual(result.files.map((file) => file.name), ['same.json', 'same(1).json']);
});

test('export-all route returns 413 instead of a partial ZIP above 200 sessions', async () => {
  const sessions = Array.from({ length: 201 }, (_, index) => ({ id: String(index), title: `s${index}` }));
  let reads = 0;
  const handler = exportRoute.exportHandler({
    isLocalRequest: () => true,
    store: {
      list: () => sessions,
      readMessages: () => { reads += 1; return []; },
    },
  });
  const res = responseRecorder();

  await handler(
    { method: 'GET' },
    res,
    new URL('http://localhost/api/sessions/export-all'),
  );

  assert.equal(res.status, 413);
  assert.match(JSON.parse(res.body).error, /200/);
  assert.equal(reads, 0);
});

test('complete export response is explicitly marked complete', async () => {
  const handler = exportRoute.exportHandler({
    isLocalRequest: () => true,
    store: {
      list: () => [{ id: '1', title: 'one' }],
      readMessages: () => [],
    },
  });
  const res = responseRecorder();

  await handler(
    { method: 'GET' },
    res,
    new URL('http://localhost/api/sessions/export-all'),
  );

  assert.equal(res.status, 200);
  assert.equal(res.headers['X-ClaudeNeko-Export-Complete'], 'true');
  assert.ok(Buffer.isBuffer(res.body));
});
