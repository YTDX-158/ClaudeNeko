import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { permissionHandler } from '../server/routes/permission.js';

function request(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'PUT';
  req.url = '/api/permission/config';
  req.headers = { 'x-neko-secret': 'secret' };
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

test('permission mode changes stop active PTYs exactly once while same-mode writes do not', async () => {
  let mode = 'bypass';
  let killCalls = 0;
  const permissionConfig = {
    getSecret: () => 'secret',
    getMode: () => mode,
    get: () => ({ mode, allow: [], deny: [] }),
    setMode(nextMode) { mode = nextMode; },
  };
  const service = permissionHandler({
    permissionConfig,
    onModeChange: () => { killCalls += 1; },
  });

  const changed = responseRecorder();
  await service.router(request({ mode: 'ask' }), changed, new URL('http://localhost/api/permission/config'));
  assert.equal(changed.status, 200);
  assert.equal(killCalls, 1);

  const unchanged = responseRecorder();
  await service.router(request({ mode: 'ask' }), unchanged, new URL('http://localhost/api/permission/config'));
  assert.equal(unchanged.status, 200);
  assert.equal(killCalls, 1);
});
