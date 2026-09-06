import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionsHandler } from '../server/routes/sessions.js';
import { SessionStore } from '../server/lib/sessionStore.js';

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
  let removedMessageId = null;
  const store = {
    get: () => session,
    readMessages: () => messages,
    appendMessage(_id, message) { messages.push(message); },
    removeMessage(_id, messageId) {
      removedMessageId = messageId;
      const index = messages.findIndex((message) => message.id === messageId);
      if (index >= 0) messages.splice(index, 1);
    },
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
  assert.ok(removedMessageId);
  assert.deepEqual(messages, [{ role: 'user', text: 'earlier context' }]);
});

test('message rollback removes only the exact failed message', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-message-rollback-'));
  try {
    const store = new SessionStore(dataDir);
    const session = store.create({ model: 'test', cwd: process.cwd() });
    store.appendMessage(session.id, { id: 'keep-1', role: 'user', text: 'keep' });
    store.appendMessage(session.id, { id: 'failed-1', role: 'user', text: 'failed', pendingJsonl: true });
    store.appendMessage(session.id, { id: 'keep-2', role: 'user', text: 'concurrent' });

    assert.equal(store.removeMessage(session.id, 'failed-1'), true);
    assert.deepEqual(store.readMessages(session.id).map((message) => message.id), ['keep-1', 'keep-2']);
    assert.equal(store.removeMessage(session.id, 'missing'), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an unavailable PTY rejects before persisting a pending user message', async () => {
  const session = { id: 'pty-unavailable', cwd: process.cwd(), title: 'session' };
  let appendCalls = 0;
  const store = {
    get: () => session,
    readMessages: () => [],
    appendMessage() { appendCalls += 1; },
    update() {},
  };
  const handler = sessionsHandler({
    store,
    config: { defaultCwd: process.cwd(), defaultModel: 'test-model' },
    busyLock: { acquire: () => true, release() {} },
    ptyHost: { available: false },
  });
  const req = Readable.from([Buffer.from(JSON.stringify({ prompt: 'hello' }))]);
  req.method = 'POST';
  req.url = '/api/sessions/pty-unavailable/messages';
  req.headers = {};
  const res = responseRecorder();

  await handler(req, res, new URL('http://localhost/api/sessions/pty-unavailable/messages'));

  assert.equal(res.status, 500);
  assert.equal(appendCalls, 0);
});
