import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
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

test('message handling stops without side effects when the session is deleted during an await', async () => {
  const staleSession = { id: 'deleted-mid-request', cwd: process.cwd(), title: 'session' };
  let getCalls = 0;
  let appendCalls = 0;
  let ensureCalls = 0;
  let releaseCalls = 0;
  const store = {
    get() { getCalls += 1; return getCalls === 1 ? staleSession : null; },
    readMessages: () => [],
    appendMessage() { appendCalls += 1; },
    update() {},
  };
  const handler = sessionsHandler({
    store,
    config: { defaultCwd: process.cwd(), defaultModel: 'test-model' },
    busyLock: {
      acquire: () => true,
      release() { releaseCalls += 1; },
    },
    ptyHost: {
      available: true,
      ensure() { ensureCalls += 1; return { available: true, isNew: true }; },
      submit: () => true,
    },
    transcript: { ensure() {} },
  });
  const req = Readable.from([Buffer.from(JSON.stringify({ prompt: 'hello' }))]);
  req.method = 'POST';
  req.url = '/api/sessions/deleted-mid-request/messages';
  req.headers = {};
  const res = responseRecorder();

  await handler(req, res, new URL('http://localhost/api/sessions/deleted-mid-request/messages'));

  assert.equal(res.status, 404);
  assert.equal(releaseCalls, 1);
  assert.equal(appendCalls, 0);
  assert.equal(ensureCalls, 0);
});

test('branch context is pending before submit and rolls back when submit fails', async () => {
  const session = {
    id: 'branch-submit-failure',
    cwd: process.cwd(),
    title: 'branch',
    parentId: 'parent-1',
    claudeSessionId: 'reserved-id',
    branchContextInjected: false,
    branchContextPending: false,
  };
  const messages = [{ role: 'user', text: 'earlier context' }];
  let pendingAtSubmit;
  const store = {
    get: () => session,
    readMessages: () => messages,
    appendMessage(_id, message) { messages.push(message); },
    update(_id, patch) { Object.assign(session, patch); return session; },
  };
  const handler = sessionsHandler({
    store,
    config: { defaultCwd: process.cwd(), defaultModel: 'test-model' },
    busyLock: { acquire: () => true, release() {} },
    ptyHost: {
      available: true,
      ensure: () => ({ available: true, isNew: true }),
      submit() {
        pendingAtSubmit = session.branchContextPending;
        return false;
      },
    },
    transcript: { ensure() {} },
  });
  const req = Readable.from([Buffer.from(JSON.stringify({ prompt: 'continue' }))]);
  req.method = 'POST';
  req.url = '/api/sessions/branch-submit-failure/messages';
  req.headers = {};
  const res = responseRecorder();

  await handler(req, res, new URL('http://localhost/api/sessions/branch-submit-failure/messages'));

  assert.equal(res.status, 500);
  assert.equal(pendingAtSubmit, true);
  assert.equal(session.branchContextPending, false);
});
