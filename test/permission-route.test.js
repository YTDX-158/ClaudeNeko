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
    { t: 'perm', p: { id: res.body.id, tool_name: 'Write', hasInput: true } },
  ]]);
  assert.deepEqual(pendingChanges, [['neko-sid', true]]);
});
