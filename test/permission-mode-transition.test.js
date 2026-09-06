import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { permissionHandler } from '../server/routes/permission.js';
import { createPtyHost } from '../server/lib/ptyHost.js';

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

test('a stop timeout rejects the mode change and preserves the previous mode', async () => {
  let mode = 'bypass';
  const permissionConfig = {
    getSecret: () => 'secret',
    getMode: () => mode,
    get: () => ({ mode, allow: [], deny: [] }),
    setMode(nextMode) { mode = nextMode; },
  };
  const service = permissionHandler({
    permissionConfig,
    onModeChange: async () => [true, false],
  });

  const res = responseRecorder();
  await service.router(request({ mode: 'ask' }), res, new URL('http://localhost/api/permission/config'));

  assert.equal(res.status, 503);
  assert.equal(mode, 'bypass');
  assert.match(res.body.error, /未完全退出|切换失败/);
});

test('concurrent mode changes are serialized', async () => {
  let mode = 'bypass';
  const transitions = [];
  let releaseFirst;
  const firstStop = new Promise((resolve) => { releaseFirst = resolve; });
  const permissionConfig = {
    getSecret: () => 'secret',
    getMode: () => mode,
    get: () => ({ mode, allow: [], deny: [] }),
    setMode(nextMode) { transitions.push(`set:${nextMode}`); mode = nextMode; },
  };
  let stopCalls = 0;
  const service = permissionHandler({
    permissionConfig,
    async onModeChange({ previousMode, mode: nextMode }) {
      transitions.push(`stop:${previousMode}->${nextMode}`);
      stopCalls += 1;
      if (stopCalls === 1) await firstStop;
      return [];
    },
  });

  const firstRes = responseRecorder();
  const secondRes = responseRecorder();
  const first = service.router(request({ mode: 'ask' }), firstRes, new URL('http://localhost/api/permission/config'));
  const second = service.router(request({ mode: 'smart' }), secondRes, new URL('http://localhost/api/permission/config'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(transitions, ['stop:bypass->ask']);
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(transitions, [
    'stop:bypass->ask', 'set:ask',
    'stop:ask->smart', 'set:smart',
  ]);
  assert.equal(firstRes.status, 200);
  assert.equal(secondRes.status, 200);
  assert.equal(mode, 'smart');
});

test('mode change blocks PTY launches across every session until the new mode is committed', async () => {
  const children = [];
  const host = createPtyHost({
    claudeBin: '',
    ptyImpl: {
      spawn(_file, args) {
        const child = {
          pid: 500 + children.length,
          args,
          onData(handler) { this.dataHandler = handler; },
          onExit(handler) { this.exitHandler = handler; },
          write() {},
          resize() {},
          emitExit(exitCode = 0) { this.exitHandler?.({ exitCode }); },
        };
        children.push(child);
        return child;
      },
    },
    taskkillImpl() {},
  });
  let mode = 'bypass';
  const permissionConfig = {
    getSecret: () => 'secret',
    getMode: () => mode,
    get: () => ({ mode, allow: [], deny: [] }),
    setMode(nextMode) { mode = nextMode; },
  };
  const service = permissionHandler({
    permissionConfig,
    onModeChangeStart: () => host.blockLaunches(),
    onModeChange: () => host.killAllAndWait(),
  });

  host.ensure('old-sid', { cwd: process.cwd(), permissionMode: mode });
  const res = responseRecorder();
  const switching = service.router(request({ mode: 'ask' }), res, new URL('http://localhost/api/permission/config'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(host.ensure('new-sid', { cwd: process.cwd(), permissionMode: mode }), {
    isNew: false,
    available: false,
    launchBlocked: true,
  });
  assert.equal(children.length, 1);
  children[0].emitExit(0);
  await switching;

  assert.equal(res.status, 200);
  assert.equal(mode, 'ask');
  assert.equal(host.ensure('new-sid', { cwd: process.cwd(), permissionMode: mode }).isNew, true);
  assert.equal(children.length, 2);
  children[1].emitExit(0);
});
