// server/routes/mediaConfig.js — 模型配置（生图/生视频预设 + 视觉理解）端点
// =====================================================================
// GET    /api/media-config              返回预设清单 + 已填配置（key 脱敏）
// PUT    /api/media-config              保存 { kind: image|video|vision, model?, baseUrl, apiKey, model? }
// DELETE /api/media-config?kind=x&model=y   清空某配置（vision 无 model）
// POST   /api/media-config/test         可达性测试 { baseUrl }
//
// 说明：
// - 固定预设（与 settings.js MEDIA 对应），用户只填 baseUrl/apiKey，填什么生成时用什么
// - 视觉理解（vision）额外有 model 字段（用户自己填视觉模型名）
// - 安全：写操作走 isLocalRequest 校验；返回 key 一律脱敏

import { sendJson } from '../lib/util.js';

function mask(key) {
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

/** 可达性测试：fetch baseUrl 根，验证网络通 + 服务响应 */
async function testReachability({ baseUrl }) {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, ''), {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });
    return { ok: true, httpStatus: res.status, note: '网络可达（非生成测试）' };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? '连接超时' : e.message };
  }
}

export function mediaConfigHandler(ctx) {
  const { mediaConfig, readBody, imageModels = [], videoModels = [] } = ctx;
  return async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;

    // ---- 预设清单 + 已填配置（key 脱敏；label 来自 settings.js MEDIA 预设） ----
    if (method === 'GET' && pathname === '/api/media-config') {
      const merge = (presets, kind) => presets.map((m) => {
        const conf = mediaConfig.getConfig(kind, m.id);
        return { id: m.id, label: m.label, baseUrl: conf?.baseUrl || '', apiKey: conf ? mask(conf.apiKey) : null };
      });
      const vision = mediaConfig.getVision();
      return sendJson(res, 200, {
        image: merge(imageModels, 'image'),
        video: merge(videoModels, 'video'),
        vision: vision
          ? { baseUrl: vision.baseUrl, apiKey: mask(vision.apiKey), model: vision.model }
          : { baseUrl: '', apiKey: null, model: '' },
      });
    }

    // ---- 保存配置（vision 用 body.model 存视觉模型名；生成模型用 model=预设id） ----
    if (method === 'PUT' && pathname === '/api/media-config') {
      const body = await readBody(req);
      const { kind, model, baseUrl, apiKey } = body || {};
      if (kind === 'vision') {
        mediaConfig.setVision({ baseUrl: baseUrl || '', apiKey: apiKey || '', model: model || '' });
        return sendJson(res, 200, { ok: true });
      }
      if ((kind !== 'image' && kind !== 'video') || !model) {
        return sendJson(res, 400, { error: '需要 kind(image|video) + model' });
      }
      if (!apiKey) return sendJson(res, 400, { error: 'apiKey 不能为空' });
      mediaConfig.setConfig(kind, model, { baseUrl: baseUrl || '', apiKey });
      return sendJson(res, 200, { ok: true });
    }

    // ---- 清空某配置 ----
    if (method === 'DELETE' && pathname === '/api/media-config') {
      const kind = url.searchParams.get('kind');
      if (kind === 'vision') {
        mediaConfig.setVision({ apiKey: '' });
        return sendJson(res, 200, { ok: true });
      }
      const model = url.searchParams.get('model');
      if ((kind !== 'image' && kind !== 'video') || !model) {
        return sendJson(res, 400, { error: '需要 kind(image|video) + model' });
      }
      mediaConfig.setConfig(kind, model, { apiKey: '' });
      return sendJson(res, 200, { ok: true });
    }

    // ---- 可达性测试 ----
    if (method === 'POST' && pathname === '/api/media-config/test') {
      const body = await readBody(req);
      const { baseUrl } = body || {};
      if (!baseUrl) return sendJson(res, 400, { error: '缺 baseUrl' });
      return sendJson(res, 200, await testReachability({ baseUrl }));
    }

    return null; // 未匹配 → 交由下一路由
  };
}
