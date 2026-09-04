// web/src/updateCheck.js — 版本更新自动检测（弹框提示）
//
// 设计约束（9-04 排雷定稿）：
//  - 只在本机访问时检查（localhost/127.0.0.1），手机远程不弹（更新是电脑侧的事）
//  - GitHub API 4s 超时，失败/连不上全静默，绝不影响使用
//  - 同版本只提示一次；点过"稍后再说"24h 内不再弹；24h 内不重复查 GitHub
//  - 版本号数字段比较（v2.4.10 > v2.4.9）
//  - 下载地址硬编码，不信任远端返回 URL；更新说明仅当纯文本展示
//  - localStorage 手动开关 neko_no_update=1 可彻底关闭（开发期用）

const REPO = 'YTDX-158/ClaudeNeko';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const DOWNLOAD_URL = `https://github.com/${REPO}/releases`; // 下载按钮固定地址

const FETCH_TIMEOUT_MS = 4000;
const REMIND_INTERVAL_MS = 24 * 3600 * 1000; // 限频：24h
const SEEN_KEY = 'neko_seen_v'; // 已提示过的版本（同版本不再弹）
const LATER_KEY = 'neko_later_ts'; // 点"稍后再说"的时间
const CHECK_KEY = 'neko_last_check'; // 上次实际查 GitHub 的时间

/** 只在电脑本机访问（桌面浏览器）时才提示；手机/公网远程访问不弹 */
export function isLocalAccess() {
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** 纯数字版本串比较：a>b 返回 1，a<b 返回 -1，相等 0（v2.4.10 > v2.4.9 正确） */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** tag 转纯版本串：'v2.4.5' → '2.4.5' */
export function parseVersionTag(tag) {
  return String(tag || '').replace(/^v/i, '').trim();
}

/** 手动开关：localStorage neko_no_update=1 彻底关闭（开发期/不想被提示时） */
export function isDisabled() {
  try { return localStorage.getItem('neko_no_update') === '1'; } catch { return false; }
}

function readLS(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLS(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 隐私模式等：降级为会话内提示一次 */ }
}

export function markSeen(version) {
  writeLS(SEEN_KEY, version);
}
export function markLater() {
  writeLS(LATER_KEY, String(Date.now()));
}

async function fetchLatestRelease() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(RELEASES_API, {
      signal: ctrl.signal,
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.tag_name !== 'string') return null;
    return data;
  } catch {
    return null; // 网络失败/超时/被墙：全静默
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检查是否有值得提示的新版本。
 * 返回 { version, name, body } 表示该弹提示；返回 null = 不弹（无新版/网络失败/已看过/稍后再说中）。
 */
export async function checkForUpdate() {
  // 24h 限频：避免频繁打 GitHub
  const last = Number(readLS(CHECK_KEY) || 0);
  if (last && Date.now() - last < REMIND_INTERVAL_MS) return null;
  writeLS(CHECK_KEY, String(Date.now()));

  const data = await fetchLatestRelease();
  if (!data) return null;

  const version = parseVersionTag(data.tag_name);
  if (!version) return null;

  // 同版本已提示过 → 不再弹
  if (readLS(SEEN_KEY) === version) return null;
  // 点过"稍后再说"且 <24h → 不弹
  const later = Number(readLS(LATER_KEY) || 0);
  if (later && Date.now() - later < REMIND_INTERVAL_MS) return null;

  return {
    version,
    name: (typeof data.name === 'string' && data.name.trim()) ? data.name : `v${version}`,
    body: typeof data.body === 'string' ? data.body : '',
  };
}
