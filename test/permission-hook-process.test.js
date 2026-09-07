import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'server', 'permission_hook.cjs');

test('permission hook exits immediately when wait reports 404', async (t) => {
  let waitRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/permission/request') {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'gone-id' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/permission/wait?id=gone-id') {
      waitRequests += 1;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'gone' }));
      return;
    }
    res.writeHead(500);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const started = Date.now();
  const child = spawn(process.execPath, [HOOK], {
    windowsHide: true,
    env: {
      ...process.env,
      NEKO_PERMISSION_PORT: String(server.address().port),
      NEKO_PERMISSION_TIMEOUT: '2000',
      NEKO_PERMISSION_POLL_INTERVAL: '25',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stdin.end(JSON.stringify({
    session_id: '87654321-4321-4321-8321-cba987654321',
    tool_name: 'Write',
    tool_input: { file_path: 'C:\\gone.txt' },
  }));

  const exitCode = await new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => {
      child.kill();
      reject(new Error('permission hook did not exit'));
    }, 5000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(watchdog);
      resolve(code);
    });
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
  assert.equal(waitRequests, 1);
  assert.equal(Date.now() - started < 1000, true);
});

test('permission hook inherits the server PORT when no dedicated override is set', async (t) => {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/permission/request') requestCount += 1;
    req.resume();
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'test complete' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const env = { ...process.env, PORT: String(server.address().port), NEKO_PERMISSION_TIMEOUT: '2000' };
  delete env.NEKO_PERMISSION_PORT;
  const child = spawn(process.execPath, [HOOK], {
    windowsHide: true,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify({
    session_id: '12345678-1234-4234-8234-123456789abc',
    tool_name: 'Write',
    tool_input: { file_path: 'C:\\custom-port.txt' },
  }));

  const exitCode = await new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => {
      child.kill();
      reject(new Error('permission hook did not use the inherited PORT'));
    }, 3000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(watchdog);
      resolve(code);
    });
  });

  assert.equal(exitCode, 0);
  assert.equal(requestCount, 1);
});
