// server/lib/remote/pairing.js — 远程配对凭证存储
// 从 @inksnow/c2web (MIT) 的 config.mjs 迁移改造：
//   - 配置路径 ~/.c2web → ~/.claudeneko（不与 c2 串数据）
//   - 配对码动态生成（c2 是写死的 FIXED_PAIR_CODE，开源后全公开，必须动态）
//   - sessions 存设备凭证的 SHA-256 哈希，明文只在校对那一刻发给手机
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'fs';
import { randomInt } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';

/** 配置目录：放用户 home 下，避开全局安装/只读目录 */
const CONFIG_DIR = join(homedir(), '.claudeneko');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const PAIRCODE_FILE = join(CONFIG_DIR, 'paircode');

// 内存缓存：启动/首次读盘后驻留内存，hasSession 不再每次同步读盘（热路径优化）
let cache = null;
function readConfig() {
  if (cache) return cache;
  let cfg = { sessions: [] };
  if (existsSync(CONFIG_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      if (Array.isArray(parsed.sessions)) cfg = { sessions: parsed.sessions };
      // 损坏/非预期结构 → 用空 sessions 兜底，不崩进程
    } catch {
      console.error('[pairing] config.json 解析失败，已重置为空（原文件损坏）');
    }
  }
  cache = cfg;
  return cache;
}

function writeConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // 原子写：先写临时文件再 rename，避免写一半被杀导致 config.json 截断损坏
  const tmp = CONFIG_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  try {
    renameSync(tmp, CONFIG_FILE);
  } catch {
    // 极端情况 rename 失败（被占用等），退化为直接写
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  }
  cache = cfg;
}

/** 记录一台新配对设备的凭证哈希（去重），使其跨重启免再配对 */
export function addSession(hash) {
  const cfg = readConfig();
  if (!cfg.sessions.includes(hash)) {
    cfg.sessions.push(hash);
    writeConfig(cfg);
  }
}

/** 该凭证哈希是否已配对 */
export function hasSession(hash) {
  return readConfig().sessions.includes(hash);
}

/** 清空全部已配对设备（换码/关闭远程时调用：旧设备全部失效，需重新配对） */
export function clearSessions() {
  writeConfig({ sessions: [] });
}

/** 生成新的 8 位配对码并落盘（供前端显示），返回明文码 */
export function generatePairCode() {
  const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PAIRCODE_FILE, code + '\n', { encoding: 'utf8', mode: 0o600 });
  return code;
}

/** 读取当前配对码（未生成返回 null） */
export function readPairCode() {
  try {
    return readFileSync(PAIRCODE_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

/** 删除配对码文件 */
export function clearPairCode() {
  try {
    rmSync(PAIRCODE_FILE, { force: true });
  } catch {
    // 不存在即可
  }
}
