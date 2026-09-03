import { logger } from './logger.js';
// server/lib/busyLock.js — 会话在途锁（busy）唯一写入口（8-27 收敛）
//
// 收敛背景：busy（Set）+ busyTimers（Map·5min 兜底 timer）曾被 5 处直接操作
// （handleMessage / cancel / force-stop / pty 退出 / assistant 事件），改一处容易撞
// 另几处。现在统一走这里，共享状态写入口只有一个模块（见 docs/架构地图.md §3）。
//
// 语义（保持 H3）：acquire 内建 5min 兜底 timer，release 清 timer（幂等）。
// 每次 release 都清对应 timer → 旧 timer 不可能到期误删下一轮新锁。
// 口头契约：assistant 事件 / cancel / force-stop / pty 退出 / 5min 超时，全部走 release。

export function createBusyLock() {
  const busy = new Set(); // sid -> 在途锁
  const busyTimers = new Map(); // sid -> 5min 兜底 timer
  const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

  /** 解锁（幂等）：删锁 + 清兜底 timer。任何释放路径都走这里。 */
  function release(id) {
    busy.delete(id);
    const t = busyTimers.get(id);
    if (t) { clearTimeout(t); busyTimers.delete(id); }
  }

  /** 加锁：成功返回 true；该会话已在生成中返回 false（前端 409「正在生成中」）。 */
  function acquire(id) {
    if (busy.has(id)) return false;
    busy.add(id);
    const timer = setTimeout(() => {
      logger.warn('busyLock', `5min 兜底超时，强制释放 sid=${id}`);
      release(id);
    }, LOCK_TIMEOUT_MS);
    busyTimers.set(id, timer);
    logger.info('busyLock', `acquire sid=${id}`);
    return true;
  }

  /** 查询是否在生成中（session.busy 显示用，不改变状态） */
  function has(id) {
    return busy.has(id);
  }

  return { acquire, release, has };
}
