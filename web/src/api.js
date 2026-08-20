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
  models: () => request('/models'),
  listSessions: () => request('/sessions'),
  createSession: (model) =>
    request('/sessions', { method: 'POST', body: JSON.stringify({ model }) }),
  getSession: (id) => request(`/sessions/${id}`),
  patchSession: (id, patch) =>
    request(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSession: (id) => request(`/sessions/${id}`, { method: 'DELETE' }),
  listMessages: (id) => request(`/sessions/${id}/messages`),
  getAutostart: () => request('/autostart'),
  setAutostart: (enabled) => request('/autostart', { method: 'POST', body: JSON.stringify({ enabled }) }),
};
