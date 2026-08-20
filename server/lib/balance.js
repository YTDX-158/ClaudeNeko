import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 读取 DeepSeek API Key。
 * 优先取环境变量，兜底解析 ~/.claude/settings.json 里的 ANTHROPIC_AUTH_TOKEN
 * （Claude Code CLI 走的同一把 key），key 只留在后端，绝不下发到前端。
 */
function readApiKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
    const env = JSON.parse(raw).env || {};
    return env.ANTHROPIC_AUTH_TOKEN || env.DEEPSEEK_API_KEY || null;
  } catch {
    return null;
  }
}

/**
 * 查询 DeepSeek 账户余额。
 * @returns {Promise<{ok:boolean, total_balance?:string, currency?:string, is_available?:boolean, error?:string}>}
 */
export function fetchBalance() {
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
