// N-02 终端 WS 入站上限：maxPayload 断超大帧 + 业务字段 schema/长度校验（真 server + 真 ws）
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createTerminalChannel } from '../server/routes/terminal.js';

async function setup() {
  const calls = { submit: [], write: [], resize: [] };
  const session = { id: 'session-1', cwd: process.cwd() };
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // config.port 必须等于实际监听端口：upgrade 的 isAllowedHost 会校验 Host 端口
  const channel = createTerminalChannel({
    ptyHost: {
      ensure: () => ({ isNew: false }),
      isRunning: () => true,
      submit: (...a) => calls.submit.push(a),
      write: (...a) => calls.write.push(a),
      resize: (...a) => calls.resize.push(a),
      touch() {}, kill() {}, markReady() {},
    },
    transcript: { ensure() {} },
    store: { get: () => session, update: () => {} },
    config: { defaultCwd: process.cwd(), port },
    isLocalRequest: () => true,
  });
  server.on('upgrade', channel.upgradeHandler);
  const url = `ws://127.0.0.1:${port}/ws?sid=session-1`;
  const connect = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
  const close = () => new Promise((resolve) => {
    server.close();
    resolve();
  });
  return { calls, connect, close };
}

function waitClose(ws) {
  return new Promise((resolve) => {
    ws.once('close', (code) => resolve(code));
  });
}

test('an over-limit frame (>2MiB) is closed with 1009', async () => {
  const s = await setup();
  let ws;
  try {
    ws = await s.connect();
    const closed = waitClose(ws);
    ws.send(Buffer.alloc(3 * 1024 * 1024)); // 3MiB 单帧 > maxPayload 2MiB
    const code = await closed;
    assert.equal(code, 1009);
  } finally {
    ws?.terminate();
    await s.close();
  }
});

test('binary frames are ignored and never reach the PTY', async () => {
  const s = await setup();
  let ws;
  try {
    ws = await s.connect();
    ws.send(Buffer.from(JSON.stringify({ t: 'send', text: 'must-not-arrive' }))); // binary 帧
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(s.calls.submit, []);
    assert.deepEqual(s.calls.write, []);
  } finally {
    ws?.terminate();
    await s.close();
  }
});

test('oversized send/i text and non-string fields are rejected; valid ones pass', async () => {
  const s = await setup();
  let ws;
  try {
    ws = await s.connect();
    ws.send(JSON.stringify({ t: 'send', text: '合法消息' }));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(s.calls.submit.length, 1);
    assert.equal(s.calls.submit[0][1], '合法消息'); // submit(sid, text)

    // 超长 send（>1MiB 业务上限）应被拒，不达 pty（仍 < 2MiB 帧上限，能到 handler 被业务校验拦）
    ws.send(JSON.stringify({ t: 'send', text: 'x'.repeat(1024 * 1024 + 1) }));
    // 非 string send 应被拒
    ws.send(JSON.stringify({ t: 'send', text: 12345 }));
    // 超长 i（>1MiB）应被拒
    ws.send(JSON.stringify({ t: 'i', d: 'y'.repeat(1024 * 1024 + 1) }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(s.calls.submit.length, 1, '超长/非 string send 不得进 pty');
    assert.equal(s.calls.write.length, 0, '超长 i 不得进 pty');

    // 合法 i 应到达
    ws.send(JSON.stringify({ t: 'i', d: 'ok' }));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(s.calls.write.length, 1);
    assert.equal(s.calls.write[0][1], 'ok');

    // 接近上限的合法大文本（900KB）应通过——防"超长粘贴被误吞"回归（9-08 放宽到 1MiB）
    ws.send(JSON.stringify({ t: 'send', text: 'z'.repeat(900 * 1024) }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(s.calls.submit.length, 2);
    assert.equal(s.calls.submit[1][1].length, 900 * 1024);
  } finally {
    ws?.terminate();
    await s.close();
  }
});

test('unknown message types and malformed JSON are ignored without error', async () => {
  const s = await setup();
  let ws;
  try {
    ws = await s.connect();
    ws.send('not-json{{');
    ws.send(JSON.stringify({ t: 'unknown-type', text: 'x' }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(ws.readyState, WebSocket.OPEN); // 连接不被这些消息打断
    assert.deepEqual(s.calls.submit, []);
  } finally {
    ws?.terminate();
    await s.close();
  }
});
