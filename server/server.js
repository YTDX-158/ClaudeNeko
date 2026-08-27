import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './lib/settings.js';
import { SessionStore } from './lib/sessionStore.js';
import { createClaudeRunner } from './lib/claudeRunner.js';
import { createBusyLock } from './lib/busyLock.js';
import { createMediaService } from './lib/mediaGen.js';
import { createPtyHost } from './lib/ptyHost.js';
import { createEventBus } from './lib/bus.js';
import { createTranscriptService } from './lib/transcript.js';
import { sendJson, readBody, serveStatic } from './lib/util.js';
import { systemHandler } from './routes/system.js';
import { mediaHandler } from './routes/media.js';
import { sessionsHandler } from './routes/sessions.js';
import { statsHandler } from './routes/stats.js';
import { searchHandler } from './routes/search.js';
import { exportHandler } from './routes/export.js';
import { remoteHandler } from './routes/remote.js';
import { createTerminalChannel } from './routes/terminal.js';
import { createRemote } from './lib/remote/index.js';
import * as pairing from './lib/remote/pairing.js';

const config = resolveConfig();
const media = createMediaService({ ...config.media, dataDir: config.dataDir }); // dataDir 供任务落盘 gen_tasks.json
const store = new SessionStore(config.dataDir);
const busyLock = createBusyLock(); // per-session 在途锁（唯一写入口，见 lib/busyLock.js）
const bus = createEventBus(); // 模块解耦事件总线（Phase2，事件字典见 lib/bus.js）
const remote = createRemote({ pairing, config }); // 远程访问生命周期（默认关）
const remoteRouter = remoteHandler({ pairing, remote });

// 常驻 pty + jsonl 轮询 + 终端 WS 通道（c2web 模式）
const ptyHost = createPtyHost({
  claudeBin: config.claudeBin,
  bus, // Phase2：pty 退出走事件总线
  onData: (sid, d) => {
    terminal.setTermBuffer(sid, d);
    // termOnly：终端流只发给已 attach 且不在同步窗的客户端（防 attach 前实时流与快照叠加 → 消息重复）
    terminal.broadcast(sid, { t: 'term', d }, { termOnly: true });
  },
});
// Phase2：pty 退出走事件总线（M4：释放 busy + 广播异常，否则用户卡在"生成中"）
// 注意：不在此释放 transcript（force-stop 后用户会重新发消息 → 重新 ensure，
// 若释放则 emitted=0 全量回放 → 触发历史重复）。释放只发生在会话删除（见 DELETE handler）。
bus.on('pty:exit', ({ sid }) => {
  console.log(`[ptyHost] pty 退出 sid=${sid}`);
  busyLock.release(sid);
  terminal.broadcast(sid, { t: 'ev', e: { kind: 'error', text: '终端进程已退出，请重新发送消息' } });
});
ptyHost.scheduleIdleReap();

// transcript 轮询回调：把 jsonl 新消息镜像进 store + 推 WS 事件（Phase2 走事件总线）
const transcript = createTranscriptService({
  bus,
  // 探测时排除 store 已有会话的 claudeSessionId（防命中活跃会话污染新会话）
  getKnownSessionIds: () => store.list().map((s) => s.claudeSessionId).filter(Boolean),
});
// Phase2：server 订阅 transcript 事件做 store 镜像 / busy 释放 / WS 推送
bus.on('transcript:sessionId', onSessionIdDiscovered);
bus.on('transcript:user', ({ sid, ev }) => claimPendingUser(sid, ev));
bus.on('transcript:assistant', handleAssistantEvent);
bus.on('transcript:tool', ({ sid, ev }) => terminal.broadcast(sid, { t: 'ev', e: ev }));

