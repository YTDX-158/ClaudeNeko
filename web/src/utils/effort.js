/**
 * 思考档位工具：省 / 标准 / 强力 → DeepSeek effort 值。
 * 标准 = null（不传 --effort，走 DeepSeek 默认档），省 = low，强力 = max。
 * 依据 DeepSeek V4 官方：有效档位只有 low / high(默认) / max。
 */

export const EFFORT_LEVELS = [
  { id: 'low', label: '🪙 省', tip: '简单问答，省 token' },
  { id: null, label: '⭐ 标准', tip: 'DeepSeek 默认思考' },
  { id: 'max', label: '💪 强力', tip: '复杂任务，深度思考' },
];

const KEY = 'claudeneko:default-effort';

/** 读全局默认档（localStorage；默认标准 = null） */
export function readDefaultEffort() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'low' || v === 'max' ? v : null;
  } catch {
    return null;
  }
}

/** 写全局默认档（null 表示标准，清除记录） */
export function setDefaultEffort(eff) {
  try {
    if (eff === 'low' || eff === 'max') localStorage.setItem(KEY, eff);
    else localStorage.removeItem(KEY);
  } catch {
    // localStorage 不可用时忽略（不影响主流程）
  }
}

/** 档位显示名（用于会话头部展示） */
export function effortLabel(eff) {
  if (eff === 'low') return '🪙 省';
  if (eff === 'max') return '💪 强力';
  return '⭐ 标准';
}
