import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isDeepSeekEndpoint(baseUrl) {
  try {
    const url = new URL(String(baseUrl || ''));
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    return false;
  }
}

/**
 * 从同一配置来源中选择明确绑定到 DeepSeek 的凭据。
 * 专用密钥优先；兼容 Claude Code 的通用 token 时，必须由同源的 DeepSeek HTTPS 地址约束。
 */
export function selectDeepSeekApiKey(...sources) {
  for (const env of sources) {
    if (env?.DEEPSEEK_API_KEY) return env.DEEPSEEK_API_KEY;
  }
  for (const env of sources) {
    if (env?.ANTHROPIC_AUTH_TOKEN && isDeepSeekEndpoint(env.ANTHROPIC_BASE_URL)) {
      return env.ANTHROPIC_AUTH_TOKEN;
    }
  }
  return null;
}

function readSettingsEnv() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
    return JSON.parse(raw).env || {};
  } catch {
    return {};
  }
}

function readApiKey() {
  return selectDeepSeekApiKey(process.env, readSettingsEnv());
}

/**
 * 查询 DeepSeek 账户余额。
 * @returns {Promise<{ok:boolean, total_balance?:string, currency?:string, is_available?:boolean, error?:string}>}
 */
function doFetch() {
  const key = readApiKey();
  if (!key) return Promise.resolve({ ok: false, error: '未配置 DeepSeek API Key' });

  return new Promise((resolve) => {
    const req = https.get(
      'https://api.deepseek.com/user/balance',
      { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, timeout: 8000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            const info = j.balance_infos?.[0];
            if (info) {
              resolve({
                ok: true,
                total_balance: info.total_balance,
                currency: info.currency,
                is_available: j.is_available !== false,
              });
            } else {
              resolve({ ok: false, error: j.error?.message || '响应格式异常' });
            }
          } catch {
            resolve({ ok: false, error: '解析余额响应失败' });
          }
        });
      },
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: '查询超时' });
    });
  });
}

// 30 秒短期缓存：连点 claude娘 不会反复打 DeepSeek 接口
const CACHE_MS = 30000;
let _cache = null;
let _cacheAt = 0;

export function fetchBalance() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_MS) return Promise.resolve(_cache);
  return doFetch().then((r) => {
    _cache = r;
    _cacheAt = now;
    return r;
  });
}
