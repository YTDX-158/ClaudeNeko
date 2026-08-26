/**
 * ws.js — 终端/聊天单 WS 通道管理
 *
 * 一条 WS（/ws?sid=<会话id>）承载三种消息：
 *   - {t:'ev'}  聊天事件（user/assistant/tool）→ onChatEvent
 *   - {t:'term'} 终端原始字节流（实时）→ onTermData
 *   - {t:'term-replay'} 终端 attach 回放（当前屏）→ onTermReplay
 *   - {t:'model'} 模型回写 → onModel
 * 客户端 → 服务端：{t:'send'} {t:'i'} {t:'r'} {t:'attach'} {t:'detach'}
 *
 * 连接地址：location.protocol https → wss，否则 ws；加 location.host（本机/远程隧道都自动对上）。
 * 断线自动重连（1.5s）；sid 变化 → 关旧开新（避免订阅错会话）。
 * 多订阅者（聊天视图 + 终端视图可能同时开）：subscribe 分发。
 */

let ws = null;
let currentSid = null;
let retryTimer = null;
let shouldConnect = false;
const subscribers = new Set(); // { sid, onChatEvent, onTermData, onTermReplay, onModel }
let wasEverOpen = false; // 是否曾握手成功（区分"凭证失效/拒绝"与"普通掉线"）

const proto = location.protocol === 'https:' ? 'wss' : 'ws';

function wsUrl(sid) {
  return `${proto}://${location.host}/ws?sid=${encodeURIComponent(sid)}`;
}

function handleMessage(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.t === 'ev') {
    for (const s of subscribers) if (s.sid === currentSid) s.onChatEvent?.(m.e);
  } else if (m.t === 'term') {
    for (const s of subscribers) if (s.sid === currentSid) s.onTermData?.(m.d);
  } else if (m.t === 'term-replay') {
    for (const s of subscribers) if (s.sid === currentSid) s.onTermReplay?.(m.d);
  } else if (m.t === 'model') {
    for (const s of subscribers) if (s.sid === currentSid) s.onModel?.(m.model);
  }
}

function open() {
  if (!shouldConnect || !currentSid) return;
  let sock;
  try {
    sock = new WebSocket(wsUrl(currentSid));
  } catch {
    return;
  }
  ws = sock;
  sock.onopen = () => {
    wasEverOpen = true;
    // 重连后若终端正开 → 自动重新 attach 拿当前屏
    const wantTerm = [...subscribers].some((s) => s.sid === currentSid && s.wantTerm);
    if (wantTerm) wsChannel.send({ t: 'attach' });
  };
  sock.onmessage = (e) => handleMessage(e.data);
  sock.onclose = () => {
    // H4 修复：只用局部 sock 判断，若当前模块级 ws 已是新连接（切 sid 后 open 过）则不碰它
    if (ws !== sock) return;
    ws = null;
    if (!shouldConnect) return;
    if (!wasEverOpen) {
      // 从未握手成功 → 后端拒绝（鉴权失败等），停止重连
      shouldConnect = false;
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, 1500); // 普通掉线重连
  };
  sock.onerror = () => {
    try {
      sock.close();
    } catch {
      // 已关
    }
  };
}

export const wsChannel = {
  /** 连接某会话（sid 变化 → 关旧开新） */
  connect(sid) {
    if (!sid) return;
    shouldConnect = true;
    if (currentSid !== sid) {
      currentSid = sid;
      wasEverOpen = false; // M18：切会话复位——新会话从零判断握手是否成功（防旧成功态导致新会话鉴权失败却无限重连）
      if (ws) {
        try {
          ws.close();
        } catch {
          // 已关
        }
        ws = null;
      }
      clearTimeout(retryTimer);
      open();
    }
  },

  disconnect() {
    shouldConnect = false;
    if (ws) {
      try {
        ws.close();
      } catch {
        // 已关
      }
      ws = null;
    }
    currentSid = null;
    clearTimeout(retryTimer);
  },

  send(obj) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        // 已断
      }
    }
  },

  /** 当前 WS 是否已连接（M10：轮询兜底用——WS 断连时放行轮询，防 spinner 永挂） */
  isConnected() {
    return !!(ws && ws.readyState === 1);
  },

  /** 终端 attach：订阅终端流 + 请求回放当前屏 */
  attach() {
    for (const s of subscribers) if (s.sid === currentSid) s.wantTerm = true;
    wsChannel.send({ t: 'attach' });
  },

  /** 终端 detach：退订终端流（省流量） */
  detach() {
    for (const s of subscribers) if (s.sid === currentSid) s.wantTerm = false;
    wsChannel.send({ t: 'detach' });
  },

  /** 订阅事件（聊天/终端共用）；返回取消订阅函数 */
  subscribe(sid, handlers) {
    const rec = { sid, ...handlers, wantTerm: false };
    subscribers.add(rec);
    return () => subscribers.delete(rec);
  },
};
