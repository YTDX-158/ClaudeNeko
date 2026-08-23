import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './lib/settings.js';
import { SessionStore } from './lib/sessionStore.js';
import { createClaudeRunner } from './lib/claudeRunner.js';
import { createMediaService } from './lib/mediaGen.js';
import { sendJson, readBody, serveStatic } from './lib/util.js';
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
      serveStatic(req, res, url, DIST_DIR);
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
