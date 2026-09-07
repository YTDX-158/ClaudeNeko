import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePermissionHook } from '../server/lib/hookManager.js';

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-hook-home-'));
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  return { home, settings };
}

test('permission hook is merged without replacing user PermissionRequest entries or other hooks', () => {
  const { home, settings } = tempHome();
  try {
    const userPermission = { matcher: 'Write', hooks: [{ type: 'command', command: 'node user-hook.cjs' }] };
    const preToolUse = [{ hooks: [{ type: 'command', command: 'node pre-tool.cjs' }] }];
    fs.writeFileSync(settings, JSON.stringify({
      env: { KEEP: 'yes' },
      hooks: { PermissionRequest: [userPermission], PreToolUse: preToolUse },
    }));

    assert.equal(ensurePermissionHook({ home, hookScript: 'D:\\Neko\\permission_hook.cjs' }), true);
    const saved = JSON.parse(fs.readFileSync(settings, 'utf8'));

    assert.deepEqual(saved.env, { KEEP: 'yes' });
    assert.deepEqual(saved.hooks.PreToolUse, preToolUse);
    assert.deepEqual(saved.hooks.PermissionRequest, [
      userPermission,
      { hooks: [{ type: 'command', command: 'node "D:\\Neko\\permission_hook.cjs"' }] },
    ]);
    assert.equal(ensurePermissionHook({ home, hookScript: 'D:\\Neko\\permission_hook.cjs' }), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an old Neko PermissionRequest entry is updated in place and duplicates are removed', () => {
  const { home, settings } = tempHome();
  try {
    const userPermission = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node company-hook.cjs' }] };
    fs.writeFileSync(settings, JSON.stringify({ hooks: { PermissionRequest: [
      { hooks: [{ type: 'command', command: 'node "C:\\OldNeko\\server\\permission_hook.cjs"' }] },
      userPermission,
      { hooks: [{ type: 'command', command: 'node "C:\\DuplicateNeko\\server\\permission_hook.cjs"' }] },
    ] } }));

    ensurePermissionHook({ home, hookScript: 'D:\\CurrentNeko\\server\\permission_hook.cjs' });
    const saved = JSON.parse(fs.readFileSync(settings, 'utf8'));

    assert.deepEqual(saved.hooks.PermissionRequest, [
      { hooks: [{ type: 'command', command: 'node "D:\\CurrentNeko\\server\\permission_hook.cjs"' }] },
      userPermission,
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
