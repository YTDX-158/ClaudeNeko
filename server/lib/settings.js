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
  { id: 'deepseek-flash[1m]', label: 'DeepSeek V4.1 Flash' },
  { id: 'deepseek-v4-pro[1m]', label: 'DeepSeek V4 Pro（9-14 后路由到 Flash）' },
];

const DEFAULT_PORT = 4000;

/**
 * claude 子进程默认工作目录。
 * 面向市场：不做个人硬编码——默认 os.homedir()（大众合理值），
 * 需要自定义（如"加载某个目录的记忆"）时用环境变量 NEKO_WORK_CWD 覆盖。
 * 本人使用：在 ~/.claude/settings.json 的 env 里设 NEKO_WORK_CWD=C:\Windows\System32，
 * claude 即加载该目录对应记忆夹（用户画像/规则/知识库），让 Neko 对话"认识用户"。
 */
function resolveDefaultCwd() {
  if (process.env.NEKO_WORK_CWD) return process.env.NEKO_WORK_CWD;
  // 兼容老配置：曾硬编码在代码里，现在从 ~/.claude/settings.json 的 env 读（无则 homedir）
  try {
    const env = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).env || {};
    if (env.NEKO_WORK_CWD) return env.NEKO_WORK_CWD;
  } catch {
    // 忽略，用默认
  }
  return os.homedir();
}
const DEFAULT_WORK_CWD = resolveDefaultCwd();

/* ---------- 媒体生成配置（预设模型 + 用户填 baseUrl/key，见 mediaConfig.js；无全局 key 兜底） ---------- */

/** 生成媒体模型/参数（可用性由运行时动态判定，不写死；未开通模型点了给明确提示） */
const MEDIA = {
  imageModels: [
    { id: 'doubao-seedream-5-0-260128', label: 'Seedream 5.0 Lite' },
    { id: 'doubao-seedream-5-0-pro-260628', label: 'Seedream 5.0 Pro' },
  ],
  videoModels: [
    // 时长范围按火山官方文档逐模型核对（8-23→8-26 改范围）：2.0 支持 4K（独享并发/RPM低/更贵），2.5 支持 1080P（时长4-30s），mini/fast 仅 480/720
    // 顺序 9-03 调整：Mini / Fast / 2.0 / 2.5（常用靠前），输入区与设置配置页同源于此
    { id: 'doubao-seedance-2-0-mini-260615', label: 'Seedance 2.0 Mini', durationRange: { min: 4, max: 15 }, resolutions: ['480P', '720P'] },
    { id: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast', durationRange: { min: 4, max: 15 }, resolutions: ['480P', '720P'] },
    { id: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0', durationRange: { min: 4, max: 15 }, resolutions: ['480P', '720P', '1080P', '4K'] },
    { id: 'doubao-seedance-2-5-260628', label: 'Seedance 2.5', durationRange: { min: 4, max: 30 }, resolutions: ['480P', '720P', '1080P'] },
  ],
  ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  // 生图分辨率档位（Seedream 5.0：目标像素，最终尺寸由 mediaGen 按比例+clamp 计算）
  imageResolutions: [
    { id: '2K', label: '2K' },
    { id: '3K', label: '3K' },
    { id: '4K', label: '4K' },
  ],
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

  throw new Error(
    '未找到 Claude Code（claude.exe）。\n' +
      '请先装好 Claude Code：运行 ClaudeInstall 一键安装器\n' +
      '  下载：https://wwbkn.lanzoum.com/b01giav0jc（密码 YTDX666）\n' +
      '或设置环境变量 CLAUDE_BIN 指向 claude.exe 的绝对路径。',
  );
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
    defaultCwd: DEFAULT_WORK_CWD,
    dataDir,
    port: Number(process.env.PORT) || DEFAULT_PORT,
    media: { ...MEDIA },
  };
}
