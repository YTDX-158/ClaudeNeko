import test from 'node:test';
import assert from 'node:assert/strict';
import * as mediaGen from '../server/lib/mediaGen.js';

test('video task DTO contains only public status fields', () => {
  const task = {
    status: 'done',
    mediaId: 'media-1',
    error: '',
    ts: 123,
    apiKey: 'secret-key',
    baseUrl: 'https://private.example',
    prompt: 'private prompt',
    sid: 'session-1',
    claimedBy: 'instance-1',
    lockHeld: true,
  };
  assert.deepEqual(mediaGen.toPublicTask?.(task), {
    status: 'done',
    mediaId: 'media-1',
    error: '',
    ts: 123,
  });
});

test('video task DTO handles missing and running tasks without leaking internals', () => {
  assert.deepEqual(mediaGen.toPublicTask?.(null), { status: 'not_found' });
  assert.deepEqual(
    mediaGen.toPublicTask?.({ status: 'running', apiKey: 'secret-key', failCount: 2 }),
    { status: 'running' },
  );
});
