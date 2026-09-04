import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../web/src/api.js';

async function captureRequest(run, responseBody = {}) {
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options = {}) => {
    call = { url, options };
    return { ok: true, json: async () => responseBody };
  };
  try {
    const result = await run();
    return { call, result };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('loads media ledger records', async () => {
  const { call, result } = await captureRequest(
    () => api.mediaLog?.(),
    { enabled: true, records: [{ id: 'r1' }], softMax: 5000 },
  );
  assert.equal(call.url, '/api/media/log');
  assert.equal(call.options.method, undefined);
  assert.equal(result.records[0].id, 'r1');
});

test('clears ledger records without requesting file deletion', async () => {
  const { call } = await captureRequest(() => api.mediaLogDelete?.({ all: true }));
  assert.equal(call.url, '/api/media/log');
  assert.equal(call.options.method, 'DELETE');
  assert.deepEqual(JSON.parse(call.options.body), { all: true });
});

test('updates the ledger enabled flag', async () => {
  const { call } = await captureRequest(() => api.mediaLogEnabled?.(false));
  assert.equal(call.url, '/api/media/log-enabled');
  assert.equal(call.options.method, 'PUT');
  assert.deepEqual(JSON.parse(call.options.body), { enabled: false });
});
