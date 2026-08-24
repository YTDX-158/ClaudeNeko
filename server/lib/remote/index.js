// server/lib/remote/index.js — 远程访问生命周期管理
// 统一管「代理 + 隧道」的起停，供 /api/remote/* 和 server.js 使用。
import { spawn } from 'node:child_process';
import { startRemoteProxy } from './proxy.js';
import { startTunnel } from './tunnel.js';

/** 远程代理端口（独立于业务 4000；cloudflared 指向这里） */
export const REMOTE_PORT = 4001;

/**
 * 创建远程管理器。
 * @param {{ pairing: object }} deps
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
        // 1) 起远程代理（监听 127.0.0.1:4001）
        // 注意：server.listen 的端口冲突（EADDRINUSE）是异步 'error' 事件，
        // 同步 try/catch 抓不到，所以由 startRemoteProxy 用 Promise 包装：
        // 返回 { server }（成功）或抛错（失败），失败时正确置 proxy=null。
        let server;
        try {
          const r = await startRemoteProxy({ port: REMOTE_PORT, pairing: deps.pairing });
          server = r.server;
        } catch (err) {
          console.error('[remote] 代理启动失败:', err.message);
          proxy = null;
          return { url: null };
        }
        proxy = server;

        // 2) 起 cloudflared 隧道（失败/未安装 → 仅局域网可用）
        const t = await startTunnel(REMOTE_PORT);
        tunnelChild = t.child; // 存子进程，stop 时杀
        publicUrl = t.url;
        console.log(`[remote] 公网地址: ${publicUrl || '(未获取，仅局域网可用)'}`);
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
          spawn('taskkill', ['/pid', String(tunnelChild.pid), '/T', '/F']);
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
      console.log('[remote] 远程访问已关闭');
    },
  };
}
