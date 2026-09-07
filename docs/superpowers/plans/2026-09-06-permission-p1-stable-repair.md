# Permission P1 Stable Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new ClaudeNeko sessions bind deterministically, surface permission requests as chat cards, preserve structured chat bubbles, and prevent user-global allow rules from silently bypassing Neko's ask/smart policy.

**Architecture:** Reserve a Claude session UUID before the PTY starts and launch a new conversation with `--session-id`; resume only when that transcript already exists. Keep transcript discovery solely as a legacy fallback, using parsed top-level user rows and full normalized text instead of raw JSON substrings. For ask/smart modes, inject session-only `permissions.ask` rules through `--settings`, while bypass mode remains unchanged.

**Tech Stack:** Node.js ESM, node:test, node-pty, Claude Code CLI, JSONL transcripts.

---

## File structure

- Create `server/lib/claudeLaunch.js`: reserve deterministic Claude session IDs, decide create versus resume, and build Claude CLI arguments.
- Modify `server/lib/ptyHost.js`: consume the launch decision and session-only permission settings.
- Modify `server/routes/sessions.js`: reserve the ID before prewarm/send and pass the same identity to PTY and transcript services.
- Modify `server/routes/terminal.js`: route every WebSocket-driven PTY start/restart through the same reservation and permission policy.
- Modify `server/server.js`: inject the permission configuration into the terminal channel.
- Modify `server/lib/transcript.js`: make legacy discovery parse exact user rows and reject old-but-active files and ambiguous matches.
- Modify `server/routes/permission.js`: log unmapped permission requests without exposing request contents.
- Create `test/claude-launch.test.js`: cover create/resume arguments and permission modes.
- Create `test/transcript-binding.test.js`: reproduce escaped Windows path/quote failure and wrong-bind hazards.
- Create `test/permission-route.test.js`: verify mapped and unmapped permission routing.

### Task 1: Deterministic session identity and launch arguments

**Files:**
- Create: `server/lib/claudeLaunch.js`
- Create: `test/claude-launch.test.js`
- Modify: `server/lib/ptyHost.js`
- Modify: `server/routes/sessions.js`
- Modify: `server/routes/terminal.js`
- Modify: `server/server.js`

- [x] **Step 1: Write failing launch-policy tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, reserveClaudeSession } from '../server/lib/claudeLaunch.js';

test('new sessions use a reserved UUID with --session-id', () => {
  const updates = [];
  const result = reserveClaudeSession({
    session: { id: 'neko-1', claudeSessionId: null },
    update: (id, patch) => updates.push([id, patch]),
    newId: () => '11111111-1111-4111-8111-111111111111',
    transcriptExists: () => false,
  });
  assert.deepEqual(result, {
    claudeSessionId: '11111111-1111-4111-8111-111111111111',
    isNewClaudeSession: true,
  });
  assert.deepEqual(updates, [['neko-1', { claudeSessionId: result.claudeSessionId }]]);
  assert.deepEqual(buildClaudeArgs(result), ['--session-id', result.claudeSessionId]);
});

test('existing transcript resumes the reserved session', () => {
  const result = reserveClaudeSession({
    session: { id: 'neko-1', claudeSessionId: '22222222-2222-4222-8222-222222222222' },
    update: () => assert.fail('must not rewrite an existing id'),
    transcriptExists: () => true,
  });
  assert.deepEqual(buildClaudeArgs(result), ['--resume', result.claudeSessionId]);
});

test('ask and smart modes override global allows only for Neko sessions', () => {
  for (const permissionMode of ['ask', 'smart']) {
    const args = buildClaudeArgs({ permissionMode });
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    assert.deepEqual(settings.permissions.ask, [
      'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch',
    ]);
    assert.equal(args.at(-2), '--permission-mode');
    assert.equal(args.at(-1), 'default');
  }
});

