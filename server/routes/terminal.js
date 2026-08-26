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

import { WebSocketServer } from 'ws';

const TERM_BUF_MAX = 64 * 1024; // 回放缓冲上限（最近 64KB 原始字节）

/**
 * 创建终端 WS 通道。
 * @param {{ ptyHost: object, transcript: object, store: object, config: object, isLocalRequest: (req)=>boolean }} deps
 */
export function createTerminalChannel({ ptyHost, transcript, store, config, isLocalRequest }) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set(); // 所有 ws 连接（ws.sid, ws.wantTerm）
  const termBufs = new Map(); // sid -> 最近 64KB 原始字节（attach 回放）

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

  /** 给订阅某 sid 的 ws 发 JSON（try/catch 防已断） */
  function broadcast(sid, obj) {
    const payload = JSON.stringify(obj);
    for (const ws of clients) {
      if (ws.sid === sid && ws.readyState === 1) {
        ws.lastActivity = Date.now(); // M14：发送内容也算活动（claude TUI 持续输出会刷新）
        try {
          ws.send(payload);
        } catch {
          // 已断
        }
      }
    }
  }

  /** 记录/回放终端缓冲（只追加到指定 sid 的缓冲，防串会话）。M12：无人看终端（无 wantTerm）时不累积，省内存 */
  function setTermBuffer(sid, d) {
    let watching = false;
    for (const w of clients) {
      if (w.sid === sid && w.wantTerm) { watching = true; break; }
    }
    if (!watching) return;
    const cur = termBufs.get(sid) || '';
    const next = (cur + d).slice(-TERM_BUF_MAX);
    termBufs.set(sid, next);
  }

  /** M12：清理某会话的终端缓冲（会话删除/pty 回收时） */
  function clearTermBuffer(sid) {
    termBufs.delete(sid);
  }

  function getTermBuffer(sid) {
    return termBufs.get(sid) || '';
  }

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
    // 鉴权：本机来源（dev/prod 都匹配；远程经 proxy 伪装成本机）
    if (!isLocalRequest(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, sid));
  }

  /** 连接建立：懒起 pty/transcript + 绑定消息协议 */
  function onConnect(ws, sid) {
    ws.sid = sid;
    ws.wantTerm = false;
    ws.lastActivity = Date.now(); // M14 心跳（流量检测）：收发消息刷新，5min 无流量才 close
    clients.add(ws);
    console.log(`[terminal] 连接建立 sid=${sid} cwd=${store.get(sid)?.cwd || config.defaultCwd}`);

    // 懒启动该会话的 pty + transcript（若 store 有该会话则带上下文）
    const session = store.get(sid);
    const cwd = session?.cwd || config.defaultCwd;
    const ptyRes = ptyHost.ensure(sid, {
      cwd,
      claudeSessionId: session?.claudeSessionId || undefined,
      model: session?.model,
    });
    console.log(`[terminal] pty ensure sid=${sid}: ${JSON.stringify(ptyRes)}`);
    transcript.ensure(sid, { cwd, claudeSessionId: session?.claudeSessionId || undefined });

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
        try {
          ws.send(JSON.stringify({ t: 'term-replay', d: getTermBuffer(sid) }));
        } catch {
          // 已断
        }
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
  };
}
