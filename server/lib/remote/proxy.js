// server/lib/remote/proxy.js — 远程访问代理（独立端口，默认 4001 起顺延：QQ 固定占 4001，由 index.js 循环选空闲）
//
// 职责：把 cloudflared 进来的公网流量转发到本地业务端口 4000，
// 但只放行「配对凭证通过」的请求。业务 4000 完全不动（桌面本地照常免鉴权）。
//
// 鉴权设计（Cookie 方案，前端零改动）：
//   - 未配对：任何请求 → 返回内置配对页（HTML，输入配对码）
//   - POST /pair：校验配对码 → 通过则签发 HttpOnly Cookie（值=设备凭证，磁盘只存其 SHA256）
//   - 之后前端同源 fetch/EventSource 自动带 Cookie → 代理放行并转发
//
// 安全：
//   - 配对码动态生成（见 pairing.js），不硬编码
//   - 远程模式下禁用高危操作：删数据（DELETE）/ SSRF 下载 / force-stop 杀进程（isBlocked，见下）
//   - 上传图片与生成媒体（生图/生视频）放行——已配对设备 = 有凭证的外部，便利功能保留，只砍不可逆/高危
//   - 转发用 pipe 流式透传（SSE / 大文件媒体都不缓冲，不爆内存）
//   - 仅监听 127.0.0.1（cloudflared 才指向这里，公网不能直连本机 loopback）

import http from 'node:http';
import net from 'node:net'; // P2：原始 TCP 管道转发 WebSocket 升级（远程终端）
import { randomBytes, createHash } from 'node:crypto';
import { readBody } from '../util.js';
import { logger } from '../logger.js';

const AUTH_COOKIE = 'neko_auth';

