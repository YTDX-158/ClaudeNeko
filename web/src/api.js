/**
 * REST API 封装。开发环境走 Vite 代理（/api → 4000），生产由 server.js 同源托管。
 */
const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error ?? '';
    } catch {
      // 响应非 JSON
    }
    const err = new Error(detail || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const api = {
  health: () => request('/health'),
  listSessions: () => request('/sessions'),
  createSession: (model) =>
    request('/sessions', { method: 'POST', body: JSON.stringify({ model }) }),
  getSession: (id) => request(`/sessions/${id}`),
  // 取消该会话正在进行的生成（停止按钮；后端杀 claude 进程并释放锁）
  cancelGeneration: (id) => request(`/sessions/${id}/cancel`, { method: 'POST' }),
  patchSession: (id, patch) =>
    request(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSession: (id) => request(`/sessions/${id}`, { method: 'DELETE' }),
  listMessages: (id) => request(`/sessions/${id}/messages`),
  // 技能包生成结果 → 追加一条 AI 消息（text + 附件媒体）进会话
  appendMediaMessage: (id, body) =>
    request(`/sessions/${id}/media-message`, { method: 'POST', body: JSON.stringify(body) }),
  // 分支：从某个会话的指定消息处新建会话，返回新会话（含已复制历史）
  createBranch: (parentId, fromMsgId) =>
    request('/sessions/branch', {
      method: 'POST',
      body: JSON.stringify({ parentId, fromMsgId }),
    }),
  getAutostart: () => request('/autostart'),
  setAutostart: (enabled) => request('/autostart', { method: 'POST', body: JSON.stringify({ enabled }) }),

  // ---- 技能包：生成媒体 / 下载视频（POST 用自定义提取友好 message） ----
  mediaConfig: () => request('/media/config'),
  mediaGenerate: async (body) => {
    const res = await fetch(BASE + '/media/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.message || `HTTP ${res.status}`);
    return j;
  },
  mediaTask: (id) => request(`/media/task/${id}`),
  mediaDownload: async (body) => {
    const res = await fetch(BASE + '/media/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.message || `HTTP ${res.status}`);
    return j;
  },
};
