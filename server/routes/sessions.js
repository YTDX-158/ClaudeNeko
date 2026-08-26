// routes/sessions.js — 会话 + 消息(handleMessage) + 分支 + cancel/force-stop + media-message（架构重构步4）
import fs from 'node:fs';
import { createClaudeRunner } from '../lib/claudeRunner.js';
import { describeImage } from '../lib/vision.js';
import { extractDocumentText } from '../lib/docText.js';
import { describeMedia } from '../lib/mediaUnderstand.js';
import { getMedia, getMediaPath } from '../lib/mediaStore.js';
import { sendJson, readBody } from '../lib/util.js';
import { createZip } from '../lib/zip.js';

/** 分支历史注入阈值：早期压缩成摘要，近期保留全量（防长会话分支后 claude 被全量历史拖慢） */
const BRANCH_RECENT = 15;

/* ---------- v1.6.0 导出/搜索常量 ---------- */
const EXPORT_MAX_SESSIONS = 200; // 备份全部：会话数上限（防全内存打包 OOM/阻塞）
const EXPORT_MAX_BYTES = 500 * 1024 * 1024; // 备份全部：总字节上限（同 media 导出）
const SEARCH_MAX_SESSIONS = 100; // 搜索：最多扫最近 N 个会话
const SEARCH_MAX_RESULTS = 200; // 搜索：结果上限（v2.0 每会话所有命中气泡全列）

/** 清理孤立代理对（标题可能被 slice(0,15) 切断 emoji 而产生孤代理；留着会让 encodeURIComponent 抛 URIError）。合法成对 emoji 保留。 */
function stripLoneSurrogates(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      }
      // 孤高代理：丢弃
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // 孤低代理：丢弃
    } else {
      out += s[i];
    }
  }
  return out;
}

/** 文件名消毒：去路径分隔符/Windows 控制字符(0-31)/保留设备名/孤立代理对，限长；空则用 fallback。 */
function safeFilename(name, fallback) {
  let cleaned = String(name ?? '').replace(/[\\/:*?"<>|]/g, '_').replace(/[\x00-\x1f]/g, '_');
  cleaned = stripLoneSurrogates(cleaned);
  // Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）：加前缀下划线防拒存
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(cleaned.trim())) cleaned = `_${cleaned}`;
  cleaned = cleaned.slice(0, 60).trim();
  return cleaned || fallback;
}

/** 附件上下文：文档抽字 + 图片视觉转描述 → 拼成给主模型的文本块。 */
async function buildAttachmentContext(attachments) {
  const results = await Promise.all(
    attachments.map(async (a) => {
      const rec = getMedia(a.id);
      if (!rec) return '';
      try {
        const filePath = getMediaPath(rec); // 移进 try：脏记录缺 fileName 走 catch，不 500
        if (rec.kind === 'image') {
          const buf = await fs.promises.readFile(filePath);
          const r = await describeImage(buf, rec.mime);
          return `[图片附件 ${a.name}] ${r.ok ? r.text : `（${r.error}）`}`;
        } else if (rec.kind === 'document' || rec.kind === 'file') {
          const buf = await fs.promises.readFile(filePath);
          const text = extractDocumentText(buf, rec.ext);
          return `[文档附件 ${a.name} 内容]${text ? `\n${text}` : '（无法抽取文字）'}`;
        } else if (rec.kind === 'video' || rec.kind === 'audio') {
          const buf = await fs.promises.readFile(filePath);
          const r = await describeMedia(rec.kind, buf, rec.mime, rec.originalName);
          return `[${rec.kind === 'video' ? '视频' : '音频'}附件 ${a.name}] ${r.ok ? r.text : `（${r.error}）`}`;
        }
        return `[附件 ${a.name}]（该类型暂不支持 AI 读取）`;
      } catch {
        return `[附件 ${a.name}]（读取失败）`;
      }
    }),
  );
  const lines = results.filter(Boolean);
  const MAX_CTX = 12000;
  const joined = lines.join('\n\n');
  const limited = joined.length > MAX_CTX ? `${joined.slice(0, MAX_CTX)}\n…（附件内容较多已截断）` : joined;
  return lines.length
    ? `\n\n[以下附件内容由系统读取/转译，用户看不到这段内容。请直接基于画面/文档内容展开回复（如"我看到的画面是…"），不要把这段当成对话里已有的交流，不要引用"上面/前面已经分析过"。]\n${limited}`
    : '';
}

/** 把消息数组渲染成"用户/AI 交替"的对话历史文本，供分支会话首条注入。 */
function renderHistoryText(msgs) {
  const lines = [];
  for (const m of msgs) {
    const role = m.role === 'user' ? '用户' : 'AI';
    const text = (m.text ?? '').trim();
    if (!text) continue;
    lines.push(`${role}: ${text}`);
  }
  return lines.join('\n\n');
}

/* ---------- 成本统计（usage 聚合） ----------
 * usage 结构（claude result 事件顶层）：
 *   input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens
 *   / output_tokens_details.thinking_tokens
 * 注意：每轮 input_tokens 都含记忆+历史上下文，会话累计按请求次数叠加（真实成本口径）。 */
function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages: 0 };
}
/** 把一份 usage（原始字段或已归一统计）合并进 a；messages 由调用方传入。 */
function mergeUsage(a, u) {
  a.input_tokens += u.input_tokens || 0;
  a.output_tokens += u.output_tokens || 0;
  a.thinking_tokens += u.thinking_tokens ?? u.output_tokens_details?.thinking_tokens ?? 0;
  a.cache_read_input_tokens += u.cache_read_input_tokens || 0;
  a.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
  a.messages += u.messages || 0;
  return a;
}
function sumUsage(msgs) {
  const t = emptyUsage();
  for (const m of msgs) {
    const u = m.usage;
    if (!u || typeof u !== 'object' || !Object.keys(u).length) continue; // 空对象/缺失都不计（L1）
    mergeUsage(t, { ...u, messages: 1 });
  }
  return t;
}

