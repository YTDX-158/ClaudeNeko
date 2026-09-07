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

test('does not parse a syntactically complete final row without a newline', (t) => {
  const file = path.join(makeTempDir(t), 'session.jsonl');
  const prompt = 'unterminated-final-row';
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: prompt } }));

  assert.equal(fileContainsUserMessage(file, prompt), false);
});

test('rejects an old session even when its mtime is current', () => {
  assert.equal(isCandidateSession({ birthtimeMs: 1_000, ctimeMs: 1_000, mtimeMs: 20_000 }, 10_000), false);
  assert.equal(isCandidateSession({ birthtimeMs: 9_999, ctimeMs: 20_000, mtimeMs: 20_000 }, 10_000), false);
  assert.equal(isCandidateSession({ birthtimeMs: 10_000, ctimeMs: 1_000, mtimeMs: 1_000 }, 10_000), true);
});

test('fails closed when birthtime is unavailable', () => {
  assert.equal(isCandidateSession({ ctimeMs: 20_000, mtimeMs: 20_000 }, 10_000), false);
  assert.equal(isCandidateSession({ birthtimeMs: 0, ctimeMs: 20_000, mtimeMs: 20_000 }, 10_000), false);
  assert.equal(isCandidateSession({ birthtimeMs: 0, ctimeMs: 1_000, mtimeMs: 20_000 }, 10_000), false);
});

test('known session IDs are excluded from legacy discovery', (t) => {
  const projectsRoot = makeTempDir(t);
  const cwd = 'D:\\legacy-project';
  const dir = path.join(projectsRoot, encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const prompt = 'exact known-id exclusion';
  const knownId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const availableId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  writeRows(path.join(dir, `${knownId}.jsonl`), [{ type: 'user', message: { content: prompt } }]);
  writeRows(path.join(dir, `${availableId}.jsonl`), [{ type: 'user', message: { content: prompt } }]);

  const match = findLatestSession(cwd, Date.now() - 2_000, new Set([knownId.toUpperCase()]), prompt, undefined, { projectsRoot });
  assert.equal(match?.sessionId, availableId);
});

test('multiple exact matches are ambiguous and diagnostics do not expose the prompt', (t) => {
  const projectsRoot = makeTempDir(t);
  const cwd = 'D:\\ambiguous-project';
  const dir = path.join(projectsRoot, encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const prompt = 'private ambiguous prompt';
  writeRows(path.join(dir, '33333333-3333-4333-8333-333333333333.jsonl'), [{ type: 'user', message: { content: prompt } }]);
  writeRows(path.join(dir, '44444444-4444-4444-8444-444444444444.jsonl'), [{ type: 'user', message: { content: prompt } }]);
  let diagnostic;

  const match = findLatestSession(cwd, Date.now() - 2_000, new Set(), prompt, (value) => {
    diagnostic = value;
  }, { projectsRoot });

  assert.equal(match, null);
  assert.match(diagnostic?.error ?? '', /ambiguous/i);
  assert.deepEqual(diagnostic?.candidates?.sort(), ['33333333', '44444444']);
  assert.equal(JSON.stringify(diagnostic).includes(prompt), false);
});

test('legacy discovery ignores non-UUID filenames and never diagnoses them', (t) => {
  const projectsRoot = makeTempDir(t);
  const cwd = 'D:\\invalid-id-project';
  const dir = path.join(projectsRoot, encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const prompt = 'private invalid filename prompt';
  writeRows(path.join(dir, 'FORGED-not-a-uuid.jsonl'), [{ type: 'user', message: { content: prompt } }]);
  writeRows(path.join(dir, 'aaaaaaaa-aaaa-0aaa-0aaa-aaaaaaaaaaaa.jsonl'), [{ type: 'user', message: { content: prompt } }]);
  let diagnostic;

  const match = findLatestSession(cwd, Date.now() - 2_000, new Set(), prompt, (value) => {
    diagnostic = value;
  }, { projectsRoot });

  assert.equal(match, null);
  assert.deepEqual(diagnostic?.candidates, []);
  assert.equal(JSON.stringify(diagnostic).includes('FORGED'), false);
});

test('legacy diagnostics report candidates whose scan was bounded at 8 MiB', (t) => {
  const projectsRoot = makeTempDir(t);
  const cwd = 'D:\\bounded-project';
  const dir = path.join(projectsRoot, encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const prompt = 'bounded exact prompt';
  const sessionId = '55555555-5555-4555-8555-555555555555';
  const file = path.join(dir, `${sessionId}.jsonl`);
  const row = `${JSON.stringify({ type: 'user', message: { content: prompt } })}\n`;
  fs.writeFileSync(file, `${row}${'x'.repeat(8 * 1024 * 1024)}\n`);
  let diagnostic;

  const match = findLatestSession(cwd, Date.now() - 2_000, new Set(), prompt, (value) => {
    diagnostic = value;
  }, { projectsRoot });

  assert.equal(match?.sessionId, sessionId);
  assert.equal(diagnostic?.truncatedCandidates, 1);
  assert.equal(JSON.stringify(diagnostic).includes(prompt), false);
});
