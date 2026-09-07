import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { permissionHandler } from '../server/routes/permission.js';

function request(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = '/api/permission/request';
  req.headers = {};
  return req;
}

function responseRecorder() {
  return {
    status: null,
    body: null,
    on() {},
    writeHead(status) { this.status = status; },
    end(raw) { this.body = raw ? JSON.parse(raw) : null; },
  };
}

async function route(service, { method = 'POST', path = '/api/permission/request', body, secret } = {}) {
  const req = body === undefined ? Readable.from([]) : request(body);
  req.method = method;
  req.url = path;
  req.headers = secret ? { 'x-neko-secret': secret } : {};
  const res = responseRecorder();
  await service.router(req, res, new URL(`http://localhost${path}`));
  return res;
}

function mappedService(overrides = {}) {
  const claudeSessionId = '87654321-4321-4321-8321-cba987654321';
  const broadcasts = [];
  const pendingChanges = [];
  const rules = [];
  const permissionConfig = {
    getMode: () => 'ask',
    getSecret: () => 'secret',
    getRules: () => ({ allow: [], deny: [] }),
    addAllow(rule) { rules.push(rule); },
    ...overrides.permissionConfig,
  };
  const service = permissionHandler({
    store: { list: () => [{ id: 'neko-sid', claudeSessionId }] },
    terminal: { broadcast(sid, message) { broadcasts.push([sid, message]); } },
    permissionConfig,
    isLocalRequest: () => true,
    onPendingChange(sid, pending) { pendingChanges.push([sid, pending]); },
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
    permissionConfig,
  });
  return { service, claudeSessionId, broadcasts, pendingChanges, rules };
}

test('an unmapped hook request logs only a short Claude session prefix', async () => {
  const claudeSessionId = '12345678-1234-4234-8234-123456789abc';
  const privateMarker = 'PRIVATE_TOOL_INPUT_MUST_NOT_BE_LOGGED';
  const warnings = [];
  const service = permissionHandler({
    store: { list: () => [] },
    permissionConfig: { getMode: () => 'ask' },
    logger: { warn(...args) { warnings.push(args.join(' ')); } },
  });
  const res = responseRecorder();

  await service.router(request({
    session_id: claudeSessionId,
    tool_name: 'Write',
    tool_input: { file_path: `C:\\private\\${privateMarker}.txt` },
    cwd: `C:\\private\\${privateMarker}`,
  }), res, new URL('http://localhost/api/permission/request'));

  assert.equal(res.status, 404);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /claudeSession=12345678/);
  assert.equal(warnings[0].includes(claudeSessionId), false);
  assert.equal(warnings[0].includes(privateMarker), false);
  assert.equal(warnings[0].includes('Write'), false);
});

test('an invalid unmapped session id cannot inject control characters into logs', async () => {
  const warnings = [];
  const service = permissionHandler({
    store: { list: () => [] },
    permissionConfig: { getMode: () => 'ask' },
    logger: { warn(...args) { warnings.push(args.join(' ')); } },
  });
  const res = responseRecorder();

  await service.router(request({
    session_id: '1234\r\nFORGED\x1b[31m',
    tool_name: 'Write',
  }), res, new URL('http://localhost/api/permission/request'));

  assert.equal(res.status, 404);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /claudeSession=invalid/);
  assert.equal(warnings[0].includes('FORGED'), false);
  assert.equal(warnings[0].includes('\r'), false);
  assert.equal(warnings[0].includes('\n'), false);
  assert.equal(warnings[0].includes('\x1b'), false);
});

test('a non-RFC UUID shape is logged as invalid', async () => {
  const warnings = [];
  const service = permissionHandler({
    store: { list: () => [] },
    permissionConfig: { getMode: () => 'ask' },
    logger: { warn(...args) { warnings.push(args.join(' ')); } },
  });
  const res = responseRecorder();

  await service.router(request({
    session_id: 'aaaaaaaa-aaaa-0aaa-0aaa-aaaaaaaaaaaa',
  }), res, new URL('http://localhost/api/permission/request'));

  assert.equal(res.status, 404);
  assert.match(warnings[0], /claudeSession=invalid/);
  assert.equal(warnings[0].includes('aaaaaaaa'), false);
});

