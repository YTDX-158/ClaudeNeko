# ClaudeNeko Market Security Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver six independently reviewable market-security fixes without merging main or changing Claude's workspace.

**Architecture:** Treat disk files, proxy authorization, upgraded sockets, exports, and task persistence as explicit trust boundaries. Add small exported helpers for deterministic Node tests, keep HTTP/UI adapters thin, and commit each task separately.

**Tech Stack:** Node.js ESM, `node:test`, Node HTTP/WebSocket primitives, React 18, Vite, Git.

---

### Task 1: Refuse corrupt configuration and write atomically

**Files:**
- Create: `test/config-service.test.js`
- Modify: `package.json`
- Modify: `server/lib/configService.js`
- Modify: `server/routes/config.js`

- [ ] **Step 1: Add `"test": "node --test"` and failing tests**

Test with a temporary home directory and these assertions:

```js
writeFileSync(settingsPath(home), '{"env":');
const before = readFileSync(settingsPath(home), 'utf8');
assert.throws(
  () => writeEnv(home, { baseUrl: 'https://example.com', authToken: 'new', model: 'm' }),
  (error) => error.code === 'CONFIG_JSON_INVALID',
);
assert.equal(readFileSync(settingsPath(home), 'utf8'), before);

writeFileSync(settingsPath(home), JSON.stringify({ hooks: { keep: true }, permissions: ['x'], env: { KEEP: 'yes' } }));
writeEnv(home, { baseUrl: 'https://example.com', authToken: 'one', model: 'm1' });
writeEnv(home, { baseUrl: 'https://example.com', authToken: 'two', model: 'm2' });
writeEnv(home, { baseUrl: 'https://example.com', authToken: 'three', model: 'm3' });
const saved = JSON.parse(readFileSync(settingsPath(home), 'utf8'));
assert.deepEqual(saved.hooks, { keep: true });
assert.deepEqual(saved.permissions, ['x']);
assert.equal(saved.env.KEEP, 'yes');
assert.equal(saved.env.ANTHROPIC_AUTH_TOKEN, 'three');
assert.equal(JSON.parse(readFileSync(`${settingsPath(home)}.bak.1`)).env.ANTHROPIC_AUTH_TOKEN, 'two');
assert.equal(JSON.parse(readFileSync(`${settingsPath(home)}.bak.2`)).env.ANTHROPIC_AUTH_TOKEN, 'one');
assert.equal(JSON.parse(readFileSync(`${settingsPath(home)}.bak.3`)).env.KEEP, 'yes');
assert.deepEqual(readdirSync(dirname(settingsPath(home))).filter((name) => name.includes('.tmp')), []);
```

Also invoke the PUT config route with corrupt JSON and assert status 409, a message containing `settings.json`, and no `ptyHost.killAll()` call.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/config-service.test.js`

Expected: the corrupt file is overwritten or the route returns 200; backup rotation assertions fail.

- [ ] **Step 3: Implement typed reads, rotating backups, and atomic replacement**

Add `ConfigFileError` with code `CONFIG_JSON_INVALID`. `readJson()` returns `{}` only for `ENOENT`; syntax and I/O errors throw. Before writing, validate the current file, copy valid generations down from `.bak.2` to `.bak.3` and `.bak.1` to `.bak.2`, then copy the current file to `.bak.1`. Write JSON to `${path}.${process.pid}.${randomUUID()}.tmp` and rename it over the target. On failure remove only that exact temporary file and rethrow. Do not use a direct-write fallback.

In `server/routes/config.js`, wrap all three `writeEnv()` call sites with:

```js
function writeEnvOrRespond(configService, res, home, values) {
  try {
    configService.writeEnv(home, values);
    return true;
  } catch (error) {
    if (error?.code !== 'CONFIG_JSON_INVALID') throw error;
    sendJson(res, 409, { error: error.message });
    return false;
  }
}
```

Return immediately when it returns false, before PTY restart or profile-current mutation.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npm.cmd test -- test/config-service.test.js
npm.cmd test
node --check server/lib/configService.js
node --check server/routes/config.js
git add package.json test/config-service.test.js server/lib/configService.js server/routes/config.js
git commit -m "fix: preserve corrupt configuration files"
```

### Task 2: Keep local logs out of the remote proxy

**Files:**
- Create: `test/remote-log-policy.test.js`
- Modify: `server/lib/remote/proxy.js`

- [ ] **Step 1: Write and run failing policy tests**

```js
assert.equal(isBlocked('GET', '/api/log'), true);
assert.equal(isBlocked('GET', '/api/log/download'), true);
assert.equal(isBlocked('GET', '/api/health'), false);
```

Run: `npm.cmd test -- test/remote-log-policy.test.js`

Expected: both log assertions fail because the routes are currently allowed.

- [ ] **Step 2: Add explicit path policy and verify**

Add an immutable exact-path set containing `/api/log` and `/api/log/download`, and consult it before the existing suffix rules. Do not weaken the business-side checks in `system.js`.

