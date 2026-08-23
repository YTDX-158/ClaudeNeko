// routes/media.js — 媒体库 + 生成媒体/下载（架构重构步3）
import { saveMedia, listMedia, getMedia, deleteMedia } from '../lib/mediaStore.js';
import { sendJson, readBody, readRawBody, serveMediaFile } from '../lib/util.js';
import { ApiError } from '../lib/mediaGen.js';

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
      const r = saveMedia(buf, decodeURIComponent(name));
      if (!r.ok) return sendJson(res, 400, { error: r.error });
      return sendJson(res, 201, r.media);
    }

    if (method === 'GET' && pathname === '/api/media') {
      return sendJson(res, 200, { media: listMedia() });
    }

    // 技能包：生成媒体 / 下载视频（必须在 mm 文件匹配之前，否则 /api/media/config 会被当成文件 id）
    if (method === 'GET' && pathname === '/api/media/config') {
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
          return sendJson(res, 200, await media.generateVideo({ prompt, model: body.model, ratio: body.ratio, duration: body.duration, resolution: body.resolution }));
        }
        return sendJson(res, 400, { error: 'BAD_KIND', message: 'kind 需为 image 或 video' });
      } catch (e) {
        return genErr(e);
      }
    }

    const mtask = pathname.match(/^\/api\/media\/task\/([^/]+)$/);
    if (mtask && method === 'GET') {
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