test('a mapped hook request returns an id, broadcasts a card, and marks the session pending', async () => {
  const claudeSessionId = '87654321-4321-4321-8321-cba987654321';
  const broadcasts = [];
  const pendingChanges = [];
  const service = permissionHandler({
    store: { list: () => [{ id: 'neko-sid', claudeSessionId }] },
    terminal: { broadcast(sid, message) { broadcasts.push([sid, message]); } },
    permissionConfig: { getMode: () => 'ask' },
    onPendingChange(sid, pending) { pendingChanges.push([sid, pending]); },
    logger: { info() {} },
  });
  const res = responseRecorder();

  await service.router(request({
    session_id: claudeSessionId,
    tool_name: 'Write',
    tool_input: { file_path: 'C:\\safe\\note.txt' },
  }), res, new URL('http://localhost/api/permission/request'));

  assert.equal(res.status, 200);
  assert.match(res.body.id, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(broadcasts, [[
    'neko-sid',
    { t: 'perm', p: {
      id: res.body.id,
      tool_name: 'Write',
      summary: 'C:\\safe\\note.txt',
      dangerous: false,
      alwaysScope: 'Write(C:\\safe\\note.txt)',
    } },
  ]]);
  assert.deepEqual(pendingChanges, [['neko-sid', true]]);
});

test('cards and pending replay expose only a bounded control-free server summary', async () => {
  const { service, claudeSessionId, broadcasts } = mappedService();
  const marker = `SECRET\r\n\x1b[31m${'x'.repeat(250)}`;
  const created = await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Bash',
    tool_input: { command: marker, password: 'must-not-be-returned' },
  } });

  const card = broadcasts[0][1].p;
  assert.deepEqual(Object.keys(card).sort(), ['alwaysScope', 'dangerous', 'id', 'summary', 'tool_name']);
  assert.equal(Object.hasOwn(card, 'tool_input'), false);
  assert.equal(card.summary.length <= 200, true);
  assert.doesNotMatch(card.summary, /[\u0000-\u001f\u007f-\u009f]/);
  assert.equal(card.alwaysScope.length <= 200, true);
  assert.doesNotMatch(card.alwaysScope, /[\u0000-\u001f\u007f-\u009f]/);
  assert.equal(card.summary.includes('must-not-be-returned'), false);

  const replay = await route(service, {
    method: 'GET',
    path: '/api/permission/pending?sid=neko-sid',
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.pending.length, 1);
  assert.equal(Object.hasOwn(replay.body.pending[0], 'tool_input'), false);
  assert.deepEqual(replay.body.pending[0], card);
  assert.equal(card.id, created.body.id);
});

test('dangerous is derived by the server from the full Bash command', async () => {
  const { service, claudeSessionId, broadcasts } = mappedService();
  await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf C:\\important' },
  } });

  assert.equal(broadcasts[0][1].p.dangerous, true);
});

test('respond rejects unknown actions without deciding or closing the request', async () => {
  const { service, claudeSessionId, broadcasts } = mappedService();
  const created = await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Write',
    tool_input: { file_path: 'C:\\safe\\note.txt' },
  } });

  const responded = await route(service, {
    path: '/api/permission/respond',
    body: { id: created.body.id, action: 'sometimes' },
    secret: 'secret',
  });
  const waited = await route(service, {
    method: 'GET', path: `/api/permission/wait?id=${created.body.id}`,
  });

  assert.equal(responded.status, 400);
  assert.match(responded.body.error, /action/i);
  assert.deepEqual(waited.body, { status: 'pending' });
  assert.equal(broadcasts.some(([, message]) => message.t === 'perm-closed'), false);
});

test('respond validates action even when the request already has a decision', async () => {
  const { service, claudeSessionId } = mappedService();
  const created = await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Write',
    tool_input: { file_path: 'C:\\safe\\note.txt' },
  } });
  await route(service, {
    path: '/api/permission/respond',
    body: { id: created.body.id, action: 'once' },
    secret: 'secret',
  });

  const repeated = await route(service, {
    path: '/api/permission/respond',
    body: { id: created.body.id, action: 'invalid' },
    secret: 'secret',
  });

  assert.equal(repeated.status, 400);
  assert.match(repeated.body.error, /action/i);
});

