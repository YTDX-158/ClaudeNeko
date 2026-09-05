// server/lib/permissionConfig.js — ClaudeNeko 权限体系配置（权限体系 P1）
// =============================================================
// 存 ClaudeNeko 自己的 data 目录（不动用户 ~/.claude settings 的 permissions）：
//   文件: {dataDir}/permissionConfig.json  { mode, allow[], deny[] }
// mode 三档（全局权限策略，P1-4 设置页单选）：
//   ask   = ①请求批准（外部编辑/联网始终询问 → 全部上浮卡片）
//   smart = ②替我审批（默认·只对风险操作问 → 黑白名单先判）
//   bypass= ③完全访问（不询问 → ptyHost 传 bypassPermissions）
// allow/deny = 档②黑白名单规则（P1-5 用）+ 「总是允许」写入区（P1-3 卡片）

import fs from 'node:fs';
import path from 'node:path';

export const PERMISSION_MODES = { ask: 'ask', smart: 'smart', bypass: 'bypass' };
export const PERMISSION_LABELS = { ask: '请求批准', smart: '替我审批', bypass: '完全访问' };
const VALID_MODES = Object.values(PERMISSION_MODES);
const DEFAULT_MODE = PERMISSION_MODES.smart; // 默认档②（用户拍板）

/** 把 ClaudeNeko 权限档翻译成 claude CLI 的 --permission-mode 值。
 *  P0 实锤：全局 bypass/allow 会吞权限请求(hook 不触发) → 档①②必须显式 default；
 *  只有档③完全访问传 bypassPermissions。 */
export function toClaudePermissionMode(nekoMode) {
  return nekoMode === PERMISSION_MODES.bypass ? 'bypassPermissions' : 'default';
}

export function createPermissionConfig({ dataDir }) {
  const file = path.join(dataDir, 'permissionConfig.json');

  function read() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return { mode: DEFAULT_MODE };
    }
  }
  function write(obj) {
    fs.mkdirSync(dataDir, { recursive: true });
    // 原子写（临时文件 + rename），防写一半损坏
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  }

  return {
    /** 读全部配置：{ mode, allow[], deny[] } */
    get() {
      const d = read();
      return {
        mode: VALID_MODES.includes(d.mode) ? d.mode : DEFAULT_MODE,
        allow: Array.isArray(d.allow) ? d.allow : [],
        deny: Array.isArray(d.deny) ? d.deny : [],
      };
    },
    getMode() { return this.get().mode; },
    setMode(mode) {
      if (!VALID_MODES.includes(mode)) throw new Error(`invalid permission mode: ${mode}`);
      const d = read(); d.mode = mode; write(d); return this.get();
    },
    /** 档②黑白名单（P1-5）/ 卡片「总是允许」写入（P1-3）：allow/deny 为工具规则串数组 */
    getRules() { const d = read(); return { allow: d.allow || [], deny: d.deny || [] }; },
    addAllow(rule) { const d = read(); if (!d.allow.includes(rule)) d.allow.push(rule); write(d); return d.allow; },
    removeAllow(rule) { const d = read(); d.allow = (d.allow || []).filter((x) => x !== rule); write(d); return d.allow; },
    addDeny(rule) { const d = read(); if (!d.deny.includes(rule)) d.deny.push(rule); write(d); return d.deny; },
    removeDeny(rule) { const d = read(); d.deny = (d.deny || []).filter((x) => x !== rule); write(d); return d.deny; },
  };
}
