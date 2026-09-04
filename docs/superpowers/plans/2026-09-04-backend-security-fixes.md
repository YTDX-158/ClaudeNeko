# Backend Security Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent balance credential misrouting, video task credential disclosure, and remote force-stop filter bypass with three independently committed fixes.

**Architecture:** Add small pure boundary helpers that are directly testable with Node's built-in test runner, then route existing HTTP flows through those helpers. Keep media task persistence and the wider remote policy model unchanged except for making `/api/balance` genuinely local-only.

**Tech Stack:** Node.js ESM, `node:test`, existing HTTP server modules, Git.

---

### Task 1: Bind balance credentials to DeepSeek

**Files:**
- Create: `test/balance.test.js`
- Modify: `package.json:5-12`
- Modify: `server/lib/balance.js:6-21`
- Modify: `server/routes/system.js:19-21`

- [ ] **Step 1: Add the built-in unit-test command and failing credential tests**

Add `"test": "node --test"` to `package.json`, then create `test/balance.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as balance from '../server/lib/balance.js';

test('prefers a dedicated DeepSeek key from process or settings', () => {
  assert.equal(
    balance.selectDeepSeekApiKey?.(
      { DEEPSEEK_API_KEY: 'process-ds' },
      { DEEPSEEK_API_KEY: 'settings-ds' },
    ),
    'process-ds',
  );
  assert.equal(balance.selectDeepSeekApiKey?.({}, { DEEPSEEK_API_KEY: 'settings-ds' }), 'settings-ds');
});

test('accepts a generic Anthropic token only for the exact DeepSeek HTTPS host', () => {
  assert.equal(
    balance.selectDeepSeekApiKey?.({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/v1',
      ANTHROPIC_AUTH_TOKEN: 'deepseek-via-anthropic',
    }),
    'deepseek-via-anthropic',
  );
  for (const baseUrl of [
    'https://open.bigmodel.cn/api/anthropic',
    'https://api.moonshot.cn/anthropic',
    'https://api.deepseek.com.evil.example/v1',
    'https://api.deepseek.com@evil.example/v1',
    'http://api.deepseek.com/v1',
    'not a url',
  ]) {
    assert.equal(
      balance.selectDeepSeekApiKey?.({
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: 'must-not-leak',
      }),
      null,
      baseUrl,
    );
  }
});

test('does not combine a generic token with another source\'s DeepSeek URL', () => {
  assert.equal(
    balance.selectDeepSeekApiKey?.(
      { ANTHROPIC_AUTH_TOKEN: 'unbound-process-token' },
      { ANTHROPIC_BASE_URL: 'https://api.deepseek.com' },
    ),
    null,
  );
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- test/balance.test.js`

Expected: FAIL because `selectDeepSeekApiKey` is not defined and the dedicated-key assertions receive `undefined`.

- [ ] **Step 3: Implement the provider-bound selector**

Replace `readApiKey()` in `server/lib/balance.js` with:

```js
function isDeepSeekEndpoint(baseUrl) {
  try {
    const u = new URL(String(baseUrl || ''));
    return u.protocol === 'https:' && u.hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    return false;
  }
}

export function selectDeepSeekApiKey(...sources) {
  for (const env of sources) {
    if (env?.DEEPSEEK_API_KEY) return env.DEEPSEEK_API_KEY;
  }
  for (const env of sources) {
    if (env?.ANTHROPIC_AUTH_TOKEN && isDeepSeekEndpoint(env.ANTHROPIC_BASE_URL)) {
      return env.ANTHROPIC_AUTH_TOKEN;
    }
  }
  return null;
}

function readSettingsEnv() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
    return JSON.parse(raw).env || {};
  } catch {
    return {};
  }
}

function readApiKey() {
  return selectDeepSeekApiKey(process.env, readSettingsEnv());
}
```

- [ ] **Step 4: Add the business-layer local check**

Change the balance branch in `server/routes/system.js` to:

```js
if (method === 'GET' && pathname === '/api/balance') {
  if (!ctx.isLocalRequest?.(req)) return sendJson(res, 403, { error: '来源校验失败' });
  return sendJson(res, 200, await fetchBalance());
}
```

- [ ] **Step 5: Run focused and syntax checks**

Run:

```powershell
npm test -- test/balance.test.js
node --check server/lib/balance.js
node --check server/routes/system.js
```

Expected: all balance tests PASS; both syntax checks exit 0.

- [ ] **Step 6: Commit Task 1**

```powershell
git add package.json test/balance.test.js server/lib/balance.js server/routes/system.js
git commit -m "fix: bind balance lookup to DeepSeek credentials"
```

### Task 2: Return a public video-task DTO

**Files:**
- Create: `test/media-task-dto.test.js`
- Modify: `server/lib/mediaGen.js:76-88,380-508`

- [ ] **Step 1: Write the failing DTO tests**

