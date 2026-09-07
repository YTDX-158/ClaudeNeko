import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('server startup catches hook installation failures and logs a warning', () => {
  const source = fs.readFileSync(new URL('../server/server.js', import.meta.url), 'utf8');
  assert.match(source, /try\s*{\s*ensurePermissionHook\(\);\s*}\s*catch\s*\([^)]*\)\s*{/s);
  assert.match(source, /catch\s*\([^)]*\)\s*{[^}]*logger\.warn\([^)]*hook[^)]*继续启动/is);
});
