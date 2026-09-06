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

// —— 档②替我审批（P1-5）：内置危险黑名单（命令前缀命中 → 直接拒绝，不打扰用户）——
const DANGEROUS_PREFIXES = [
  'rm -rf', 'rm -r ', 'rm -f /', 'format ', 'diskpart', 'del /s', 'del /f /s', 'rd /s',
  'reg delete', 'cipher /w', 'net user', 'shutdown /s', 'taskkill /f /im', 'del C:\\', 'rd C:\\',
  'powershell -enc', 'powershell -e ', 'format', 'mkfs', ':(){ :|:& };:', 'chmod 777 /',
];

/** 规则串匹配当前请求（规则格式：工具名级 'Bash' / 参数级 'Bash(cmd*)' / 'Write(path*)'） */
function ruleMatches(rule, req) {
  const t = req.tool_name || '';
  const input = req.tool_input || {};
  const m = /^([A-Za-z]+)\((.*)\)$/.exec(rule || '');
  if (!m) return t === rule;
  const [, tool, pat] = m;
  if (t !== tool) return false;
  const target = tool === 'Bash'
    ? String(input.command || (Array.isArray(input.args) ? input.args[0] : '') || '').trim().split(/[\s;&|<>]/)[0]
    : (input.file_path || input.path || '');
  const star = pat.endsWith('*');
  const core = star ? pat.slice(0, -1) : pat;
  return star ? target.startsWith(core) : target === core;
}

/** smartDecide：档②替我审批的自动判定。命中黑名单/黑白名单规则 → 返回 decision；否则返回 null（上浮弹卡） */
function smartDecide(req, permissionConfig) {
  const cfg = permissionConfig?.getRules ? permissionConfig.getRules() : null;
  const allow = cfg?.allow || [];
  const deny = cfg?.deny || [];
  const input = req.tool_input || {};
  // ① 内置危险黑名单（Bash 命令前缀）
  if (req.tool_name === 'Bash') {
    const cmd = String(input.command || (Array.isArray(input.args) ? input.args[0] : '') || '').trim().toLowerCase();
    if (DANGEROUS_PREFIXES.some((d) => cmd.startsWith(d.toLowerCase()))) {
      return { behavior: 'deny', message: '检测到高风险系统操作，已自动拒绝（如需执行请改用「请求批准」模式或临时直接操作）' };
    }
  }
  // ② 用户 deny 规则命中 → 拒
  if (deny.some((r) => ruleMatches(r, req))) return { behavior: 'deny', message: '已按你的规则拒绝此操作' };
  // ③ 用户 allow 规则命中 → 放（已有规则，无需再写）
  if (allow.some((r) => ruleMatches(r, req))) return { behavior: 'allow' };
  return null; // 拿不准 → 上浮弹卡
}

