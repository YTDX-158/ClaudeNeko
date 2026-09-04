// routes/export.js — 会话导出（单会话 JSON / 全部打包 zip）。8-27 Phase1 拆分：从 sessions.js 搬出，逻辑零改动。
// 改导出只动本文件（见 docs/架构地图.md）。
import { sendJson } from '../lib/util.js';
import { createZip } from '../lib/zip.js';

const EXPORT_MAX_SESSIONS = 200; // 备份全部：会话数上限（防全内存打包 OOM/阻塞）
const EXPORT_MAX_BYTES = 500 * 1024 * 1024; // 备份全部：总字节上限（同 media 导出）

/** 清理孤立代理对（标题可能被 slice(0,15) 切断 emoji 而产生孤代理；留着会让 encodeURIComponent 抛 URIError）。合法成对 emoji 保留。 */
function stripLoneSurrogates(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      }
      // 孤高代理：丢弃
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // 孤低代理：丢弃
    } else {
      out += s[i];
    }
  }
  return out;
}

/** 文件名消毒：去路径分隔符/Windows 控制字符(0-31)/保留设备名/孤立代理对，限长；空则用 fallback。 */
function safeFilename(name, fallback) {
  let cleaned = String(name ?? '').replace(/[\\/:*?"<>|]/g, '_').replace(/[\x00-\x1f]/g, '_');
  cleaned = stripLoneSurrogates(cleaned);
  // Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）：加前缀下划线防拒存
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(cleaned.trim())) cleaned = `_${cleaned}`;
  cleaned = cleaned.slice(0, 60).trim();
  return cleaned || fallback;
}

export class ExportLimitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExportLimitError';
    this.code = code;
    this.status = 413;
  }
}

/** 在创建 ZIP 前完整收集并校验；任一上限触发时不返回部分文件。 */
export function prepareSessionExport(sessions, readMessages, {
  maxSessions = EXPORT_MAX_SESSIONS,
  maxBytes = EXPORT_MAX_BYTES,
} = {}) {
  if (sessions.length > maxSessions) {
    throw new ExportLimitError(
      'EXPORT_SESSION_LIMIT',
      `会话数量超过 ${maxSessions} 个导出上限，未生成备份；请减少会话或分批导出`,
    );
  }
  const files = [];
  const usedNames = new Set();
  let totalSize = 0;
  for (const session of sessions) {
    const data = Buffer.from(JSON.stringify({
      version: 1,
      session,
      messages: readMessages(session.id),
    }), 'utf8');
    if (totalSize + data.length > maxBytes) {
      const maxMb = maxBytes / (1024 * 1024);
      const limitLabel = Number.isInteger(maxMb) && maxMb >= 1 ? `${maxMb}MB` : `${maxBytes} 字节`;
      throw new ExportLimitError(
        'EXPORT_SIZE_LIMIT',
        `会话数据超过 ${limitLabel} 导出上限，未生成备份；请减少会话或分批导出`,
      );
    }
    totalSize += data.length;
    let name = `${safeFilename(session.title, session.id)}.json`;
    let suffix = 1;
    while (usedNames.has(name)) {
      name = `${name.slice(0, -5)}(${suffix}).json`;
      suffix += 1;
    }
    usedNames.add(name);
    files.push({ name, data });
  }
  return { files, totalSize };
}

export function exportHandler(ctx) {
  const { store, isLocalRequest } = ctx;
  return async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;

    // 会话导出：单个 JSON / 全部打包 zip（复用 zip.js，零依赖）
    const exOne = pathname.match(/^\/api\/sessions\/([^/]+)\/export$/);
    if (exOne && method === 'GET') {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      const id = exOne[1];
      const session = store.get(id);
      if (!session) return sendJson(res, 404, { error: '会话不存在' });
      const data = JSON.stringify({ version: 1, session, messages: store.readMessages(id) }, null, 2);
      const fname = `${safeFilename(session.title, 'session')}.json`;
      res.on('error', () => {}); // 客户端断开（EPIPE）不崩进程（审查②）
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fname.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
      });
      res.end(data);
      return;
    }

    if (method === 'GET' && pathname === '/api/sessions/export-all') {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      const sessions = store.list();
      let prepared;
      try {
        prepared = prepareSessionExport(sessions, (id) => store.readMessages(id));
      } catch (error) {
        if (error instanceof ExportLimitError) return sendJson(res, error.status, { error: error.message, code: error.code });
        throw error;
      }
      const { files } = prepared;
      if (!files.length) {
        return sendJson(res, 404, { error: '没有可导出的会话' });
      }
      const zip = createZip(files);
      res.on('error', () => {}); // 客户端断开（EPIPE）不崩进程（审查②）
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="claudeneko-sessions-${Date.now()}.zip"`,
        'X-ClaudeNeko-Export-Complete': 'true',
      });
      res.end(zip);
      return;
    }

    return null; // 未匹配 → 下一路由
  };
}
