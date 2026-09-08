// server/permission_hook.cjs — ClaudeNeko PermissionRequest 转发 hook（权限体系 P1-2）
// =============================================================
// claude 即将弹权限确认时调用本脚本。职责（瘦转发器，判定逻辑在 ClaudeNeko server）：
//   1. 读 stdin 的 PermissionRequest JSON（session_id/tool_name/tool_input/cwd…）
//   2. POST → ClaudeNeko server /api/permission/request → 拿 requestId
//   3. 轮询 GET /api/permission/wait?id=… → 等用户审批决定（A 方案=一直等）
//   4. 拿到 decision → 输出 PermissionRequest 协议 JSON（allow/deny）→ claude 继续
// 兜底（绝不阻塞 claude）：
//   - 连不上 server（ClaudeNeko 没跑）→ 空输出 exit 0 → claude 走原生询问
//   - server 无对应会话 / 协议异常 / 超时 → 同上空输出
// 注意：stdout 只输出协议 JSON，任何多余输出会破坏协议。
'use strict';
const http = require('http');

const HOST = process.env.NEKO_PERMISSION_HOST || '127.0.0.1';
const PORT = Number(process.env.NEKO_PERMISSION_PORT || process.env.PORT || 4000);
// A 方案「没人理一直等」；15min 兜底防僵尸（claude 原生菜单此时早已等很久，用户可在终端处理）
const TOTAL_TIMEOUT_MS = Number(process.env.NEKO_PERMISSION_TIMEOUT || 900000);
const POLL_INTERVAL_MS = Number(process.env.NEKO_PERMISSION_POLL_INTERVAL || 1500);

let pollTimer = null;
let finished = false;

let input = '';
process.stdin.on('data', (d) => (input += d.toString()));
process.stdin.on('end', () => run(input));
const totalTimer = setTimeout(() => exitEmpty(), TOTAL_TIMEOUT_MS);

function run(raw) {
  let req;
  try { req = JSON.parse(raw); } catch { return exitEmpty(); }
  const payload = JSON.stringify({
    tool_name: req.tool_name,
    tool_input: req.tool_input,
    session_id: req.session_id,
    cwd: req.cwd,
  });
  httpRequest('POST', '/api/permission/request', payload, (code, body) => {
    if (code !== 200 || !body) return exitEmpty();
    let id;
    try { id = JSON.parse(body).id; } catch {}
    if (!id) return exitEmpty();
    pollWait(id, (decision) => {
      if (!decision) return exitEmpty();
      const out = {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision,
        },
      };
      finish(JSON.stringify(out));
    });
  });
}

/** 轮询 wait 直到 server 返回 decision 或超时（A 方案=一直等到用户点） */
function pollWait(id, cb) {
  const poll = () => {
    if (finished) return;
    httpRequest('GET', `/api/permission/wait?id=${encodeURIComponent(id)}`, null, (code, body) => {
      if (finished) return;
      if (code === 404) return exitEmpty();
      if (code === 200 && body) {
        let d;
        try { d = JSON.parse(body); } catch {}
        if (d && d.status === 'decided' && d.decision) return cb(d.decision);
      }
      pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    });
  };
  poll();
}

/** 原生 HTTP 请求（GET 无 body；POST 带 JSON body） */
function httpRequest(method, path, body, cb) {
  let settled = false;
  const done = (code, responseBody) => {
    if (settled) return;
    settled = true;
    cb(code, responseBody);
  };
  const req = http.request(
    { host: HOST, port: PORT, path, method, timeout: 10000 },
    (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => done(res.statusCode, data));
    },
  );
  req.on('error', () => done(null, null));
  req.on('timeout', () => { req.destroy(); done(null, null); });
  if (body) {
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('Content-Length', Buffer.byteLength(body));
  }
  req.end(body || undefined);
}

/** 空输出 = claude 走原生权限询问（优雅降级，绝不阻塞） */
function exitEmpty() {
  finish('');
}

function finish(output) {
  if (finished) return;
  finished = true;
  clearTimeout(totalTimer);
  if (pollTimer) clearTimeout(pollTimer);
  process.stdout.write(output);
  process.exit(0);
}
