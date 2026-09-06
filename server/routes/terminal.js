// server/routes/terminal.js — 网页终端 WS 通道 + runtime 编排
//
// 一条 WS 承载两种读路 + 一条写路：
//   - 终端读路：pty 原始字节流 → {t:'term'}（只发给 wantTerm 的客户端，64KB 回放缓冲）
//   - 聊天读路：jsonl 轮询事件 → {t:'ev'}（server.js 经 onChatEvent 转调广播）
//   - 写路：客户端 → {t:'send'|'i'|'r'} 注入 pty
//
// 协议沿用 @inksnow/c2web (MIT)：
//   客户端→服务端: send(text) / i(d) / r(c,r) / attach / detach
//   服务端→客户端: ev / term / term-replay
//
// 每个 Neko 会话（sid）一个常驻 pty + 一个 transcript 轮询（懒启动）。
// 鉴权：upgrade 时校验 isLocalRequest(req)——本机 dev/prod 来源头都匹配；
// 远程经 proxy 重写 Origin/Host 成本机后也匹配（与现有 HTTP 转发模型一致）。

import { existsSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { reserveClaudeSession } from '../lib/claudeLaunch.js';
import { logger } from '../lib/logger.js';
import { createSocketRegistry } from '../lib/remote/proxy.js';
import { sessionFile } from '../lib/transcript.js';

const TERM_BUF_MAX = 2 * 1024 * 1024; // 回放缓冲上限（最近 2MB 原始字节，够滚回看多次生成的完整输出；原 64KB 太小）
const SYNC_WINDOW_MS = 200; // attach 同步窗：200ms 内 drop 实时流，等快照稳定再发（tmux-web 默认值）
// —— 死锁自愈（8-29 单色+c 根治）：claude 偶发「TUI 渲染死锁」——
// 取证实锤：claude 进程活着（启动输出>1KB 触发就绪、内存 300MB），但当前画面 termBuf 只有 1 字节"C"，
// 回放给前端即「单色+c」。attach+resize 80 列也不唤醒（已实测），只能 kill 重启（用户验证「重开就好」）。
// 判据 = termBuf 实质长度：正常 TUI 画面远超 200B，死锁只有"C"。
// ⚠ 8-29 实测发现：死锁可发生在「attach 后」任意时刻（手机 attach → 清 termBuf → claude 重绘崩），
// 单次检测（spawn 后 25s 查一次）覆盖不了 → 改为**周期检测**（每 30s 检查活跃会话，清缓冲后 10s 宽限防误杀）。
const HEAL_INTERVAL_MS = 30 * 1000; // 周期检测间隔
const HEAL_CLEAR_GRACE_MS = 10 * 1000; // 清缓冲/attach 后宽限期（等 claude 重绘，防误杀）
const STARTUP_MIN_TERMBUF = 200; // termBuf 长度下限（低于 = TUI 未画出/死锁）
const MAX_STARTUP_RETRIES = 2; // 自愈重启最多重试次数（共 3 次尝试）
const WAKE_CHECK_MS = 3 * 1000; // attach 后快速唤醒检查：3s 内 TUI 未画出 → 宽列 resize 唤醒（秒级，不用 kill 重启）
const WAKE_COLS = 80; // 唤醒列宽：claude Ink 在宽列重绘正常（实测 attach 80 列即恢复），窄列才崩

/**
 * 创建终端 WS 通道。
 * @param {{ ptyHost: object, transcript: object, store: object, config: object, permissionConfig?: object, isLocalRequest: (req)=>boolean }} deps
 */
export function createTerminalChannel({ ptyHost, transcript, store, config, permissionConfig, isLocalRequest }) {
  // perMessageDeflate:false —— 禁用 WS 压缩。
  // 远程链路（cloudflared 隧道）对 permessage-deflate 压缩帧的转发不可靠（实测手机端
  // WS 数据损坏：聊天靠 HTTP 轮询兜底仍显示但 streaming 卡死、终端完全空白）。
  // 禁用后帧全明文，浏览器端不再协商压缩，cloudflared 字节透传即安全。
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const clients = new Set(); // 所有 ws 连接（ws.sid, ws.wantTerm）
  const remoteClients = createSocketRegistry({
    disconnect(ws) {
      if (typeof ws.terminate === 'function') ws.terminate();
      else ws.close?.(1008, '远程凭据已撤销');
    },
  });
  const termBufs = new Map(); // sid -> 最近 64KB 原始字节（attach 回放）
  const healState = new Map(); // sid -> { retries, lastClear }（死锁自愈检测状态）
  const wakeTimers = new Map(); // sid -> setTimeout（attach 后快速唤醒检查）

  function ensureRuntime(sid) {
    const session = store.get(sid);
    if (!session) return { isNew: false, available: false };
    const cwd = session.cwd || config.defaultCwd;
    const reserved = reserveClaudeSession({
      session,
      getSession: (id) => store.get(id),
      update: (id, patch) => store.update(id, patch),
      transcriptExists: (claudeSessionId) => existsSync(sessionFile(cwd, claudeSessionId)),
    });
    const ptyRes = ptyHost.ensure(sid, {
      cwd,
      ...reserved,
      permissionMode: permissionConfig?.getMode(),
    });
    transcript.ensure(sid, { cwd, claudeSessionId: reserved.claudeSessionId });
    return ptyRes;
  }

  // M14 心跳（流量检测版）：不依赖 ping/pong（实测前端可能不回 pong 导致误杀）。
  // 改为看连接「消息活动」：每次收发消息刷新 lastActivity，5 分钟无任何流量才 close。
  // claude TUI 持续输出（onData 广播）会不断刷新，正常连接永不误杀。
  const IDLE_CLOSE_MS = 5 * 60 * 1000;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const w of clients) {
      if (w.lastActivity === undefined) w.lastActivity = now;
      if (now - w.lastActivity > IDLE_CLOSE_MS) {
        try { w.close(); } catch { /* 已关 */ }
      }
    }
  }, 60000);
  heartbeat.unref?.();

  /** 给订阅某 sid 的 ws 发 JSON（try/catch 防已断）。
   *  opts.termOnly=true：终端流只发给「已 attach（wantTerm）」且「不在同步窗内」的客户端——
   *  防止 attach 前的客户端收到实时流、与稍后的快照回放叠加（手机远程消息重复的根因）。
   *  聊天事件 ev 不传 termOnly（聊天不依赖 attach，要全收）。 */
  function broadcast(sid, obj, opts) {
    const payload = JSON.stringify(obj);
    const now = Date.now();
    for (const ws of clients) {
      if (ws.sid === sid && ws.readyState === 1) {
        if (opts?.termOnly) {
          if (!ws.wantTerm) continue; // 没 attach 的不收终端流
          if (ws.syncUntil && now < ws.syncUntil) continue; // 同步窗内 drop 实时流（等快照稳定）
        }
        ws.lastActivity = Date.now(); // M14：发送内容也算活动（claude TUI 持续输出会刷新）
        try {
          ws.send(payload);
        } catch {
          // 已断
        }
      }
    }
  }

  /** 记录/回放终端缓冲（只追加到指定 sid 的缓冲，防串会话）。
   *  只要有输出就累积（不要求有人开终端页）——聊天发消息也在累积终端历史，
   *  重开终端页能滚回看之前的完整输出。
   *  ⚠ 完整帧对齐（实测数据）：claude TUI 每次全量重绘以 \x1b[2J（清屏）开始。
   *  若 termBuf 超上限被 slice 截断，回放会从「重绘中间」开始 → 手机远程屏幕乱
   *  （消息多显示/移位/插入错位）。所以保留「最后一次清屏之后」的内容，之前的作废
   *  → 回放始终从完整帧起点开始，不会从中间截断。 */
  function setTermBuffer(sid, d) {
    const prev = termBufs.get(sid) || '';
    const combined = prev + d;
    const lastClear = combined.lastIndexOf('\x1b[2J');
    const from = Math.max(lastClear, combined.length - TERM_BUF_MAX); // 无清屏退化到长度上限
    termBufs.set(sid, combined.slice(from));
  }

  /** M12：清理某会话的终端缓冲（会话删除/pty 回收时） */
  function clearTermBuffer(sid) {
    termBufs.delete(sid);
  }

  function getTermBuffer(sid) {
    return termBufs.get(sid) || '';
  }

  /** 登记死锁自愈检测（8-29）：attach/新 pty 时调用。更新 lastClear 给 claude 重绘宽限期（防误杀）。 */
  function trackHeal(sid) {
    const st = healState.get(sid) || { retries: 0 };
    st.lastClear = Date.now(); // attach/清缓冲后宽限，等 claude 重绘完
    healState.set(sid, st);
  }

  /** attach 后快速唤醒检查（8-29 单色+c 根治）：手机 attach 窄列会触发 claude Ink 渲染崩（termBuf 只有"C"）。
   *  WAKE_CHECK_MS 后 termBuf 仍 < 阈值 → 宽列 resize 唤醒（claude Ink 宽列重绘正常，实测 attach 80 列秒恢复）。
   *  比周期检测（kill 重启 40s）快得多，且不杀进程、不丢状态。 */
  function scheduleWakeCheck(sid) {
    if (wakeTimers.has(sid)) clearTimeout(wakeTimers.get(sid)); // 防频繁 attach 叠定时器
    const t = setTimeout(() => {
      wakeTimers.delete(sid);
      if (!ptyHost.isRunning(sid)) return; // pty 没了
      const bufLen = getTermBuffer(sid).length;
      if (bufLen >= STARTUP_MIN_TERMBUF) return; // TUI 已正常画出
      logger.warn('terminal', `会话 ${sid} attach 后 termBuf 仅 ${bufLen}B（疑似窄列渲染崩/单色+c），宽列 ${WAKE_COLS} 列 resize 唤醒`);
      ptyHost.resize(sid, WAKE_COLS, 30);
    }, WAKE_CHECK_MS);
    wakeTimers.set(sid, t);
  }

  // 周期死锁检测（8-29）：每 HEAL_INTERVAL_MS 检查活跃会话 termBuf，过小且超宽限 → 判死锁 → 重启。
  // 覆盖「attach 后任意时刻死锁」（单次检测只在 spawn 后查一次，覆盖不了）。
  const healTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, st] of healState) {
      if (!ptyHost.isRunning(sid)) {
        healState.delete(sid); // pty 没了，撤检测
        continue;
      }
      if (now - st.lastClear < HEAL_CLEAR_GRACE_MS) continue; // 清缓冲/attach 宽限期，等重绘
      const bufLen = getTermBuffer(sid).length;
      if (bufLen >= STARTUP_MIN_TERMBUF) {
        healState.delete(sid); // TUI 正常画出了
        continue;
      }
      if (st.retries >= MAX_STARTUP_RETRIES) {
        logger.error('terminal', `会话 ${sid} termBuf 持续仅 ${bufLen}B（疑似 TUI 死锁/单色+c），重试 ${st.retries} 次仍失败，放弃自愈`);
        healState.delete(sid);
        continue;
      }
      const retries = st.retries + 1;
      logger.warn('terminal', `会话 ${sid} termBuf 仅 ${bufLen}B < ${STARTUP_MIN_TERMBUF}B（疑似 TUI 渲染死锁/单色+c），第 ${retries}/${MAX_STARTUP_RETRIES} 次自动重启`);
      void ptyHost.kill(sid).then((stopped) => {
        if (!stopped) {
          logger.error('terminal', `会话 ${sid} 旧终端未在时限内退出，暂不自动重启`);
          return;
        }
        clearTermBuffer(sid);
        ensureRuntime(sid);
        // 记录重试次数 + 重置宽限（给新 pty 启动/重绘时间）
        healState.set(sid, { retries, lastClear: Date.now() });
      });
    }
  }, HEAL_INTERVAL_MS);
  healTimer.unref?.();

  /** WS upgrade 入口：仅 /ws + 有 sid + isLocalRequest 才接管 */
  function upgradeHandler(req, socket, head) {
    let u;
    try {
      u = new URL(req.url, 'http://x');
    } catch {
      socket.destroy();
      return;
    }
    if (u.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const sid = u.searchParams.get('sid');
    if (!sid) {
      socket.destroy();
      return;
    }
    // C2：校验 sid 真实存在，乱填 sid 不建空壳连接（也防 transcript 懒启动探测误绑）
    if (!store.get(sid)) {
      socket.destroy();
      return;
    }
    // 鉴权：本机来源（dev/prod 都匹配；远程经 proxy 伪装成本机）
    if (!isLocalRequest(req)) {
      socket.destroy();
      return;
    }
    const isRemote = req.headers['x-claudeneko-remote'] === '1';
    wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, sid, isRemote));
  }

  /** 连接建立：懒起 pty/transcript + 绑定消息协议 */
  function onConnect(ws, sid, isRemote = false) {
    ws.sid = sid;
    ws.wantTerm = false;
    ws.lastActivity = Date.now(); // M14 心跳（流量检测）：收发消息刷新，5min 无流量才 close
    clients.add(ws);
    if (isRemote) remoteClients.track(ws);
    logger.info('terminal', `连接建立 sid=${sid} cwd=${store.get(sid)?.cwd || config.defaultCwd}`);

    // 懒启动该会话的 pty + transcript（若 store 有该会话则带上下文）
    const ptyRes = ensureRuntime(sid);
    logger.info('terminal', `pty ensure sid=${sid}: ${JSON.stringify(ptyRes)}`);
    // 死锁自愈：新 pty（冷启动）登记周期检测（30s 查一次 termBuf，TUI 未画出自动重启）
    if (ptyRes.isNew) trackHeal(sid);

    // 回放对话历史：客户端按 claudeMessageId 去重，重连不重复渲染
    // （历史消息由前端 3s 轮询 / listMessages 拉取，这里不重复推全量）

    ws.on('message', (raw) => {
      ws.lastActivity = Date.now(); // M14：收到任何消息都刷新活动
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.t === 'send') {
        ptyHost.submit(sid, m.text);
      } else if (m.t === 'i') {
        ptyHost.write(sid, m.d);
      } else if (m.t === 'r') {
        ptyHost.resize(sid, m.c, m.r);
      } else if (m.t === 'attach') {
        ws.wantTerm = true;
        ptyHost.touch(sid);
        // 死锁自愈：attach 触发 claude 重绘可能崩（窄列/单色+c）。登记周期检测 + 3s 快速唤醒
        trackHeal(sid);
        scheduleWakeCheck(sid);
        // 兜底：pty 不在跑（force-stop 杀过 / 空闲回收过）但用户打开了终端页 → 自动重新拉起
        // （resume 原会话，历史还在）。注意：WS 连接可能复用（聊天在用），onConnect 不会重新触发，必须在此 ensure。
        // ⚠ 顺序：ensure 必须在 resize 前（pty 不存在时 resize 无效）。
        if (!ptyHost.isRunning(sid)) {
          ensureRuntime(sid);
          clearTermBuffer(sid); // 新 pty 是全新 claude：旧 termBuf 作废，防新旧画面叠加
        }
        // 客户端列宽同步（借鉴 c2web：resize 触发 Ink 用客户端列宽重绘，拿到权威完整画面）。
        // 窄视口（手机/窄窗，cols<80）清 termBuf——防回放「旧宽列帧」在新窄屏上折行穿插；
        // 宽视口（电脑本地）不清——保留滚动历史（回归防护）。
        if (Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols > 0 && m.rows > 0) {
          if (m.cols < 80) clearTermBuffer(sid);
          ptyHost.resize(sid, m.cols, m.rows);
        }
        // 同步窗（业界 tmux-web sync-window 模式）：attach 后先 drop 实时流 200ms，
        // 等 termBuf 相对稳定（TUI 用客户端列宽重绘完）再发快照，避免「attach 前的实时流 + 快照回放」叠加乱序。
        clearTimeout(ws.syncTimer); // 防重复 attach 双定时器
        ws.syncUntil = Date.now() + SYNC_WINDOW_MS;
        ws.syncTimer = setTimeout(() => {
          if (ws.readyState !== 1 || !ws.wantTerm) return; // 中途 detach/断开就放弃
          ws.syncUntil = 0; // 同步窗结束，恢复实时流
          try {
            ws.send(JSON.stringify({ t: 'term-replay', d: getTermBuffer(sid) }));
          } catch {
            // 已断
          }
        }, SYNC_WINDOW_MS);
      } else if (m.t === 'detach') {
        ws.wantTerm = false;
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      // 空闲回收由 ptyHost 的 lastActive 时间戳决定（submit/write/onData 都会刷新），
      // 无终端订阅时仍可被聊天使用（聊天发消息会 submit 到 pty），此处无需额外处理
    });

    ws.on('error', () => {
      clients.delete(ws);
    });
  }

  return {
    upgradeHandler,
    broadcast,
    setTermBuffer,
    getTermBuffer,
    clearTermBuffer,
    disconnectRemoteClients: () => remoteClients.disconnectAll(),
  };
}