test('always persistence failure is non-2xx and leaves the card pending', async () => {
  const { service, claudeSessionId, broadcasts } = mappedService({
    permissionConfig: { addAllow() { throw new Error('disk full'); } },
  });
  const created = await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  } });

  const responded = await route(service, {
    path: '/api/permission/respond',
    body: { id: created.body.id, action: 'always' },
    secret: 'secret',
  });
  const waited = await route(service, {
    method: 'GET', path: `/api/permission/wait?id=${created.body.id}`,
  });

  assert.equal(responded.status >= 400, true);
  assert.match(responded.body.error, /保存|persist|规则/i);
  assert.deepEqual(waited.body, { status: 'pending' });
  assert.equal(broadcasts.some(([, message]) => message.t === 'perm-closed'), false);
});

test('always also fails closed when the persistence method is unavailable', async () => {
  const { service, claudeSessionId, broadcasts } = mappedService({
    permissionConfig: { addAllow: undefined },
  });
  const created = await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  } });

  const responded = await route(service, {
    path: '/api/permission/respond',
    body: { id: created.body.id, action: 'always' },
    secret: 'secret',
  });

  assert.equal(responded.status, 503);
  assert.equal(broadcasts.some(([, message]) => message.t === 'perm-closed'), false);
});

test('always creates exact rules from the server-held Bash command and file path', async () => {
  const { service, claudeSessionId, rules } = mappedService();
  for (const [tool_name, tool_input] of [
    ['Bash', { command: 'npm test -- --grep exact' }],
    ['Write', { file_path: 'C:\\safe folder\\exact.txt' }],
    ['Edit', { file_path: 'C:\\safe folder\\exact.txt' }],
    ['MultiEdit', { file_path: 'C:\\safe folder\\exact.txt' }],
  ]) {
    const created = await route(service, { body: { session_id: claudeSessionId, tool_name, tool_input } });
    const responded = await route(service, {
      path: '/api/permission/respond',
      body: { id: created.body.id, action: 'always', rule: `${tool_name}(attacker*)` },
      secret: 'secret',
    });
    assert.equal(responded.status, 200);
  }

  assert.deepEqual(rules, [
    'Bash(npm test -- --grep exact)',
    'Write(C:\\safe folder\\exact.txt)',
    'Edit(C:\\safe folder\\exact.txt)',
    'MultiEdit(C:\\safe folder\\exact.txt)',
  ]);
});

test('exact rules preserve meaningful spaces in commands and file paths', async () => {
  const { service, claudeSessionId, rules } = mappedService();
  for (const [tool_name, tool_input] of [
    ['Bash', { command: 'node  script.js' }],
    ['Write', { file_path: 'C:\\safe  folder\\exact.txt' }],
  ]) {
    const created = await route(service, { body: { session_id: claudeSessionId, tool_name, tool_input } });
    await route(service, {
      path: '/api/permission/respond',
      body: { id: created.body.id, action: 'always' },
      secret: 'secret',
    });
  }

  assert.deepEqual(rules, [
    'Bash(node  script.js)',
    'Write(C:\\safe  folder\\exact.txt)',
  ]);
});

test('smart rules match only the complete Bash command', async () => {
  const exactRule = 'Bash(npm test -- --grep exact)';
  const { service, claudeSessionId, broadcasts } = mappedService({
    permissionConfig: {
      getMode: () => 'smart',
      getRules: () => ({ allow: [exactRule], deny: [] }),
    },
  });

  const exact = await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Bash',
    tool_input: { command: 'npm test -- --grep exact' },
  } });
  const exactWait = await route(service, {
    method: 'GET', path: `/api/permission/wait?id=${exact.body.id}`,
  });
  const replayedWait = await route(service, {
    method: 'GET', path: `/api/permission/wait?id=${exact.body.id}`,
  });
  await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Bash',
    tool_input: { command: 'npm test -- --grep different' },
  } });

  assert.deepEqual(exactWait.body, { status: 'decided', decision: { behavior: 'allow' } });
  assert.equal(replayedWait.status, 404);
  assert.equal(broadcasts.filter(([, message]) => message.t === 'perm').length, 1);
});

