// server/lib/hookManager.js — PermissionRequest hook 注入管理（权限体系 P1-2）
// =============================================================
// ClaudeNeko 启动时把 PermissionRequest hook 注册进 ~/.claude/settings.json，
// 让本机所有 claude 会话的权限请求都经过 ClaudeNeko 审批通道。
// 保留用户已有 hooks（PreToolUse 等）；hook 指向本 server 的转发脚本，路径随安装目录变 → 每次比对刷新（B8）。
// ⚠ 兜底：hook 脚本连不上本 server（ClaudeNeko 没跑）→ 立即空输出 → claude 走原生询问，
//   所以用户不开 ClaudeNeko 时 hook 零干扰（多 ~50ms 一次权限请求，可接受）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settingsPath, readSettings } from './configService.js';
import { logger } from './logger.js';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); // server/
const HOOK_SCRIPT = path.join(SERVER_DIR, 'permission_hook.cjs');

function desiredEntry(hookScript) {
  return { hooks: [{ type: 'command', command: `node "${hookScript}"` }] };
}

function isNekoPermissionEntry(entry) {
  return Array.isArray(entry?.hooks) && entry.hooks.some((hook) => (
    hook?.type === 'command'
    && typeof hook.command === 'string'
    && /permission_hook\.cjs(?:["']|\s|$)/i.test(hook.command)
  ));
}

/** 确保 ~/.claude/settings.json 的 hooks.PermissionRequest 指向本 server 转发脚本。
 *  读-改-写（保留用户全部字段 incl. env/key/PreToolUse）；返回 true=本次写入过。 */
export function ensurePermissionHook({ home = os.homedir(), hookScript = HOOK_SCRIPT } = {}) {
  const p = settingsPath(home);
  const cfg = readSettings(home);
  const desired = desiredEntry(hookScript);
  const current = Array.isArray(cfg.hooks?.PermissionRequest) ? cfg.hooks.PermissionRequest : [];
  const merged = [];
  let inserted = false;
  for (const entry of current) {
    if (!isNekoPermissionEntry(entry)) {
      merged.push(entry);
      continue;
    }
    if (!inserted) {
      merged.push(desired);
      inserted = true;
    }
  }
  if (!inserted) merged.push(desired);
  if (JSON.stringify(current) === JSON.stringify(merged)) return false;
  cfg.hooks = cfg.hooks || {};
  cfg.hooks.PermissionRequest = merged;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
  logger.info('hookManager', `已注入/更新 PermissionRequest hook → ${hookScript}`);
  return true;
}
