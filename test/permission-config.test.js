import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPermissionConfig } from '../server/lib/permissionConfig.js';

function withTempConfig(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-permission-config-'));
  try {
    return run(dataDir);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('allow and deny mutations initialize arrays in a brand-new config', () => withTempConfig((dataDir) => {
  const config = createPermissionConfig({ dataDir });

  assert.deepEqual(config.addAllow('Bash(npm test)'), ['Bash(npm test)']);
  assert.deepEqual(config.addDeny('Write(C:\\protected.txt)'), ['Write(C:\\protected.txt)']);
  assert.deepEqual(config.getRules(), {
    allow: ['Bash(npm test)'],
    deny: ['Write(C:\\protected.txt)'],
  });
}));

test('allow and deny mutations recover missing or malformed array fields', () => withTempConfig((dataDir) => {
  const file = path.join(dataDir, 'permissionConfig.json');
  fs.writeFileSync(file, JSON.stringify({ mode: 'smart', allow: 'bad' }));
  const config = createPermissionConfig({ dataDir });

  assert.deepEqual(config.addAllow('Bash(npm test)'), ['Bash(npm test)']);
  assert.deepEqual(config.addDeny('Edit(C:\\exact.txt)'), ['Edit(C:\\exact.txt)']);
  assert.deepEqual(config.removeAllow('Bash(npm test)'), []);
  assert.deepEqual(config.removeDeny('Edit(C:\\exact.txt)'), []);
}));
