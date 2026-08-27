// server/lib/mediaConfig.js — 生图生视频模型条目管理（mediaConfig.json）
// =====================================================================
// 结构：{ image: [条目], video: [条目] }
// 条目 = { id, name, provider, baseUrl, model, apiKey }
// 支持「每个模型不同 API」：每条目独立供应商/baseUrl/key。
// 存 ClaudeNeko 自有 data/mediaConfig.json（不污染 ~/.claude）。

import path from 'node:path';
import { readJson, writeJson } from './dataStore.js';

export function createMediaConfig({ dataDir }) {
  const file = path.join(dataDir, 'mediaConfig.json');

  function load() {
    return readJson(file, { image: [], video: [] });
  }
  function save(d) {
    writeJson(file, d);
  }

  /** 列出某类条目（image | video） */
  function listItems(kind) {
    return load()[kind] || [];
  }

  /** 取单个条目 */
  function getItem(kind, id) {
    return (load()[kind] || []).find((x) => x.id === id) || null;
  }

  /** 新增条目（无 id 自动生成） */
  function addItem(kind, item) {
    const d = load();
    d[kind] = d[kind] || [];
    d[kind].push({ ...item, id: item.id || `m-${Date.now()}` });
    save(d);
    return d[kind][d[kind].length - 1];
  }

  /** 更新条目（按 id） */
  function updateItem(kind, id, patch) {
    const d = load();
    const i = (d[kind] || []).findIndex((x) => x.id === id);
    if (i < 0) return false;
    d[kind][i] = { ...d[kind][i], ...patch };
    save(d);
    return true;
  }

  /** 删除条目 */
  function removeItem(kind, id) {
    const d = load();
    d[kind] = (d[kind] || []).filter((x) => x.id !== id);
    save(d);
  }

  return { listItems, getItem, addItem, updateItem, removeItem };
}
