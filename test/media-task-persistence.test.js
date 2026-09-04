import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';

import { createMediaService } from '../server/lib/mediaGen.js';

const tempDirs = [];
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeneko-media-tasks-'));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(dataDir, getConfig = () => ({
  baseUrl: 'https://current.example/api/v3',
  apiKey: 'current-secret',
})) {
  return {
    imageModels: [],
    videoModels: [{
      id: 'video-model',
      durations: [4, 30],
      durationRange: { min: 4, max: 30 },
      resolutions: ['720P'],
    }],
    ratios: ['16:9'],
    imageResolutions: [],
    transcribeEnabled: false,
    dataDir,
    mediaConfig: {
      getConfig,
      hasAnyKey: () => true,
    },
    logEnabled: () => false,
  };
}

function writeTasks(dataDir, tasks) {
  fs.writeFileSync(
    path.join(dataDir, 'gen_tasks.json'),
    JSON.stringify({ v: 1, tasks }, null, 2),
  );
}

function readTasks(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'gen_tasks.json'), 'utf8'));
}

test('startup rewrites terminal-only persistence as an empty recovery queue', () => {
  const dataDir = makeTempDir();
  writeTasks(dataDir, {
    completed: { status: 'done', ts: Date.now(), apiKey: 'done-secret', mediaId: 'media-1' },
    failed: { status: 'error', ts: Date.now(), apiKey: 'error-secret', error: 'provider error' },
  });

  createMediaService(makeConfig(dataDir));

  assert.deepEqual(readTasks(dataDir), { v: 1, tasks: {} });
});

test('startup keeps only an allowlisted running record and rehydrates current credentials', async () => {
  const dataDir = makeTempDir();
  writeTasks(dataDir, {
    running: {
      status: 'running',
      ts: Date.now(),
      resolution: '720P',
      model: 'video-model',
      ratio: '16:9',
      duration: 5,
      apiKey: 'legacy-secret',
      baseUrl: 'https://legacy.example/api/v3',
      prompt: 'private prompt',
      sid: 'private-session',
      claimedBy: 'old-process',
      lockHeld: true,
      failCount: 2,
    },
  });

  const service = createMediaService(makeConfig(dataDir));
  const persisted = readTasks(dataDir);
  assert.deepEqual(Object.keys(persisted.tasks), ['running']);
  assert.deepEqual(Object.keys(persisted.tasks.running).sort(), [
    'duration', 'model', 'ratio', 'resolution', 'status', 'ts',
  ]);
  assert.equal(JSON.stringify(persisted).includes('legacy-secret'), false);
  assert.equal(JSON.stringify(persisted).includes('private prompt'), false);
  assert.equal(JSON.stringify(persisted).includes('private-session'), false);

  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({ status: 'failed', error: { message: 'provider rejected task' } }),
    };
  };

  const result = await service.queryTask('running');
  assert.equal(request.url, 'https://current.example/api/v3/contents/generations/tasks/running');
  assert.equal(request.options.headers.Authorization, 'Bearer current-secret');
  assert.equal(result.status, 'error');
  assert.deepEqual(readTasks(dataDir), { v: 1, tasks: {} });
});

test('new video tasks never persist credentials, prompts, ownership, or runtime locks', async () => {
  const dataDir = makeTempDir();
  global.fetch = async () => ({ ok: true, json: async () => ({ id: 'new-task' }) });
  const service = createMediaService(makeConfig(dataDir));

  await service.generateVideo({
    prompt: 'do not persist me',
    model: 'video-model',
    ratio: '16:9',
    duration: 6,
    resolution: '720P',
    sid: 'session-secret',
  });

  const persisted = readTasks(dataDir);
  assert.deepEqual(Object.keys(persisted.tasks['new-task']).sort(), [
    'duration', 'model', 'ratio', 'resolution', 'status', 'ts',
  ]);
  const serialized = JSON.stringify(persisted);
  for (const forbidden of [
    'apiKey', 'baseUrl', 'prompt', 'sid', 'claimedBy', 'claimedAt',
    'failCount', 'lockHeld', 'querying', 'current-secret', 'do not persist me', 'session-secret',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `persisted ${forbidden}`);
  }
});
