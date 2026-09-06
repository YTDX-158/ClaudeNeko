import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import * as proxy from '../server/lib/remote/proxy.js';
import { createRemote } from '../server/lib/remote/index.js';
import { remoteHandler } from '../server/routes/remote.js';
import { createTerminalChannel } from '../server/routes/terminal.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.destroyCalls = 0;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyCalls += 1;
    this.emit('close');
  }
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

function connect(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

test('socket registry destroys tracked sockets once and forgets closed sockets', () => {
  const registry = proxy.createSocketRegistry?.();
  assert.ok(registry);
  const first = new FakeSocket();
  const second = new FakeSocket();
  registry.track(first);
  registry.track(second);
  first.destroy();

  registry.disconnectAll();
  registry.disconnectAll();

  assert.equal(first.destroyCalls, 1);
  assert.equal(second.destroyCalls, 1);
  assert.equal(registry.size(), 0);
});

test('terminal revocation closes remote WebSockets but preserves local WebSockets', async () => {
  const session = { id: 'session-1', cwd: process.cwd() };
  const channel = createTerminalChannel({
    ptyHost: {
      ensure: () => ({ isNew: false }),
      isRunning: () => true,
      submit() {}, write() {}, resize() {}, touch() {}, kill() {},
    },
    transcript: { ensure() {} },
    store: {
      get: () => session,
      update: (_id, patch) => Object.assign(session, patch),
    },
    config: { defaultCwd: process.cwd() },
    isLocalRequest: () => true,
  });
  const server = http.createServer();
  server.on('upgrade', channel.upgradeHandler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let remoteWs;
  let localWs;
  try {
    remoteWs = await connect(`ws://127.0.0.1:${port}/ws?sid=session-1`, { 'x-claudeneko-remote': '1' });
    localWs = await connect(`ws://127.0.0.1:${port}/ws?sid=session-1`);

    channel.disconnectRemoteClients?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(remoteWs.readyState, WebSocket.CLOSED);
    assert.equal(localWs.readyState, WebSocket.OPEN);
  } finally {
    remoteWs?.terminate();
    localWs?.terminate();
    server.close();
  }
});

test('regenerating a pair code clears sessions and disconnects existing clients', async () => {
  const events = [];
  const handler = remoteHandler({
    pairing: {
      generatePairCode() { events.push('generate'); return '12345678'; },
      clearSessions() { events.push('clear-sessions'); },
    },
    remote: {
      disconnectAll() { events.push('disconnect'); },
    },
  });
  const res = responseRecorder();

  await handler(
    { method: 'POST' },
    res,
    new URL('http://localhost/api/remote/regenerate-code'),
  );

  assert.equal(res.status, 200);
  assert.deepEqual(events, ['generate', 'clear-sessions', 'disconnect']);
});

test('stopping remote access disconnects proxy and business WebSockets before closing', async () => {
  const events = [];
  const remote = createRemote({
    pairing: {},
    config: { port: 4000 },
    startRemoteProxy: async () => ({
      server: { close() { events.push('close-proxy'); } },
      disconnectAll() { events.push('disconnect-proxy'); },
    }),
    startTunnel: async () => ({ child: null, url: 'https://example.test' }),
    disconnectBusinessSockets() { events.push('disconnect-business'); },
  });

  await remote.start();
  remote.stop();

  assert.deepEqual(events, ['disconnect-proxy', 'disconnect-business', 'close-proxy']);
  assert.equal(remote.isEnabled(), false);
});
