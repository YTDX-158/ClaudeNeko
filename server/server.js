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
import { describeMedia } from './lib/mediaUnderstand.js';
import { createMediaService, ApiError } from './lib/mediaGen.js';

const config = resolveConfig();
const media = createMediaService(config.media);
const store = new SessionStore(config.dataDir);
const busy = new Set(); // per-session 在途锁
const activeRunners = new Map(); // id -> runner（取消用）

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(SERVER_DIR, '..', 'web', 'dist');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, '..', 'package.json'), 'utf8')).version || '1.3.0';

/* ---------- 工具 ---------- */

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
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
      data += chunk;
      if (data.length > 1e6) {
        tooLarge = true;
        finish({ __tooLarge: true }); // 标记超限，由调用方返回 413
        req.pause(); // 暂停接收，等 413 响应发出后连接自然关闭（destroy 会抢先断连）
      }
    });
    req.on('end', () => {
      try {
        finish(data ? JSON.parse(data) : {});
      } catch {
        finish({});
      }
    });
    req.on('error', () => finish({}));
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
    const timer = setTimeout(() => { req.destroy(); resolve(null); }, 30000); // 上传 30s 超时
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
    req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    req.on('error', () => { clearTimeout(timer); resolve(null); });
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

/** 附件上下文：文档抽字 + 图片视觉转描述 → 拼成给主模型的文本块。 */
async function buildAttachmentContext(attachments) {
  // 并行处理 + 异步读文件（不阻塞事件循环），单个失败不影响其他
  const results = await Promise.all(
    attachments.map(async (a) => {
      const rec = getMedia(a.id);
      if (!rec) return '';
      const filePath = getMediaPath(rec);
      try {
        if (rec.kind === 'image') {
          const buf = await fs.promises.readFile(filePath);
          const r = await describeImage(buf, rec.mime);
          return `[图片附件 ${a.name}] ${r.ok ? r.text : `（${r.error}）`}`;
        } else if (rec.kind === 'document' || rec.kind === 'file') {
          const buf = await fs.promises.readFile(filePath);
          const text = extractDocumentText(buf, rec.ext);
          return `[文档附件 ${a.name} 内容]${text ? `\n${text}` : '（无法抽取文字）'}`;
        } else if (rec.kind === 'video' || rec.kind === 'audio') {
          const buf = await fs.promises.readFile(filePath);
          const r = await describeMedia(rec.kind, buf, rec.mime, rec.originalName);
          return `[${rec.kind === 'video' ? '视频' : '音频'}附件 ${a.name}] ${r.ok ? r.text : `（${r.error}）`}`;
        }
        return `[附件 ${a.name}]（该类型暂不支持 AI 读取）`;
      } catch {
        return `[附件 ${a.name}]（读取失败）`;
      }
    }),
  );
  const lines = results.filter(Boolean);
  // 附件上下文总长上限，防多文档/多附件撑爆 prompt
  const MAX_CTX = 12000;
  const joined = lines.join('\n\n');
  const limited = joined.length > MAX_CTX ? `${joined.slice(0, MAX_CTX)}\n…（附件内容较多已截断）` : joined;
  return lines.length
    ? `\n\n[以下附件内容由系统读取/转译，用户看不到这段内容。请直接基于画面/文档内容展开回复（如"我看到的画面是…"），不要把这段当成对话里已有的交流，不要引用"上面/前面已经分析过"。]\n${limited}`
    : '';
}

