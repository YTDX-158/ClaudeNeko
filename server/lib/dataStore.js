// server/lib/dataStore.js — 通用 JSON 文件存储（原子写）
// 供 profiles.json（对话模型档案）/ mediaConfig.json（媒体模型条目）使用。
// 原子写：写 tmp → rename，避免中途崩溃留下半截文件（复用 mediaGen 的落盘模式）。

import fs from 'node:fs';
import path from 'node:path';

/** 读 JSON 文件；不存在/损坏 → 返回 fallback */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 写 JSON 文件（原子：tmp + rename）；父目录不存在会自动创建 */
export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
