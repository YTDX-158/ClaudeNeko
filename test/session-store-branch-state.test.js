import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../server/lib/sessionStore.js';

test('branch creation persists branchContextInjected as false', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'claudeneko-branch-state-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new SessionStore(dataDir);

  const branch = store.create({
    parentId: 'parent-1',
    branchFromMsg: 'message-1',
    branchContextInjected: false,
  });
  const reloaded = new SessionStore(dataDir).get(branch.id);

  assert.equal(reloaded.branchContextInjected, false);
});
