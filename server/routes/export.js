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
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fname.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
      });
      res.end(data);
      return;
    }

    if (method === 'GET' && pathname === '/api/sessions/export-all') {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      const sessions = store.list().slice(0, EXPORT_MAX_SESSIONS); // 上限：防会话过多全内存打包
      const files = [];
      const usedNames = new Set(); // 记最终文件名：重名加 (n) 序号，且避开真实标题同名（防 zip 覆盖丢数据）
      let totalSize = 0;
      for (const s of sessions) {
        const data = Buffer.from(JSON.stringify({ version: 1, session: s, messages: store.readMessages(s.id) }), 'utf8'); // 紧凑格式，省内存
        totalSize += data.length;
        if (totalSize > EXPORT_MAX_BYTES) break; // 字节上限
        let name = `${safeFilename(s.title, s.id)}.json`;
        let n = 1;
        while (usedNames.has(name)) {
          name = `${name.slice(0, -5)}(${n}).json`;
          n++;
        }
        usedNames.add(name);
        files.push({ name, data });
      }
      if (!files.length) {
        // 有会话但全超限 → 明确提示，别误导为"没会话"
        return sendJson(res, 404, { error: sessions.length ? '会话数据超过 500MB 导出上限，请减少会话或单条导出' : '没有可导出的会话' });
      }
      const zip = createZip(files);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="claudeneko-sessions-${Date.now()}.zip"`,
      });
      res.end(zip);
      return;
    }

    return null; // 未匹配 → 下一路由
  };
}
