import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  encodeProjectDir,
  fileContainsUserMessage,
  findLatestSession,
  isCandidateSession,
  normalizeUserText,
} from '../server/lib/transcript.js';

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRows(file, rows) {
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

test('normalizes line endings and surrounding whitespace only', () => {
  assert.equal(normalizeUserText('  first\r\nsecond\rthird  '), 'first\nsecond\nthird');
});

test('matches a Windows path and quotes by parsing the exact user row', (t) => {
  const file = path.join(makeTempDir(t), 'session.jsonl');
  const prompt = '在 C 盘创建 C:\\权限卡片测试，写上"你好"';
  writeRows(file, [{ type: 'user', message: { content: prompt } }]);

  assert.equal(fileContainsUserMessage(file, prompt), true);
});

test('does not match substrings or text in non-user/non-string rows', (t) => {
  const file = path.join(makeTempDir(t), 'session.jsonl');
  writeRows(file, [
    { type: 'assistant', message: { content: '目标提示词' } },
    { type: 'user', message: { content: '交接文档里提到：目标提示词' } },
    { type: 'user', message: { content: ['目标提示词'] } },
  ]);

  assert.equal(fileContainsUserMessage(file, '目标提示词'), false);
});

test('normalizes line endings while retaining full-message identity', (t) => {
  const file = path.join(makeTempDir(t), 'session.jsonl');
  writeRows(file, [{ type: 'user', message: { content: '第一行\n第二行' } }]);

  assert.equal(fileContainsUserMessage(file, ' 第一行\r\n第二行\r\n'), true);
});

test('does not parse a JSONL row truncated by the 8 MiB read cap', (t) => {
  const file = path.join(makeTempDir(t), 'session.jsonl');
  const prompt = 'cap-boundary-target';
  const cap = 8 * 1024 * 1024;
  const targetRow = JSON.stringify({ type: 'user', message: { content: prompt } });
  const prefix = `${'x'.repeat(cap - Buffer.byteLength(targetRow) - 1)}\n`;
  fs.writeFileSync(file, `${prefix}${targetRow}garbage-after-cap\n`);

  assert.equal(fileContainsUserMessage(file, prompt), false);
});

test('rejects an old session even when its mtime is current', () => {
  assert.equal(isCandidateSession({ birthtimeMs: 1_000, ctimeMs: 1_000, mtimeMs: 20_000 }, 10_000), false);
  assert.equal(isCandidateSession({ birthtimeMs: 9_500, ctimeMs: 9_500, mtimeMs: 9_500 }, 10_000), true);
});

test('falls back to ctime when birthtime is unavailable', () => {
  assert.equal(isCandidateSession({ birthtimeMs: 0, ctimeMs: 9_500, mtimeMs: 1_000 }, 10_000), true);
  assert.equal(isCandidateSession({ birthtimeMs: 0, ctimeMs: 1_000, mtimeMs: 20_000 }, 10_000), false);
});

test('known session IDs are excluded from legacy discovery', (t) => {
  const home = makeTempDir(t);
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (oldProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldProfile;
  });
  const cwd = 'D:\\legacy-project';
  const dir = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const prompt = 'exact known-id exclusion';
  writeRows(path.join(dir, 'known.jsonl'), [{ type: 'user', message: { content: prompt } }]);
  writeRows(path.join(dir, 'available.jsonl'), [{ type: 'user', message: { content: prompt } }]);

  const match = findLatestSession(cwd, Date.now() - 2_000, new Set(['known']), prompt);
  assert.equal(match?.sessionId, 'available');
});

test('multiple exact matches are ambiguous and diagnostics do not expose the prompt', (t) => {
  const home = makeTempDir(t);
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (oldProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldProfile;
  });
  const cwd = 'D:\\ambiguous-project';
  const dir = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const prompt = 'private ambiguous prompt';
  writeRows(path.join(dir, 'first.jsonl'), [{ type: 'user', message: { content: prompt } }]);
  writeRows(path.join(dir, 'second.jsonl'), [{ type: 'user', message: { content: prompt } }]);
  let diagnostic;

  const match = findLatestSession(cwd, Date.now() - 2_000, new Set(), prompt, (value) => {
    diagnostic = value;
  });

  assert.equal(match, null);
  assert.match(diagnostic?.error ?? '', /ambiguous/i);
  assert.equal(JSON.stringify(diagnostic).includes(prompt), false);
});
