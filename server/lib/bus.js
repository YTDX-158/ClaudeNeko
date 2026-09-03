import { logger } from './logger.js';
// server/lib/bus.js — 最小事件总线（Phase2：模块解耦）
//
// 目的：模块（transcript/ptyHost）不再直接依赖 server.js 的回调，改为 emit 事件；
// 装配层（server.js）订阅事件做业务。加新功能 = 订阅事件 + 注册路由，不改模块本体。
// 同步 emit（事件处理是轻量内存操作），handler 抛错被捕获打日志，不影响其他订阅者。
//
// 事件字典（新增事件在此登记，并同步 docs/架构地图.md §4）：
//   transcript:user        { sid, ev }  轮询到 user 消息（含 pendingJsonl 认领）
//   transcript:assistant   { sid, ev }  轮询到 assistant 完整回复（落盘 + 释放 busy）
//   transcript:tool        { sid, ev }  轮询到 tool_use（前端徽标）
//   transcript:sessionId   { sid, claudeSessionId }  首次探测到 claudeSessionId
//   pty:exit               { sid, exitCode }         常驻 pty 退出
//
// 高频流不走总线（ptyHost onData 终端字节流仍用直接回调，避免每帧 Map 遍历）。

export function createEventBus() {
  const handlers = new Map(); // event -> Set<fn>

  function on(event, fn) {
    let list = handlers.get(event);
    if (!list) { list = new Set(); handlers.set(event, list); }
    list.add(fn);
    return () => list.delete(fn); // 返回解绑函数
  }

  function off(event, fn) {
    handlers.get(event)?.delete(fn);
  }

  function emit(event, payload) {
    const list = handlers.get(event);
    if (!list) return;
    for (const fn of [...list]) {
      try {
        fn(payload);
      } catch (err) {
        logger.error('bus', `${event} 订阅者出错:`, err.message);
      }
    }
  }

  return { on, off, emit };
}
