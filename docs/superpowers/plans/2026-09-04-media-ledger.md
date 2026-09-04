# Media Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the media generation ledger as a dedicated, usable tab without altering the existing server-log panel or backend ledger format.

**Architecture:** Add three REST wrappers, mount a new `MediaLedger` component only inside the media-library ledger tab, and reuse the existing media-ledger visual vocabulary with a responsive table. Backend APIs remain unchanged and destructive UI is limited to clearing records without deleting media files.

**Tech Stack:** React 18, existing REST wrapper, CSS, Vite, Node built-in test runner.

---

### Task 1: Add typed-by-behavior media-ledger API calls

**Files:**
- Create: `test/media-ledger-api.test.js`
- Modify: `web/src/api.js:69-106`

- [ ] **Step 1: Write failing API contract tests**

Create `test/media-ledger-api.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../web/src/api.js';

async function captureRequest(run, responseBody = {}) {
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options = {}) => {
    call = { url, options };
    return { ok: true, json: async () => responseBody };
  };
  try {
    const result = await run();
    return { call, result };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('loads media ledger records', async () => {
  const { call, result } = await captureRequest(
    () => api.mediaLog?.(),
    { enabled: true, records: [{ id: 'r1' }], softMax: 5000 },
  );
  assert.equal(call.url, '/api/media/log');
  assert.equal(call.options.method, undefined);
  assert.equal(result.records[0].id, 'r1');
});

test('clears ledger records without requesting file deletion', async () => {
  const { call } = await captureRequest(() => api.mediaLogDelete?.({ all: true }));
  assert.equal(call.url, '/api/media/log');
  assert.equal(call.options.method, 'DELETE');
  assert.deepEqual(JSON.parse(call.options.body), { all: true });
});

test('updates the ledger enabled flag', async () => {
  const { call } = await captureRequest(() => api.mediaLogEnabled?.(false));
  assert.equal(call.url, '/api/media/log-enabled');
  assert.equal(call.options.method, 'PUT');
  assert.deepEqual(JSON.parse(call.options.body), { enabled: false });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- test/media-ledger-api.test.js`

Expected: FAIL because the three API methods do not exist and the captured call is undefined.

- [ ] **Step 3: Add the three REST wrappers**

Add to the media section of `web/src/api.js`:

```js
mediaLog: () => request('/media/log'),
mediaLogDelete: (body) => request('/media/log', { method: 'DELETE', body: JSON.stringify(body) }),
mediaLogEnabled: (enabled) =>
  request('/media/log-enabled', { method: 'PUT', body: JSON.stringify({ enabled }) }),
```

- [ ] **Step 4: Run focused and full unit tests**

Run:

```powershell
npm test -- test/media-ledger-api.test.js
npm test
```

Expected: all API contract tests and all existing unit tests PASS.

### Task 2: Implement and mount the dedicated MediaLedger component

**Files:**
- Create: `web/src/components/MediaLedger.jsx`
- Modify: `web/src/components/MediaLibrary.jsx:1-14,138-153`
- Modify: `web/src/styles.css:1938-1999`

- [ ] **Step 1: Create the component with explicit loading, error, toggle, refresh, and clear flows**

