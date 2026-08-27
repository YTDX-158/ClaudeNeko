// routes/search.js — 消息搜索 v2.0。8-27 Phase1 拆分：从 sessions.js 搬出，逻辑零改动。
// 改搜索只动本文件（见 docs/架构地图.md）。
import { sendJson } from '../lib/util.js';

const SEARCH_MAX_SESSIONS = 100; // 搜索：最多扫最近 N 个会话
const SEARCH_MAX_RESULTS = 200; // 搜索：结果上限（v2.0 每会话所有命中气泡全列）

export function searchHandler(ctx) {
  const { store, isLocalRequest } = ctx;
  return async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;

    // 搜索 v2.0：只搜消息内容，返回消息级结果（前端可跳转到具体气泡）。
    // 多关键词：空格/逗号分词 + 去重 + 限词数 → 单遍收集，有全命中则 AND，否则降级 OR（标注命中词）。
    // 每会话所有命中气泡全列；总数上限 SEARCH_MAX_RESULTS。
    if (method === 'GET' && pathname === '/api/search') {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      const raw = String(url.searchParams.get('q') ?? '').trim();
      // 分词 + 去重（防"导演 导演"重复计数）+ 限词数（防超长查询拖慢，按完整词截断不再切半词）
      const keywords = [...new Set(raw.toLowerCase().split(/[\s,，]+/).filter(Boolean))].slice(0, 10);
      if (!keywords.length) return sendJson(res, 200, { results: [], degraded: false, truncated: false });
      const sessions = store.list().slice(0, SEARCH_MAX_SESSIONS); // 只搜最近 N 会话，控性能
      // 单遍收集所有命中（任一关键词即入），matchedKeywords 记实际命中词
      const all = [];
      let truncated = false;
      for (const s of sessions) {
        const msgs = store.readMessages(s.id);
        for (let i = 0; i < msgs.length; i++) {
          const text = msgs[i].text ?? '';
          const lower = text.toLowerCase();
          const hits = keywords.filter((k) => lower.includes(k));
          if (!hits.length) continue;
          // snippet：以所有命中词在文本中最早出现的位置为基准（别用输入序第一个词，会切错上下文）
          const first = Math.min(...hits.map((k) => lower.indexOf(k)));
          const snippet = `…${text.slice(Math.max(0, first - 20), first + 60)}…`;
          all.push({
            sessionId: s.id,
            sessionTitle: s.title,
            messageIndex: i, // 消息在会话里的位置（前端跳转锚点）
            role: msgs[i].role,
            snippet,
            matchedKeywords: hits, // AND 时=全部词；OR 时=实际命中的词
          });
          if (all.length >= SEARCH_MAX_RESULTS) { truncated = true; break; }
        }
        if (truncated) break;
      }
      // 全命中（AND）优先；否则降级 OR，命中词多的排前
      const andResults = all.filter((r) => r.matchedKeywords.length === keywords.length);
      if (andResults.length) {
        return sendJson(res, 200, { results: andResults, degraded: false, truncated });
      }
      all.sort((a, b) => b.matchedKeywords.length - a.matchedKeywords.length);
      return sendJson(res, 200, { results: all, degraded: true, truncated });
    }

    return null; // 未匹配 → 下一路由
  };
}
