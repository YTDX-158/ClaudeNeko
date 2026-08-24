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
  createSession: (model, effort) =>
    request('/sessions', { method: 'POST', body: JSON.stringify({ model, effort }) }),
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

  // ---- 远程访问（手机/公网连接，需配对码；默认关） ----
  remoteStatus: () => request('/remote/status'),
  remoteOn: () => request('/remote/on', { method: 'POST' }),
  remoteOff: () => request('/remote/off', { method: 'POST' }),
  remoteRegenerateCode: () => request('/remote/regenerate-code', { method: 'POST' }),

  // ---- 技能包：生成媒体 / 下载视频（POST 用自定义提取友好 message） ----
  // 媒体批量导出 zip：POST ids → 返回 zip blob（前端触发下载）
  exportMediaZip: async (ids) => {
    const res = await fetch(BASE + '/media/export-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ClaudeNeko-媒体-${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 延迟回收：大 zip 浏览器还没读完 blob 就 revoke 会导致下载失败
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  },
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
  // 强制结束当前对话任务（杀 claude + 清生成任务）
  forceStop: (id) => request(`/sessions/${id}/force-stop`, { method: 'POST' }),
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