test('bypass mode does not inject ask rules', () => {
  const args = buildClaudeArgs({ permissionMode: 'bypass' });
  assert.equal(args.includes('--settings'), false);
  assert.deepEqual(args.slice(-2), ['--permission-mode', 'bypassPermissions']);
});
```

- [x] **Step 2: Run the launch-policy tests and verify RED**

Run: `node --test test/claude-launch.test.js`

Expected: FAIL because `server/lib/claudeLaunch.js` does not exist.

- [x] **Step 3: Implement the launch-policy module**

```js
import { randomUUID } from 'node:crypto';
import { toClaudePermissionMode } from './permissionConfig.js';

export const NEKO_ASK_TOOLS = Object.freeze([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch',
]);

export function reserveClaudeSession({ session, update, newId = randomUUID, transcriptExists }) {
  const claudeSessionId = session.claudeSessionId || newId();
  if (!session.claudeSessionId) update(session.id, { claudeSessionId });
  return { claudeSessionId, isNewClaudeSession: !transcriptExists(claudeSessionId) };
}

export function buildClaudeArgs({ claudeSessionId, isNewClaudeSession = false, model, permissionMode } = {}) {
  const args = [];
  if (claudeSessionId) args.push(isNewClaudeSession ? '--session-id' : '--resume', claudeSessionId);
  if (model) args.push('--model', model);
  if (permissionMode && permissionMode !== 'bypass') {
    args.push('--settings', JSON.stringify({ permissions: { ask: NEKO_ASK_TOOLS } }));
  }
  if (permissionMode) args.push('--permission-mode', toClaudePermissionMode(permissionMode));
  return args;
}
```

- [x] **Step 4: Wire the policy into PTY prewarm and message launch**

In `server/lib/ptyHost.js`, replace inline argument assembly with `buildClaudeArgs(...)`, adding the `isNewClaudeSession` option to `ensure`.

In `server/routes/sessions.js`, reserve the Claude ID synchronously before every first `prewarm` or message launch. Determine transcript existence with `existsSync(sessionFile(cwd, claudeSessionId))`, pass the returned ID and `isNewClaudeSession` to `ptyHost.ensure`, and pass the same ID to `transcript.ensure`. Detect a branch's first launch from transcript-file existence rather than from a null ID, so prewarming cannot suppress branch-history injection.

In `server/routes/terminal.js`, add one local `ensureRuntime(sid)` helper that obtains the current session, reserves its Claude ID, passes `permissionConfig.getMode()` to every PTY creation/restart, and starts transcript polling with the same ID. Replace all four duplicated PTY/transcript launch sites with this helper. In `server/server.js`, pass `permissionConfigService` into `createTerminalChannel`.

- [x] **Step 5: Run the launch-policy test and full suite**

Run: `node --test test/claude-launch.test.js`

Expected: 4 passed, 0 failed.

Run: `npm test`

Expected: all tests pass.

- [x] **Step 6: Commit deterministic launch behavior**

```bash
git add server/lib/claudeLaunch.js server/lib/ptyHost.js server/routes/sessions.js server/routes/terminal.js server/server.js test/claude-launch.test.js
git commit -m "fix(permission): bind Claude sessions before PTY launch"
```

### Task 2: Safe legacy transcript discovery

**Files:**
- Modify: `server/lib/transcript.js`
- Create: `test/transcript-binding.test.js`

- [x] **Step 1: Write failing transcript-matching tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileContainsUserMessage, isCandidateSession } from '../server/lib/transcript.js';

test('matches a Windows path and quotes by parsing the user row', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const prompt = '在 C 盘创建 C:\\权限卡片测试，写上"你好"';
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: prompt } })}\n`);
  assert.equal(fileContainsUserMessage(file, prompt), true);
});

test('does not match text embedded inside a different user message', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: '交接文档里提到：目标提示词' } })}\n`);
  assert.equal(fileContainsUserMessage(file, '目标提示词'), false);
});

test('normalizes line endings but retains full-message identity', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: '第一行\n第二行' } })}\n`);
  assert.equal(fileContainsUserMessage(file, '第一行\r\n第二行'), true);
});

