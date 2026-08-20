import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './lib/settings.js';
import { SessionStore } from './lib/sessionStore.js';
import { createClaudeRunner } from './lib/claudeRunner.js';
import { sseHeaders, writeSse } from './lib/sse.js';
import { fetchBalance } from './lib/balance.js';

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
  if (!prompt) return sendJson(res, 400, { error: 'prompt 不能为空' });

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
  store.appendMessage(id, { role: 'user', text: prompt, ts: Date.now() });
  if (session.title === '新会话') {
    const title = prompt.slice(0, 15);
    store.update(id, { title });
    send('title_update', { sessionId: id, title });
  }
  send('start', { sessionId: id });

  const runner = createClaudeRunner({
    claudeBin: config.claudeBin,
    prompt,
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
