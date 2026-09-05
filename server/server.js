import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './lib/settings.js';
import { SessionStore } from './lib/sessionStore.js';
// （maybeStartMediaClaude 已退役：媒体生成命令改为经 pty 提交进 claude 会话，见 routes/media.js）
import { createBusyLock } from './lib/busyLock.js';
import { createMediaService } from './lib/mediaGen.js';
import { setVisionConfigProvider } from './lib/vision.js';
import { pruneMedia } from './lib/mediaStore.js';
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
import { configHandler } from './routes/config.js';
import { mediaConfigHandler } from './routes/mediaConfig.js';
import { permissionHandler } from './routes/permission.js'; // 权限体系 P1-2：审批接口
import { ensurePermissionHook } from './lib/hookManager.js'; // 权限体系 P1-2：注入 PermissionRequest hook
import { createModelConfig } from './lib/modelConfig.js';
import { createMediaConfig } from './lib/mediaConfig.js';
import { createPermissionConfig } from './lib/permissionConfig.js'; // 权限体系 P1：权限档存储（server/data/permissionConfig.json）
import * as configService from './lib/configService.js';
import { detectEnv } from './lib/envReport.js';
import { createRemote } from './lib/remote/index.js';
import * as pairing from './lib/remote/pairing.js';
import { logger } from './lib/logger.js';

// 9-03 崩溃日志：未捕获异常/拒绝留 ERROR/WARN（本地排雷最怕悄无声息挂）
process.on('uncaughtException', (e) => {
  logger.error('server', '未捕获异常（进程退出）', e);
  process.exit(1); // 记录后退出，防半死进程
});
process.on('unhandledRejection', (reason) => {
  logger.warn('server', '未处理的 Promise 拒绝', reason instanceof Error ? reason : new Error(String(reason)));
});

const config = resolveConfig();
const mediaConfigService = createMediaConfig({ dataDir: config.dataDir }); // 生图生视频模型条目（设置中心「媒体配置」）
const permissionConfigService = createPermissionConfig({ dataDir: config.dataDir }); // 权限体系 P1：权限档（ask/smart/bypass）+ 黑白名单
const media = createMediaService({
  ...config.media,
  dataDir: config.dataDir,
  mediaConfig: mediaConfigService,
  logEnabled: () => mediaConfigService.getLogEnabled(), // 台账记录开关（默认开，可关）
  // 视频任务完成 → 按 sid 回填 claude 会话（记忆完整；异步回调执行时 ptyHost 已初始化）
  onTaskSettled: ({ sid, status, error, model }) => {
    if (!sid || !ptyHost) return;
    const text = status === 'done'
      ? `【系统记录】上述视频已生成（媒体库可查看，模型 ${model || ''}）。`
      : `【系统记录】上述视频生成失败：${error || '未知原因'}。`;
    ptyHost.submit(sid, text, { noConfirm: true }); // 媒体记忆：丢了不重发（防重复注入）
  },
}); // dataDir 供任务落盘 gen_tasks.json
setVisionConfigProvider(() => mediaConfigService.getVision()); // 视觉理解只认配置页（mediaConfig.vision）
// 媒体库自动清理（审查⑤）：启动清一次 + 每 24h 清一次（TTL 30 天 / 总量上限 2GB）
pruneMedia();
setInterval(() => { try { pruneMedia(); } catch (e) { logger.error('media', '定时清理失败:', e.message); } }, 24 * 3600 * 1000).unref?.();
const store = new SessionStore(config.dataDir);
const busyLock = createBusyLock(); // per-session 在途锁（唯一写入口，见 lib/busyLock.js）
const bus = createEventBus(); // 模块解耦事件总线（Phase2，事件字典见 lib/bus.js）
const remote = createRemote({
  pairing,
  config,
  disconnectBusinessSockets: () => terminal.disconnectRemoteClients(),
}); // 远程访问生命周期（默认关）
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
  logger.info('ptyHost', `pty 退出 sid=${sid}`);
  busyLock.release(sid);
  permissionService?.cancelBySid?.(sid); // 权限体系 N2：会话关闭 → 清未决权限请求（防泄漏）
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
bus.on('transcript:user', ({ sid, ev }) => {
  // 确认送达（9-02）：jsonl 里出现该 user 文本 = 消息真进了 claude → 清 ptyHost 待确认（不再重发）
  ptyHost?.confirmDelivered?.(sid, ev.text, ev.ts);
  claimPendingUser(sid, ev);
});
bus.on('transcript:assistant', handleAssistantEvent);
bus.on('transcript:tool', ({ sid, ev }) => terminal.broadcast(sid, { t: 'ev', e: ev }));
// 确认送达重发耗尽（9-02）：消息确认没进 claude → 释放 busy + 广播失败（前端"思考中"换错误，不再干等 5min 超时）
bus.on('pty:confirm-fail', ({ sid, text }) => {
  busyLock.release(sid);
  terminal.broadcast(sid, { t: 'send-fail', text });
  logger.warn('pty', `消息确认送达失败（重发耗尽）sid=${sid}: ${String(text).slice(0, 50)}`);
});

