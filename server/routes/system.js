// routes/system.js — 系统端点：health / balance / skills / autostart / models / env / log（架构重构步2）
import fs from 'node:fs';
import { fetchBalance } from '../lib/balance.js';
import { listSkills, sendJson } from '../lib/util.js';
import { detectEnv } from '../lib/envReport.js';
import { logger, tailLog } from '../lib/logger.js';

export function systemHandler(ctx) {
  return async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;
    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, version: ctx.appVersion });
    }
    if (method === 'GET' && pathname === '/api/env') {
      // 环境检测契约（接口 B）：与 ClaudeInstall --detect-json 同结构
      return sendJson(res, 200, detectEnv());
    }
    if (method === 'GET' && pathname === '/api/balance') {
      if (!ctx.isLocalRequest?.(req)) return sendJson(res, 403, { error: '来源校验失败' });
      return sendJson(res, 200, await fetchBalance());
    }
    if (method === 'GET' && pathname === '/api/skills') {
      return sendJson(res, 200, { skills: listSkills() });
    }
    if (method === 'GET' && pathname === '/api/autostart') {
      return sendJson(res, 200, { enabled: await ctx.getAutoStartEnabled() });
    }
    if (method === 'POST' && pathname === '/api/autostart') {
      const body = await ctx.readBody(req);
      await ctx.setAutoStart(Boolean(body.enabled));
      // 验证是否真的生效：任务注册/注销可能静默失败（如权限不足），避免前端显示"开"实际没开
      const actual = await ctx.getAutoStartEnabled();
      if (actual !== Boolean(body.enabled)) {
        return sendJson(res, 500, { error: '开机自启设置失败（可能权限不足），请检查系统后重试' });
      }
      return sendJson(res, 200, { enabled: actual });
    }
    if (method === 'GET' && pathname === '/api/models') {
      return sendJson(res, 200, { models: ctx.config.models, default: ctx.config.defaultModel });
    }
    // 日志面板（9-03）：仅本机可读（日志已脱敏，但仍留给本机排雷；远程不给）
    if (method === 'GET' && pathname === '/api/log') {
      if (!ctx.isLocalRequest?.(req)) return sendJson(res, 403, { error: '来源校验失败' });
      const lines = Math.min(Number(url.searchParams.get('lines')) || 300, 2000);
      return sendJson(res, 200, { lines: tailLog(lines), path: 'server/log.txt' });
    }
    if (method === 'GET' && pathname === '/api/log/download') {
      if (!ctx.isLocalRequest?.(req)) return sendJson(res, 403, { error: '来源校验失败' });
      // 合并 log.old（轮转历史）+ log.txt 供下载回传排雷
      const LOG = logger.LOG_FILE;
      const oldF = (n) => LOG.replace(/\.txt$/, `.old.${n}.txt`);
      const legacy = LOG.replace(/\.txt$/, '.old.txt'); // 旧版单份命名兼容
      const parts = [];
      for (const p of [oldF(3), oldF(2), oldF(1), legacy, LOG]) {
        try { parts.push(fs.readFileSync(p, 'utf8')); } catch { /* 文件不存在跳过 */ }
      }
      const data = parts.join('');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="claudeneko.log"; filename*=UTF-8''ClaudeNeko-%E6%97%A5%E5%BF%97-${Date.now()}.log`,
      });
      res.end(data);
      return;
    }
    return null; // 未匹配 → 交由下一路由
  };
}
