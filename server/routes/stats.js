// routes/stats.js — 成本统计（全局汇总 / 单会话汇总）。8-27 Phase1 拆分：从 sessions.js 搬出，逻辑零改动。
// 改统计功能只动本文件（见 docs/架构地图.md）。
import { sendJson } from '../lib/util.js';

/* ---------- 成本统计（usage 聚合） ----------
 * usage 结构（claude result 事件顶层）：
 *   input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens
 *   / output_tokens_details.thinking_tokens
 * 注意：每轮 input_tokens 都含记忆+历史上下文，会话累计按请求次数叠加（真实成本口径）。 */
function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages: 0 };
}
/** 把一份 usage（原始字段或已归一统计）合并进 a；messages 由调用方传入。 */
function mergeUsage(a, u) {
  a.input_tokens += u.input_tokens || 0;
  a.output_tokens += u.output_tokens || 0;
  a.thinking_tokens += u.thinking_tokens ?? u.output_tokens_details?.thinking_tokens ?? 0;
  a.cache_read_input_tokens += u.cache_read_input_tokens || 0;
  a.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
  a.messages += u.messages || 0;
  return a;
}
function sumUsage(msgs) {
  const t = emptyUsage();
  for (const m of msgs) {
    const u = m.usage;
    if (!u || typeof u !== 'object' || !Object.keys(u).length) continue; // 空对象/缺失都不计（L1）
    mergeUsage(t, { ...u, messages: 1 });
  }
  return t;
}

export function statsHandler(ctx) {
  const { store, isLocalRequest } = ctx;
  return async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;

    // 成本统计：全局汇总 / 单会话汇总（usage 仅 v1.6.0 后新消息有；历史/取消消息无）
    if (method === 'GET' && pathname === '/api/stats') {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      const sessions = store.list();
      const totals = emptyUsage();
      const per = [];
      for (const s of sessions) {
        const st = sumUsage(store.readMessages(s.id));
        if (st.messages) per.push({ id: s.id, title: s.title, ...st });
        mergeUsage(totals, st);
      }
      return sendJson(res, 200, { totals, sessions: per });
    }

    const sts = pathname.match(/^\/api\/sessions\/([^/]+)\/stats$/);
    if (sts && method === 'GET') {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      const s = store.get(sts[1]);
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      return sendJson(res, 200, { session: { id: s.id, title: s.title }, stats: sumUsage(store.readMessages(s.id)) });
    }

    return null; // 未匹配 → 下一路由
  };
}
