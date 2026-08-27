// server/routes/mediaConfig.js — 生图生视频模型条目端点（设置中心「生图/生视频」）
// =====================================================================
// GET    /api/media-config?kind=image|video   列出条目（key 脱敏）
// PUT    /api/media-config                    增改条目 { kind, id?, name, provider, baseUrl, model, apiKey }
// DELETE /api/media-config?kind=x&id=y        删除条目
// POST   /api/media-config/test               可达性测试 { baseUrl, apiKey, model }
//
// 说明：
// - 条目 = 完整接入配置，支持「每个模型不同 API」（供应商/baseUrl/模型/key 独立）
// - 测试连通 = 轻量可达性（fetch baseUrl 看网络通），非真实生成测试（各供应商差异大）
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
  return async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;
    const { mediaConfig, readBody } = ctx;

    // ---- 列出条目（脱敏） ----
    if (method === 'GET' && pathname === '/api/media-config') {
      const kind = url.searchParams.get('kind');
      if (kind !== 'image' && kind !== 'video') {
        return sendJson(res, 400, { error: 'kind 必须是 image 或 video' });
      }
      const items = mediaConfig.listItems(kind).map((it) => ({
        ...it,
        apiKey: mask(it.apiKey), // key 只显示掩码
      }));
      return sendJson(res, 200, { items });
    }

    // ---- 增改条目（有 id = 更新；无 id = 新增） ----
    if (method === 'PUT' && pathname === '/api/media-config') {
      const body = await readBody(req);
      const { kind, id, name, provider, baseUrl, model, apiKey } = body || {};
      if (kind !== 'image' && kind !== 'video') return sendJson(res, 400, { error: 'kind 必须是 image 或 video' });
      if (!name || !baseUrl || !model || !apiKey) {
        return sendJson(res, 400, { error: '需要 name + baseUrl + model + apiKey' });
      }
      if (id) {
        const ok = mediaConfig.updateItem(kind, id, { name, provider: provider || 'custom', baseUrl, model, apiKey });
        if (!ok) return sendJson(res, 404, { error: '条目不存在' });
        return sendJson(res, 200, { ok: true, id });
      }
      const item = mediaConfig.addItem(kind, { name, provider: provider || 'custom', baseUrl, model, apiKey });
      return sendJson(res, 200, { ok: true, id: item.id });
    }

    // ---- 删除条目 ----
    if (method === 'DELETE' && pathname === '/api/media-config') {
      const kind = url.searchParams.get('kind');
      const id = url.searchParams.get('id');
      if ((kind !== 'image' && kind !== 'video') || !id) {
        return sendJson(res, 400, { error: '需要 kind(image|video) + id' });
      }
      mediaConfig.removeItem(kind, id);
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
