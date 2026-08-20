/**
 * upload.js — 媒体上传公共函数（Composer / MediaLibrary 共用）
 * 60s 超时 + 检查 r.ok（上传失败不伪装成功）。
 */

/** 上传文件到媒体库，返回附件快照 { id, name, kind }；失败 reject。 */
export function uploadToMedia(file) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000); // 上传 60s 超时
  return fetch(`/api/media?name=${encodeURIComponent(file.name || 'pasted.png')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
    signal: ctrl.signal,
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('上传失败'))))
    .then((m) => ({ id: m.id, name: m.originalName, kind: m.kind }))
    .finally(() => clearTimeout(timer));
}