/* ---------- 分支：构造历史说明块（喂给 claude 的首条 prompt 前缀） ---------- */
/** 把消息数组渲染成"用户/AI 交替"的对话历史文本，供分支会话首条注入。 */
function renderHistoryText(msgs) {
  const lines = [];
  for (const m of msgs) {
    const role = m.role === 'user' ? '用户' : 'AI';
    const text = (m.text ?? '').trim();
    if (!text) continue;
    lines.push(`${role}: ${text}`);
  }
  return lines.join('\n\n');
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
  busy.add(id); // 同步加锁（紧跟检查，防多开/并发双跑）
  const unlockBusy = () => busy.delete(id);

  const body = await readBody(req);
  if (body && body.__tooLarge) { unlockBusy(); return sendJson(res, 413, { error: '内容超过 1MB 上限，请缩短后重试' }); }
  const prompt = String(body.prompt ?? '').trim();
  // 附件（媒体库 id + 展示快照）：仅消息展示用，不传给 claude prompt（模型暂不看图）
  const attachments = Array.isArray(body.attachments)
    ? body.attachments
        .filter((a) => a && typeof a.id === 'string')
        .map((a) => ({ id: a.id, name: a.name || a.id, kind: a.kind || 'file' }))
    : [];
  if (!prompt && attachments.length === 0) {
    unlockBusy();
    return sendJson(res, 400, { error: '消息内容不能为空（请输入文字或附加文件）' });
  }
  // 附件上下文：文档抽字 + 图片视觉转描述（在 claude 调用前同步完成，让主模型"读到"附件）
  let attachCtx = '';
  try {
    attachCtx = await buildAttachmentContext(attachments);
  } catch {
    unlockBusy();
    throw new Error('附件处理失败');
  }
  // 分支首条：分支会话尚未发过真消息（claudeSessionId 仍空）时，
  // 把新会话里已复制的历史拼成说明块注入 claudePrompt；说明块只喂给 claude，不落盘。
  let branchHistoryCtx = '';
  if (session.parentId && !session.claudeSessionId && store.readMessages(id).length > 0) {
    const historyMsgs = store.readMessages(id).filter((m) => (m.text ?? '').trim());
    const historyText = renderHistoryText(historyMsgs);
    if (historyText) {
      branchHistoryCtx = `[这是你之前与该用户的对话历史，请记住并在此基础上继续（用户看不到这段说明）：\n\n${historyText}\n\n]`;
    }
  }
  const claudePrompt = [branchHistoryCtx, prompt, attachCtx].filter(Boolean).join('\n\n') || '（附件消息，无文字内容）';

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
    // 命名源：文字 或 第一个附件名（纯附件首条也能正常命名）
    const nameSource = prompt || attachments[0]?.name || '附件';
    const title = nameSource.slice(0, 15);
    store.update(id, { title });
    send('title_update', { sessionId: id, title });
  }
  send('start', { sessionId: id });

  let lastAssistantMsgId = null; // 记录本轮最后一次完整 assistant 的 claudeMessageId，result 落盘用

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
        lastAssistantMsgId = evt.message.id; // 记录最后一次完整 assistant 的 id，供 result 落盘用
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
          store.appendMessage(id, { role: 'assistant', text, ts: Date.now(), claudeMessageId: lastAssistantMsgId ?? null });
        }
        send('done', { text });
      }
    },
    onError: (err) => {
      // 空闲超时不是"启动失败"——用独立文案提示；其余（二进制缺失/参数错误等）才报启动失败
      const msg =
        err.code === 'IDLE_TIMEOUT'
          ? `claude 长时间无响应，已中止本次生成`
          : `claude 启动失败：${err.message}`;
      sendErrorTo(res, msg);
    },
  });

  activeRunners.set(id, runner);

  // 释放锁/runner（防重复执行：正常结束只生效一次）
  let settled = false;
  const release = () => {
    if (settled) return;
    settled = true;
    activeRunners.delete(id);
    busy.delete(id);
  };

  // 客户端断开（刷新/关页面）：不再取消 claude 进程——
  // 让 claude 在后台继续跑完并落盘，刷新回来后能取到完整回复（不再"不了了之"）。
  // busy 锁保留到 runner.done 完成（finally 里 release），防止刷新期间重复发消息双跑；
  // 若 claude 真卡死，claudeRunner 的空闲超时兜底会终止并释放。

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

/** 每会话生成媒体首次拉 claude：确认 + 留痕（claude 记住本会话在干媒体生成）。
 *  并行不阻塞生成；失败静默降级（仍标记，不反复拉）。 */
