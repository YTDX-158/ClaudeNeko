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

/* ---------- 媒体生成配置（BYOK：豆包 key 从 env / ~/.claude/settings.json 读，不硬编码） ---------- */
// 豆包账号级 key：优先 DOUBAO_API_KEY，VISION_API_KEY 兜底（同账号视觉 key 可调 Seedream/Seedance，零额外配置）
function readDoubaoKey() {
  const keys = ['DOUBAO_API_KEY', 'VISION_API_KEY'];
  for (const k of keys) if (process.env[k]) return process.env[k];
  try {
    const env = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).env || {};
    for (const k of keys) if (env[k]) return env[k];
  } catch {
    // 忽略，返回空
  }
  return '';
}

/** 生成媒体模型/参数（可用性由运行时动态判定，不写死；未开通模型点了给明确提示） */
const MEDIA = {
  imageModels: [
    { id: 'doubao-seedream-5-0-260128', label: 'Seedream 5.0 Lite' },
    { id: 'doubao-seedream-5-0-pro-260628', label: 'Seedream 5.0 Pro' },
  ],
  videoModels: [
    // 分辨率/时长按火山官方文档逐模型核对（8-23）：2.0 支持 4K（独享并发/RPM低/更贵），2.5 支持 1080P（时长4-30s），mini/fast 仅 480/720
    { id: 'doubao-seedance-2-5-260628', label: 'Seedance 2.5', durations: [4, 5, 10, 15, 30], resolutions: ['480P', '720P', '1080P'] },
    { id: 'doubao-seedance-2-0-mini-260615', label: 'Seedance 2.0 Mini', durations: [4, 5, 10, 15], resolutions: ['480P', '720P'] },
    { id: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0', durations: [4, 5, 10, 15], resolutions: ['480P', '720P', '1080P', '4K'] },
    { id: 'doubao-seedance-2-0-fast-260128', label: 'Seedance Fast', durations: [4, 5, 10, 15], resolutions: ['480P', '720P'] },
  ],
  ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  // 生图分辨率档位（Seedream 5.0：目标像素，最终尺寸由 mediaGen 按比例+clamp 计算）
  imageResolutions: [
    { id: '2K', label: '2K' },
    { id: '3K', label: '3K' },
    { id: '4K', label: '4K' },
  ],
  downloadBlacklist: [],
  transcribeEnabled: true,
};

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
    media: { ...MEDIA, doubaoKey: readDoubaoKey() },
  };
}
