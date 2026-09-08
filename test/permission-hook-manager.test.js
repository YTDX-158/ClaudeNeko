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

test('unverifiable legacy-looking PermissionRequest entries are preserved while the current hook is added', () => {
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
      { hooks: [{ type: 'command', command: 'node "C:\\OldNeko\\server\\permission_hook.cjs"' }] },
      userPermission,
      { hooks: [{ type: 'command', command: 'node "C:\\DuplicateNeko\\server\\permission_hook.cjs"' }] },
      { hooks: [{ type: 'command', command: 'node "D:\\CurrentNeko\\server\\permission_hook.cjs"' }] },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a mixed entry keeps its matcher and user hook while the current Neko hook is separated', () => {
  const { home, settings } = tempHome();
  try {
    const hookScript = 'D:\\CurrentNeko\\server\\permission_hook.cjs';
    const userHook = { type: 'command', command: 'node user-approval.cjs' };
    fs.writeFileSync(settings, JSON.stringify({ hooks: { PermissionRequest: [
      { matcher: 'Write', hooks: [
        { type: 'command', command: `node "${hookScript}"` },
        userHook,
      ] },
    ] } }));

    ensurePermissionHook({ home, hookScript });
    const saved = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.deepEqual(saved.hooks.PermissionRequest, [
      { matcher: 'Write', hooks: [userHook] },
      { hooks: [{ type: 'command', command: `node "${hookScript}"` }] },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a user hook with the same basename outside a Neko server directory is preserved', () => {
  const { home, settings } = tempHome();
  try {
    const userEntry = { hooks: [{ type: 'command', command: 'node "D:\\UserHooks\\permission_hook.cjs"' }] };
    const hookScript = 'D:\\CurrentNeko\\server\\permission_hook.cjs';
    fs.writeFileSync(settings, JSON.stringify({ hooks: { PermissionRequest: [userEntry] } }));

    ensurePermissionHook({ home, hookScript });
    const saved = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.deepEqual(saved.hooks.PermissionRequest, [
      userEntry,
      { hooks: [{ type: 'command', command: `node "${hookScript}"` }] },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a user hook under a directory named server is never mistaken for a legacy Neko hook', () => {
  const { home, settings } = tempHome();
  try {
    const userEntry = { hooks: [{ type: 'command', command: 'node "D:\\UserHooks\\server\\permission_hook.cjs"' }] };
    const hookScript = 'D:\\CurrentNeko\\server\\permission_hook.cjs';
    fs.writeFileSync(settings, JSON.stringify({ hooks: { PermissionRequest: [userEntry] } }));

    ensurePermissionHook({ home, hookScript });
    const saved = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.deepEqual(saved.hooks.PermissionRequest, [
      userEntry,
      { hooks: [{ type: 'command', command: `node "${hookScript}"` }] },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a metadata entry containing only the current Neko hook is consumed without duplication', () => {
  const { home, settings } = tempHome();
  try {
    const hookScript = 'D:\\CurrentNeko\\server\\permission_hook.cjs';
    fs.writeFileSync(settings, JSON.stringify({ hooks: { PermissionRequest: [
      { matcher: 'Write', hooks: [{ type: 'command', command: `node "${hookScript}"` }] },
    ] } }));

    ensurePermissionHook({ home, hookScript });
    const saved = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.deepEqual(saved.hooks.PermissionRequest, [
      { hooks: [{ type: 'command', command: `node "${hookScript}"` }] },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