function maybeStartMediaClaude(session, skill, prompt) {
  if (!session || session.mediaClaudeInited) return;
  // 只落盘（store.update 会替换对象引用，直接改内存引用是冗余/无效）
  store.update(session.id, { mediaClaudeInited: true });
  const cPrompt = `用户在生成媒体：${skill === 'image' ? '生图' : '生视频'}「${prompt}」。你只需回复一句简短的确认（例如"好的，正在生成"）。不要展开、不要记录、不要执行任何操作、不要写记忆。`;
  const runner = createClaudeRunner({
    claudeBin: config.claudeBin,
    prompt: cPrompt,
    model: session.model || config.defaultModel,
    claudeSessionId: session.claudeSessionId || undefined,
    cwd: session.cwd || config.defaultCwd,
    onEvent: (evt) => {
      if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id && !session.claudeSessionId) {
        store.update(session.id, { claudeSessionId: evt.session_id });
      }
      if (evt.type === 'assistant' && evt.message?.id) {
        const text = (evt.message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        if (text) {
          store.appendMessage(session.id, { role: 'assistant', text, ts: Date.now(), claudeMessageId: evt.message.id });
        }
      }
    },
    onError: () => {}, // 静默：拉 claude 失败不影响生成
  });
  // 不 await，后台跑；结果由 onEvent 落盘
}

