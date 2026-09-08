// N-01 防 DNS rebinding：isAllowedHost 只认 loopback authority（表驱动）
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedHost } from '../server/lib/util.js';

function req(host) {
  return { headers: host == null ? {} : { host } };
}

test('accepts loopback authorities on the configured port', () => {
  for (const host of ['127.0.0.1:4000', 'localhost:4000', '[::1]:4000']) {
    assert.equal(isAllowedHost(req(host), 4000), true, host);
  }
});

test('accepts bare loopback hosts (no port) — HTTP/1.0-style local clients', () => {
  assert.equal(isAllowedHost(req('127.0.0.1'), 4000), true);
  assert.equal(isAllowedHost(req('localhost'), 4000), true);
  assert.equal(isAllowedHost(req('LOCALHOST'), 4000), true);
  assert.equal(isAllowedHost(req('[::1]'), 4000), true);
});

test('accepts loopback host when no port is configured (config port unknown)', () => {
  assert.equal(isAllowedHost(req('127.0.0.1:8080'), undefined), true);
  assert.equal(isAllowedHost(req('localhost:8080'), null), true);
});

test('rejects attacker-controlled / non-loopback authorities', () => {
  for (const host of [
    'evil.com',
    'evil.com:4000',
    '10.0.0.1',
    '10.0.0.1:4000',
    '192.168.1.5:4000',
    '127.0.0.1.evil.com:4000', // 尾缀仿冒（非精确匹配）
    'localhost.evil.com:4000',
    'user@127.0.0.1', // 畸形 Host（userinfo 注入）
    '127.0.0.1:evil', // 端口非数字
    'example.com:80',
  ]) {
    assert.equal(isAllowedHost(req(host), 4000), false, host);
  }
});

test('rejects wrong port on an otherwise loopback host', () => {
  assert.equal(isAllowedHost(req('127.0.0.1:9999'), 4000), false);
  assert.equal(isAllowedHost(req('localhost:80'), 4000), false);
  assert.equal(isAllowedHost(req('[::1]:443'), 4000), false);
});

test('rejects missing, empty, or non-string Host', () => {
  assert.equal(isAllowedHost(req(undefined), 4000), false);
  assert.equal(isAllowedHost(req(null), 4000), false);
  assert.equal(isAllowedHost(req(''), 4000), false);
  assert.equal(isAllowedHost({ headers: {} }, 4000), false);
  assert.equal(isAllowedHost(null, 4000), false);
});
