import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, reserveClaudeSession } from '../server/lib/claudeLaunch.js';

const ASK_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch'];

test('reserves a fixed id once and launches a new Claude session with --session-id', () => {
  const session = { id: 'neko-1' };
  const updates = [];

  const reserved = reserveClaudeSession({
    session,
    update: (id, patch) => updates.push([id, patch]),
    newId: () => '11111111-1111-4111-8111-111111111111',
    transcriptExists: () => false,
  });

  assert.deepEqual(reserved, {
    claudeSessionId: '11111111-1111-4111-8111-111111111111',
    isNewClaudeSession: true,
  });
  assert.deepEqual(updates, [[
    'neko-1',
    { claudeSessionId: '11111111-1111-4111-8111-111111111111' },
  ]]);
  assert.deepEqual(buildClaudeArgs(reserved), [
    '--session-id',
    '11111111-1111-4111-8111-111111111111',
  ]);
});

test('resumes an existing id with a transcript without updating the session', () => {
  let updates = 0;
  const reserved = reserveClaudeSession({
    session: { id: 'neko-2', claudeSessionId: 'existing-id' },
    update: () => { updates += 1; },
    transcriptExists: (id) => id === 'existing-id',
  });

  assert.deepEqual(reserved, { claudeSessionId: 'existing-id', isNewClaudeSession: false });
  assert.equal(updates, 0);
  assert.deepEqual(buildClaudeArgs(reserved), ['--resume', 'existing-id']);
});

test('uses --session-id for a reserved id whose transcript does not exist yet', () => {
  let updates = 0;
  const reserved = reserveClaudeSession({
    session: { id: 'neko-3', claudeSessionId: 'prewarmed-id' },
    update: () => { updates += 1; },
    transcriptExists: () => false,
  });

  assert.equal(updates, 0);
  assert.deepEqual(reserved, { claudeSessionId: 'prewarmed-id', isNewClaudeSession: true });
  assert.deepEqual(buildClaudeArgs(reserved), ['--session-id', 'prewarmed-id']);
});

for (const permissionMode of ['ask', 'smart']) {
  test(`${permissionMode} injects explicit ask tools and default Claude permission mode`, () => {
    const args = buildClaudeArgs({ permissionMode });
    const settingsIndex = args.indexOf('--settings');

    assert.notEqual(settingsIndex, -1);
    assert.deepEqual(JSON.parse(args[settingsIndex + 1]), { permissions: { ask: ASK_TOOLS } });
    assert.deepEqual(args.slice(-2), ['--permission-mode', 'default']);
  });
}

test('bypass omits settings and uses bypassPermissions', () => {
  const args = buildClaudeArgs({ permissionMode: 'bypass' });

  assert.equal(args.includes('--settings'), false);
  assert.deepEqual(args, ['--permission-mode', 'bypassPermissions']);
});