```powershell
npm.cmd test -- test/remote-log-policy.test.js
npm.cmd test
node --check server/lib/remote/proxy.js
git add test/remote-log-policy.test.js server/lib/remote/proxy.js
git commit -m "fix: block local logs from remote access"
```

### Task 3: Revoke existing remote WebSockets

**Files:**
- Create: `test/remote-socket-revocation.test.js`
- Modify: `server/lib/remote/proxy.js`
- Modify: `server/lib/remote/index.js`
- Modify: `server/routes/remote.js`
- Modify: `server/routes/terminal.js`
- Modify: `server/server.js`

- [ ] **Step 1: Write failing socket lifecycle tests**

Test the wished-for registry API with fake sockets:

```js
const registry = createSocketRegistry();
const downstream = fakeSocket();
const upstream = fakeSocket();
registry.track(downstream);
registry.track(upstream);
registry.disconnectAll();
assert.equal(downstream.destroyCalls, 1);
assert.equal(upstream.destroyCalls, 1);
registry.disconnectAll();
assert.equal(downstream.destroyCalls, 1);
```

Create a terminal channel with minimal dependency stubs, upgrade one request carrying
`x-claudeneko-remote: 1`, and assert `disconnectRemoteClients()` closes that WebSocket
while an unmarked local WebSocket remains open. Test `remoteHandler` regeneration with
a fake `remote.disconnectAll` and assert it is called after session clearing.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/remote-socket-revocation.test.js`

Expected: registry and disconnect methods are missing.

- [ ] **Step 3: Implement revocation ownership**

Export `createSocketRegistry()` from the proxy. It stores live sockets, removes them on
`close`, and destroys each live socket exactly once in `disconnectAll()`. Track both
ends of every proxy upgrade. Return `{ server, disconnectAll }` from
`startRemoteProxy()`.

Set `x-claudeneko-remote: 1` only on proxy-to-business upgrade requests. In the terminal
channel, add marked WebSockets to `remoteClients`, remove them on close/error, and expose:

```js
function disconnectRemoteClients() {
  for (const ws of [...remoteClients]) {
    remoteClients.delete(ws);
    try { ws.close(1008, '远程凭据已撤销'); } catch { try { ws.terminate?.(); } catch {} }
  }
}
```

The remote manager stores the returned proxy controller. Its public `disconnectAll()`
calls both controller and injected business disconnect callback. `stop()` invokes it
before closing the proxy server. Code regeneration clears pairing sessions and then
calls `remote.disconnectAll()`.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npm.cmd test -- test/remote-socket-revocation.test.js
npm.cmd test
node --check server/lib/remote/proxy.js
node --check server/lib/remote/index.js
node --check server/routes/remote.js
node --check server/routes/terminal.js
node --check server/server.js
git add test/remote-socket-revocation.test.js server/lib/remote/proxy.js server/lib/remote/index.js server/routes/remote.js server/routes/terminal.js server/server.js
git commit -m "fix: disconnect sockets when remote access is revoked"
```

### Task 4: Protect pairing from cross-site lockout

**Files:**
- Create: `test/pair-security.test.js`
- Modify: `server/lib/remote/proxy.js`

- [ ] **Step 1: Write failing helper and handler tests**

Cover exact Host/Origin comparison, JSON-only POSTs, nonce source binding and one-time
consumption, five-failure source lock, an independent source remaining available, and
the fifty-failure global lock. A locked handler test injects a `readBody` function that
throws and asserts it was never called.

```js
assert.equal(isPairRequestAllowed({ headers: { host: 'demo.example', origin: 'https://demo.example', 'content-type': 'application/json' } }), true);
assert.equal(isPairRequestAllowed({ headers: { host: 'demo.example', origin: 'https://evil.example', 'content-type': 'text/plain' } }), false);
const nonces = createPairNonceStore({ ttlMs: 60_000 });
const nonce = nonces.issue('source-a');
assert.equal(nonces.consume(nonce, 'source-b'), false);
assert.equal(nonces.consume(nonce, 'source-a'), true);
assert.equal(nonces.consume(nonce, 'source-a'), false);
```

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/pair-security.test.js`

Expected: security helpers are missing and the old global counter locks every source.

- [ ] **Step 3: Implement nonce, same-origin, and two-level limiting**

Export deterministic factories `createPairNonceStore()` and `createPairRateLimiter()`.
The limiter exposes `check(source, now)` and `recordFailure(source, now)` with source
limit 5/60s and global limit 50/60s. `GET` pairing responses issue a 32-byte random
nonce bound to `CF-Connecting-IP`, first `X-Forwarded-For`, or socket address. Embed it
in the pairing script and send it as `X-Neko-Pair-Nonce`.

For `POST /pair`, perform operations in this exact order:

1. derive source and check both locks;
2. require exact same-origin Host and `application/json`;
3. consume the nonce for that source;
4. read and validate the body;
5. on wrong code record one failure and issue a replacement nonce.

Do not count CSRF, invalid-content-type, invalid-nonce, or oversized-body requests as
code guesses.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npm.cmd test -- test/pair-security.test.js
npm.cmd test
node --check server/lib/remote/proxy.js
git add test/pair-security.test.js server/lib/remote/proxy.js
git commit -m "fix: protect remote pairing from cross-site lockout"
```

