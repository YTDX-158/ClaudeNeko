import test from 'node:test';
import assert from 'node:assert/strict';
import { createPtyHost } from '../server/lib/ptyHost.js';

class FakePtyChild {
  constructor(pid) {
    this.pid = pid;
    this.writeCalls = [];
  }

  onData(handler) { this.dataHandler = handler; }
  onExit(handler) { this.exitHandler = handler; }
  write(data) { this.writeCalls.push(data); }
  resize() {}
  emitExit(exitCode = 0) { this.exitHandler?.({ exitCode }); }
}

test('mode-change stop blocks reuse and handles each PTY exit exactly once', async () => {
  const children = [];
  const exitEvents = [];
  const host = createPtyHost({
    claudeBin: '',
    ptyImpl: {
      spawn() {
        const child = new FakePtyChild(children.length + 1);
        children.push(child);
        return child;
      },
    },
    taskkillImpl() {},
    bus: { emit(name, payload) { if (name === 'pty:exit') exitEvents.push(payload); } },
  });

  assert.equal(typeof host.killAllAndWait, 'function');
  assert.equal(host.ensure('sid-1', { cwd: process.cwd() }).isNew, true);
  children[0].dataHandler('\x1b[?2004h');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(host.submit('sid-1', 'already writing'), true);
  assert.deepEqual(children[0].writeCalls, ['already writing']);
  const waiting = host.killAllAndWait();

  assert.deepEqual(host.ensure('sid-1', { cwd: process.cwd() }), {
    isNew: false,
    available: false,
    stopping: true,
  });
  assert.equal(host.submit('sid-1', 'must not reach the old PTY'), false);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(children[0].writeCalls, ['already writing']);
  assert.equal(children.length, 1);

  children[0].emitExit(0);
  await waiting;
  assert.deepEqual(exitEvents, [{ sid: 'sid-1', exitCode: 0 }]);
  assert.equal(host.isRunning('sid-1'), false);

  assert.equal(host.ensure('sid-1', { cwd: process.cwd() }).isNew, true);
  assert.equal(children.length, 2);
  children[0].emitExit(0);
  assert.equal(host.isRunning('sid-1'), true);
  assert.deepEqual(exitEvents, [{ sid: 'sid-1', exitCode: 0 }]);

  host.killAll();
});

test('a timed-out mode-change stop keeps its stopping placeholder until the real exit', async () => {
  const children = [];
  const exitEvents = [];
  const host = createPtyHost({
    claudeBin: '',
    ptyImpl: {
      spawn() {
        const child = new FakePtyChild(100 + children.length);
        children.push(child);
        return child;
      },
    },
    taskkillImpl() {},
    bus: { emit(name, payload) { if (name === 'pty:exit') exitEvents.push(payload); } },
  });

  host.ensure('sid-timeout', { cwd: process.cwd() });
  assert.deepEqual(await host.killAllAndWait(), [false]);
  assert.equal(host.isRunning('sid-timeout'), true);
  assert.equal(host.submit('sid-timeout', 'blocked after timeout'), false);
  assert.equal(host.ensure('sid-timeout', { cwd: process.cwd() }).stopping, true);

  children[0].emitExit(9);
  assert.equal(host.isRunning('sid-timeout'), false);
  assert.deepEqual(exitEvents, [{ sid: 'sid-timeout', exitCode: 9 }]);
});

for (const stopKind of ['kill', 'killAll', 'idle']) {
  test(`${stopKind} uses the guarded stop lifecycle`, async () => {
    const children = [];
    const exitEvents = [];
    let idleSweep;
    const host = createPtyHost({
      claudeBin: '',
      ptyImpl: {
        spawn() {
          const child = new FakePtyChild(200 + children.length);
          children.push(child);
          return child;
        },
      },
      taskkillImpl() {},
      setIntervalImpl(fn) { idleSweep = fn; return { unref() {} }; },
      bus: { emit(name, payload) { if (name === 'pty:exit') exitEvents.push(payload); } },
    });

    host.ensure('sid-stop', { cwd: process.cwd() });
    children[0].dataHandler('\x1b[?2004h');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(host.submit('sid-stop', 'queued write'), true);

    let waiting;
    if (stopKind === 'kill') waiting = host.kill('sid-stop');
    if (stopKind === 'killAll') host.killAll();
    if (stopKind === 'idle') {
      host.scheduleIdleReap(-1);
      idleSweep();
    }

    assert.equal(host.submit('sid-stop', 'must be blocked'), false);
    assert.equal(host.ensure('sid-stop', { cwd: process.cwd() }).stopping, true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(children[0].writeCalls, ['queued write']);
    assert.deepEqual(exitEvents, []);

    children[0].emitExit(0);
    if (waiting) assert.equal(await waiting, true);
    assert.deepEqual(exitEvents, [{ sid: 'sid-stop', exitCode: 0 }]);
    assert.equal(host.isRunning('sid-stop'), false);
  });
}
