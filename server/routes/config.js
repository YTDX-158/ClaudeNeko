// server/routes/config.js — 对话模型配置端点（设置中心「模型配置」）
// ============================================================
// GET    /api/config                 读当前 ~/.claude 配置（脱敏）
// PUT    /api/config                 写 env（全局默认切换：baseUrl/authToken/model）
// POST   /api/config/test            连通测试（轻量 fetch baseUrl/v1/messages）
// GET    /api/config/profiles        列出档案
// PUT    /api/config/profiles        保存档案 { name, provider, baseUrl, model, authToken }
// DELETE /api/config/profiles?name=x 删除档案
// POST   /api/config/profiles/apply  应用档案 { name } → 写 env + 标记 current
// POST   /api/config/profiles/save-current  当前生效配置存为档案（只存档，不应用/不重启）
// POST   /api/config/profiles/save-apply    存档案并应用（原子：存档 + 写 env + 标记 current + 重启）
//
// 安全：写操作（PUT/POST/DELETE）走 routeApi 前的 isLocalRequest 校验（非本地 403）；
//       返回一律脱敏（key 只显示掩码），日志不带 key。

import { sendJson } from '../lib/util.js';
import { detectProvider } from '../lib/envReport.js'; // 纯函数，不 spawnSync

/** key 掩码：sk-1f3b…44（前4后4，中间打码） */
function mask(key) {
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function writeEnvOrRespond(configService, res, home, values) {
  try {
    configService.writeEnv(home, values);
    return true;
  } catch (error) {
    if (error?.code !== 'CONFIG_JSON_INVALID') throw error;
    sendJson(res, 409, { error: error.message });
    return false;
  }
}

/** 连通测试：向 baseUrl/v1/messages 发最小请求，验证 baseUrl+key+model 是否可用 */
async function testConnection({ baseUrl, authToken, model }) {
  const url = baseUrl.replace(/\/+$/, '') + '/v1/messages';
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': authToken, // 兼容 Anthropic 原生
        Authorization: `Bearer ${authToken}`, // 兼容中转 Bearer
      },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000), // 15s 防挂起
    });
    const j = await res.json().catch(() => ({}));
    const latencyMs = Date.now() - t0;
    if (res.ok) return { ok: true, latencyMs };
    return { ok: false, error: j?.error?.message || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? '连接超时' : e.message };
  }
}

