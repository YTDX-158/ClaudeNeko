// server/lib/remote/tunnel.js — cloudflared quick tunnel（免账号免费）
// 从 @inksnow/c2web (MIT) 的 src/tunnel.mjs 搬入，逻辑原样。
import { spawn } from 'child_process';

/**
 * 拉起 cloudflared quick tunnel（免账号免费），解析出公网地址。
 * 未安装 / 起不来时优雅降级返回 { url: null, child: null }，仅可局域网访问。
 * @param {number} port 本地端口
 * @returns {Promise<{url:string|null, child:ChildProcess|null}>} 公网地址 + 子进程（供 stop 时杀）
 */
export function startTunnel(port) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ url: null, child: null });
      return;
    }

    let done = false;
    const finish = (val) => {
      if (!done) {
        done = true;
        resolve({ url: val, child });
      }
    };

    // cloudflared 通常把公网 URL 打到 stderr
    const onData = (d) => {
      const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) finish(m[0]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => finish(null)); // 未安装会走这里
    setTimeout(() => finish(null), 15000); // 超时降级
  });
}
