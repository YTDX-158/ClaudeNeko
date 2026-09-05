// routes/permission.js — 权限体系 P1-2：审批接口（ClaudeNeko server 侧判定中心）
// =============================================================
// 三方交互：
//   hook（permission_hook.cjs）──POST request→ 拿 id ──轮询 GET wait→ 拿 decision
//   web 前端 ──收到广播 {t:'perm',p}─ 用户点卡片 ──POST respond(secret 校验)→ 决定
// server 职责：挂起队列(pending) / 广播卡片 / 组 claude decision / 会话关闭清理 / 重放
//
// decision 三态（对应卡片 3 档）：
//   once   → {behavior:'allow'}                          （只此一次）
//   always → {behavior:'allow', updatedPermissions:[rule]}（以后都行·写规则）
//   deny   → {behavior:'deny', message:'用户拒绝了此操作'} （不行）
// ⚠ 规则粒度防宽(雷③)：always 的 rule 必须精确到这次调用，由前端/server 组装，见 P1-3/P1-5

import { randomUUID } from 'node:crypto';
import { sendJson, readBody } from '../lib/util.js';

/** 「以后都行」生成精确 claude 规则（粒度防宽·雷③）——从 tool_input 抽具体目标，不落整类工具。
 *  Bash → 命令首 token+*（Bash(ipconfig*)）；写类 → 文件路径+*；联网 → 工具级（P1-5 细化域名） */
function buildRule(req) {
  const t = req.tool_name || '';
  const input = req.tool_input || {};
  if (t === 'Bash') {
    const cmd = String(input.command || (Array.isArray(input.args) ? input.args[0] : '') || '').trim().split(/[\s;&|<>]/)[0];
    if (cmd) return `Bash(${cmd}*)`;
  }
  const fp = input.file_path || input.path;
  if ((t === 'Write' || t === 'Edit' || t === 'MultiEdit') && fp) return `${t}(${fp}*)`;
  return t; // 其余兜底工具名级
}