Create `test/media-task-dto.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as mediaGen from '../server/lib/mediaGen.js';

test('video task DTO contains only public status fields', () => {
  const task = {
    status: 'done',
    mediaId: 'media-1',
    error: '',
    ts: 123,
    apiKey: 'secret-key',
    baseUrl: 'https://private.example',
    prompt: 'private prompt',
    sid: 'session-1',
    claimedBy: 'instance-1',
    lockHeld: true,
  };
  assert.deepEqual(mediaGen.toPublicTask?.(task), {
    status: 'done',
    mediaId: 'media-1',
    error: '',
    ts: 123,
  });
});

test('video task DTO handles missing and running tasks without leaking internals', () => {
  assert.deepEqual(mediaGen.toPublicTask?.(null), { status: 'not_found' });
  assert.deepEqual(
    mediaGen.toPublicTask?.({ status: 'running', apiKey: 'secret-key', failCount: 2 }),
    { status: 'running' },
  );
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- test/media-task-dto.test.js`

Expected: FAIL because `toPublicTask` is not defined.

- [ ] **Step 3: Implement the DTO projection and route query results through it**

Add near `createMediaService` in `server/lib/mediaGen.js`:

```js
export function toPublicTask(task) {
  if (!task || typeof task !== 'object') return { status: 'not_found' };
  const out = { status: typeof task.status === 'string' ? task.status : 'not_found' };
  if (Object.hasOwn(task, 'mediaId')) out.mediaId = task.mediaId;
  if (Object.hasOwn(task, 'error')) out.error = task.error;
  if (Object.hasOwn(task, 'ts')) out.ts = task.ts;
  return out;
}
```

Keep the not-found branch public. In the existing `t.querying = (async () => { ... })()` chain, insert `.then(toPublicTask)` immediately after the async IIFE closes and immediately before `.finally(...)`. Do not replace or otherwise alter the state-machine body. The exact boundary diff is:

```diff
-  })().finally(() => {
+  })()
+  .then(toPublicTask)
+  .finally(() => {
    t.querying = null;
  });
```

- [ ] **Step 4: Run focused, full unit, and syntax checks**

Run:

```powershell
npm test -- test/media-task-dto.test.js
npm test
node --check server/lib/mediaGen.js
```

Expected: DTO tests and all unit tests PASS; syntax check exits 0.

- [ ] **Step 5: Inspect the query boundary for forbidden fields**

Run: `git diff -- server/lib/mediaGen.js`

Expected: `apiKey/baseUrl/prompt/sid` remain internal for task recovery, while every fulfilled `queryTask()` promise passes through `toPublicTask` before reaching callers.

- [ ] **Step 6: Commit Task 2**

```powershell
git add test/media-task-dto.test.js server/lib/mediaGen.js
git commit -m "fix: redact internal fields from media task responses"
```

### Task 3: Canonicalize remote proxy paths before policy checks

**Files:**
- Create: `test/remote-proxy.test.js`
- Modify: `server/lib/remote/proxy.js:24-31,97-104,149-165`

- [ ] **Step 1: Write the failing canonicalization and policy tests**

Create `test/remote-proxy.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as proxy from '../server/lib/remote/proxy.js';

test('canonicalizes a raw backslash force-stop path before checking policy', () => {
  const pathname = proxy.normalizeProxyPath?.('/api/sessions/demo\\force-stop?source=test');
  assert.equal(pathname, '/api/sessions/demo/force-stop');
  assert.equal(proxy.isBlocked('POST', pathname), true);
});

test('keeps ordinary paths available and blocks local-only balance', () => {
  assert.equal(proxy.isBlocked('POST', '/api/media/generate'), false);
  assert.equal(proxy.isBlocked('GET', '/api/balance'), true);
});

test('returns null for an invalid absolute URL', () => {
  assert.equal(proxy.normalizeProxyPath?.('http://['), null);
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- test/remote-proxy.test.js`

Expected: FAIL because `normalizeProxyPath` is not defined and `/api/balance` is currently allowed.

- [ ] **Step 3: Implement canonicalization and fail-closed handling**

Add to `server/lib/remote/proxy.js`:

```js
export function normalizeProxyPath(rawUrl) {
  try {
    return new URL(String(rawUrl || ''), 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
}
```

Add the local-only route to `isBlocked`:

```js
if (pathname === '/api/balance') return true;
```

At the top of the request handler, replace the raw split with:

```js
const pathname = normalizeProxyPath(req.url);
const method = req.method;
if (!pathname) {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: '请求路径无效' }));
  return;
}
```

Use `pathname` for `/pair` and `isBlocked`; continue forwarding the original `req.url` so valid query strings are preserved.

- [ ] **Step 4: Run focused, full unit, syntax, and diff checks**

Run:

```powershell
npm test -- test/remote-proxy.test.js
npm test
node --check server/lib/remote/proxy.js
git diff --check
```

Expected: all tests PASS; syntax and whitespace checks exit 0.

- [ ] **Step 5: Commit Task 3**

```powershell
git add test/remote-proxy.test.js server/lib/remote/proxy.js
git commit -m "fix: canonicalize remote proxy security paths"
```