test('rejects an old session even when its mtime is current', () => {
  assert.equal(isCandidateSession({ birthtimeMs: 1_000, mtimeMs: 20_000 }, 10_000), false);
  assert.equal(isCandidateSession({ birthtimeMs: 9_500, mtimeMs: 9_500 }, 10_000), true);
});
```

- [x] **Step 2: Run transcript tests and verify RED**

Run: `node --test test/transcript-binding.test.js`

Expected: FAIL because the parsed matching exports do not exist.

- [x] **Step 3: Replace raw substring matching with parsed exact-user matching**

Implement `normalizeUserText`, `fileContainsUserMessage`, and `isCandidateSession`. Read at most the first 8 MiB, parse complete JSONL lines, accept only `type === 'user'` with string `message.content`, compare the complete normalized string, and use birth time—not active mtime—to admit legacy candidates. If more than one candidate matches exactly, report an ambiguous diagnostic and bind none.

- [x] **Step 4: Pass the full submitted text into legacy discovery**

Remove the 30-character truncation from both `createTranscriptService` and `findLatestSession`. Keep empty-message rejection and known-session exclusion.

- [x] **Step 5: Run transcript and full tests**

Run: `node --test test/transcript-binding.test.js`

Expected: 4 passed, 0 failed.

Run: `npm test`

Expected: all tests pass.

- [x] **Step 6: Commit safe legacy discovery**

```bash
git add server/lib/transcript.js test/transcript-binding.test.js
git commit -m "fix(transcript): parse exact user rows for legacy binding"
```

### Task 3: Permission mapping diagnostics

**Files:**
- Modify: `server/routes/permission.js`
- Create: `test/permission-route.test.js`

- [x] **Step 1: Write a failing unmapped-request test**

Create a request stream containing a synthetic `session_id`, invoke `permissionHandler(...).router`, and assert a 404 response plus one warning whose text contains only a short session-ID prefix and does not contain `tool_input` contents.

- [x] **Step 2: Run the permission route test and verify RED**

Run: `node --test test/permission-route.test.js`

Expected: FAIL because the current 404 path emits no diagnostic warning.

- [x] **Step 3: Add a privacy-safe warning before the 404 response**

Log `权限请求找不到对应会话 claudeSession=<first 8 chars>` before returning 404. Do not log tool input, cwd, prompt text, secrets, or the full UUID.

- [x] **Step 4: Add and pass a mapped-request test**

Use a fake store whose session has the synthetic Claude ID; assert HTTP 200, a generated request ID, a permission-card broadcast, and `onPendingChange(sid, true)`.

- [x] **Step 5: Run permission and full tests**

Run: `node --test test/permission-route.test.js`

Expected: all permission tests pass.

Run: `npm test`

Expected: all tests pass.

- [x] **Step 6: Commit permission diagnostics**

```bash
git add server/routes/permission.js test/permission-route.test.js
git commit -m "fix(permission): diagnose unmapped hook requests"
```

### Task 4: Integration verification and evidence

**Files:**
- Modify: `docs/superpowers/plans/2026-09-06-permission-p1-stable-repair.md`
- Create: `docs/权限P1稳健修复验证_20260906.md`

- [x] **Step 1: Run automated verification**

Run: `npm test`

Expected: all tests pass with zero failures.

Run: `npm run build`

Expected: Vite production build exits 0.

- [x] **Step 2: Run an isolated real CLI identity check**

Launch the installed Claude CLI with a fresh UUID and `--session-id` in a disposable directory, send a harmless prompt, then verify the created JSONL filename equals the reserved UUID. Terminate only the disposable test process.

- [x] **Step 3: Run a Neko permission-path check**

Start the branch server on an unused local port with an isolated data directory or equivalent test harness. Confirm that a mapped PermissionRequest is accepted, appears as a pending card event, resolves once, and that an unmapped request falls back with a privacy-safe diagnostic.

- [x] **Step 4: Record evidence and residual limits**

Write the exact commands, test totals, build result, real-session filename evidence, permission route evidence, and any manual UI step still requiring the user's running browser into `docs/权限P1稳健修复验证_20260906.md`.

- [x] **Step 5: Commit verification evidence**

```bash
git add docs/superpowers/plans/2026-09-06-permission-p1-stable-repair.md docs/权限P1稳健修复验证_20260906.md
git commit -m "docs(permission): record P1 repair verification"
```