export function permissionHandler({ store, terminal, permissionConfig, isLocalRequest, logger }) {
  const pending = new Map(); // id -> { sid, req:{tool_name,tool_input,session_id,cwd}, decision:null, ts }

  /** N2：会话 pty 关闭/被 kill → 清该会话所有未决请求（防泄漏 + 防 hook 卡到兜底超时） */
  function cancelBySid(sid) {
    for (const [id, p] of pending) {
      if (p.sid === sid && !p.decision) pending.delete(id);
    }
  }
  /** N1：某会话未决请求（前端重连/刷新重放用） */
  function listPendingBySid(sid) {
    return [...pending.entries()]
      .filter(([, p]) => p.sid === sid && !p.decision)
      .map(([id, p]) => ({ id, tool_name: p.req.tool_name, tool_input: p.req.tool_input }));
  }

  /** 把 claude 会话 id 关联到 ClaudeNeko sid（hook 带 session_id = claude 侧） */
  function sidForClaudeSession(sessionId) {
    if (!sessionId || !store) return null;
    const s = store.list().find((x) => x.claudeSessionId === sessionId);
    return s ? s.id : null;
  }

  async function handleRequest(req, res) {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: '空请求体' });
    const sid = sidForClaudeSession(body.session_id);
    if (!sid) return sendJson(res, 404, { error: '找不到对应会话' });
    const id = randomUUID();
    pending.set(id, {
      sid,
      req: {
        tool_name: body.tool_name || '',
        tool_input: body.tool_input || {},
        session_id: body.session_id || '',
        cwd: body.cwd || '',
      },
      decision: null,
      ts: Date.now(),
    });
    // 推卡片给该会话前端（tool_input 可能巨大/含敏感 → 只传摘要长度，前端再截断渲染）
    terminal?.broadcast(sid, { t: 'perm', p: { id, tool_name: body.tool_name || '', hasInput: !!(body.tool_input && Object.keys(body.tool_input).length) } });
    logger?.info('permission', `权限请求 id=${id} sid=${sid} tool=${body.tool_name || ''}`);
    return sendJson(res, 200, { id });
  }

  function handleWait(req, res, url) {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    if (!id) return sendJson(res, 400, { error: '缺 id' });
    const p = pending.get(id);
    if (!p) return sendJson(res, 404, { error: '请求不存在或已关闭' });
    if (p.decision) return sendJson(res, 200, { status: 'decided', decision: p.decision });
    return sendJson(res, 200, { status: 'pending' });
  }

  async function handleRespond(req, res) {
    // 防伪造(雷6)：respond 需带共享密钥（前端从 /api/permission/secret 拿）
    const secret = req.headers['x-neko-secret'];
    if (!secret || secret !== permissionConfig?.getSecret()) {
      return sendJson(res, 403, { error: '校验失败' });
    }
    const body = await readBody(req);
    if (!body || !body.id) return sendJson(res, 400, { error: '缺 id' });
    const p = pending.get(body.id);
    if (!p) return sendJson(res, 404, { error: '请求不存在或已处理' });
    if (p.decision) return sendJson(res, 200, { ok: true }); // 幂等：已处理不再覆盖(N4)

    const action = body.action; // 'once' | 'always' | 'deny'
    let decision;
    if (action === 'always') {
      // 「以后都行」：allow + 写规则。优先前端精确串；否则 server 从 tool_input 生成（粒度防宽·雷③）
      const rule = typeof body.rule === 'string' && body.rule ? body.rule : buildRule(p.req);
      decision = { behavior: 'allow' };
      if (rule) {
        decision.updatedPermissions = [rule];
        try { permissionConfig?.addAllow(rule); } catch {}
      }
    } else if (action === 'deny') {
      decision = { behavior: 'deny', message: body.message || '用户拒绝了此操作' };
    } else {
      decision = { behavior: 'allow' }; // 默认 once（只此一次）
    }
    p.decision = decision;
    terminal?.broadcast(p.sid, { t: 'perm-closed', p: { id: body.id } });
    logger?.info('permission', `权限决定 id=${body.id} action=${action}`);
    return sendJson(res, 200, { ok: true });
  }

  /** 设置页写权限档/规则（P1-4）：body 支持 {mode} 设档 / {removeAllow:rule} / {removeDeny:rule} 移除记住的规则 */
  async function handleSetConfig(req, res) {
    const secret = req.headers['x-neko-secret'];
    if (!secret || secret !== permissionConfig?.getSecret()) return sendJson(res, 403, { error: '校验失败' });
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: '空请求体' });
    try {
      if (body.mode) {
        permissionConfig.setMode(body.mode);
        return sendJson(res, 200, permissionConfig.get());
      }
      if (typeof body.removeAllow === 'string') {
        permissionConfig.removeAllow(body.removeAllow);
        return sendJson(res, 200, permissionConfig.get());
      }
      if (typeof body.removeDeny === 'string') {
        permissionConfig.removeDeny(body.removeDeny);
        return sendJson(res, 200, permissionConfig.get());
      }
      return sendJson(res, 400, { error: '未知操作' });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  async function router(req, res, url) {
    const p = url.pathname;
    if (p === '/api/permission/request' && req.method === 'POST') return handleRequest(req, res);
    if (p === '/api/permission/wait' && req.method === 'GET') return handleWait(req, res, url);
    if (p === '/api/permission/respond' && req.method === 'POST') return handleRespond(req, res);
    if (p === '/api/permission/pending' && req.method === 'GET') {
      // N1：前端重连重放未决卡片（?sid=xx）——仅本机（前端拿 secret 已校验来源）
      const sid = new URL(req.url, 'http://x').searchParams.get('sid');
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      return sendJson(res, 200, { pending: sid ? listPendingBySid(sid) : [] });
    }
    if (p === '/api/permission/secret' && req.method === 'GET') {
      // respond 防伪造成密钥（仅本机可取）
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      return sendJson(res, 200, { secret: permissionConfig?.getSecret() });
    }
    if (p === '/api/permission/config' && req.method === 'GET') {
      // 设置页读权限档+规则（仅本机）
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      return sendJson(res, 200, permissionConfig.get());
    }
    if (p === '/api/permission/config' && req.method === 'PUT') {
      return handleSetConfig(req, res);
    }
    return null; // 不匹配 → 交给下个 router
  }

  return { router, cancelBySid, listPendingBySid };
}
