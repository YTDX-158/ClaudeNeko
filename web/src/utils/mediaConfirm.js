/**
 * 生成确认开关：生成图片/视频前是否弹确认框（设置→功能页开关，默认开）。
 * 默认开 = 防误触白白消耗 API 额度（生成前先确认一次）。
 * 键名 claudeneko:confirm-media 与 skinEngine 的 FUNCTION_KEYS 同步——
 * 「恢复功能默认」会清掉它（回到默认开）。
 */

const KEY = 'claudeneko:confirm-media';

/** 读当前开关（默认开 = true；仅显式 '0' 时关） */
export function readConfirmMedia() {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

/** 写开关（true=开并清键回默认；false=显式关，写 '0'） */
export function setConfirmMedia(on) {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, '0');
  } catch {
    // localStorage 不可用时忽略（默认开，不影响主流程）
  }
}
