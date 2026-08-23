// routes/system.js — 系统端点：health / balance / skills / autostart / models（架构重构步2）
import { fetchBalance } from '../lib/balance.js';
import { listSkills, sendJson } from '../lib/util.js';

export function systemHandler(ctx) {
  return async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;
    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, version: ctx.appVersion });
    }
    if (method === 'GET' && pathname === '/api/balance') {
      return sendJson(res, 200, await fetchBalance());
    }
    if (method === 'GET' && pathname === '/api/skills') {
      return sendJson(res, 200, { skills: listSkills() });
    }
    if (method === 'GET' && pathname === '/api/autostart') {
      return sendJson(res, 200, { enabled: await ctx.getAutoStartEnabled() });
    }
    if (method === 'POST' && pathname === '/api/autostart') {
      const body = await ctx.readBody(req);
      await ctx.setAutoStart(Boolean(body.enabled));
      return sendJson(res, 200, { enabled: Boolean(body.enabled) });
    }
    if (method === 'GET' && pathname === '/api/models') {
      return sendJson(res, 200, { models: ctx.config.models, default: ctx.config.defaultModel });
    }
    return null; // 未匹配 → 交由下一路由
  };
}
