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
import { remoteHandler } from './routes/remote.js';
import { createRemote } from './lib/remote/index.js';
import * as pairing from './lib/remote/pairing.js';

const config = resolveConfig();
const media = createMediaService(config.media);
const store = new SessionStore(config.dataDir);
const busy = new Set(); // per-session 在途锁
const activeRunners = new Map(); // id -> runner（取消用）
const remote = createRemote({ pairing, config }); // 远程访问生命周期（默认关）
const remoteRouter = remoteHandler({ pairing, remote });

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(SERVER_DIR, '..', 'web', 'dist');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, '..', 'package.json'), 'utf8')).version || '1.3.0';
const systemRouter = systemHandler({ config, appVersion: APP_VERSION, getAutoStartEnabled, setAutoStart, readBody });
const mediaRouter = mediaHandler({ media, store, maybeStartMediaClaude });
const sessionsRouter = sessionsHandler({ store, config, busy, activeRunners, media });

/* ---------- 工具 ---------- */


/* ---------- 常驻自愈（任务计划）：登录触发 + 管理员可选开机触发，替换旧 HKCU 自启 ---------- */
const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_NAME = 'ClaudeNekoWeb'; // 旧 HKCU 自启项名（切换时清理）
const TASK_LOGON = 'ClaudeNekoServer'; // 登录触发任务（守护 start-server.bat）
const TASK_BOOT = 'ClaudeNekoServerBoot'; // 开机触发任务（需管理员，尽力而为）

function runPowerShell(script) {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    let err = '';
    // 15s 超时：PowerShell 挂起（任务计划服务异常等）时不让 /api/autostart 无限转圈
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已退出
      }
      resolve(out.trim());
    }, 15000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      clearTimeout(timer);
      // 注册/注销失败的真实原因（Access denied 等）落日志，排障不再靠猜
      if (err.trim()) console.error('[autostart] powershell stderr:', err.trim());
      resolve(out.trim());
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      console.error('[autostart] powershell 启动失败:', e.message);
      resolve(out.trim());
    });
  });
}

async function getAutoStartEnabled() {
  // 查任务存在且未被禁用（Disabled 状态不算自启开启，前端开关应与真实生效对齐）
  const out = await runPowerShell(
    `$t = Get-ScheduledTask -TaskName '${TASK_LOGON}' -ErrorAction SilentlyContinue; if ($t -and ("$($t.State)" -ne 'Disabled')) { 'yes' } else { 'no' }`,
  );
  return out === 'yes';
}

async function setAutoStart(enabled) {
  if (enabled) {
    const vbs = path.join(SERVER_DIR, '..', 'start-server.vbs').replace(/'/g, "''");
    // 登录触发 + 每 5 分钟重复（自愈）。schtasks 命令行不支持 ONLOGON 重复间隔，
    // 故用 PowerShell Repetition 实现。同时清理旧开机触发任务 + 旧 HKCU（防双机制重复拉起）。
    const script = [
      `$vbs = '${vbs}'`,
      // 先清残留任务 + 短延迟（Unregister 是异步的，立即 Register 会静默失败）
      `Unregister-ScheduledTask -TaskName '${TASK_LOGON}' -Confirm:$false -ErrorAction SilentlyContinue`,
      `Start-Sleep -Milliseconds 300`,
      `$trigger = New-ScheduledTaskTrigger -AtLogOn`,
      `$rep = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)`,
      `$trigger.Repetition = $rep.Repetition`,
      `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')`,
      `Register-ScheduledTask -TaskName '${TASK_LOGON}' -Action $action -Trigger $trigger -Force | Out-Null`,
      `Unregister-ScheduledTask -TaskName '${TASK_BOOT}' -Confirm:$false -ErrorAction SilentlyContinue`,
      `Remove-ItemProperty -Path '${RUN_KEY}' -Name '${AUTOSTART_NAME}' -ErrorAction SilentlyContinue`,
    ].join('; ');
    await runPowerShell(script);
  } else {
    await runPowerShell(
      `Unregister-ScheduledTask -TaskName '${TASK_LOGON}' -Confirm:$false -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${TASK_BOOT}' -Confirm:$false -ErrorAction SilentlyContinue`,
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

  const remoteRes = await remoteRouter(req, res, url);
  if (remoteRes !== null) return;

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

/* ---------- 退出清理：杀隧道 + 关远程代理，避免 Windows 下孤儿残留 ---------- */
function cleanupRemote() {
  try {
    remote.stop();
  } catch {
    // 忽略
  }
}
process.on('exit', cleanupRemote);
for (const sig of ['SIGINT', 'SIGTERM']) {
  try {
    process.on(sig, () => {
      cleanupRemote();
      process.exit(0);
    });
  } catch {
    // 平台不支持该信号
  }
}
