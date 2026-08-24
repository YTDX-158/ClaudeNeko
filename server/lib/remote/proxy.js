// server/lib/remote/proxy.js — 远程访问代理（独立端口 4001）
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
//   - 远程模式下 SSRF 高危接口（/api/media/download 任意 URL 抓取）直接 403 禁用
//   - 转发用 pipe 流式透传（SSE / 大文件媒体都不缓冲，不爆内存）
//   - 仅监听 127.0.0.1（cloudflared 才指向这里，公网不能直连本机 loopback）

import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';

/** 业务端口（本地 ClaudeNeko 主服务） */
const TARGET_PORT = 4000;
const AUTH_COOKIE = 'neko_auth';
/** 远程模式下禁用的路径（SSRF 等高风险接口） */
const BLOCKED_PATHS = new Set(['/api/media/download']);

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
 * @param {{port:number, pairing:{hasSession:(h:string)=>boolean, readPairCode:()=>string|null}}} opts
 * @returns {http.Server}
 */
export function startRemoteProxy({ port, pairing }) {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const method = req.method;

    // 1) 配对接口：放行（无需凭证），校验码 → 签发 HttpOnly Cookie
    if (method === 'POST' && url === '/pair') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let code = '';
        try {
          code = String(JSON.parse(body).code || '');
        } catch {
          // 坏请求
        }
        const current = pairing.readPairCode();
        if (current && code === current) {
          const session = randomBytes(32).toString('hex');
          pairing.addSession(sha256(session));
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `${AUTH_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
        }
      });
      return;
    }

    // 2) 校验凭证：未配对 → 返回配对页（连页面都不给看）
    const session = getCookie(req.headers.cookie || '', AUTH_COOKIE);
    if (!session || !pairing.hasSession(sha256(session))) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAIR_HTML);
      return;
    }

    // 3) 远程禁用 SSRF 高危接口
    if (BLOCKED_PATHS.has(url)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '远程模式已禁用该功能（安全保护）' }));
      return;
    }

    // 4) 转发到业务端口（流式透传：SSE / 大媒体不缓冲）
    const headers = { ...req.headers };
    delete headers.host; // 让 Node 重算为目标端口 host
    delete headers.connection;
    const upstream = http.request(
      { host: '127.0.0.1', port: TARGET_PORT, path: req.url, method, headers },
      (up) => {
        // 转发上游响应头；若上游是 SSE（text/event-stream）headers 会带好，透传即可
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('代理连接失败');
    });
    // 连接清理：任一端断开都销毁另一端的连接，防 SSE 长连接/大文件挂死泄漏
    res.on('close', () => { try { upstream.destroy(); } catch { /* 已关 */ } });
    req.on('aborted', () => { try { upstream.destroy(); } catch { /* 已关 */ } });
    req.pipe(upstream);
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
      console.log(`[remote] 远程代理已启动: http://127.0.0.1:${port}（仅配对凭证可过）`);
      resolve({ server });
    });
  });
}
