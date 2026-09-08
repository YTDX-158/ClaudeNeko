// N-03 终端流背压：decideTermFlow 发送决策（纯函数表驱动）
// 决策只依赖 bufferedAmount + termStalled，逻辑与 TCP 缓冲时序解耦，稳定可测
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideTermFlow } from '../server/routes/terminal.js';

test('healthy clients keep streaming normally', () => {
  assert.deepEqual(decideTermFlow({ bufferedAmount: 0, termStalled: false }), { action: 'send' });
  assert.deepEqual(decideTermFlow({ bufferedAmount: 100 * 1024, termStalled: false }), { action: 'send' });
});

test('bufferedAmount above the high-water mark drops frames and stalls', () => {
  assert.deepEqual(decideTermFlow({ bufferedAmount: 1.5 * 1024 * 1024, termStalled: false }), { action: 'drop' });
  assert.deepEqual(decideTermFlow({ bufferedAmount: 2 * 1024 * 1024, termStalled: false }), { action: 'drop' });
});

test('a stalled client stays in skip while buffering drains back down', () => {
  // 缓冲仍在 LOW~HIGH 之间：不补不快照，继续丢实时帧
  assert.deepEqual(decideTermFlow({ bufferedAmount: 512 * 1024, termStalled: true }), { action: 'skip' });
  assert.deepEqual(decideTermFlow({ bufferedAmount: 1 * 1024 * 1024, termStalled: true }), { action: 'skip' });
});

test('a stalled client that drained below the low-water mark gets a replay snapshot', () => {
  assert.deepEqual(decideTermFlow({ bufferedAmount: 100 * 1024, termStalled: true }), { action: 'replay' });
  assert.deepEqual(decideTermFlow({ bufferedAmount: 0, termStalled: true }), { action: 'replay' });
});

test('a client above the hard water mark is closed regardless of stalled flag', () => {
  assert.deepEqual(decideTermFlow({ bufferedAmount: 9 * 1024 * 1024, termStalled: false }), { action: 'close' });
  assert.deepEqual(decideTermFlow({ bufferedAmount: 10 * 1024 * 1024, termStalled: true }), { action: 'close' });
});

test('boundary values resolve deterministically', () => {
  // 恰在高水位上（=1MiB）：未超 → 走 termStalled 分支，无标记 → send
  assert.deepEqual(decideTermFlow({ bufferedAmount: 1 * 1024 * 1024, termStalled: false }), { action: 'send' });
  // 恰在低水位上（=256KiB）：已丢帧但未充分回落 → skip
  assert.deepEqual(decideTermFlow({ bufferedAmount: 256 * 1024, termStalled: true }), { action: 'skip' });
  // 恰低于低水位 → replay
  assert.deepEqual(decideTermFlow({ bufferedAmount: 256 * 1024 - 1, termStalled: true }), { action: 'replay' });
});
