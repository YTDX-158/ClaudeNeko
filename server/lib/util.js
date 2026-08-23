// util.js — 通用 HTTP 工具（纯函数，无业务状态）。从 server.js 拆出（2026-08-24 架构重构）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMediaPath } from './mediaStore.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function readBody(req) {
  return new Promise((resolve) => {
    // Buffer[] 收集再一次性 utf8 解码：避免 data += chunk 逐块独立解码导致跨包中文字符乱码
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    // 30s 超时：客户端连上但不发请求体（或挂起）时释放，防挂起请求占着 busy 锁
    const timer = setTimeout(() => {
      try {
        req.destroy();
      } catch {
        // 已关闭
      }
      finish({});
    }, 30000);
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > 1e6) {
        tooLarge = true;
        finish({ __tooLarge: true });
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      let obj = {};
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        if (text) {
          const parsed = JSON.parse(text);
          // 归一化：null / 数组 / 非对象 → {}（防 body.prompt 崩 + busy 锁泄漏）
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed;
        }
      } catch {
        // 非法 JSON → {}，调用方按缺字段处理（不 500）
      }
      finish(obj);
    });
    req.on('error', () => finish({}));
  });
}

export function serveStatic(req, res, url, distDir) {
  let filePath = path.join(distDir, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(distDir)) filePath = path.join(distDir, 'index.html');

  const fallback = () => {
    fs.readFile(path.join(distDir, 'index.html'), (err, indexHtml) => {
      if (err) {
        sendJson(res, 503, { error: '前端未构建，请先运行 npm run build' });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(indexHtml);
    });
  };

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return fallback();
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

export function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const meta = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return meta;
}

export function listSkills() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const dirs = [path.join(base, 'skills'), path.join(process.cwd(), '.claude', 'skills')];
  const out = [];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const sk = path.join(dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(sk)) continue;
      try {
        const md = fs.readFileSync(sk, 'utf8');
        const meta = parseFrontmatter(md);
        out.push({
          name: meta.name || entry.name,
          description: meta.description || '',
          path: path.join(dir, entry.name),
          body: md.length > 6000 ? md.slice(0, 6000) + '\n…（内容较长已截断）' : md,
        });
      } catch {
        // 单个 skill 读取失败不影响其他
      }
    }
  }
  return out;
}

export const MAX_MEDIA_SIZE = 50 * 1024 * 1024; // 50MB 上传上限

export function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      req.destroy();
      resolve(null);
    }, 30000);
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_MEDIA_SIZE) {
        clearTimeout(timer);
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export function serveMediaFile(req, res, rec, asDownload) {
  // 防御：脏记录 fileName 缺失时 path.join 会抛 "path undefined" → 500，直接 404
  if (!rec || !rec.fileName) {
    sendJson(res, 404, { error: '文件不存在' });
    return;
  }
  const filePath = getMediaPath(rec);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendJson(res, 404, { error: '文件不存在' });
    return;
  }
  const base = {
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': rec.mime,
  };
  if (asDownload) base['Content-Disposition'] = `attachment; filename="${encodeURIComponent(rec.originalName)}"`;
  const range = req.headers.range;
  if (range && !asDownload) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...base, 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
  }
}
