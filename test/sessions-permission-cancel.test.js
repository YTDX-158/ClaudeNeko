import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionsHandler } from '../server/routes/sessions.js';

function responseRecorder() {
  return {
    status: null,
    body: null,
    on() {},
    writeHead(status) { this.status = status; },
    end(raw) { this.body = raw ? JSON.parse(raw) : null; },
  };
}

test('session cancel also cancels all permission requests for that sid', async () => {
  const calls = [];
  const handler = sessionsHandler({
    store: { list: () => [] },
    config: { defaultModel: 'test-model' },
    busyLock: { release(sid) { calls.push(['release', sid]); } },
    ptyHost: {
      isRunning: () => true,
      interrupt(sid) { calls.push(['interrupt', sid]); },
    },
    permissionService: {
      cancelBySid(sid) { calls.push(['permissions', sid]); },
    },
  });
  const req = { method: 'POST' };
  const res = responseRecorder();

  await handler(req, res, new URL('http://localhost/api/sessions/session-1/cancel'));

  assert.equal(res.status, 200);
  assert.deepEqual(calls, [
    ['interrupt', 'session-1'],
    ['permissions', 'session-1'],
    ['release', 'session-1'],
  ]);
});
