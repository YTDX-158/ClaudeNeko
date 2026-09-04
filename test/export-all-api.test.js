import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../web/src/api.js';

async function withFetch(response, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('export client surfaces a 413 error instead of downloading it', async () => {
  await assert.rejects(
    () => withFetch({
      ok: false,
      status: 413,
      json: async () => ({ error: '会话超过 200 个，未生成备份' }),
      headers: { get: () => null },
    }, () => api.exportAllSessions?.()),
    /超过 200/,
  );
});

test('export client rejects an archive not explicitly marked complete', async () => {
  await assert.rejects(
    () => withFetch({
      ok: true,
      status: 200,
      json: async () => ({}),
      blob: async () => ({ zip: true }),
      headers: { get: () => null },
    }, () => api.exportAllSessions?.()),
    /完整/,
  );
});

test('export client returns the blob only for a complete archive', async () => {
  const blob = { zip: true };
  const result = await withFetch({
    ok: true,
    status: 200,
    blob: async () => blob,
    headers: { get: (name) => name === 'X-ClaudeNeko-Export-Complete' ? 'true' : null },
  }, () => api.exportAllSessions?.());
  assert.equal(result, blob);
});
