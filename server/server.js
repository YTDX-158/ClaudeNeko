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
import { sendJson, readBody, serveStatic, parseFrontmatter, listSkills, readRawBody, serveMediaFile } from './lib/util.js';
import { systemHandler } from './routes/system.js';
import { mediaHandler } from './routes/media.js';
import { sessionsHandler } from './routes/sessions.js';

const config = resolveConfig();
const media = createMediaService(config.media);
const store = new SessionStore(config.dataDir);
const busy = new Set(); // per-session 在途锁
const activeRunners = new Map(); // id -> runner（取消用）

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(SERVER_DIR, '..', 'web', 'dist');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, '..', 'package.json'), 'utf8')).version || '1.3.0';
const systemRouter = systemHandler({ config, appVersion: APP_VERSION, getAutoStartEnabled, setAutoStart, readBody });
const mediaRouter = mediaHandler({ media, store, maybeStartMediaClaude });
const sessionsRouter = sessionsHandler({ store, config, busy, activeRunners, media });

/* ---------- 工具 ---------- */


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
/* ---------- 媒体库（上传/列表/预览下载/删除） ---------- */

/** 附件上下文：文档抽字 + 图片视觉转描述 → 拼成给主模型的文本块。 */
/* ---------- 分支：构造历史说明块（喂给 claude 的首条 prompt 前缀） ---------- */
/** 把消息数组渲染成"用户/AI 交替"的对话历史文本，供分支会话首条注入。 */
/* ---------- API ---------- */

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

/** 分支历史注入阈值：早期压缩成摘要，近期保留全量（防长会话分支后 claude 被全量历史拖慢） */

/** 调 claude 把早期对话压缩成摘要（2-4 句中文要点），供分支会话引用；失败返回空串（调用方 fallback 全量）。 */
/** 分支会话创建后：后台生成早期历史摘要（fire-and-forget，不阻塞分支创建），完成存 session.earlySummary。 */
async function routeApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  const sys = await systemRouter(req, res, url);
  if (sys !== null) return;

  const mediaRes = await mediaRouter(req, res, url);
  if (mediaRes !== null) return;

  const sessRes = await sessionsRouter(req, res, url);
  if (sessRes !== null) return;

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
    // 后台生成早期历史摘要（长会话分支提速：首次/后续发消息用「摘要+近期全量」而非全量历史）
    maybeSummarizeEarlyHistory(session, slice);
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

  // 强制结束当前对话任务：杀 claude runner + 释放锁 + 清全部生成任务（生视频也能取消）
  if (method === 'POST' && pathname.endsWith('/force-stop')) {
    const id = pathname.split('/').slice(-2)[0];
    const runner = activeRunners.get(id);
    if (runner) {
      runner.cancel(); // 杀 claude 进程树
      activeRunners.delete(id);
    }
    busy.delete(id); // 释放该会话锁
    media.cancelAll(); // 清生成任务（并发 1，清全部 = 清当前）
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