export function configHandler(ctx) {
  return async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;
    const { modelConfig, configService, readBody, ptyHost, store, busyLock, media } = ctx;
    const home = ctx.home; // 测试注入：指向临时目录；生产不传 = 真实 ~/.claude

    // ---- 读当前配置（脱敏） ----
    // ⚠ 纯读 settings 推导：不调 detectEnv（那个 spawnSync 同步阻塞 node/npm/claude 各 0.2~1s+，
    //   高频请求会卡 UI「加载中」半天）。detectEnv 留给诊断（--detect-json / /api/env）。
    if (method === 'GET' && pathname === '/api/config') {
      const env = configService.readSettings(home).env || {};
      const baseUrl = env.ANTHROPIC_BASE_URL || null;
      const model = env.ANTHROPIC_MODEL || null;
      const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
      return sendJson(res, 200, {
        provider: detectProvider(baseUrl), // 纯函数，不 spawn
        model,
        baseUrl,
        configured: Boolean(token && baseUrl),
        keyMask: mask(token),
      });
    }

    // ---- 写 env（全局默认切换） ----
    if (method === 'PUT' && pathname === '/api/config') {
      // N-06：先 readBody 再查 busy——原「先查 busy 再 await readBody」留了最长 30s 竞态窗口
      //（等 body 期间新任务可能启动，随后写配置 + killAll 会误杀它）。现在检查与写入之间无 await，窗口归零。
      const body = await ctx.readBody(req);
      // 有任务在跑（会话回复中 / 媒体生成中）→ 拒绝切换，提示先停止（避免 kill 打断正在进行的任务）
      const hasBusyTask = (store && busyLock && store.list().some((s) => busyLock.has(s.id))) || media?.hasActive?.();
      if (hasBusyTask) {
        return sendJson(res, 409, { error: '有任务正在运行，请先「⛔ 结束」停止后再切换模型' });
      }
      const { baseUrl, authToken, model } = body || {};
      if (!baseUrl || !authToken || !model) {
        return sendJson(res, 400, { error: '需要 baseUrl + authToken + model 三个字段' });
      }
      if (!writeEnvOrRespond(configService, res, home, { baseUrl, authToken, model })) return;
      // 配置已变：重启所有活跃 pty，让 claude 进程用新配置（懒启动读 env）——「没接模型→配置→能用」的关键
      if (ptyHost?.killAll) ptyHost.killAll();
      return sendJson(res, 200, { ok: true, keyMask: mask(authToken), note: '已保存，会话将用新配置重启' });
    }

    // ---- 连通测试 ----
    if (method === 'POST' && pathname === '/api/config/test') {
      const body = await ctx.readBody(req);
      const { baseUrl, authToken, model } = body || {};
      if (!baseUrl || !authToken || !model) return sendJson(res, 400, { error: '缺 baseUrl/authToken/model' });
      return sendJson(res, 200, await testConnection({ baseUrl, authToken, model }));
    }

    // ---- 档案 ----
    if (method === 'GET' && pathname === '/api/config/profiles') {
      return sendJson(res, 200, modelConfig.listProfiles());
    }
    if (method === 'PUT' && pathname === '/api/config/profiles') {
      const body = await ctx.readBody(req);
      const { name, provider, baseUrl, model, authToken } = body || {};
      if (!name || !baseUrl || !model || !authToken) {
        return sendJson(res, 400, { error: '需要 name + baseUrl + model + authToken' });
      }
      modelConfig.saveProfile(name, { provider: provider || 'custom', baseUrl, model, authToken });
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && pathname === '/api/config/profiles/apply') {
      // N-06：先 readBody 再查 busy（消除 30s 竞态窗口，见 PUT /api/config 注）
      const body = await ctx.readBody(req);
      // 有任务在跑 → 拒绝应用档案（同样防打断）
      const hasBusyTask = (store && busyLock && store.list().some((s) => busyLock.has(s.id))) || media?.hasActive?.();
      if (hasBusyTask) {
        return sendJson(res, 409, { error: '有任务正在运行，请先「⛔ 结束」停止后再应用档案' });
      }
      const { name } = body || {};
      const p = modelConfig.getProfile(name);
      if (!p) return sendJson(res, 404, { error: '档案不存在' });
      if (!writeEnvOrRespond(configService, res, home, {
        baseUrl: p.baseUrl,
        authToken: p.authToken,
        model: p.model,
      })) return;
      modelConfig.setCurrent(name);
      if (ptyHost?.killAll) ptyHost.killAll(); // 应用档案后同样重启 pty
      return sendJson(res, 200, { ok: true, applied: name });
    }
    // ---- 存档案：把「当前生效配置」（~/.claude env）一键存成档案，不应用（它本来就在生效） ----
    if (method === 'POST' && pathname === '/api/config/profiles/save-current') {
      const env = configService.readSettings(home).env || {};
      const baseUrl = env.ANTHROPIC_BASE_URL || null;
      const authToken = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || null;
      const model = env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_DEFAULT_OPUS_MODEL || null;
      if (!baseUrl || !authToken) {
        return sendJson(res, 400, { error: '当前未配置对话模型，无法存为档案' });
      }
      const body = await ctx.readBody(req);
      const name = (body?.name || model || 'current').trim();
      if (!name) return sendJson(res, 400, { error: '缺档案名称' });
      modelConfig.saveProfile(name, { provider: detectProvider(baseUrl), baseUrl, model, authToken });
      return sendJson(res, 200, { ok: true, name });
    }
    // ---- 存档案并应用（一个请求原子完成：存档 + 写 env + 标记 current + 重启 pty） ----
    if (method === 'POST' && pathname === '/api/config/profiles/save-apply') {
      // N-06：先 readBody 再查 busy（消除 30s 竞态窗口，见 PUT /api/config 注）
      const body = await ctx.readBody(req);
      const hasBusyTask = (store && busyLock && store.list().some((s) => busyLock.has(s.id))) || media?.hasActive?.();
      if (hasBusyTask) {
        return sendJson(res, 409, { error: '有任务正在运行，请先「⛔ 结束」停止后再保存' });
      }
      const { name, baseUrl, model, authToken } = body || {};
      if (!name || !baseUrl || !authToken || !model) {
        return sendJson(res, 400, { error: '需要 name + baseUrl + authToken + model' });
      }
      if (!writeEnvOrRespond(configService, res, home, { baseUrl, authToken, model })) return;
      modelConfig.saveProfile(name, { provider: body.provider || 'custom', baseUrl, model, authToken });
      modelConfig.setCurrent(name);
      if (ptyHost?.killAll) ptyHost.killAll();
      return sendJson(res, 200, { ok: true, applied: name, keyMask: mask(authToken) });
    }
    if (method === 'DELETE' && pathname === '/api/config/profiles') {
      const name = url.searchParams.get('name');
      if (!name) return sendJson(res, 400, { error: '缺 name 参数' });
      modelConfig.deleteProfile(name);
      return sendJson(res, 200, { ok: true });
    }

    return null; // 未匹配 → 交由下一路由
  };
}
