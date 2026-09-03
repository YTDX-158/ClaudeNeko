// server/lib/remote/index.js — 远程访问生命周期管理
// 统一管「代理 + 隧道」的起停，供 /api/remote/* 和 server.js 使用。
import { spawn } from 'node:child_process';
import { startRemoteProxy } from './proxy.js';
import { startTunnel } from './tunnel.js';
import { logger } from '../logger.js';

/** 远程代理起始端口（独立于业务端口；cloudflared 指向实际用到的那个）。环境变量可覆盖。
 *  ⚠ 不能写死单个端口：QQ（QQNT）固定占用 4001（9-02 实测），写死 4001 → 装 QQ 的机器开远程必失败。
 *  从起始端口起顺延找空闲，见 PORT_TRIES。 */
export const REMOTE_PORT = Number(process.env.NEKO_REMOTE_PORT) || 4001;
/** 端口顺延上限：4001 起最多试 50 个（4001~4050），全被占才报错 */
const PORT_TRIES = 50;

/**
 * 创建远程管理器。
 * @param {{ pairing: object, config: { port: number } }} deps
 */
export function createRemote(deps) {
  let proxy = null;
  let tunnelChild = null;
  let publicUrl = null;
  let _startPromise = null;

  return {
    isEnabled: () => proxy !== null,

    publicUrl: () => publicUrl,

    /** 开启远程：起代理 + 起隧道。幂等（已开直接返回）。 */
    async start() {
      if (proxy) return { url: publicUrl };
      if (_startPromise) return _startPromise;

      _startPromise = (async () => {
        // 1) 起远程代理：从起始端口起顺延找空闲（QQ 固定占 4001，写死单端口必冲突）
        //    端口冲突（EADDRINUSE）是异步 'error' 事件，由 startRemoteProxy 用 Promise 包装：
        //    成功 resolve { server }，失败 reject → 试下一个端口。
        let server = null;
        let usedPort = null;
        let lastErr = null;
        for (let p = REMOTE_PORT; p < REMOTE_PORT + PORT_TRIES; p++) {
          try {
            const r = await startRemoteProxy({
              port: p,
              pairing: deps.pairing,
              targetPort: deps.config?.port ?? 4000, // 业务端口跟随 config，改 PORT 不断链
            });
            server = r.server;
            usedPort = p;
            break;
          } catch (err) {
            lastErr = err;
            logger.warn('remote', `代理端口 ${p} 启动失败（试下一个）: ${err.message}`);
          }
        }
        if (!server) {
          proxy = null;
          const msg = `远程代理端口 ${REMOTE_PORT}~${REMOTE_PORT + PORT_TRIES - 1} 全被占用（常见：QQ 固定占 4001）。请退出占用程序后重试`;
          return { url: null, error: msg, detail: lastErr?.message || '' };
        }
        proxy = server;

        // 2) 起 cloudflared 隧道指向实际用到的端口（失败/被拦/网络不通 → 仅局域网可用）
        const t = await startTunnel(usedPort);
        tunnelChild = t.child; // 存子进程，stop 时杀
        publicUrl = t.url;
        logger.info('remote', `公网地址: ${publicUrl || '(未获取，仅局域网可用)'}（代理端口 ${usedPort}）`);
        return { url: publicUrl };
      })();

      try {
        return await _startPromise;
      } finally {
        _startPromise = null;
      }
    },

    /** 关闭远程：杀隧道 + 关代理 */
    stop() {
      // 杀 cloudflared 进程树（Windows 下用 taskkill 清子进程）
      if (tunnelChild) {
        try {
          const kill = spawn('taskkill', ['/pid', String(tunnelChild.pid), '/T', '/F'], { windowsHide: true });
          kill.on('error', () => { /* taskkill 缺失等，静默 */ });
        } catch {
          // 已退出
        }
        tunnelChild = null;
      }
      if (proxy) {
        try {
          proxy.close();
        } catch {
          // 已关
        }
        proxy = null;
      }
      publicUrl = null;
      logger.info('remote', '远程访问已关闭');
    },
  };
}
