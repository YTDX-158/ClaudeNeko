// routes/media.js — 媒体库 + 生成媒体/下载（架构重构步3）
import fs from 'node:fs';
import { saveMedia, listMedia, getMedia, getMediaPath, deleteMedia } from '../lib/mediaStore.js';
import { sendJson, readBody, readRawBody, serveMediaFile } from '../lib/util.js';
import { ApiError } from '../lib/mediaGen.js';
import { createZip } from '../lib/zip.js';

export function mediaHandler(ctx) {
  return async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;
    const media = ctx.media;

    const genErr = (e) =>
      e instanceof ApiError
        ? sendJson(res, 400, { error: e.code, message: e.message })
        : sendJson(res, 500, { error: 'INTERNAL', message: e.message });

    // 上传 / 列表
    if (method === 'POST' && pathname === '/api/media') {
      const name = url.searchParams.get('name') || '';
      const buf = await readRawBody(req);
      if (!buf) return sendJson(res, 413, { error: '文件过大（>50MB）或上传失败' });
      // name 来自 searchParams.get 已百分号解码一次，勿再 decodeURIComponent（文件名含 % 会 URIError → 500）
      const r = saveMedia(buf, name);
      if (!r.ok) return sendJson(res, 400, { error: r.error });
      return sendJson(res, 201, r.media);
    }

    if (method === 'GET' && pathname === '/api/media') {
      if (!ctx.isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      return sendJson(res, 200, { media: listMedia() });
    }

    // 媒体批量导出：按 id 列表打包 zip（STORE 模式，零依赖）
    if (method === 'POST' && pathname === '/api/media/export-zip') {
      const body = await readBody(req);
      const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
      if (!ids.length) return sendJson(res, 400, { error: '未选择要导出的媒体' });
      // 上限保护：防一次打包过多/过大（同步读 + 全内存打包会阻塞事件循环/占内存）
      if (ids.length > 200) return sendJson(res, 413, { error: '一次最多导出 200 个文件' });
      // 一次取全量索引，避免循环里反复读+解析 index.json
      const idx = listMedia();
      const nameCount = new Map();
      const files = [];
      let totalSize = 0;
      for (const id of ids) {
        const rec = idx.find((m) => m.id === id);
        if (!rec || !rec.fileName) continue; // 跳过不存在/脏记录
        try {
          const data = await fs.promises.readFile(getMediaPath(rec)); // 异步读，不阻塞事件循环
          totalSize += data.length;
          if (totalSize > 500 * 1024 * 1024) {
            return sendJson(res, 413, { error: '导出内容超过 500MB 上限' });
          }
          // zip 条目名消毒：只取 basename、去路径分隔符/控制字符、限长（防 zip-slip + 超长截断）
          let name = (rec.originalName || rec.fileName).replace(/[\\/:\0\r\n\t]/g, '_').slice(0, 200) || 'file';
          // 重复名加序号，防同名覆盖丢文件
          const n = nameCount.get(name) || 0;
          nameCount.set(name, n + 1);
          if (n > 0) {
            const dot = name.lastIndexOf('.');
            name = dot > 0 ? `${name.slice(0, dot)}(${n})${name.slice(dot)}` : `${name}(${n})`;
          }
          files.push({ name, data });
        } catch {
          // 文件读不到跳过
        }
      }
      if (!files.length) return sendJson(res, 404, { error: '所选媒体均无法读取' });
      const zip = createZip(files);
      // filename* 用 RFC 5987 编码中文文件名（Node header 不接受非 ASCII）
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="claudeneko.zip"; filename*=UTF-8''ClaudeNeko-%E5%AA%92%E4%BD%93-${Date.now()}.zip`,
      });
      res.end(zip);
      return;
    }

    // 技能包：生成媒体 / 下载视频（必须在 mm 文件匹配之前，否则 /api/media/config 会被当成文件 id）
    if (method === 'GET' && pathname === '/api/media/config') {
      if (!ctx.isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      return sendJson(res, 200, media.getConfig());
    }

    if (method === 'POST' && pathname === '/api/media/generate') {
      const body = await readBody(req);
      if (body && body.__tooLarge) return sendJson(res, 413, { error: '内容超过 1MB 上限，请缩短后重试' });
      const prompt = String(body.prompt ?? '').trim();
      if (!prompt) return sendJson(res, 400, { error: 'EMPTY_PROMPT', message: '提示词不能为空' });
      const gsess = body.sessionId ? ctx.store.get(String(body.sessionId)) : null;
      try {
        if (body.kind === 'image') {
          if (gsess) ctx.maybeStartMediaClaude(gsess, 'image', prompt);
          return sendJson(res, 200, await media.generateImage({ prompt, model: body.model, ratio: body.ratio, resolution: body.resolution }));
        }
        if (body.kind === 'video') {
          if (gsess) ctx.maybeStartMediaClaude(gsess, 'video', prompt);
          return sendJson(res, 200, await media.generateVideo({ prompt, model: body.model, ratio: body.ratio, duration: body.duration, resolution: body.resolution, refMode: body.refMode, refImages: body.refImages }));
        }
        return sendJson(res, 400, { error: 'BAD_KIND', message: 'kind 需为 image 或 video' });
      } catch (e) {
        return genErr(e);
      }
    }

    const mtask = pathname.match(/^\/api\/media\/task\/([^/]+)$/);
    if (mtask && method === 'GET') {
      if (!ctx.isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      try {
        return sendJson(res, 200, await media.queryTask(mtask[1]));
      } catch (e) {
        return genErr(e);
      }
    }

    if (method === 'POST' && pathname === '/api/media/download') {
      const body = await readBody(req);
      if (body && body.__tooLarge) return sendJson(res, 413, { error: '内容超过 1MB 上限，请缩短后重试' });
      if (!body.url) return sendJson(res, 400, { error: 'NO_URL', message: '请粘贴视频链接' });
      try {
        return sendJson(res, 200, await media.download({ url: String(body.url), transcribe: !!body.transcribe }));
      } catch (e) {
        return genErr(e);
      }
    }

    // 媒体文件服务 / 下载 / 删除（放最后：/api/media/{id} 不与其他端点冲突）
    const mm = pathname.match(/^\/api\/media\/([^/]+)(\/download)?$/);
    if (mm) {
      if (!ctx.isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      const [, mid, dl] = mm;
      const rec = getMedia(mid);
      if (!rec) return sendJson(res, 404, { error: '文件不存在' });
      if (method === 'GET') return serveMediaFile(req, res, rec, !!dl);
      if (method === 'DELETE') {
        deleteMedia(rec.id);
        return sendJson(res, 200, { ok: true });
      }
    }

    return null; // 未匹配 → 下一路由
  };
}
