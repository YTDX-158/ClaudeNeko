// server/lib/modelConfig.js — 对话模型档案管理（profiles.json）
// =============================================================
// 档案 = 一套完整接入配置：{ name: { provider, baseUrl, model, authToken } }
// 存 ClaudeNeko 自有 data/profiles.json；「切换」= 写 ~/.claude env（configService）+ 标记 current。
// 只存档案数据，不直接操作 ~/.claude（那是 configService 的事）。

import path from 'node:path';
import { readJson, writeJson } from './dataStore.js';

export function createModelConfig({ dataDir }) {
  const file = path.join(dataDir, 'profiles.json');

  function load() {
    return readJson(file, { profiles: {}, current: null });
  }
  function save(d) {
    writeJson(file, d);
  }

  /** 列出所有档案名 + 当前生效的档案名 */
  function listProfiles() {
    const d = load();
    return { profiles: Object.keys(d.profiles), current: d.current };
  }

  /** 取单个档案（含 key，仅服务端用；对外返回要脱敏） */
  function getProfile(name) {
    return load().profiles[name] || null;
  }

  /** 保存/覆盖一个档案 */
  function saveProfile(name, data) {
    const d = load();
    d.profiles[name] = data;
    save(d);
  }

  /** 删除档案；若删的是 current，则 current 清空 */
  function deleteProfile(name) {
    const d = load();
    delete d.profiles[name];
    if (d.current === name) d.current = null;
    save(d);
  }

  /** 标记某档案为"当前生效"（写入 ~/.claude env 由调用方做） */
  function setCurrent(name) {
    const d = load();
    if (!d.profiles[name]) return false;
    d.current = name;
    save(d);
    return true;
  }

  return { listProfiles, getProfile, saveProfile, deleteProfile, setCurrent };
}
