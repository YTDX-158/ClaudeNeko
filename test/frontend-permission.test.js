import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  canPersistPermissionForHost,
  mergePendingPermissions,
  isActiveSocketEvent,
  permissionCardCopy,
  reconcilePendingSnapshot,
  releaseClosedSnapshotIds,
  shouldTrackClosedPermission,
  runPermissionCancel,
  runPermissionResponse,
} from '../web/src/permissionUi.js';

test('pending permission snapshots merge by id and prefer the bounded backend summary', () => {
  const existing = [
    { id: 'one', tool_name: 'Write', hasInput: true },
    { id: 'two', tool_name: 'Read', summary: '旧摘要' },
  ];
  const snapshot = [
    { id: 'two', tool_name: 'Read', summary: '读取 package.json' },
    { id: 'three', tool_name: 'Bash', summary: '运行 npm test' },
    { tool_name: 'Edit', summary: '没有 id 的坏数据' },
  ];

  assert.deepEqual(mergePendingPermissions(existing, snapshot), [
    { id: 'one', tool_name: 'Write', hasInput: true },
    { id: 'two', tool_name: 'Read', summary: '读取 package.json' },
    { id: 'three', tool_name: 'Bash', summary: '运行 npm test' },
  ]);
});

test('a reconnect snapshot removes disconnected stale cards but keeps websocket cards received during loading', () => {
  const current = [
    { id: 'stale-before-load', summary: '后端已关闭' },
    { id: 'arrived-during-load', summary: 'WS 新卡片' },
    { id: 'closed-during-load', summary: 'WS 已关闭' },
  ];
  const snapshot = [
    { id: 'still-pending', summary: '后端权威快照' },
    { id: 'closed-during-load', summary: '过期的响应数据' },
  ];

  assert.deepEqual(reconcilePendingSnapshot(
    current,
    snapshot,
    new Set(['stale-before-load', 'closed-during-load']),
    new Set(['closed-during-load']),
  ), [
    { id: 'still-pending', summary: '后端权威快照' },
    { id: 'arrived-during-load', summary: 'WS 新卡片' },
  ]);
});

test('permission card copy uses only the bounded summary and explains dangerous and always scope', () => {
  const secret = 'PRIVATE_INPUT_MUST_NOT_RENDER';
  const copy = permissionCardCopy({
    id: 'perm-1',
    tool_name: 'Bash',
    summary: `运行高风险命令 ${'x'.repeat(300)}`,
    dangerous: true,
    alwaysScope: '本次命令前缀 npm*',
    tool_input: { command: secret },
  });

  assert.equal(copy.summary.length <= 200, true);
  assert.equal(copy.summary.includes(secret), false);
  assert.match(copy.riskText, /高风险/);
  assert.match(copy.alwaysText, /本次命令前缀 npm\*/);
});

test('permission card copy hides full input when the server did not provide a summary', () => {
  const secret = 'PRIVATE_PATH_MUST_NOT_RENDER';
  const copy = permissionCardCopy({
    id: 'perm-2',
    tool_name: 'Write',
    hasInput: true,
    tool_input: { file_path: secret },
  });

  assert.equal(copy.summary.includes(secret), false);
  assert.match(copy.summary, /详情已隐藏/);
  assert.match(copy.alwaysText, /同类操作/);
});

test('a rejected approval restores the card and propagates the error for retry handling', async () => {
  const busyStates = [];
  const failure = new Error('network failed');

  await assert.rejects(
    runPermissionResponse(() => Promise.reject(failure), 'once', (busy) => busyStates.push(busy)),
    failure,
  );
  assert.deepEqual(busyStates, [true, false]);
});

test('approval stays busy while its promise is pending and reports explicit false as failure', async () => {
  const busyStates = [];
  let settle;
  const pending = new Promise((resolve) => { settle = resolve; });
  const response = runPermissionResponse(() => pending, 'always', (busy) => busyStates.push(busy));

  assert.deepEqual(busyStates, [true]);
  settle(false);
  assert.equal(await response, false);
  assert.deepEqual(busyStates, [true, false]);
});

test('a failed stop request does not hide permissions that are still pending on the server', async () => {
  let closed = false;
  await assert.rejects(
    runPermissionCancel(
      () => Promise.reject(new Error('offline')),
      () => { closed = true; },
    ),
    /offline/,
  );
  assert.equal(closed, false);
});

test('messages from an old websocket cannot be delivered to the newly active session', () => {
  const oldSocket = {};
  const newSocket = {};
  assert.equal(isActiveSocketEvent(oldSocket, 'A', newSocket, 'B'), false);
  assert.equal(isActiveSocketEvent(newSocket, 'B', newSocket, 'B'), true);
});

test('completed snapshot tombstones are released without deleting newer closures', () => {
  assert.deepEqual(
    [...releaseClosedSnapshotIds(new Set(['old', 'new']), new Set(['old']))],
    ['new'],
  );
});

test('permission closure tombstones exist only while a stale snapshot can still arrive', () => {
  assert.equal(shouldTrackClosedPermission(0), false);
  assert.equal(shouldTrackClosedPermission(1), true);
});

test('persistent permission actions are offered only on loopback pages', () => {
  assert.equal(canPersistPermissionForHost('localhost'), true);
  assert.equal(canPersistPermissionForHost('127.0.0.1'), true);
  assert.equal(canPersistPermissionForHost('::1'), true);
  assert.equal(canPersistPermissionForHost('remote.example.com'), false);
});

test('websocket and chat hook retain reconnect, session identity, and accessible dialog contracts', async () => {
  const [wsSource, hookSource, cardSource, composerSource] = await Promise.all([
    readFile(new URL('../web/src/ws.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/src/hooks/useChatStream.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/src/components/PermCard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../web/src/components/Composer.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(wsSource, /onOpen\?\./);
  assert.match(hookSource, /getPendingPermissions\(requestedSessionId\)/);
  assert.match(hookSource, /pendingLoadRef/);
  assert.match(hookSource, /activePendingLoadsRef/);
  assert.match(cardSource, /role="alertdialog"/);
  assert.match(cardSource, /aria-live="assertive"/);
  assert.match(cardSource, /aria-labelledby=/);
  assert.match(cardSource, /autoFocus/);
  assert.match(composerSource, /autoFocus={index === 0}/);
});
