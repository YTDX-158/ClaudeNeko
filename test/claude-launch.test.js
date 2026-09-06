import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, reserveClaudeSession } from '../server/lib/claudeLaunch.js';
import * as launch from '../server/lib/claudeLaunch.js';

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

test('uses the latest stored session when the caller holds a stale unbound snapshot', () => {
  let updates = 0;
  const reserved = reserveClaudeSession({
    session: { id: 'neko-race', claudeSessionId: null },
    getSession: () => ({ id: 'neko-race', claudeSessionId: 'reserved-by-prewarm' }),
    update: () => { updates += 1; },
    newId: () => 'must-not-be-used',
    transcriptExists: () => false,
  });

  assert.equal(updates, 0);
  assert.deepEqual(reserved, {
    claudeSessionId: 'reserved-by-prewarm',
    isNewClaudeSession: true,
  });
});

test('refuses to reserve a deleted session instead of falling back to a stale snapshot', () => {
  let updates = 0;

  assert.throws(() => reserveClaudeSession({
    session: { id: 'neko-deleted', claudeSessionId: null },
    getSession: () => null,
    update: () => { updates += 1; },
    newId: () => 'must-not-launch',
    transcriptExists: () => false,
  }), /no longer exists/);
  assert.equal(updates, 0);
});

test('a prewarmed branch still needs context until transcript confirms injection', () => {
  assert.equal(launch.shouldInjectBranchContext?.({
    id: 'branch-1',
    parentId: 'parent-1',
    claudeSessionId: 'already-reserved',
    branchContextInjected: false,
  }), true);
});

test('ordinary or empty transcript user events cannot complete branch context injection', () => {
  const updates = [];
  const session = {
    id: 'branch-2',
    parentId: 'parent-1',
    branchContextPending: true,
    branchContextInjected: false,
  };

  assert.equal(launch.completeBranchContextInjection?.({ session, text: '', update: (...args) => updates.push(args) }), false);
  assert.equal(launch.completeBranchContextInjection?.({ session, text: 'terminal command', update: (...args) => updates.push(args) }), false);
  assert.deepEqual(updates, []);
});

test('only a matching transcript user event completes a pending branch context injection', () => {
  const updates = [];
  const session = {
    id: 'branch-3',
    parentId: 'parent-1',
    branchContextPending: true,
    branchContextInjected: false,
  };
  const text = `${launch.BRANCH_CONTEXT_PREFIX}\n\n用户: earlier history`;

  assert.equal(launch.completeBranchContextInjection?.({ session, text, update: (...args) => updates.push(args) }), true);
  assert.deepEqual(updates, [[
    'branch-3',
    { branchContextPending: false, branchContextInjected: true },
  ]]);
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
