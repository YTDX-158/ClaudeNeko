// server/lib/logger.js — 轻量日志（9-03 建）：时间戳 + 级别 + 写文件 + 轮转 + 敏感屏蔽
// 不用第三方库（本地单用户工具，自写足够；避开 console 全局包装的污染/无法分级问题）
//   - 级别过滤：LOG_LEVEL=debug|info|warn|error（默认 info；debug 只在调查时开）
//   - 写文件：appendFileSync → server/log.txt（logger 自管，不依赖外部 >> 重定向）
//   - 轮转：log.txt > 10MB → 改名 log.old.txt 重新记（单写者自检，无竞争）
//   - 敏感屏蔽：序列化对象时 apiKey/secret/token 等字段 → ***（防凭证泄漏进日志，9-03 教训）
//   - Error 特判：打 err.stack 而非 [object Object]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); // server/
export const LOG_FILE = path.join(LOG_DIR, 'log.txt');
const MAX_SIZE = 10 * 1024 * 1024; // 10MB 轮转阈值
/** 归档文件名：保留最近 3 份（log.old.1.txt ~ log.old.3.txt，从旧到新） */
const oldFile = (n) => LOG_FILE.replace(/\.txt$/, `.old.${n}.txt`);

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
const THRESHOLD = LEVEL_ORDER[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVEL_ORDER.info;

// 敏感字段正则：对象键命中即屏蔽（防 API key / token 泄漏）
const SENSITIVE = /(api[_-]?key|secret|token|password|authorization)/i;

/** 本地时间 + 时区偏移（如 2026-09-03 08:12:33 GMT+08:00），排雷对时序 + 回传无时区歧义 */
function fmtTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} GMT${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/** 对象序列化 + 敏感字段屏蔽（循环引用防爆） */
function mask(obj) {
  try {
    const seen = new WeakSet();
    const rec = (o) => {
      if (!o || typeof o !== 'object') return o;
      if (seen.has(o)) return '[循环引用]';
      seen.add(o);
      if (o instanceof Error) return String(o.stack || o);
      if (Array.isArray(o)) return o.map(rec);
      const out = {};
      for (const [k, v] of Object.entries(o)) out[k] = SENSITIVE.test(k) ? '***' : rec(v);
      return out;
    };
    return JSON.stringify(rec(obj));
  } catch {
    return String(obj);
  }
}

/** 参数 → 单行文本：Error 打 stack、对象过 mask、其余转字符串 */
function fmtArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || String(a);
      if (typeof a === 'object' && a !== null) return mask(a);
      return String(a);
    })
    .join(' ');
}

/** 写前轮转检查：超 10MB → 滚动归档保留最近 3 份（Windows 占用则本轮跳过，下轮重试） */
function ensureRotate() {
  try {
    if (fs.statSync(LOG_FILE).size > MAX_SIZE) {
      // 兼容旧命名 log.old.txt（历史单份产物）→ 并入 .1（位置空则改名，否则删旧的）
      const legacy = LOG_FILE.replace(/\.txt$/, '.old.txt');
      if (fs.existsSync(legacy)) {
        try {
          if (!fs.existsSync(oldFile(1))) fs.renameSync(legacy, oldFile(1));
          else fs.unlinkSync(legacy);
        } catch { /* 占用则忽略 */ }
      }
      // 从旧到新滚（每步独立 try，失败不中断链）：删 .3 → .2→.3 → .1→.2 → log.txt→.1
      const del = (p) => { try { fs.unlinkSync(p); } catch { /* 不存在/占用 */ } };
      const mv = (a, b) => { try { fs.renameSync(a, b); } catch { /* 占用 */ } };
      del(oldFile(3));
      mv(oldFile(2), oldFile(3));
      mv(oldFile(1), oldFile(2));
      mv(LOG_FILE, oldFile(1));
    }
  } catch {
    // log.txt 不存在（首次），正常
  }
}

function write(level, tag, args) {
  if (LEVEL_ORDER[level] < THRESHOLD) return; // 级别过滤（低于阈值的直接跳过，省格式化）
  const line = `[${fmtTs()}] [${level.toUpperCase().padEnd(5)}]${tag ? ` [${tag}]` : ''} ${fmtArgs(args)}\n`;
  try {
    ensureRotate();
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    // 日志写失败不影响主流程
  }
}

export const logger = {
  debug: (tag, ...a) => write('debug', tag, a),
  info: (tag, ...a) => write('info', tag, a),
  warn: (tag, ...a) => write('warn', tag, a),
  error: (tag, ...a) => write('error', tag, a),
  mask,
  LOG_FILE,
};

/**
 * 读 log.txt 尾部 N 行（供设置页日志面板）。
 * 边界处理：① 读末尾段从第一个 \n 截（防 UTF-8 多字节切坏首行）② 每行去尾部 \r（旧格式兼容）
 * ③ 末行无 \n 结尾 = logger 正在写入的半行 → 容忍保留（实时场景，下次刷新完整）④ 返回最多 lines 行。
 */
export function tailLog(lines = 300, maxBytes = 1024 * 1024) {
  try {
    const st = fs.statSync(LOG_FILE);
    if (!st.size) return [];
    const len = Math.min(st.size, maxBytes);
    const fd = fs.openSync(LOG_FILE, 'r');
    let text;
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // 从读到的边界往后找第一个 \n（丢弃被切坏的半行开头，只当文件比读窗大时）
    if (st.size > len) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    // 按行分割 + 去行尾 \r；结尾 \n 产生的空末行去掉
    const parts = text.split('\n').map((l) => l.replace(/\r$/, ''));
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts.slice(-lines);
  } catch {
    return [];
  }
}
