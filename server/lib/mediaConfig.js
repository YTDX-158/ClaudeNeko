// server/lib/mediaConfig.js — 生图生视频预设 + 视觉理解 配置管理（mediaConfig.json）
// =====================================================================
// 结构：{ image: { 模型id: { baseUrl, apiKey } }, video: { 模型id: { baseUrl, apiKey } }, vision: { baseUrl, apiKey, model } }
// 固定预设模型（与 settings.js MEDIA 对应），用户只填 baseUrl/apiKey，填什么生成时用什么；
// 没配的模型生成时抛「未配置」提示，不再有全局 key 兜底。
// 存 ClaudeNeko 自有 data/mediaConfig.json（不污染 ~/.claude）。

import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './dataStore.js';

/** 跨进程写锁（防多实例并发写 mediaConfig.json 互相覆盖）：独占创建 .lock，最多等 2s。 */
function withFileLock(lockFile, fn) {
  const start = Date.now();
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx'); // 独占创建：已存在（另一实例在写）则抛错
      fs.closeSync(fd);
      break;
    } catch {
      if (Date.now() - start > 2000) throw new Error('mediaConfig 写锁超时（可能有另一实例在写）');
      sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockFile); } catch { /* 已删/不存在 */ }
  }
}

export function createMediaConfig({ dataDir }) {
  const file = path.join(dataDir, 'mediaConfig.json');
  const EMPTY = { image: {}, video: {}, vision: { baseUrl: '', apiKey: '', model: '' } };

  function load() {
    return normalize(readJson(file, EMPTY));
  }
  function save(d) {
    writeJson(file, d);
  }

  /** 归一化：老「数组条目」结构 → 新「对象预设」结构。老自定义条目清掉（用户拍板）；vision 只读配置页。 */
  function normalize(d) {
    if (!d || typeof d !== 'object') return { ...EMPTY };
    const asMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}); // 数组（老条目）→ 丢弃
    const vision = d.vision && typeof d.vision === 'object' && !Array.isArray(d.vision)
      ? { baseUrl: d.vision.baseUrl || '', apiKey: d.vision.apiKey || '', model: d.vision.model || '' }
      : { ...EMPTY.vision };
    return { image: asMap(d.image), video: asMap(d.video), vision };
  }

  /** 读某生成模型配置（image|video）。apiKey 为空视为未配置 → null */
  function getConfig(kind, modelId) {
    const m = load()[kind] || {};
    const hit = m[modelId];
    return hit && hit.apiKey ? { baseUrl: hit.baseUrl || '', apiKey: hit.apiKey } : null;
  }

  /** 写某生成模型配置；apiKey 为空 = 清掉该配置（回到未配置态）。跨进程锁防多实例覆盖。 */
  function setConfig(kind, modelId, { baseUrl, apiKey }) {
    return withFileLock(`${file}.lock`, () => {
      const d = load();
      if (apiKey) d[kind][modelId] = { baseUrl: baseUrl || '', apiKey };
      else delete d[kind][modelId];
      save(d);
    });
  }

  /** 读视觉理解配置（未配 → null） */
  function getVision() {
    const v = load().vision;
    return v && v.apiKey ? { baseUrl: v.baseUrl || '', apiKey: v.apiKey, model: v.model || '' } : null;
  }

  /** 写视觉理解配置；apiKey 为空 = 清。跨进程锁防多实例覆盖。 */
  function setVision({ baseUrl, apiKey, model }) {
    return withFileLock(`${file}.lock`, () => {
      const d = load();
      d.vision = apiKey ? { baseUrl: baseUrl || '', apiKey, model: model || '' } : { ...EMPTY.vision };
      save(d);
    });
  }

  /** 是否已有任一配置（image/video/vision 任一有 key）——输入区「未配置」提示用 */
  function hasAnyKey() {
    const d = load();
    for (const kind of ['image', 'video']) {
      for (const m of Object.values(d[kind] || {})) if (m && m.apiKey) return true;
    }
    return !!(d.vision && d.vision.apiKey);
  }

  return { getConfig, setConfig, getVision, setVision, hasAnyKey };
}