test('smart write rules match only the complete file path and never legacy prefixes', async () => {
  const { service, claudeSessionId, broadcasts } = mappedService({
    permissionConfig: {
      getMode: () => 'smart',
      getRules: () => ({
        allow: ['Write(C:\\safe\\exact.txt)', 'Write(C:\\legacy\\*)'],
        deny: [],
      }),
    },
  });
  const exact = await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Write',
    tool_input: { file_path: 'C:\\safe\\exact.txt' },
  } });
  const exactWait = await route(service, {
    method: 'GET', path: `/api/permission/wait?id=${exact.body.id}`,
  });
  await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Write',
    tool_input: { file_path: 'C:\\safe\\exact.txt.bak' },
  } });
  await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Write',
    tool_input: { file_path: 'C:\\legacy\\child.txt' },
  } });

  assert.deepEqual(exactWait.body, { status: 'decided', decision: { behavior: 'allow' } });
  assert.equal(broadcasts.filter(([, message]) => message.t === 'perm').length, 2);
});

test('each permission request expires after 15 minutes and closes its card', async () => {
  const scheduled = [];
  const cleared = [];
  const { service, claudeSessionId, broadcasts, pendingChanges } = mappedService({
    now: () => 1234,
    setTimeoutFn(fn, delay) {
      const token = { fn, delay };
      scheduled.push(token);
      return token;
    },
    clearTimeoutFn(token) { cleared.push(token); },
  });
  const created = await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Write',
    tool_input: { file_path: 'C:\\expires.txt' },
  } });

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 15 * 60 * 1000);
  scheduled[0].fn();

  const waited = await route(service, {
    method: 'GET', path: `/api/permission/wait?id=${created.body.id}`,
  });
  assert.equal(waited.status, 404);
  assert.deepEqual(broadcasts.at(-1), [
    'neko-sid', { t: 'perm-closed', p: { id: created.body.id } },
  ]);
  assert.deepEqual(pendingChanges.at(-1), ['neko-sid', false]);
  assert.deepEqual(cleared, [scheduled[0]]);
});

test('the first decided wait deletes the record and clears its TTL timer', async () => {
  const scheduled = [];
  const cleared = [];
  const { service, claudeSessionId } = mappedService({
    permissionConfig: {
      getMode: () => 'smart',
      getRules: () => ({ allow: ['Bash(npm test)'], deny: [] }),
    },
    setTimeoutFn(fn, delay) {
      const token = { fn, delay };
      scheduled.push(token);
      return token;
    },
    clearTimeoutFn(token) { cleared.push(token); },
  });
  const created = await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  } });

  const first = await route(service, {
    method: 'GET', path: `/api/permission/wait?id=${created.body.id}`,
  });
  const second = await route(service, {
    method: 'GET', path: `/api/permission/wait?id=${created.body.id}`,
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 404);
  assert.deepEqual(cleared, [scheduled[0]]);
});

test('cancelBySid deletes undecided and decided records, closes every card, and notifies false', async () => {
  const scheduled = [];
  const cleared = [];
  const { service, claudeSessionId, broadcasts, pendingChanges } = mappedService({
    setTimeoutFn(fn, delay) {
      const token = { fn, delay };
      scheduled.push(token);
      return token;
    },
    clearTimeoutFn(token) { cleared.push(token); },
  });
  const first = await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Write',
    tool_input: { file_path: 'C:\\first.txt' },
  } });
  const second = await route(service, { body: {
    session_id: claudeSessionId,
    tool_name: 'Edit',
    tool_input: { file_path: 'C:\\second.txt' },
  } });
  await route(service, {
    path: '/api/permission/respond',
    body: { id: first.body.id, action: 'once' },
    secret: 'secret',
  });

  service.cancelBySid('neko-sid');

  const firstWait = await route(service, { method: 'GET', path: `/api/permission/wait?id=${first.body.id}` });
  const secondWait = await route(service, { method: 'GET', path: `/api/permission/wait?id=${second.body.id}` });
  assert.equal(firstWait.status, 404);
  assert.equal(secondWait.status, 404);
  assert.deepEqual(
    broadcasts.filter(([, message]) => message.t === 'perm-closed').slice(-2).map(([, message]) => message.p.id),
    [first.body.id, second.body.id],
  );
  assert.deepEqual(cleared, scheduled);
  assert.deepEqual(pendingChanges.at(-1), ['neko-sid', false]);
});