/** 将请求目标规范成策略层唯一使用的路径；无效 URL 必须失败关闭。 */
export function normalizeProxyPath(rawUrl) {
  try {
    return new URL(String(rawUrl || ''), 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
}

/** 远程禁用判定：删数据（DELETE）/ SSRF 下载 / force-stop 杀进程 → 403。放行其余（含上传/生成媒体）。 */
export function isBlocked(method, pathname) {
  if (method === 'DELETE') return true;                 // 删数据（媒体等）：不可逆
  if (pathname === '/api/balance') return true;         // 余额与供应商凭据：仅本机可用
  if (pathname === '/api/media/download') return true;  // SSRF：任意 URL 抓取
  if (pathname.endsWith('/force-stop')) return true;    // 杀 claude 进程
  return false;
}
/** 配对码暴力破解防护：连续失败 N 次后锁定 M 毫秒 */
const MAX_PAIR_FAILS = 5;
const PAIR_LOCK_MS = 60_000;
let pairFails = 0; // 全局失败计数（单用户本机场景足够；公网攻击面受限）
let pairLockUntil = 0;

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/** 内置配对页：未配对访问时返回，输入码后 POST /pair 换 Cookie */
const PAIR_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClaudeNeko 远程配对</title>
<style>
  body{font-family:system-ui,sans-serif;background:#111827;color:#f3f4f6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#1f2937;border-radius:16px;padding:32px;max-width:340px;width:100%;text-align:center}
  h1{font-size:20px;margin:0 0 8px}
  p{color:#9ca3af;font-size:14px;margin:0 0 20px}
  input{width:100%;padding:12px;font-size:18px;text-align:center;border:1px solid #374151;border-radius:8px;background:#111827;color:#fff;box-sizing:border-box;letter-spacing:4px}
  button{margin-top:16px;width:100%;padding:12px;font-size:16px;border:none;border-radius:8px;background:#3b82f6;color:#fff;cursor:pointer}
  button:disabled{opacity:.5}
  .err{color:#f87171;font-size:13px;margin-top:12px;min-height:18px}
</style>
</head>
<body>
  <div class="card">
    <h1>🔑 ClaudeNeko 远程</h1>
    <p>请输入电脑上显示的配对码</p>
    <input id="code" inputmode="numeric" maxlength="8" autocomplete="off">
    <button id="go" onclick="pair()">配对</button>
    <div class="err" id="err"></div>
  </div>
<script>
async function pair(){
  const code=document.getElementById('code').value.trim();
  const btn=document.getElementById('go'); const err=document.getElementById('err');
  btn.disabled=true; err.textContent='';
  try{
    const r=await fetch('/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
    if(r.ok){ location.reload(); }
    else { err.textContent='配对码不对，请重试'; btn.disabled=false; }
  }catch(e){ err.textContent='网络错误'; btn.disabled=false; }
}
</script>
</body>
</html>`;

/** 从 Cookie 头里取指定 cookie 值 */
function getCookie(header, name) {
  if (!header) return '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

/**
 * 启动远程代理。
 * @param {{port:number, targetPort:number, pairing:{hasSession:(h:string)=>boolean, readPairCode:()=>string|null}}} opts
 * @returns {http.Server}
 */
export function startRemoteProxy({ port, targetPort = 4000, pairing }) {
  const server = http.createServer(async (req, res) => {
    const pathname = normalizeProxyPath(req.url);
    const method = req.method;
    if (!pathname) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '请求路径无效' }));
      return;
    }

    // 1) 配对接口：放行（无需凭证），校验码 → 签发 HttpOnly Cookie
    if (method === 'POST' && pathname === '/pair') {
      const body = await readBody(req); // 复用健壮版：超时/1MB上限/UTF-8归一化
      let code = '';
      try {
        code = String(body.code || '');
      } catch {
        // 坏请求
      }
      // 暴力破解防护：锁定期间直接拒绝（不管码对不对）
      if (Date.now() < pairLockUntil) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, locked: true }));
        return;
      }
      const current = pairing.readPairCode();
      if (current && code === current) {
        pairFails = 0; // 配对成功重置计数
        const session = randomBytes(32).toString('hex');
        pairing.addSession(sha256(session));
        res.writeHead(200, {
          'Content-Type': 'application/json',
          // Secure：隧道全走 https，防 http 入口下明文凭证被窃取
          'Set-Cookie': `${AUTH_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000; Secure`,
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        pairFails += 1;
        if (pairFails >= MAX_PAIR_FAILS) {
          pairLockUntil = Date.now() + PAIR_LOCK_MS;
          pairFails = 0; // 锁定后重置计数，避免锁定解除后立即再次累计
          logger.warn('remote', `配对失败累计 ${MAX_PAIR_FAILS} 次，已锁定 ${PAIR_LOCK_MS / 1000}s 防爆破`);
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
      return;
    }

    // 2) 校验凭证：未配对 → 返回配对页（连页面都不给看）
    const session = getCookie(req.headers.cookie || '', AUTH_COOKIE);
    if (!session || !pairing.hasSession(sha256(session))) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAIR_HTML);
      return;
    }

    // 3) 远程禁用高危操作（删数据 / SSRF 下载 / force-stop）
    if (isBlocked(method, pathname)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '远程模式已禁用该功能（安全保护）' }));
      return;
    }

    // 4) 转发到业务端口（流式透传：SSE / 大媒体不缓冲）
    const headers = { ...req.headers };
    delete headers.host; // 让 Node 重算为目标端口 host
    delete headers.connection;
    // 关键：把 Origin/Referer 重写成 localhost——业务端口有"来源校验"（isLocalRequest），
    // 手机请求带公网 Origin 会被 403。代理已通过配对鉴权，转发时应伪装成本机来源。
    if (headers.origin) headers.origin = `http://127.0.0.1:${targetPort}`;
    if (headers.referer) headers.referer = `http://127.0.0.1:${targetPort}/`;
    const upstream = http.request(
      { host: '127.0.0.1', port: targetPort, path: req.url, method, headers },
      (up) => {
        // 转发上游响应头；若上游是 SSE（text/event-stream）headers 会带好，透传即可
        res.writeHead(up.statusCode, up.headers);
        // 断连防护：客户端/上游任一断开都解除管道 + 带检查销毁，不崩进程（审查②，防重复 close assert）
        const cleanup = () => {
          try { up.unpipe(res); } catch { /* 已结束 */ }
          if (!up.destroyed) { try { up.destroy(); } catch { /* 已关 */ } }
          if (!res.destroyed) { try { res.destroy(); } catch { /* 已关 */ } }
        };
        up.on('error', cleanup);
        res.on('error', cleanup);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('代理连接失败');
      } else {
        // 已开始流式（SSE/大文件）：不能往 text/event-stream 里写裸文本，
        // 直接销毁连接让客户端感知中断
        try {
          res.destroy();
        } catch {
          // 已关
        }
      }
    });
    // 连接清理：任一端断开都销毁另一端的连接，防 SSE 长连接/大文件挂死泄漏
    res.on('close', () => { try { upstream.destroy(); } catch { /* 已关 */ } });
    req.on('aborted', () => { try { upstream.destroy(); } catch { /* 已关 */ } });
    req.pipe(upstream);
  });

  // ---- WebSocket 转发（P2：远程终端页）----
  // 手机前端终端页连 wss://公网/ws?sid=xxx → cloudflared → 4001。
  // Node http server 不挂 upgrade 会把 WS 升级请求当普通 HTTP 处理（404/断连），必须处理。
  // 校验配对（同 HTTP）→ 重写来源头（业务 4000 的 isLocalRequest 放行）→ 原始 TCP 管道到 4000。
  // 用原始管道而非 ws 客户端转发：字节级透传，避开 per-message deflate 等握手协商兼容问题。
  server.on('upgrade', (req, socket, head) => {
    // 1) 配对鉴权：未配对拒绝升级（ws 握手都不给）
    const session = getCookie(req.headers.cookie || '', AUTH_COOKIE);
    const authed = session && pairing.hasSession(sha256(session));
    // 诊断日志（P2 排查用）：WS 升级到没到代理、配对过没过
    logger.info('remote', `WS upgrade ${req.url} cookie=${session ? '有' : '无'} 配对=${authed ? '通过' : '拒绝'}`);
    if (!authed) {
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      } catch {
        // 已断
      }
      socket.destroy();
      return;
    }
    // 2) 重写来源头：手机请求带公网 Origin/Host，业务 4000 的 isLocalRequest 会 403，
    //    代理已通过配对鉴权，转发时应伪装成本机来源（与 HTTP 转发一致）
    req.headers.origin = `http://127.0.0.1:${targetPort}`;
    req.headers.referer = `http://127.0.0.1:${targetPort}/`;
    req.headers.host = `127.0.0.1:${targetPort}`;
    // 3) 原始 TCP 管道：重建升级请求头（保留 WebSocket 握手必需头）→ 双向透传。
    //    head 是握手扩展数据（permessage-deflate 等），必须透传，否则协商失败。
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
      const rawHeaders =
        `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
        Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
        '\r\n\r\n';
      try {
        upstream.write(rawHeaders);
        if (head && head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      } catch {
        // 已断
      }
    });
    // 任一端断/错 → 销毁另一端（防半开连接挂死）
    const closePair = () => {
      try { upstream.destroy(); } catch { /* 已关 */ }
      try { socket.destroy(); } catch { /* 已关 */ }
    };
    upstream.on('error', closePair);
    socket.on('error', closePair);
    socket.on('close', () => { try { upstream.destroy(); } catch { /* 已关 */ } });
  });

  // 返回 Promise：端口冲突（EADDRINUSE）是异步 'error' 事件，同步 try/catch 抓不到，
  // 这里监听 listening/error 包装成成功/失败，让调用方（index.js）能正确判断启动是否成功。
  return new Promise((resolve, reject) => {
    const onErr = (err) => {
      try { server.close(); } catch { /* 已关 */ }
      reject(err);
    };
    server.once('error', onErr);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onErr);
      logger.info('remote', `远程代理已启动: http://127.0.0.1:${port}（仅配对凭证可过）`);
      resolve({ server });
    });
  });
}
