import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

/**
 * mediaStore.js — 本地媒体库存储（图片/视频/文档）
 * 安全要点（按 OWASP 文件上传实践）：
 *  - 存储文件名用 UUID（绝不用客户端原始名），原始名只进元数据 → 防路径穿越
 *  - 用 magic bytes（文件真实签名）校验类型，不信 Content-Type / 扩展名
 *  - 二进制与元数据分离：文件在 server/media/，索引在 server/media/index.json
 */
const MEDIA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'media');
const INDEX_FILE = path.join(MEDIA_DIR, 'index.json');

/** 通过文件真实签名识别类型；不认识返回 null（拒绝）。 */
export function detectType(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png', kind: 'image' };
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg', kind: 'image' };
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { ext: 'gif', mime: 'image/gif', kind: 'image' };
  // WebP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return { ext: 'webp', mime: 'image/webp', kind: 'image' };
  }
  // PDF
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return { ext: 'pdf', mime: 'application/pdf', kind: 'document' };
  // MP4（ftyp box）
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return { ext: 'mp4', mime: 'video/mp4', kind: 'video' };
  // WebM
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: 'webm', mime: 'video/webm', kind: 'video' };
  // MP3（ID3）
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return { ext: 'mp3', mime: 'audio/mpeg', kind: 'audio' };
  return null;
}

function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveIndex(idx) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
}

/** 保存上传的二进制 → 返回 { ok, media | error } */
export function saveMedia(buffer, originalName) {
  let type = detectType(buffer);
  if (!type) {
    const ext = (originalName.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || 'bin';
    // 文档/文本类扩展名归为 document（无魔数签名的纯文本、Office 文档等）
    const docExts = [
      // 纯文本 / 标记
      'txt', 'md', 'markdown', 'text', 'log', 'ini', 'conf', 'cfg', 'env',
      'json', 'xml', 'yaml', 'yml', 'csv', 'tsv',
      'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
      'py', 'sh', 'bat', 'cmd', 'ps1', 'vbs',
      'java', 'c', 'cpp', 'cc', 'h', 'hpp', 'rb', 'go', 'rs', 'php', 'sql',
      'swift', 'kt', 'dart', 'lua', 'pl', 'r',
      // Office / 开放文档
      'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
    ];
    type = docExts.includes(ext)
      ? { ext, mime: 'text/plain', kind: 'document' }
      : { ext, mime: 'application/octet-stream', kind: 'file' };
  }
  const id = crypto.randomUUID();
  const fileName = `${id}.${type.ext}`;
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.writeFileSync(path.join(MEDIA_DIR, fileName), buffer);
  const rec = {
    id,
    fileName,
    originalName: originalName || fileName,
    ext: type.ext,
    mime: type.mime,
    kind: type.kind,
    size: buffer.length,
    createdAt: Date.now(),
  };
  const idx = loadIndex();
  idx.push(rec);
  saveIndex(idx);
  return { ok: true, media: rec };
}

/** 全部媒体（新的在前） */
export function listMedia() {
  return loadIndex().sort((a, b) => b.createdAt - a.createdAt);
}

export function getMedia(id) {
  return loadIndex().find((m) => m.id === id) || null;
}

export function getMediaPath(rec) {
  return path.join(MEDIA_DIR, rec.fileName);
}

export function deleteMedia(id) {
  const idx = loadIndex();
  const i = idx.findIndex((m) => m.id === id);
  if (i < 0) return false;
  const [rec] = idx.splice(i, 1);
  saveIndex(idx);
  try {
    fs.unlinkSync(path.join(MEDIA_DIR, rec.fileName));
  } catch {
    // 文件可能已不存在
  }
  return true;
}

/* ---------- 媒体库自动清理（审查⑤ 8-27） ---------- */
const DEFAULT_TTL = 30 * 24 * 3600 * 1000; // 30 天
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 总容量上限 2GB（视频多时防占死硬盘）

/** 清理过期媒体：① 创建时间超 TTL 的删；② 总量超上限删最旧。返回删除条数。
 *  启动时 + 定期调用（server.js 接线）。 */
export function pruneMedia({ maxAgeMs = DEFAULT_TTL, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const idx = loadIndex();
  if (!idx.length) return 0;
  const now = Date.now();
  // ① 超 TTL 删
  const afterTtl = idx.filter((m) => now - (m.createdAt || 0) < maxAgeMs);
  // ② 总量超上限 → 最旧先删（先按 createdAt 升序）
  let total = afterTtl.reduce((s, m) => s + (m.size || 0), 0);
  const ordered = [...afterTtl].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const keep = [];
  for (const m of ordered) {
    if (total > maxBytes) { total -= m.size || 0; continue; }
    keep.push(m);
  }
  const removed = idx.length - keep.length;
  if (!removed) return 0;
  const keepIds = new Set(keep.map((m) => m.id));
  const toDelete = idx.filter((m) => !keepIds.has(m.id));
  saveIndex(keep);
  for (const m of toDelete) {
    try { fs.unlinkSync(path.join(MEDIA_DIR, m.fileName)); } catch { /* 已不存在 */ }
  }
  logger.info('media', `自动清理 ${removed} 条过期媒体（剩余 ${keep.length} 条）`);
  return removed;
}