export function permissionHandler({ store, terminal, permissionConfig, isLocalRequest, logger, onPendingChange, onModeChangeStart, onModeChange }) {
  const pending = new Map(); // id -> { sid, req:{tool_name,tool_input,session_id,cwd}, decision:null, ts }
  let modeChangeTail = Promise.resolve(); // 权限切换串行化：避免并发请求交叉停机/覆盖配置

  /** N2：会话 pty 关闭/被 kill → 清该会话所有未决请求（防泄漏 + 防 hook 卡到兜底超时） */
  function cancelBySid(sid) {
    for (const [id, p] of pending) {
      if (p.sid === sid && !p.decision) pending.delete(id);
    }
    notifyPending(sid); // 清空后同步 ptyHost（通常 pty 已死 rec 不存在 → no-op，双保险）
  }
  /** N1：某会话未决请求（前端重连/刷新重放用） */
  function listPendingBySid(sid) {
    return [...pending.entries()]
      .filter(([, p]) => p.sid === sid && !p.decision)
      .map(([id, p]) => ({ id, tool_name: p.req.tool_name, tool_input: p.req.tool_input }));
  }

  /** 通知 ptyHost 该会话权限挂起状态（listPendingBySid 排除已决 → 反映真实未决数；
   *  挂起中暂停 pty 确认重发，防等批权限时误重发同条消息 —— 🔴P1 遗留修复 9-06） */
  function notifyPending(sid) {
    try { onPendingChange?.(sid, listPendingBySid(sid).length > 0); } catch {}
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
    if (!sid) {
      const shortSession = String(body.session_id || '').slice(0, 8) || 'missing';
      // 仅记录短标识用于关联排障；禁止记录工具参数、cwd、提示词、密钥或完整 Claude UUID。
      logger?.warn?.('permission', `权限请求找不到对应会话 claudeSession=${shortSession}`);
      return sendJson(res, 404, { error: '找不到对应会话' });
    }
    const id = randomUUID();
    // 档②替我审批（P1-5）：黑白名单/危险黑名单先判——命中直接给决定（不弹卡），拿不准才上浮弹卡
    const mode = permissionConfig?.getMode?.() || 'smart';
    const autoDecision = mode === 'smart' ? smartDecide(body, permissionConfig) : null;
    pending.set(id, {
      sid,
      req: {
        tool_name: body.tool_name || '',
        tool_input: body.tool_input || {},
        session_id: body.session_id || '',
        cwd: body.cwd || '',
      },
      decision: autoDecision,
      ts: Date.now(),
    });
    if (!autoDecision) {
      // 需人工审批 → 推卡片给该会话前端（tool_input 可能巨大/含敏感 → 只传摘要长度，前端再截断渲染）
      terminal?.broadcast(sid, { t: 'perm', p: { id, tool_name: body.tool_name || '', hasInput: !!(body.tool_input && Object.keys(body.tool_input).length) } });
    }
    logger?.info('permission', `权限请求 id=${id} sid=${sid} tool=${body.tool_name || ''} mode=${mode} ${autoDecision ? '自动:' + autoDecision.behavior : '上浮'}`);
    notifyPending(sid); // 请求入队 → 通知 ptyHost（autoDecision 时无未决 → false，人工上浮 → true）
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
      // 「以后都行」：写规则到 ClaudeNeko permissionConfig（smart 判定读它，下次同类自动放行）；
      // ⚠ decision 只给纯 behavior:'allow'——实测 updatedPermissions 字段会让 claude 解析失败、decision 失效
      const rule = typeof body.rule === 'string' && body.rule ? body.rule : buildRule(p.req);
      decision = { behavior: 'allow' };
      if (rule) {
        try { permissionConfig?.addAllow(rule); } catch {}
      }
    } else if (action === 'deny') {
      decision = { behavior: 'deny', message: body.message || '用户拒绝了此操作' };
    } else {
      decision = { behavior: 'allow' }; // 默认 once（只此一次）
    }
    p.decision = decision;
    terminal?.broadcast(p.sid, { t: 'perm-closed', p: { id: body.id } });
    notifyPending(p.sid); // 决定落地 → 通知 ptyHost 解除挂起（若仍有多余未决 → 保持 true）
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
        if (!['ask', 'smart', 'bypass'].includes(body.mode)) {
          return sendJson(res, 400, { error: `invalid permission mode: ${body.mode}` });
        }
        const change = async () => {
          const previousMode = permissionConfig.getMode();
          if (body.mode === previousMode) return sendJson(res, 200, permissionConfig.get());

          // 先停掉按旧策略运行的 Claude，确认全部退出后才落盘新模式。
          // 若超时，stopping 占位仍保留，且旧配置不变，不能向用户谎报切换成功。
          const releaseLaunches = onModeChangeStart?.({ previousMode, mode: body.mode });
          try {
            const results = await onModeChange?.({ previousMode, mode: body.mode });
            const stopped = results !== false && (!Array.isArray(results) || results.every(Boolean));
            if (!stopped) {
              return sendJson(res, 503, { error: '旧终端未完全退出，权限模式切换失败；请稍后重试' });
            }
            permissionConfig.setMode(body.mode);
            return sendJson(res, 200, permissionConfig.get());
          } catch (e) {
            logger?.error?.('permission', '权限模式切换失败', e);
            return sendJson(res, 503, { error: '权限模式切换失败，请稍后重试' });
          } finally {
            try { releaseLaunches?.(); } catch {}
          }
        };
        const queued = modeChangeTail.then(change, change);
        modeChangeTail = queued.then(() => undefined, () => undefined);
        return queued;
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