Create `web/src/components/MediaLedger.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { api } from '../api.js';

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function formatParams(record) {
  const parts = [];
  if (record.resolution) parts.push(record.resolution);
  if (record.duration != null) parts.push(`${record.duration}s`);
  if (record.ratio) parts.push(record.ratio);
  return parts.join(' · ') || '—';
}

function formatFile(record) {
  const name = record.fileName || (record.mediaId ? '文件在媒体库' : '—');
  return record.sizeMb != null ? `${name} · ${record.sizeMb}MB` : name;
}

export default function MediaLedger() {
  const [enabled, setEnabled] = useState(true);
  const [records, setRecords] = useState([]);
  const [softMax, setSoftMax] = useState(5000);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.mediaLog();
      setEnabled(data.enabled ?? true);
      setRecords(Array.isArray(data.records) ? data.records : []);
      setSoftMax(Number(data.softMax) || 5000);
    } catch (e) {
      setError(e.message || '台账读取失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const toggleEnabled = async () => {
    const previous = enabled;
    const next = !previous;
    setEnabled(next);
    setChanging(true);
    setError('');
    try {
      await api.mediaLogEnabled(next);
    } catch (e) {
      setEnabled(previous);
      setError(e.message || '台账开关更新失败');
    } finally {
      setChanging(false);
    }
  };

  const clearRecords = async () => {
    if (!records.length || !window.confirm('确定清空全部台账记录？媒体文件会保留。')) return;
    setChanging(true);
    setError('');
    try {
      await api.mediaLogDelete({ all: true });
      setRecords([]);
      await refresh();
    } catch (e) {
      setError(e.message || '清空台账失败');
    } finally {
      setChanging(false);
    }
  };

  return (
    <section className="media-log-panel" aria-label="媒体生成台账">
      <div className="media-log-toolbar">
        <label className="media-log-toggle" title="关闭后不再记录新的生成，历史记录保留">
          <input type="checkbox" checked={enabled} disabled={changing} onChange={toggleEnabled} />
          记录生成台账
        </label>
        <span className="skin-hint">
          共 {records.length} 条{records.length >= softMax ? '（已达软上限，建议清理）' : ''}
        </span>
        <button className="skin-btn" onClick={refresh} disabled={loading || changing}>刷新</button>
        <button className="skin-btn danger" onClick={clearRecords} disabled={!records.length || changing}>
          清空记录
        </button>
      </div>

      {error && <div className="media-log-error" role="alert">{error}</div>}
      {loading ? (
        <div className="skin-hint media-log-state">加载中…</div>
      ) : records.length === 0 ? (
        <div className="skin-hint media-log-state">暂无台账记录，生成图片或视频后会自动记录。</div>
      ) : (
        <div className="media-log-table-wrap">
          <table className="media-log-table">
            <thead>
              <tr>
                <th>时间</th><th>类型</th><th>模型</th><th>提示词</th>
                <th>参数</th><th>结果</th><th>文件</th><th>成本</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td className="media-log-time">{formatTime(record.time)}</td>
                  <td><span className={`media-log-kind ${record.type}`}>{record.type === 'image' ? '图片' : '视频'}</span></td>
                  <td className="media-log-model" title={record.model}>{record.model || '—'}</td>
                  <td><span className="media-log-prompt" title={record.prompt}>{record.prompt || '（无提示词）'}</span></td>
                  <td className="media-log-params">{formatParams(record)}</td>
                  <td><span className={`media-log-result ${record.result}`} title={record.error || ''}>{record.result === 'success' ? '成功' : '失败'}</span></td>
                  <td className="media-log-file" title={record.fileName || ''}>{formatFile(record)}</td>
                  <td>—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Replace the incorrect server-log component in MediaLibrary**

In `web/src/components/MediaLibrary.jsx`, replace:

```jsx
import LogPanel from './LogPanel.jsx';
```

with:

```jsx
import MediaLedger from './MediaLedger.jsx';
```

Then replace:

```jsx
<LogPanel />
```

with:

```jsx
<MediaLedger />
```

- [ ] **Step 3: Replace the orphaned card rules with responsive table rules**

Keep `.media-log-panel`, `.media-log-toolbar`, `.media-log-toggle`, `.media-log-model`, `.media-log-result`, and `.media-log-prompt`, and add rules that provide:

```css
.media-log-error { padding: 8px 12px; color: var(--danger); }
.media-log-state { padding: 24px 12px; text-align: center; }
.media-log-table-wrap { overflow: auto; padding: 8px; }
.media-log-table { width: 100%; min-width: 920px; border-collapse: collapse; font-size: 12px; }
.media-log-table th,
.media-log-table td { padding: 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.media-log-table th { position: sticky; top: 0; background: var(--panel); color: var(--muted); z-index: 1; }
.media-log-prompt { display: block; max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.media-log-kind { display: inline-block; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.media-log-kind.image { background: rgba(88,166,255,.15); color: #58a6ff; }
.media-log-kind.video { background: rgba(188,140,255,.15); color: #bc8cff; }
.media-log-file { max-width: 180px; word-break: break-all; }
```

Preserve existing theme tokens and avoid fixed colors for table surfaces.

- [ ] **Step 4: Run build and all unit tests**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected: all unit tests PASS; Vite production build exits 0; no whitespace errors.

- [ ] **Step 5: Commit the API and component as one user-visible feature**

```powershell
git add test/media-ledger-api.test.js web/src/api.js web/src/components/MediaLedger.jsx web/src/components/MediaLibrary.jsx web/src/styles.css
git commit -m "feat: restore the media generation ledger"
```

### Task 3: Final branch verification

**Files:**
- Verify only; no production files should change.

- [ ] **Step 1: Run the complete automated verification set**

```powershell
npm test
npm run build
$files = Get-ChildItem server -Recurse -Filter *.js
foreach ($file in $files) { node --check $file.FullName }
git diff --check main...HEAD
git status --short
```

Expected: unit tests PASS, build exits 0, all backend syntax checks exit 0, diff check is clean, and working tree is empty.

- [ ] **Step 2: Record real-environment handoff items**

Report these as Claude-side smoke tests, without claiming they ran in the clone:

1. Switch to Zhipu/Kimi/MiniMax and click the mascot; no request containing that provider key reaches DeepSeek.
2. Submit and query a real video task; response contains no private fields.
3. Open remote access and send the raw backslash force-stop path; proxy returns 403.
4. Open Media Library → Ledger with real records; verify rows, failure tooltip, toggle, refresh, clear-records-only, and narrow-screen horizontal scrolling.

