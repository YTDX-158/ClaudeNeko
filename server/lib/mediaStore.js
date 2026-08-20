import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
    // 未知类型 → 通用附件（application/octet-stream 兜底，RFC 2046 标准），可下载不预览
    const ext = (originalName.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || 'bin';
    type = { ext, mime: 'application/octet-stream', kind: 'file' };
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
