// server/lib/remote/pairing.js — 远程配对凭证存储
// 从 @inksnow/c2web (MIT) 的 config.mjs 迁移改造：
//   - 配置路径 ~/.c2web → ~/.claudeneko（不与 c2 串数据）
//   - 配对码动态生成（c2 是写死的 FIXED_PAIR_CODE，开源后全公开，必须动态）
//   - sessions 存设备凭证的 SHA-256 哈希，明文只在校对那一刻发给手机
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { randomInt } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';

/** 配置目录：放用户 home 下，避开全局安装/只读目录 */
const CONFIG_DIR = join(homedir(), '.claudeneko');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const PAIRCODE_FILE = join(CONFIG_DIR, 'paircode');

function readConfig() {
  if (existsSync(CONFIG_FILE)) {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    if (!Array.isArray(cfg.sessions)) cfg.sessions = [];
    return cfg;
  }
  return { sessions: [] };
}

function writeConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
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
