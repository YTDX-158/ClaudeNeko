import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { canonicalPathname, isBlocked, startRemoteProxy } from '../server/lib/remote/proxy.js';

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

function request(port, method, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: { Cookie: 'neko_auth=test-session', ...extraHeaders },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('remote policy always blocks permission config but preserves paired approval', () => {
  assert.equal(isBlocked('GET', '/api/permission/config'), true);
  assert.equal(isBlocked('PUT', '/api/permission/config'), true);
  assert.equal(isBlocked('POST', '/api/permission/config'), true);

  assert.equal(isBlocked('GET', '/api/permission/secret'), false);
  assert.equal(isBlocked('POST', '/api/permission/respond'), false);
  assert.equal(isBlocked('GET', '/api/permission/pending'), false);
  assert.equal(isBlocked('POST', '/api/permission/request'), true);
  assert.equal(isBlocked('GET', '/api/permission/wait'), true);
});

test('remote proxy blocks canonical, dot-segment, and backslash permission config paths', async () => {
  let forwarded = 0;
  const forwardedRemoteMarkers = [];
  const upstream = http.createServer((req, res) => {
    forwarded += 1;
    forwardedRemoteMarkers.push(req.headers['x-claudeneko-remote']);
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
    const cases = [
      ['GET', '/api/permission/config?view=rules', '/api/permission/config'],
      ['PUT', '/api/permission/settings/../config', '/api/permission/config'],
      ['GET', '/api/permission/settings/%2e%2e/config', '/api/permission/config'],
      ['GET', '/api/permission/settings\\..\\config', '/api/permission/config'],
      ['POST', '/api/permission/request', '/api/permission/request'],
      ['GET', '/api/permission/wait?id=forged', '/api/permission/wait'],
    ];
    for (const [method, path, canonical] of cases) {
      assert.equal(canonicalPathname(path), canonical);
      assert.equal(await request(proxyPort, method, path), 403);
    }
    assert.equal(forwarded, 0);

    assert.equal(await request(proxyPort, 'GET', '/api/permission/secret', { 'X-ClaudeNeko-Remote': '0' }), 204);
    assert.equal(await request(proxyPort, 'POST', '/api/permission/respond'), 204);
    assert.equal(forwarded, 2);
    assert.deepEqual(forwardedRemoteMarkers, ['1', '1']);
  } finally {
    proxy.disconnectAll();
    await close(proxy.server);
    await close(upstream);
  }
});