### Task 5: Reject incomplete full exports

**Files:**
- Create: `test/export-all.test.js`
- Create: `test/export-all-api.test.js`
- Modify: `server/routes/export.js`
- Modify: `web/src/api.js`
- Modify: `web/src/skin/SkinSettings.jsx`

- [ ] **Step 1: Write failing all-or-nothing export tests**

Export `prepareSessionExport()` and inject small limits in tests:

```js
assert.throws(
  () => prepareSessionExport([{ id: '1' }, { id: '2' }], () => [], { maxSessions: 1, maxBytes: 100 }),
  (error) => error.status === 413 && error.code === 'EXPORT_SESSION_LIMIT',
);
assert.throws(
  () => prepareSessionExport([{ id: '1', title: 'a' }], () => [{ text: 'too large' }], { maxSessions: 2, maxBytes: 10 }),
  (error) => error.status === 413 && error.code === 'EXPORT_SIZE_LIMIT',
);
assert.equal(prepareSessionExport([{ id: '1', title: 'a' }], () => [], { maxSessions: 2, maxBytes: 1000 }).files.length, 1);
```

Mock `fetch` for `api.exportAllSessions()` and assert a 413 JSON response rejects with
the server message, an absent completeness header rejects, and a complete response
returns the ZIP blob.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/export-all.test.js test/export-all-api.test.js`

Expected: preparation and API methods are missing.

- [ ] **Step 3: Implement complete preparation and perceptible client errors**

`prepareSessionExport()` rejects before returning any files when either limit is
exceeded. The handler maps its typed limit error to 413 and adds
`X-ClaudeNeko-Export-Complete: true` only to a complete ZIP response.

`api.exportAllSessions()` fetches the endpoint, parses an error body on failure,
requires the completeness header, and returns a blob. `SkinSettings` creates the
download link only after this promise succeeds and shows `alert(error.message)` on
failure.

- [ ] **Step 4: Run GREEN, build, and commit**

```powershell
npm.cmd test -- test/export-all.test.js test/export-all-api.test.js
npm.cmd test
npm.cmd run build
node --check server/routes/export.js
git add test/export-all.test.js test/export-all-api.test.js server/routes/export.js web/src/api.js web/src/skin/SkinSettings.jsx
git commit -m "fix: reject incomplete full-session exports"
```

### Task 6: Sanitize and prune persisted media tasks

**Files:**
- Create: `test/media-task-persistence.test.js`
- Modify: `server/lib/mediaGen.js`

- [ ] **Step 1: Write failing persistence/restart tests**

Create the service with a temporary `dataDir`, a deterministic `mediaConfig`, and a
fixture containing running, done, and error tasks. Assert startup rewrites the file to
one running task and that its serialized JSON contains none of these strings:

```js
for (const forbidden of ['apiKey', 'baseUrl', 'prompt', 'sid', 'secret-key', 'private prompt']) {
  assert.equal(serialized.includes(forbidden), false, forbidden);
}
```

Submit a video task with mocked `fetch`, then read `gen_tasks.json` and assert its
persisted task contains exactly `status`, `ts`, `resolution`, `model`, `ratio`, and
`duration`. Simulate a terminal query response and assert the task disappears from disk
while its in-memory query result remains available.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- test/media-task-persistence.test.js`

Expected: terminal fixtures remain on disk and submitted tasks expose credential and
prompt fields in serialized JSON.

- [ ] **Step 3: Implement recovery-queue serialization**

Add a pure `toPersistedTask()` that returns null unless status is `running`, otherwise
returns only the six recovery fields. `persistTasks()` serializes entries accepted by
that projection. `loadTasks()` always rewrites a successfully parsed file after
filtering, hydrates the claimed task's `baseUrl` and `apiKey` from
`mediaConfig.getConfig('video', model)`, and drops tasks that cannot be hydrated.

Keep credentials in memory for the life of the process so active queries are stable.
Terminal transitions call `persistTasks()`, which now removes the task from disk
immediately while retaining it in the in-memory map for the current cleaner deadlines.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npm.cmd test -- test/media-task-persistence.test.js
npm.cmd test
node --check server/lib/mediaGen.js
git add test/media-task-persistence.test.js server/lib/mediaGen.js
git commit -m "fix: remove secrets and terminal jobs from task storage"
```

### Task 7: Final verification and handoff

**Files:** Verify only.

- [ ] **Step 1: Run complete verification**

```powershell
npm.cmd test
npm.cmd run build
$failed = $false
Get-ChildItem server -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { $failed = $true } }
if ($failed) { exit 1 }
git diff --check main...HEAD
git status --short
```

- [ ] **Step 2: Push without merging**

```powershell
git push -u origin codex-fixes-round2-20260904
```

- [ ] **Step 3: Report Claude smoke checks**

Report corrupt-file preservation and restore, real local/remote log behavior, live WS
revocation on both code regeneration and remote shutdown, browser pairing behavior
through Cloudflare, large real export UI errors, and restarted video-task recovery as
real-environment checks not claimed by the isolated test suite.
