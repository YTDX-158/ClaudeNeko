// server/lib/remote/tunnel.js — cloudflared quick tunnel（免账号免费）
// 从 @inksnow/c2web (MIT) 的 src/tunnel.mjs 搬入，逻辑原样。
import { spawn } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// cloudflared 查找：绿色包内置 bin/cloudflared.exe 优先（免装可分发），否则用 PATH 里的（用户自装）
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const BIN_CLOUDFLARED = path.join(SERVER_DIR, '..', '..', '..', 'bin', 'cloudflared.exe');

/**
 * 拉起 cloudflared quick tunnel（免账号免费），解析出公网地址。
 * 未安装 / 起不来时优雅降级返回 { url: null, child: null }，仅可局域网访问。
 * @param {number} port 本地端口
 * @returns {Promise<{url:string|null, child:ChildProcess|null}>} 公网地址 + 子进程（供 stop 时杀）
 */
export function startTunnel(port) {
  return new Promise((resolve) => {
    let child;
    const bin = fs.existsSync(BIN_CLOUDFLARED) ? BIN_CLOUDFLARED : 'cloudflared';
    try {
      child = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true, // 不闪控制台窗口
      });
    } catch {
      resolve({ url: null, child: null });
      return;
    }
    child.on('error', () => finish(null)); // 未安装 / spawn 失败（异步错误）

    let done = false;
    const finish = (val) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
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
    // 超时降级：15s 没拿到 URL 就放弃，并杀掉 cloudflared 防孤儿进程残留暴露端口
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已退出
      }
      finish(null);
    }, 15000);
  });
}
