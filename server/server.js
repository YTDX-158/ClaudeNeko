import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './lib/settings.js';
import { SessionStore } from './lib/sessionStore.js';
import { createClaudeRunner } from './lib/claudeRunner.js';
import { sseHeaders, writeSse } from './lib/sse.js';
import { fetchBalance } from './lib/balance.js';
import { saveMedia, listMedia, getMedia, getMediaPath, deleteMedia } from './lib/mediaStore.js';
import { describeImage } from './lib/vision.js';
import { extractDocumentText } from './lib/docText.js';

const config = resolveConfig();
const store = new SessionStore(config.dataDir);
const busy = new Set(); // per-session 在途锁
const activeRunners = new Map(); // id -> runner（取消用）

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(SERVER_DIR, '..', 'web', 'dist');

/* ---------- 工具 ---------- */

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      data += chunk;
      if (data.length > 1e6) {
        tooLarge = true;
        resolve({ __tooLarge: true }); // 标记超限，由调用方返回 413
        req.pause(); // 暂停接收，等 413 响应发出后连接自然关闭（destroy 会抢先断连）
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => {});
  });
}

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

function serveStatic(req, res, url) {
  let filePath = path.join(DIST_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(DIST_DIR)) filePath = path.join(DIST_DIR, 'index.html');

  const fallback = () => {
    fs.readFile(path.join(DIST_DIR, 'index.html'), (err, indexHtml) => {
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

/* ---------- 开机自启（HKCU Run，登录时后台启动后端，无需管理员） ---------- */
const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_NAME = 'ClaudeNekoWeb';

function runPowerShell(script) {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => resolve(out.trim()));
    child.on('error', () => resolve(''));
  });
}

async function getAutoStartEnabled() {
  const out = await runPowerShell(
    `(Get-ItemProperty -Path '${RUN_KEY}' -Name '${AUTOSTART_NAME}' -ErrorAction SilentlyContinue).'${AUTOSTART_NAME}'`,
  );
  return !!out;
}

async function setAutoStart(enabled) {
  if (enabled) {
    // 登录时隐藏启动后端（run-node.vbs 动态定位，不硬编码路径）
    const vbs = path.join(SERVER_DIR, '..', 'run-node.vbs');
    await runPowerShell(
      `Set-ItemProperty -Path '${RUN_KEY}' -Name '${AUTOSTART_NAME}' -Value 'wscript "${vbs}"'`,
    );
  } else {
    await runPowerShell(
      `Remove-ItemProperty -Path '${RUN_KEY}' -Name '${AUTOSTART_NAME}' -ErrorAction SilentlyContinue`,
    );
  }
}

/* ---------- 已装 Skills（查看用，不管理） ---------- */
function parseFrontmatter(md) {
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

function listSkills() {
  // 用户级 skills + 项目级 .claude/skills（CLAUDE_CONFIG_DIR 可换配置目录，兜底 os.homedir()）
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const dirs = [path.join(base, 'skills'), path.join(process.cwd(), '.claude', 'skills')];
  const out = [];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在/无权限
    }
    for (const entry of entries) {
      // symlink（如指向 ~/.agents/skills 的共享 skill）也算，跟随读取
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

/* ---------- 媒体库（上传/列表/预览下载/删除） ---------- */
const MAX_MEDIA_SIZE = 50 * 1024 * 1024; // 50MB 上传上限

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_MEDIA_SIZE) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

function serveMediaFile(req, res, rec, asDownload) {
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
    // 视频拖动需要 Range（HTTP 206）
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size) {
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

/** 附件上下文：文档抽字 + 图片视觉转描述 → 拼成给主模型的文本块。 */
async function buildAttachmentContext(attachments) {
  const lines = [];
  for (const a of attachments) {
    const rec = getMedia(a.id);
    if (!rec) continue;
    const filePath = getMediaPath(rec);
    try {
      if (rec.kind === 'image') {
        const r = await describeImage(fs.readFileSync(filePath), rec.mime);
        lines.push(`[图片附件 ${a.name}] ${r.ok ? r.text : `（${r.error}）`}`);
      } else if (rec.kind === 'document' || rec.kind === 'file') {
        const text = extractDocumentText(filePath, rec.ext);
        lines.push(`[文档附件 ${a.name} 内容]${text ? `\n${text}` : '（无法抽取文字）'}`);
      } else {
        lines.push(`[附件 ${a.name}]（该类型暂不支持 AI 读取）`);
      }
    } catch {
      lines.push(`[附件 ${a.name}]（读取失败）`);
    }
  }
  return lines.length
    ? `\n\n[附件内容已由系统读取/转译，请直接基于以上内容回答，无需再调用工具读取附件文件]\n${lines.join('\n\n')}`
    : '';
}

/* ---------- API ---------- */

function sendErrorTo(res, message) {
  try {
    writeSse(res, 'error', { message });
    writeSse(res, 'done', {});
  } catch {
    // 客户端已断开
  }
}

async function handleMessage(req, res, url) {
  const id = url.pathname.split('/')[3];
  const session = store.get(id);
  if (!session) return sendJson(res, 404, { error: '会话不存在' });
  if (busy.has(id)) return sendJson(res, 409, { error: '该会话正在生成中' });

  const body = await readBody(req);
  if (body && body.__tooLarge) return sendJson(res, 413, { error: '内容超过 1MB 上限，请缩短后重试' });
  const prompt = String(body.prompt ?? '').trim();
  // 附件（媒体库 id + 展示快照）：仅消息展示用，不传给 claude prompt（模型暂不看图）
  const attachments = Array.isArray(body.attachments)
    ? body.attachments
        .filter((a) => a && typeof a.id === 'string')
        .map((a) => ({ id: a.id, name: a.name || a.id, kind: a.kind || 'file' }))
    : [];
  if (!prompt && attachments.length === 0) {
    return sendJson(res, 400, { error: '消息内容不能为空（请输入文字或附加文件）' });
  }
  // 附件上下文：文档抽字 + 图片视觉转描述（在 claude 调用前同步完成，让主模型"读到"附件）
  const attachCtx = await buildAttachmentContext(attachments);
  const claudePrompt = [prompt, attachCtx].filter(Boolean).join('\n\n') || '（附件消息，无文字内容）';

  busy.add(id);
  sseHeaders(res);

  const send = (event, data) => {
    try {
      writeSse(res, event, data);
    } catch {
      // 客户端已断开
    }
  };

  // resume 重放的历史消息按 claudeMessageId 去重，只追加本轮
  const knownClaudeIds = new Set(
    store.readMessages(id).filter((m) => m.claudeMessageId).map((m) => m.claudeMessageId),
  );

  const isNewSession = !session.claudeSessionId;

  // 乐观落盘 user 消息；新会话标题取第一句前 15 字，并通过 SSE 推给前端
  store.appendMessage(id, {
    role: 'user',
    text: prompt,
    ts: Date.now(),
    ...(attachments.length ? { attachments } : {}),
  });
  if (session.title === '新会话') {
    const title = prompt.slice(0, 15);
    store.update(id, { title });
    send('title_update', { sessionId: id, title });
  }
  send('start', { sessionId: id });

  const runner = createClaudeRunner({
    claudeBin: config.claudeBin,
    prompt: claudePrompt,
    model: session.model,
    claudeSessionId: session.claudeSessionId || undefined,
    cwd: session.cwd || config.defaultCwd,
    onEvent: (evt) => {
      // 新会话捕获 claude 内部 session id，供后续 --resume
      if (evt.type === 'system' && evt.subtype === 'init') {
        if (isNewSession && evt.session_id) {
          store.update(id, { claudeSessionId: evt.session_id });
        }
        // 捕获 claude 实际使用的模型 → 存会话 + 推给前端实时显示（右上角）
        if (evt.model) {
          store.update(id, { model: evt.model });
          send('model_update', { sessionId: id, model: evt.model });
        }
      }
      // 流式文本增量（打字效果）
      if (
        evt.type === 'stream_event' &&
        evt.event?.type === 'content_block_delta' &&
        evt.event.delta?.type === 'text_delta'
      ) {
        send('text_delta', { text: evt.event.delta.text });
      }
      // 全量 assistant（含 resume 重放），按 message.id 去重
      if (evt.type === 'assistant' && evt.message?.id && !knownClaudeIds.has(evt.message.id)) {
        knownClaudeIds.add(evt.message.id);
        const text = (evt.message.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (text) send('assistant', { claudeMessageId: evt.message.id, text });
      }
      // 结束：落盘 assistant、结束 SSE
      if (evt.type === 'result') {
        const text = typeof evt.result === 'string' ? evt.result : '';
        if (text) {
          store.appendMessage(id, { role: 'assistant', text, ts: Date.now(), claudeMessageId: null });
        }
        send('done', { text });
      }
    },
    onError: (err) => sendErrorTo(res, `claude 启动失败：${err.message}`),
  });

  activeRunners.set(id, runner);

  // 释放锁/runner（防重复执行：客户端断开、正常结束都只生效一次）
  let settled = false;
  const release = () => {
    if (settled) return;
    settled = true;
    activeRunners.delete(id);
    busy.delete(id);
  };

  // 客户端断开（刷新/关页面）：立即取消 claude 进程并释放锁，
  // 不等 runner.done —— 否则 claude 进程若卡住，busy 会永久占着，该会话再也发不了消息。
  res.on('close', () => {
    runner.cancel();
    release();
  });

  try {
    await runner.done;
  } finally {
    release();
    // 结束 SSE 流，前端据此收到流结束并定稿
    try {
      res.end();
    } catch {
      // 客户端已断开
    }
  }
}

async function routeApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, version: '1.3.0' });
  }

  if (method === 'GET' && pathname === '/api/balance') {
    return sendJson(res, 200, await fetchBalance());
  }

  if (method === 'GET' && pathname === '/api/skills') {
    return sendJson(res, 200, { skills: listSkills() });
  }

  if (method === 'POST' && pathname === '/api/media') {
    const name = url.searchParams.get('name') || '';
    const buf = await readRawBody(req);
    if (!buf) return sendJson(res, 413, { error: '文件过大（>50MB）或上传失败' });
    const r = saveMedia(buf, decodeURIComponent(name));
    if (!r.ok) return sendJson(res, 400, { error: r.error });
    return sendJson(res, 201, r.media);
  }

  if (method === 'GET' && pathname === '/api/media') {
    return sendJson(res, 200, { media: listMedia() });
  }

  const mm = pathname.match(/^\/api\/media\/([^/]+)(\/download)?$/);
  if (mm) {
    const [, mid, dl] = mm;
    const rec = getMedia(mid);
    if (!rec) return sendJson(res, 404, { error: '文件不存在' });
    if (method === 'GET') {
      return serveMediaFile(req, res, rec, !!dl);
    }
    if (method === 'DELETE') {
      deleteMedia(rec.id);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (method === 'GET' && pathname === '/api/models') {
    return sendJson(res, 200, { models: config.models, default: config.defaultModel });
  }

  if (method === 'GET' && pathname === '/api/autostart') {
    return sendJson(res, 200, { enabled: await getAutoStartEnabled() });
  }
  if (method === 'POST' && pathname === '/api/autostart') {
    const body = await readBody(req);
    await setAutoStart(Boolean(body.enabled));
    return sendJson(res, 200, { enabled: Boolean(body.enabled) });
  }

  if (method === 'GET' && pathname === '/api/sessions') {
    return sendJson(res, 200, { sessions: store.list() });
  }

  if (method === 'POST' && pathname === '/api/sessions') {
    const body = await readBody(req);
    // 方案C：先清理所有无消息的空会话（避免侧栏堆积空白会话）
    const cleanedIds = [];
    for (const s of store.list()) {
      if (store.readMessages(s.id).length === 0) {
        cleanedIds.push(s.id);
        store.remove(s.id);
      }
    }
    // 模型不在此存：由 CC Switch 在系统层切换，claude CLI 用系统默认模型
    const session = store.create({ model: body.model || undefined, cwd: body.cwd || config.defaultCwd });
    return sendJson(res, 201, { session, cleanedIds });
  }

  const m = pathname.match(/^\/api\/sessions\/([^/]+)(\/messages)?$/);
  if (m) {
    const [, id, suffix] = m;

    if (method === 'POST' && suffix === '/messages') {
      return handleMessage(req, res, url);
    }

    if (method === 'GET' && suffix === '/messages') {
      return sendJson(res, 200, { messages: store.readMessages(id) });
    }

    if (suffix === undefined) {
      if (method === 'GET') {
        const session = store.get(id);
        return session ? sendJson(res, 200, { session }) : sendJson(res, 404, { error: '会话不存在' });
      }
      if (method === 'PATCH') {
        const session = store.get(id);
        if (!session) return sendJson(res, 404, { error: '会话不存在' });
        const body = await readBody(req);
        const patch = {};
        if (body.model) patch.model = body.model;
        if (body.title) patch.title = body.title;
        return sendJson(res, 200, { session: store.update(id, patch) });
      }
      if (method === 'DELETE') {
        store.remove(id);
        return sendJson(res, 200, { ok: true });
      }
    }
  }

  sendJson(res, 404, { error: '接口不存在' });
}

/* ---------- 服务 ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await routeApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    console.error('[server] 处理请求出错:', err.message);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
    else res.destroy();
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[server] Claude Web 后端已启动: http://127.0.0.1:${config.port}`);
  console.log(`[server] claude.exe: ${config.claudeBin}`);
});