async function routeApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, version: APP_VERSION });
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

  /* ---------- 技能包：生成媒体 / 下载视频（mediaGen） ---------- */
  const genErr = (e) =>
    e instanceof ApiError
      ? sendJson(res, 400, { error: e.code, message: e.message })
      : sendJson(res, 500, { error: 'INTERNAL', message: e.message });

  if (method === 'GET' && pathname === '/api/media/config') {
    return sendJson(res, 200, media.getConfig());
  }

  if (method === 'POST' && pathname === '/api/media/generate') {
    const body = await readBody(req);
    if (body && body.__tooLarge) return sendJson(res, 413, { error: '内容超过 1MB 上限，请缩短后重试' });
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) return sendJson(res, 400, { error: 'EMPTY_PROMPT', message: '提示词不能为空' });
    const gsess = body.sessionId ? store.get(String(body.sessionId)) : null;
    try {
      if (body.kind === 'image') {
        if (gsess) maybeStartMediaClaude(gsess, 'image', prompt);
        return sendJson(res, 200, await media.generateImage({ prompt, model: body.model, ratio: body.ratio, resolution: body.resolution }));
      }
      if (body.kind === 'video') {
        if (gsess) maybeStartMediaClaude(gsess, 'video', prompt);
        return sendJson(res, 200, await media.generateVideo({ prompt, model: body.model, ratio: body.ratio, duration: body.duration, resolution: body.resolution }));
      }
      return sendJson(res, 400, { error: 'BAD_KIND', message: 'kind 需为 image 或 video' });
    } catch (e) {
      return genErr(e);
    }
  }

  const mtask = pathname.match(/^\/api\/media\/task\/([^/]+)$/);
  if (mtask && method === 'GET') {
    try {
      return sendJson(res, 200, await media.queryTask(mtask[1]));
    } catch (e) {
      return genErr(e);
    }
  }

  if (method === 'POST' && pathname === '/api/media/download') {
    const body = await readBody(req);
    if (body && body.__tooLarge) return sendJson(res, 413, { error: '内容超过 1MB 上限，请缩短后重试' });
    if (!body.url) return sendJson(res, 400, { error: 'NO_URL', message: '请粘贴视频链接' });
    try {
      return sendJson(res, 200, await media.download({ url: String(body.url), transcribe: !!body.transcribe }));
    } catch (e) {
      return genErr(e);
    }
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

  // 分支：从某个会话的指定消息处新建会话，复制其之前的历史作为上下文
  if (method === 'POST' && pathname === '/api/sessions/branch') {
    const body = await readBody(req);
    const parentId = String(body.parentId ?? '');
    const fromMsgId = String(body.fromMsgId ?? '');
    const parent = store.get(parentId);
    if (!parent) return sendJson(res, 404, { error: '源会话不存在' });
    const msgs = store.readMessages(parentId);
    const idx = msgs.findIndex((m) => m.claudeMessageId === fromMsgId || (fromMsgId && m.id === fromMsgId));
    if (idx < 0) return sendJson(res, 400, { error: '分支点消息不存在' });
    const slice = msgs.slice(0, idx + 1); // 分支点及之前的历史（含分支点这条 AI 回复）

    // 创建分支会话：继承父会话模型；标题取分支点消息前 15 字（避免首条消息触发自动命名）
    const branchPoint = msgs[idx];
    const title = (branchPoint.text ?? '').trim().slice(0, 15) || `从「${(parent.title ?? '源会话').slice(0, 8)}」分支`;
    const session = store.create({
      model: parent.model || undefined,
      cwd: parent.cwd || config.defaultCwd,
      title: title || '新会话',
      parentId,
      branchFromMsg: fromMsgId,
    });
    // 把复制出的历史逐条落盘到新会话 jsonl（前端切过来直接能看到完整历史）
    for (const m of slice) store.appendMessage(session.id, { ...m });
    return sendJson(res, 201, { session });
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

  // 取消该会话正在进行的生成（前端「停止」按钮走这里，真正杀 claude 进程并释放锁）
  if (method === 'POST' && pathname.endsWith('/cancel')) {
    const id = pathname.split('/').slice(-2)[0];
    const runner = activeRunners.get(id);
    if (runner) {
      runner.cancel(); // 杀 claude 进程树 → runner.done 会 resolve → finally 释放锁
      activeRunners.delete(id);
      busy.delete(id); // 立即释放，让用户能立刻重新发消息（而非等进程退出）
    }
    return sendJson(res, 200, { ok: true });
  }

  // 技能包消息：生成前用户提示词（role=user，触发命名）+ 生成结果 AI 消息（role=assistant 默认）
  const mmsg = pathname.match(/^\/api\/sessions\/([^/]+)\/media-message$/);
  if (mmsg && method === 'POST') {
    const sid = mmsg[1];
    const session = store.get(sid);
    if (!session) return sendJson(res, 404, { error: '会话不存在' });
    const body = await readBody(req);
    const role = body.role === 'user' ? 'user' : 'assistant';
    const text = String(body.text ?? '').trim();
    const attachments = Array.isArray(body.attachments) ? body.attachments.filter((a) => a && a.id) : [];
    if (!text && !attachments.length) return sendJson(res, 400, { error: '内容为空' });
    store.appendMessage(sid, { role, text, attachments, ts: Date.now() });
    // 新会话首条用户消息触发自动命名（照 handleMessage：text 或附件名前 15 字）
    if (role === 'user' && session.title === '新会话') {
      const nameSource = text || attachments[0]?.name || '生成';
      store.update(sid, { title: nameSource.slice(0, 15) });
    }
    return sendJson(res, 201, { ok: true });
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
        // 附带 busy 状态，前端刷新后能判断"上一条是否还在后台生成"
        return session
          ? sendJson(res, 200, { session: { ...session, busy: busy.has(id) } })
          : sendJson(res, 404, { error: '会话不存在' });
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

/* ---------- 来源校验（防 DNS rebinding / 跨域 CSRF） ---------- */
/** 非 GET 请求校验来源必须来自本机：同源/无来源（curl/本地程序）放行，陌生来源 403。 */
function isLocalRequest(req) {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (!origin && !referer) return true; // 无来源头 = 同源或命令行/本地程序
  const isLocal = (v) =>
    v === 'null' || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(v);
  return isLocal(origin || '') || isLocal(referer || '');
}

/* ---------- 服务 ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      // 写操作拦截陌生来源；读操作（GET）放行
      if (req.method !== 'GET' && !isLocalRequest(req)) {
        sendJson(res, 403, { error: '来源校验失败' });
        return;
      }
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
  console.log(`[server] ClaudeNeko 后端已启动: http://127.0.0.1:${config.port}`);
  console.log(`[server] claude.exe: ${config.claudeBin}`);
});