// 终端 WS 通道（upgrade 挂载在 server.on('upgrade')）
const terminal = createTerminalChannel({ ptyHost, transcript, store, config, isLocalRequest });
// —— 权限体系 P1-2：注入 PermissionRequest hook（写 ~/.claude/settings.json，保留用户 PreToolUse）+ 审批服务 ——
ensurePermissionHook();
const permissionService = permissionHandler({
  store, terminal, permissionConfig: permissionConfigService, isLocalRequest, logger,
});

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(SERVER_DIR, '..', 'web', 'dist');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, '..', 'package.json'), 'utf8')).version || '1.3.0';
const modelConfig = createModelConfig({ dataDir: config.dataDir });
const configRouter = configHandler({ modelConfig, configService, detectEnv, readBody, ptyHost, store, busyLock, media });
const mediaConfigRouter = mediaConfigHandler({ mediaConfig: mediaConfigService, readBody, imageModels: config.media.imageModels, videoModels: config.media.videoModels });
const systemRouter = systemHandler({ config, appVersion: APP_VERSION, getAutoStartEnabled, setAutoStart, readBody, isLocalRequest });
const mediaRouter = mediaHandler({ media, mediaConfig: mediaConfigService, store, ptyHost, isLocalRequest });
const sessionsRouter = sessionsHandler({ store, config, busyLock, media, isLocalRequest, ptyHost, transcript, terminal, permissionConfig: permissionConfigService });
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
      if (err.trim()) logger.error('autostart', 'powershell stderr:', err.trim());
      resolve(out.trim());
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      logger.error('autostart', 'powershell 启动失败:', e.message);
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
// （maybeStartMediaClaude 已删除：媒体生成命令改为经 pty 提交进 claude 会话，见 routes/media.js）

/** 分支历史注入阈值：早期压缩成摘要，近期保留全量（防长会话分支后 claude 被全量历史拖慢） */

/** 调 claude 把早期对话压缩成摘要（2-4 句中文要点），供分支会话引用；失败返回空串（调用方 fallback 全量）。 */
/** 分支会话创建后：后台生成早期历史摘要（fire-and-forget，不阻塞分支创建），完成存 session.earlySummary。 */

/* ---------- transcript 事件 → store 镜像 + WS 推送 ---------- */
/** 系统记录确认词：claude 对【系统记录】的机械确认（只认"已记录"类，不误伤"好的/收到"等正常回复）。 */
const SYSTEM_CONFIRM = /^(好的?，?)?已记录?[，。！!~～\s]*$/i;
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
    // 系统记录确认：claude 对【系统记录】的机械确认 → 标 isSystem（前端不渲染，防"已记录"刷屏）。
    // B2（9-03 放宽）：不再要求「最近一条 user 是 isSystem」——媒体系统记录可能夹在用户真实消息之间，
    // 原条件会漏标（store 实证：'已记录。' 因前文是用户消息而漏滤显示成气泡）。
    // 放宽为：匹配短确认词（≤30 字符）即标。误吞风险极低——用户正常问答不会产出 ≤30 字符的纯"已记录"式回复。
    const isSystemConfirm = SYSTEM_CONFIRM.test(String(ev.text || '').trim()) && String(ev.text || '').trim().length <= 30;
    store.appendMessage(sid, {
      role: 'assistant',
      text: ev.text,
      thinking: ev.thinking || undefined,
      usage: normalizeUsage(ev.usage) || undefined,
      ts: ev.ts ?? Date.now(),
      claudeMessageId: ev.claudeMessageId,
      ...(isSystemConfirm ? { isSystem: true } : {}),
    });
    // H3 修复：busyLock.release 内建清 5min 超时器（防旧 timer 到期误删下一轮新锁）
    busyLock.release(sid);
    terminal.broadcast(sid, { t: 'ev', e: ev });
  } catch (err) {
    logger.error('transcript', `assistant 事件处理失败 sid=${sid}:`, err.message);
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
  const text = typeof ev.text === 'string' ? ev.text : '';
  // B1（9-03）：系统记录（【系统记录】开头）回读 → 不认领用户 pending（它不是用户消息），
  // 直接独立落库为 isSystem user。否则系统记录的 id 会认领到用户真实消息上（store 实证），
  // 导致 claude 的"已记录"确认找不到前置 isSystem → 漏标漏滤。
  if (text.startsWith('【系统记录】')) {
    store.appendMessage(sid, { role: 'user', text, ts: ev.ts ?? Date.now(), claudeMessageId: ev.claudeMessageId, isSystem: true });
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
  // 没有 pendingJsonl（终端直接打的）→ append 新用户消息。
  store.appendMessage(sid, { role: 'user', text, ts: ev.ts ?? Date.now(), claudeMessageId: ev.claudeMessageId });
}

async function routeApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  const sys = await systemRouter(req, res, url);
  if (sys !== null) return;

  const cfgRes = await configRouter(req, res, url);
  if (cfgRes !== null) return;

  const mcRes = await mediaConfigRouter(req, res, url);
  if (mcRes !== null) return;

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

  const permRes = await permissionService.router(req, res, url); // 权限体系 P1-2：审批（request/wait/respond/pending/secret）
  if (permRes !== null) return;

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
    logger.error('server', '处理请求出错:', err.message);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
    else res.destroy();
  }
});

// WebSocket upgrade（终端/聊天通道）：挂到主 server，远程经 proxy 转发后 isLocalRequest 放行
server.on('upgrade', terminal.upgradeHandler);

server.listen(config.port, '127.0.0.1', () => {
  logger.info('server', `ClaudeNeko 后端已启动: http://127.0.0.1:${config.port}`);
  logger.info('server', `claude.exe: ${config.claudeBin}`);
  logger.info('server', `终端页: ${ptyHost.available ? '可用（node-pty 已加载）' : '不可用（node-pty 加载失败，聊天降级）'}`);
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
