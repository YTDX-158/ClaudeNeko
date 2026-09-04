import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as configService from '../server/lib/configService.js';
import { configHandler } from '../server/routes/config.js';

const tempHomes = [];

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'claudeneko-config-'));
  tempHomes.push(home);
  mkdirSync(dirname(configService.settingsPath(home)), { recursive: true });
  return home;
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

afterEach(() => {
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test('corrupt settings are rejected without changing the original bytes', () => {
  const home = makeHome();
  const file = configService.settingsPath(home);
  writeFileSync(file, '{"env":', 'utf8');
  const before = readFileSync(file, 'utf8');

  assert.throws(
    () => configService.writeEnv(home, {
      baseUrl: 'https://example.com',
      authToken: 'new-token',
      model: 'model-new',
    }),
    (error) => error.code === 'CONFIG_JSON_INVALID' && error.message.includes('settings.json'),
  );
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('valid writes preserve unrelated configuration and rotate three backups', () => {
  const home = makeHome();
  const file = configService.settingsPath(home);
  writeFileSync(file, JSON.stringify({
    hooks: { keep: true },
    permissions: ['read'],
    env: { KEEP: 'yes' },
  }), 'utf8');

  for (const [authToken, model] of [['one', 'm1'], ['two', 'm2'], ['three', 'm3']]) {
    configService.writeEnv(home, { baseUrl: 'https://example.com', authToken, model });
    assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')));
  }

  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.hooks, { keep: true });
  assert.deepEqual(saved.permissions, ['read']);
  assert.equal(saved.env.KEEP, 'yes');
  assert.equal(saved.env.ANTHROPIC_AUTH_TOKEN, 'three');
  assert.equal(JSON.parse(readFileSync(`${file}.bak.1`, 'utf8')).env.ANTHROPIC_AUTH_TOKEN, 'two');
  assert.equal(JSON.parse(readFileSync(`${file}.bak.2`, 'utf8')).env.ANTHROPIC_AUTH_TOKEN, 'one');
  assert.equal(JSON.parse(readFileSync(`${file}.bak.3`, 'utf8')).env.KEEP, 'yes');
  assert.deepEqual(readdirSync(dirname(file)).filter((name) => name.includes('.tmp')), []);
});

test('config route reports corrupt settings and does not restart PTYs', async () => {
  const home = makeHome();
  const file = configService.settingsPath(home);
  writeFileSync(file, '{broken', 'utf8');
  let killCalls = 0;
  const handler = configHandler({
    modelConfig: {},
    configService,
    detectEnv: () => ({}),
    readBody: async () => ({
      baseUrl: 'https://example.com',
      authToken: 'new-token',
      model: 'model-new',
    }),
    ptyHost: { killAll() { killCalls += 1; } },
    store: { list: () => [] },
    busyLock: { has: () => false },
    media: { hasActive: () => false },
    home,
  });
  const res = responseRecorder();

  await handler({ method: 'PUT' }, res, new URL('http://localhost/api/config'));

  assert.equal(res.status, 409);
  assert.match(res.body.error, /settings\.json/);
  assert.equal(killCalls, 0);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});