// 终端 WS 通道（upgrade 挂载在 server.on('upgrade')）
const terminal = createTerminalChannel({ ptyHost, transcript, store, config, isLocalRequest });

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(SERVER_DIR, '..', 'web', 'dist');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, '..', 'package.json'), 'utf8')).version || '1.3.0';
const systemRouter = systemHandler({ config, appVersion: APP_VERSION, getAutoStartEnabled, setAutoStart, readBody });
const mediaRouter = mediaHandler({ media, store, maybeStartMediaClaude, isLocalRequest });
const sessionsRouter = sessionsHandler({ store, config, busyLock, media, isLocalRequest, ptyHost, transcript, terminal });
const statsRouter = statsHandler({ store, isLocalRequest }); // 成本统计（独立路由）
const searchRouter = searchHandler({ store, isLocalRequest }); // 消息搜索（独立路由）
const exportRouter = exportHandler({ store, isLocalRequest }); // 会话导出（独立路由）

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
  const mediaClaudeCwd = path.join(config.dataDir, 'mediaClaude');
  try { fs.mkdirSync(mediaClaudeCwd, { recursive: true }); } catch { /* 尽力而为 */ }
  const cPrompt = `用户在生成媒体：${skill === 'image' ? '生图' : '生视频'}「${prompt}」。你只需回复一句简短的确认（例如"好的，正在生成"）。不要展开、不要记录、不要执行任何操作、不要写记忆。`;
  const runner = createClaudeRunner({
    claudeBin: config.claudeBin,
    prompt: cPrompt,
    model: session.model || config.defaultModel,
    // ⚠ 修正点4：不传 claudeSessionId（独立会话）——只是一句确认，不需要上下文，
    // 也避免与常驻 pty 同时写同一 jsonl 冲突。claudeSessionId 归属权只由 transcript 写（修正点2）。
    // M1：cwd 用独立目录（mediaClaude），其 jsonl 建在别处，不干扰会话目录的 transcript 探测
    cwd: mediaClaudeCwd,
    onEvent: (evt) => {
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

/* ---------- transcript 事件 → store 镜像 + WS 推送 ---------- */
/** 新会话首次探测到 claudeSessionId（transcript 扫描 jsonl 得到）→ 回写 store（修正点2：归属权只由这里写） */
function onSessionIdDiscovered({ sid, claudeSessionId }) {
  // ⚠ Phase2 适配：bus 订阅收的是 payload 对象（{sid, claudeSessionId}），
  // 不是旧的 (sid, claudeSessionId) 两参数——签名不匹配会导致永不回写 claudeSessionId
  const s = store.get(sid);
  if (!s || s.claudeSessionId) return;
  // ⚠ 占用检查（8-26 P1 修复）：该 claudeSessionId 已被其他会话占用 → 探测到别人在用的会话，忽略
  const taken = store.list().some((x) => x.id !== sid && x.claudeSessionId === claudeSessionId);
  if (taken) return;
  store.update(sid, { claudeSessionId });
  // 探测到 jsonl = claude 主程序真正就绪 → 通知 ptyHost 补发积压消息
  //（8-27 修复：outAcc>1000 就绪判定不可靠，冷启动会提前亮灯吞回车）
  ptyHost.markReady(sid);
}

/** transcript:assistant 事件（Phase2 拆分）：落盘 store + 释放 busy + WS 推送 */
function handleAssistantEvent({ sid, ev }) {
  try {
    // 去重：jsonl 同 message.id 多次轮询（emitted 已挡，但跨轮询兜底）
    const msgs = store.readMessages(sid);
    if (msgs.some((m) => m.claudeMessageId === ev.claudeMessageId)) return;
    store.appendMessage(sid, {
      role: 'assistant',
      text: ev.text,
      thinking: ev.thinking || undefined,
      usage: normalizeUsage(ev.usage) || undefined,
      ts: ev.ts ?? Date.now(),
      claudeMessageId: ev.claudeMessageId,
    });
    // H3 修复：busyLock.release 内建清 5min 超时器（防旧 timer 到期误删下一轮新锁）
    busyLock.release(sid);
    terminal.broadcast(sid, { t: 'ev', e: ev });
  } catch (err) {
    console.error(`[transcript] assistant 事件处理失败 sid=${sid}:`, err.message);
  }
}

/** 把 jsonl 的 message.usage 归一化成 store 的 usage 结构（供成本统计） */
function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const out = {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
  };
  // 归一 thinking_tokens（jsonl 可能在 output_tokens_details 里）
  out.thinking_tokens = u.output_tokens_details?.thinking_tokens ?? 0;
  if (out.input_tokens || out.output_tokens || out.thinking_tokens) return out;
  return null;
}

/** 认领 pendingJsonl：找该会话最近一条 pendingJsonl 用户消息，补 claudeMessageId */
function claimPendingUser(sid, ev) {
  const msgs = store.readMessages(sid);
  // H2 修复：先按 claudeMessageId 查重（服务重启后 transcript 全量回放会重放历史 user 消息，
  // 若 store 已有同 id 的则直接跳过，不 append 造成重复）
  if (ev.claudeMessageId && msgs.some((m) => m.claudeMessageId === ev.claudeMessageId)) {
    return;
  }
  // 从后往前找最近一条 pendingJsonl 用户消息（避免误认领终端新打的）
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'user' && m.pendingJsonl) {
      store.updateMessage(sid, i, { claudeMessageId: ev.claudeMessageId, pendingJsonl: false });
      return;
    }
  }
  // 没有 pendingJsonl（终端直接打的）→ append 新用户消息
  store.appendMessage(sid, { role: 'user', text: ev.text, ts: ev.ts ?? Date.now(), claudeMessageId: ev.claudeMessageId });
}

async function routeApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  const sys = await systemRouter(req, res, url);
  if (sys !== null) return;

  const mediaRes = await mediaRouter(req, res, url);
  if (mediaRes !== null) return;

  // Phase1 拆分：导出/搜索/统计独立路由。放 sessions 前——/api/sessions/export-all 等
  // 前缀会撞 sessions 的通用匹配（^/api/sessions/([^/]+)），必须让独立路由先处理。
  const exportRes = await exportRouter(req, res, url);
  if (exportRes !== null) return;

  const searchRes = await searchRouter(req, res, url);
  if (searchRes !== null) return;

  const statsRes = await statsRouter(req, res, url);
  if (statsRes !== null) return;

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
  // 来源校验：只认本机域名。Origin: null（沙箱 iframe/data: 文档）一律视为陌生来源——它来自任意网页
  const isLocal = (v) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(v);
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

// WebSocket upgrade（终端/聊天通道）：挂到主 server，远程经 proxy 转发后 isLocalRequest 放行
server.on('upgrade', terminal.upgradeHandler);

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[server] ClaudeNeko 后端已启动: http://127.0.0.1:${config.port}`);
  console.log(`[server] claude.exe: ${config.claudeBin}`);
  console.log(`[server] 终端页: ${ptyHost.available ? '可用（node-pty 已加载）' : '不可用（node-pty 加载失败，聊天降级）'}`);
});

/* ---------- 退出清理：杀隧道 + 关远程代理 + 杀 pty 进程树，避免 Windows 下孤儿残留 ---------- */
function cleanupRemote() {
  try {
    remote.stop();
  } catch {
    // 忽略
  }
  try {
    ptyHost.killAll();
  } catch {
    // 忽略
  }
  try {
    transcript.releaseAll();
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
