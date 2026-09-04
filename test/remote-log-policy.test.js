import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isBlocked, startRemoteProxy } from '../server/lib/remote/proxy.js';

test('remote policy blocks both local log endpoints', () => {
  assert.equal(isBlocked('GET', '/api/log'), true);
  assert.equal(isBlocked('GET', '/api/log/download'), true);
});

test('remote policy keeps ordinary read-only endpoints available', () => {
  assert.equal(isBlocked('GET', '/api/health'), false);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      headers: { Cookie: 'neko_auth=test-session' },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('remote proxy blocks dot-segment variants before forwarding', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  const targetPort = await listen(upstream);
  const proxy = await startRemoteProxy({
    port: 0,
    targetPort,
    pairing: {
      hasSession: () => true,
      readPairCode: () => null,
      addSession: () => {},
    },
  });
  const proxyPort = proxy.server.address().port;

  try {
    assert.equal(await request(proxyPort, '/api/x/../log'), 403);
    assert.equal(await request(proxyPort, '/api/x/%2e%2e/log/download'), 403);
  } finally {
    proxy.disconnectAll();
    await close(proxy.server);
    await close(upstream);
  }
});
