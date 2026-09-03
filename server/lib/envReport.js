// server/lib/envReport.js — 环境检测契约（接口 B）
// =================================================
// 与 ClaudeInstall scripts/lib/detect.js 同契约（schemaVersion 1），供 GET /api/env 使用。
// 结构：
//   { schemaVersion, node:{present,version}, npm:{...}, claude:{...},
//     config:{path, configured, provider, model}, claudeNeko:{present, path} }

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isConfigured, settingsPath } from './configService.js';

function versionOf(cmd) {
  // Windows 上 npm/claude 是 .cmd，必须经 shell；用整串字符串避开 DEP0190 弃用警告
  const r = spawnSync(cmd + ' --version', {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim();
}

// 已知中转域名 → provider；未知 → custom（与 ClaudeInstall 一致）
// 与前端 PROVIDERS（ModelSettings.jsx）对应；只做「域名归属」识别，供 /api/env 与当前生效卡片显示
const PROVIDER_TABLE = [
  ['api.deepseek.com', 'deepseek'],
  ['dashscope.aliyuncs.com', 'qwen'],
  ['open.bigmodel.cn', 'zhipu'],
  ['api.moonshot.cn', 'kimi'],
  ['api.minimaxi.com', 'minimax'],
  ['ark.cn-beijing.volces.com', 'volcengine'],
];

export function detectProvider(baseUrl) {
  if (!baseUrl) return null;
  for (const [domain, name] of PROVIDER_TABLE) {
    if (baseUrl.includes(domain)) return name;
  }
  return 'custom';
}

// 常用目录存在即视为已装（无副作用，不启动服务）；可被环境变量覆盖
// 自身推导：server 跑在哪，ClaudeNeko 就装在哪——不写死个人路径
const NEKO_PATHS = [
  fileURLToPath(new URL('../../', import.meta.url)),
];

export function detectNeko() {
  const extra = process.env.CLAUDE_NEKO_DIR;
  const candidates = extra ? [extra] : NEKO_PATHS;
  for (const p of candidates) {
    if (fs.existsSync(p)) return { present: true, path: p };
  }
  return { present: false, path: null };
}

export function detectEnv(home) {
  const nodeVer = versionOf('node');
  const npmVer = versionOf('npm');
  const claudeVer = versionOf('claude');

  const env = (() => {
    try {
      return JSON.parse(fs.readFileSync(settingsPath(home), 'utf-8')).env || {};
    } catch {
      return {};
    }
  })();

  return {
    schemaVersion: 1,
    node: { present: !!nodeVer, version: nodeVer },
    npm: { present: !!npmVer, version: npmVer },
    claude: { present: !!claudeVer, version: claudeVer },
    config: {
      path: path.join(home || os.homedir(), '.claude'),
      configured: isConfigured(home),
      provider: detectProvider(env.ANTHROPIC_BASE_URL),
      model: env.ANTHROPIC_MODEL || null,
    },
    claudeNeko: detectNeko(),
  };
}
