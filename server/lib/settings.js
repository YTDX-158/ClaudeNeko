import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 支持的模型。DeepSeek 不接受 claude 内置的 anthropic 模型名，
 * 直接传完整模型串给 --model，由 API 端解析。
 */
const MODELS = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
];

const DEFAULT_PORT = 4000;

/** 探测 claude.exe：先查已知安装路径，失败则用 npm prefix -g 拼路径。 */
function findClaudeBin() {
  const knownPaths = [
    process.env.CLAUDE_BIN,
    path.join(
      process.env.APPDATA ?? '',
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    ),
  ].filter(Boolean);

  for (const p of knownPaths) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const prefix = execSync('npm prefix -g').toString().trim();
    const p = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(p)) return p;
  } catch {
    // 忽略，下面统一抛错
  }

  throw new Error('未找到 claude.exe，请设置环境变量 CLAUDE_BIN 指向其绝对路径');
}

/**
 * 解析运行时配置。
 * @returns {{ claudeBin: string, models: {id:string,label:string}[], defaultModel: string, defaultCwd: string, dataDir: string, port: number }}
 */
export function resolveConfig() {
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = path.join(serverDir, '..', 'data');

  return {
    claudeBin: findClaudeBin(),
    models: MODELS,
    defaultModel: MODELS[0].id,
    defaultCwd: os.homedir(),
    dataDir,
    port: Number(process.env.PORT) || DEFAULT_PORT,
  };
}