/** 调 claude 把早期对话压缩成摘要（2-4 句中文要点），供分支会话引用；失败返回空串（调用方 fallback 全量）。 */
function summarizeHistory(msgs, cwd, config) {
  return new Promise((resolve) => {
    const text = msgs.map((m) => `${m.role === 'user' ? '用户' : 'AI'}: ${(m.text ?? '').trim()}`).join('\n');
    let out = '';
    const runner = createClaudeRunner({
      claudeBin: config.claudeBin,
      prompt: `请用 2-4 句中文总结下面这段用户与 AI 的早期对话要点（主题 / 关键结论 / 用户需求），供后续继续对话参考。不要展开，不要提问。\n\n对话：\n${text}`,
      model: config.defaultModel,
      cwd: cwd || config.defaultCwd,
      onEvent: (evt) => {
        if (evt.type === 'assistant') {
          const t = (evt.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
          if (t) out = t;
        }
      },
      onError: () => resolve(''),
    });
    const timer = setTimeout(() => {
      try {
        runner.cancel?.();
      } catch {
        /* 已结束 */
      }
      resolve(out.trim());
    }, 30000);
    runner.done.then(() => {
      clearTimeout(timer);
      resolve(out.trim());
    }).catch(() => {
      clearTimeout(timer);
      resolve(out.trim());
    });
  });
}

/** 分支会话创建后：后台生成早期历史摘要（fire-and-forget，不阻塞分支创建），完成存 session.earlySummary。 */
function maybeSummarizeEarlyHistory(session, slice, store, config) {
  if (!slice || slice.length <= BRANCH_RECENT) return;
  const early = slice.slice(0, slice.length - BRANCH_RECENT).filter((m) => (m.text ?? '').trim());
  if (!early.length) return;
  summarizeHistory(early, session.cwd || config.defaultCwd, config)
    .then((summary) => {
      if (summary) store.update(session.id, { earlySummary: summary });
    })
    .catch(() => {});
}

/** 发消息：注入常驻 pty（TUI），落盘 user 消息，busy 锁在 assistant 事件/超时释放。 */
async function handleMessage(ctx, req, res, url) {
  const { store, config, busy, busyTimers, ptyHost, transcript, terminal } = ctx;
  const id = url.pathname.split('/')[3];
  const session = store.get(id);
  if (!session) return sendJson(res, 404, { error: '会话不存在' });
  if (busy.has(id)) return sendJson(res, 409, { error: '该会话正在生成中' });
  busy.add(id);
  const unlockBusy = () => busy.delete(id);
  // busy 锁异常兜底：assistant 事件 / 5 分钟超时释放，防会话永久 409。
  // H3：timer 存 busyTimers Map（server.js 的 assistant 事件能清掉），防旧 timer 到期误删下一轮新锁。
  const busyTimer = setTimeout(() => { busy.delete(id); busyTimers.delete(id); }, 5 * 60 * 1000);
  busyTimers.set(id, busyTimer);
  const clearBusyTimer = () => { const t = busyTimers.get(id); if (t) { clearTimeout(t); busyTimers.delete(id); } };

  const body = await readBody(req);
  if (body && body.__tooLarge) { clearBusyTimer(); unlockBusy(); return sendJson(res, 413, { error: '内容超过 1MB 上限，请缩短后重试' }); }
  const prompt = String(body.prompt ?? '').trim();
  const attachments = Array.isArray(body.attachments)
    ? body.attachments.filter((a) => a && typeof a.id === 'string').map((a) => ({ id: a.id, name: a.name || a.id, kind: a.kind || 'file' }))
    : [];
  if (!prompt && attachments.length === 0) {
    clearBusyTimer(); unlockBusy();
    return sendJson(res, 400, { error: '消息内容不能为空（请输入文字或附加文件）' });
  }
  let attachCtx = '';
  try {
    attachCtx = await buildAttachmentContext(attachments);
  } catch {
    clearBusyTimer(); unlockBusy();
    throw new Error('附件处理失败');
  }
  // 分支首条：注入复制历史（早期摘要 + 近期全量，或全量兜底）
  // ⚠ 修正点1：有 claudeSessionId（pty 会 resume）→ 历史天然在，不注入；
  //   无 claudeSessionId（新 pty 无 resume）→ 首条注入 branchHistoryCtx
  const isBranchFirst = session.parentId && !session.claudeSessionId && store.readMessages(id).length > 0;
  let branchHistoryCtx = '';
  if (isBranchFirst) {
    const all = store.readMessages(id).filter((m) => (m.text ?? '').trim());
    let historyText;
    if (session.earlySummary) {
      historyText = `[早期对话摘要]\n${session.earlySummary}\n\n[近期对话]\n${renderHistoryText(all.slice(-BRANCH_RECENT))}`;
    } else {
      historyText = renderHistoryText(all);
    }
    if (historyText) {
      branchHistoryCtx = `[这是你之前与该用户的对话历史，请记住并在此基础上继续（用户看不到这段说明）：\n\n${historyText}\n\n]`;
    }
  }
  const claudePrompt = [branchHistoryCtx, prompt, attachCtx].filter(Boolean).join('\n\n') || '（附件消息，无文字内容）';

  // 落盘用户消息（原始 prompt + pendingJsonl 标记：供 transcript 认领补 claudeMessageId）
  store.appendMessage(id, { role: 'user', text: prompt, ts: Date.now(), pendingJsonl: true, ...(attachments.length ? { attachments } : {}) });
  if (session.title === '新会话') {
    const nameSource = prompt || attachments[0]?.name || '附件';
    store.update(id, { title: nameSource.slice(0, 15) });
  }

  // 注入常驻 pty（若 pty 不可用 → 降级回 -p runner）
  const cwd = session.cwd || config.defaultCwd;
  if (!ptyHost.available) {
    clearBusyTimer(); unlockBusy();
    return sendJson(res, 500, { error: '终端功能不可用（node-pty 未加载）' });
  }
  const ptyRes = ptyHost.ensure(id, { cwd, claudeSessionId: session.claudeSessionId || undefined, model: session.model });
  transcript.ensure(id, { cwd, claudeSessionId: session.claudeSessionId || undefined });
  // M2 修复：submit 内部处理"未就绪"——pty 刚起时消息进队列，claude TUI 就绪后自动补发，
  // 不再固定延迟 12s（慢机/大历史也不会吞消息）。isNew 时也直接 submit（排队等就绪）。
  const ok = ptyHost.submit(id, claudePrompt);
  if (!ok) {
    clearBusyTimer(); unlockBusy();
    return sendJson(res, 500, { error: '注入终端失败（pty 未就绪）' });
  }

  // 快速返回（不再 SSE 流式；assistant 结果由 transcript 轮询 → WS 事件推送）
  // busy 锁不在此释放：交给 server.js handleTranscriptEvent（assistant 事件 → busy.delete）
  // 或本 busyTimer 5 分钟超时兜底（H3：timer 存 busyTimers Map，assistant 事件会 clearBusyTimer，旧 timer 不会删新锁）
  sendJson(res, 200, { ok: true, sessionId: id });
}

export function sessionsHandler(ctx) {
  const { store, config, busy } = ctx;
  return async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;

    if (method === 'GET' && pathname === '/api/sessions') {
      if (!ctx.isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      return sendJson(res, 200, { sessions: store.list() });
    }

    // 分支：从某个会话的指定消息处新建会话，复制其之前的历史作为上下文
    if (method === 'POST' && pathname === '/api/sessions/branch') {
      const body = await readBody(req);
      const parentId = String(body.parentId ?? '');
      const fromMsgId = String(body.fromMsgId ?? '');
      const parent = store.get(parentId);
      if (!parent) return sendJson(res, 404, { error: '源会话不存在' });
      const msgs = store.readMessages(parentId);
      const idx = msgs.findIndex((m) => m.claudeMessageId === fromMsgId || (fromMsgId && m.id === fromMsgId));
      if (idx < 0) return sendJson(res, 400, { error: '分支点消息不存在' });
      const slice = msgs.slice(0, idx + 1);
      const branchPoint = msgs[idx];
      const title = (branchPoint.text ?? '').trim().slice(0, 15) || `从「${(parent.title ?? '源会话').slice(0, 8)}」分支`;
      const session = store.create({
        model: parent.model || undefined,
        cwd: parent.cwd || config.defaultCwd,
        title: title || '新会话',
        parentId,
        branchFromMsg: fromMsgId,
        effort: parent.effort || undefined, // 分支继承父会话思考档位
      });
      // 分支复制消息时剥离 usage：避免同一批 token 在父+分支各计一次（成本统计双重计数）
      for (const m of slice) {
        const { usage, ...rest } = m;
        store.appendMessage(session.id, rest);
      }
      maybeSummarizeEarlyHistory(session, slice, store, config);
      return sendJson(res, 201, { session });
    }

    if (method === 'POST' && pathname === '/api/sessions') {
      const body = await readBody(req);
      const cleanedIds = [];
      for (const s of store.list()) {
        if (store.readMessages(s.id).length === 0) {
          cleanedIds.push(s.id);
          store.remove(s.id);
        }
      }
      const session = store.create({
        model: body.model || undefined,
        cwd: body.cwd || config.defaultCwd,
        // 建会话 effort 只接受 low/max（标准档=不传）
        effort: body.effort === 'low' || body.effort === 'max' ? body.effort : undefined,
      });
      return sendJson(res, 201, { session, cleanedIds });
    }

    // 取消该会话正在进行的生成（停止按钮）：发 Esc 中断 pty 当前生成
    if (method === 'POST' && pathname.endsWith('/cancel')) {
      const id = pathname.split('/').slice(-2)[0];
      if (ctx.ptyHost?.isRunning(id)) {
        ctx.ptyHost.interrupt(id); // Esc 中断当前生成（TUI 内可再继续）
      }
      busy.delete(id);
      // B1：清该会话的 5min 超时器（防旧 timer 到期误删下一轮新锁，与 assistant 事件路径对称）
      const t = ctx.busyTimers?.get(id);
      if (t) { clearTimeout(t); ctx.busyTimers.delete(id); }
      return sendJson(res, 200, { ok: true });
    }

    // 强制结束当前对话任务：杀 pty 进程树 + 释放锁 + 清全部生成任务
    if (method === 'POST' && pathname.endsWith('/force-stop')) {
      const id = pathname.split('/').slice(-2)[0];
      if (ctx.ptyHost?.isRunning(id)) {
        ctx.ptyHost.kill(id); // taskkill 整棵树
      }
      busy.delete(id);
      const t = ctx.busyTimers?.get(id);
      if (t) { clearTimeout(t); ctx.busyTimers.delete(id); }
      ctx.media.cancelAll();
      return sendJson(res, 200, { ok: true });
    }

    // 技能包消息：生成前用户提示词（role=user，触发命名）+ 生成结果 AI 消息（role=assistant 默认）
    const mmsg = pathname.match(/^\/api\/sessions\/([^/]+)\/media-message$/);
    if (mmsg && method === 'POST') {
      const sid = mmsg[1];
      const session = store.get(sid);
      if (!session) return sendJson(res, 404, { error: '会话不存在' });
      const body = await readBody(req);
      const role = body.role === 'user' ? 'user' : 'assistant';
      const text = String(body.text ?? '').trim();
      const attachments = Array.isArray(body.attachments) ? body.attachments.filter((a) => a && a.id) : [];
      if (!text && !attachments.length) return sendJson(res, 400, { error: '内容为空' });
      store.appendMessage(sid, { role, text, attachments, ts: Date.now() });
      if (role === 'user' && session.title === '新会话') {
        const nameSource = text || attachments[0]?.name || '生成';
        store.update(sid, { title: nameSource.slice(0, 15) });
      }
      return sendJson(res, 201, { ok: true });
    }

    // 会话导出：单个 JSON / 全部打包 zip（复用 zip.js，零依赖）
    const exOne = pathname.match(/^\/api\/sessions\/([^/]+)\/export$/);
    if (exOne && method === 'GET') {
      if (!ctx.isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      const id = exOne[1];
      const session = store.get(id);
      if (!session) return sendJson(res, 404, { error: '会话不存在' });
      const data = JSON.stringify({ version: 1, session, messages: store.readMessages(id) }, null, 2);
      const fname = `${safeFilename(session.title, 'session')}.json`;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fname.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
      });
      res.end(data);
      return;
    }

    if (method === 'GET' && pathname === '/api/sessions/export-all') {
      if (!ctx.isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      const sessions = store.list().slice(0, EXPORT_MAX_SESSIONS); // 上限：防会话过多全内存打包
      const files = [];
      const usedNames = new Set(); // 记最终文件名：重名加 (n) 序号，且避开真实标题同名（防 zip 覆盖丢数据）
      let totalSize = 0;
      for (const s of sessions) {
        const data = Buffer.from(JSON.stringify({ version: 1, session: s, messages: store.readMessages(s.id) }), 'utf8'); // 紧凑格式，省内存
        totalSize += data.length;
        if (totalSize > EXPORT_MAX_BYTES) break; // 字节上限
        let name = `${safeFilename(s.title, s.id)}.json`;
        let n = 1;
        while (usedNames.has(name)) {
          name = `${name.slice(0, -5)}(${n}).json`;
          n++;
        }
        usedNames.add(name);
        files.push({ name, data });
      }
      if (!files.length) {
        // 有会话但全超限 → 明确提示，别误导为"没会话"
        return sendJson(res, 404, { error: sessions.length ? '会话数据超过 500MB 导出上限，请减少会话或单条导出' : '没有可导出的会话' });
      }
      const zip = createZip(files);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="claudeneko-sessions-${Date.now()}.zip"`,
      });
      res.end(zip);
      return;
    }

    // 成本统计：全局汇总 / 单会话汇总（usage 仅 v1.6.0 后新消息有；历史/取消消息无）
    if (method === 'GET' && pathname === '/api/stats') {
      if (!ctx.isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      const sessions = store.list();
      const totals = emptyUsage();
      const per = [];
      for (const s of sessions) {
        const st = sumUsage(store.readMessages(s.id));
        if (st.messages) per.push({ id: s.id, title: s.title, ...st });
        mergeUsage(totals, st);
      }
      return sendJson(res, 200, { totals, sessions: per });
    }

    const sts = pathname.match(/^\/api\/sessions\/([^/]+)\/stats$/);
    if (sts && method === 'GET') {
      if (!ctx.isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      const s = store.get(sts[1]);
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      return sendJson(res, 200, { session: { id: s.id, title: s.title }, stats: sumUsage(store.readMessages(s.id)) });
    }

    // 搜索 v2.0：只搜消息内容，返回消息级结果（前端可跳转到具体气泡）。
    // 多关键词：空格/逗号分词 + 去重 + 限词数 → 单遍收集，有全命中则 AND，否则降级 OR（标注命中词）。
    // 每会话所有命中气泡全列；总数上限 SEARCH_MAX_RESULTS。
    if (method === 'GET' && pathname === '/api/search') {
      if (!ctx.isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
      const raw = String(url.searchParams.get('q') ?? '').trim();
      // 分词 + 去重（防"导演 导演"重复计数）+ 限词数（防超长查询拖慢，按完整词截断不再切半词）
      const keywords = [...new Set(raw.toLowerCase().split(/[\s,，]+/).filter(Boolean))].slice(0, 10);
      if (!keywords.length) return sendJson(res, 200, { results: [], degraded: false, truncated: false });
      const sessions = store.list().slice(0, SEARCH_MAX_SESSIONS); // 只搜最近 N 会话，控性能
      // 单遍收集所有命中（任一关键词即入），matchedKeywords 记实际命中词
      const all = [];
      let truncated = false;
      for (const s of sessions) {
        const msgs = store.readMessages(s.id);
        for (let i = 0; i < msgs.length; i++) {
          const text = msgs[i].text ?? '';
          const lower = text.toLowerCase();
          const hits = keywords.filter((k) => lower.includes(k));
          if (!hits.length) continue;
          // snippet：以所有命中词在文本中最早出现的位置为基准（别用输入序第一个词，会切错上下文）
          const first = Math.min(...hits.map((k) => lower.indexOf(k)));
          const snippet = `…${text.slice(Math.max(0, first - 20), first + 60)}…`;
          all.push({
            sessionId: s.id,
            sessionTitle: s.title,
            messageIndex: i, // 消息在会话里的位置（前端跳转锚点）
            role: msgs[i].role,
            snippet,
            matchedKeywords: hits, // AND 时=全部词；OR 时=实际命中的词
          });
          if (all.length >= SEARCH_MAX_RESULTS) { truncated = true; break; }
        }
        if (truncated) break;
      }
      // 全命中（AND）优先；否则降级 OR，命中词多的排前
      const andResults = all.filter((r) => r.matchedKeywords.length === keywords.length);
      if (andResults.length) {
        return sendJson(res, 200, { results: andResults, degraded: false, truncated });
      }
      all.sort((a, b) => b.matchedKeywords.length - a.matchedKeywords.length);
      return sendJson(res, 200, { results: all, degraded: true, truncated });
    }

    const m = pathname.match(/^\/api\/sessions\/([^/]+)(\/messages)?$/);
    if (m) {
      const [, id, suffix] = m;
      if (method === 'POST' && suffix === '/messages') {
        return handleMessage(ctx, req, res, url);
      }
      if (method === 'GET' && suffix === '/messages') {
        if (!ctx.isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
        return sendJson(res, 200, { messages: store.readMessages(id) });
      }
      if (suffix === undefined) {
        if (method === 'GET') {
          if (!ctx.isLocalRequest(req)) return sendJson(res, 403, { error: '来源校验失败' });
          const session = store.get(id);
          return session
            ? sendJson(res, 200, { session: { ...session, busy: busy.has(id) } })
            : sendJson(res, 404, { error: '会话不存在' });
        }
        if (method === 'PATCH') {
          const session = store.get(id);
          if (!session) return sendJson(res, 404, { error: '会话不存在' });
          const body = await readBody(req);
          const patch = {};
          if (body.model) patch.model = body.model;
          if (body.title) patch.title = body.title;
          if (body.pinned !== undefined) {
            // 严格类型校验：防字符串 "false" 被 !! 强转成 true 误置顶（与 effort 校验风格一致）
            if (typeof body.pinned !== 'boolean') return sendJson(res, 400, { error: '置顶参数无效（需布尔值）' });
            patch.pinned = body.pinned;
          }
          // effort 只接受 null/undefined（标准档）或 low/max，非法值直接 400
          if (body.effort !== undefined) {
            if (body.effort === null || body.effort === 'low' || body.effort === 'max') {
              patch.effort = body.effort;
            } else {
              return sendJson(res, 400, { error: '思考档位无效（仅支持 省/标准/强力）' });
            }
          }
          return sendJson(res, 200, { session: store.update(id, patch) });
        }
        if (method === 'DELETE') {
          // H1 修复：删会话同步清理常驻 pty + jsonl 轮询（防定时器/进程泄漏）
          ctx.ptyHost?.kill(id);
          ctx.transcript?.release(id);
          ctx.terminal?.clearTermBuffer(id); // M12：清终端回放缓冲
          store.remove(id);
          return sendJson(res, 200, { ok: true });
        }
      }
    }

    return null; // 未匹配 → 下一路由
  };
}
