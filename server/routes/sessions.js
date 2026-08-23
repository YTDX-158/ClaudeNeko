// routes/sessions.js — 会话 + 消息(handleMessage) + 分支 + cancel/force-stop + media-message（架构重构步4）
import fs from 'node:fs';
import { createClaudeRunner } from '../lib/claudeRunner.js';
import { sseHeaders, writeSse } from '../lib/sse.js';
import { describeImage } from '../lib/vision.js';
import { extractDocumentText } from '../lib/docText.js';
import { describeMedia } from '../lib/mediaUnderstand.js';
import { getMedia, getMediaPath } from '../lib/mediaStore.js';
import { sendJson, readBody } from '../lib/util.js';

/** 分支历史注入阈值：早期压缩成摘要，近期保留全量（防长会话分支后 claude 被全量历史拖慢） */
const BRANCH_RECENT = 15;

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

function sendErrorTo(res, message) {
  try {
    writeSse(res, 'error', { message });
    writeSse(res, 'done', {});
  } catch {
    // 客户端已断开
  }
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

/** 发消息：流式调 claude，落盘 user/assistant 消息，处理分支历史注入、busy 锁、取消。 */
async function handleMessage(ctx, req, res, url) {
  const { store, config, busy, activeRunners } = ctx;
  const id = url.pathname.split('/')[3];
  const session = store.get(id);
  if (!session) return sendJson(res, 404, { error: '会话不存在' });
  if (busy.has(id)) return sendJson(res, 409, { error: '该会话正在生成中' });
  busy.add(id);
  const unlockBusy = () => busy.delete(id);

  const body = await readBody(req);
  if (body && body.__tooLarge) { unlockBusy(); return sendJson(res, 413, { error: '内容超过 1MB 上限，请缩短后重试' }); }
  const prompt = String(body.prompt ?? '').trim();
  const attachments = Array.isArray(body.attachments)
    ? body.attachments.filter((a) => a && typeof a.id === 'string').map((a) => ({ id: a.id, name: a.name || a.id, kind: a.kind || 'file' }))
    : [];
  if (!prompt && attachments.length === 0) {
    unlockBusy();
    return sendJson(res, 400, { error: '消息内容不能为空（请输入文字或附加文件）' });
  }
  let attachCtx = '';
  try {
    attachCtx = await buildAttachmentContext(attachments);
  } catch {
    unlockBusy();
    throw new Error('附件处理失败');
  }
  // 分支首条：注入复制历史（早期摘要 + 近期全量，或全量兜底）
  let branchHistoryCtx = '';
  if (session.parentId && !session.claudeSessionId && store.readMessages(id).length > 0) {
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

  sseHeaders(res);
  const send = (event, data) => {
    try {
      writeSse(res, event, data);
    } catch {
      // 客户端已断开
    }
  };

  const knownClaudeIds = new Set(store.readMessages(id).filter((m) => m.claudeMessageId).map((m) => m.claudeMessageId));
  const isNewSession = !session.claudeSessionId;

  store.appendMessage(id, { role: 'user', text: prompt, ts: Date.now(), ...(attachments.length ? { attachments } : {}) });
  if (session.title === '新会话') {
    const nameSource = prompt || attachments[0]?.name || '附件';
    store.update(id, { title: nameSource.slice(0, 15) });
    send('title_update', { sessionId: id, title: nameSource.slice(0, 15) });
  }
  send('start', { sessionId: id });

  let lastAssistantMsgId = null;

  const runner = createClaudeRunner({
    claudeBin: config.claudeBin,
    prompt: claudePrompt,
    model: session.model,
    effort: session.effort || undefined,
    claudeSessionId: session.claudeSessionId || undefined,
    cwd: session.cwd || config.defaultCwd,
    onEvent: (evt) => {
      if (evt.type === 'system' && evt.subtype === 'init') {
        if (isNewSession && evt.session_id) store.update(id, { claudeSessionId: evt.session_id });
        if (evt.model) {
          store.update(id, { model: evt.model });
          send('model_update', { sessionId: id, model: evt.model });
        }
      }
      if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta' && evt.event.delta?.type === 'text_delta') {
        send('text_delta', { text: evt.event.delta.text });
      }
      if (evt.type === 'assistant' && evt.message?.id && !knownClaudeIds.has(evt.message.id)) {
        knownClaudeIds.add(evt.message.id);
        lastAssistantMsgId = evt.message.id;
        const text = (evt.message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (text) send('assistant', { claudeMessageId: evt.message.id, text });
      }
      if (evt.type === 'result') {
        const text = typeof evt.result === 'string' ? evt.result : '';
        if (text) {
          store.appendMessage(id, { role: 'assistant', text, ts: Date.now(), claudeMessageId: lastAssistantMsgId ?? null });
        }
        send('done', { text });
      }
    },
    onError: (err) => {
      const msg = err.code === 'IDLE_TIMEOUT' ? `claude 长时间无响应，已中止本次生成` : `claude 启动失败：${err.message}`;
      sendErrorTo(res, msg);
    },
  });

  activeRunners.set(id, runner);
  let settled = false;
  const release = () => {
    if (settled) return;
    settled = true;
    // 只有当前 runner 仍是 activeRunners 里登记的那个才清锁：
    // 若已被 cancel/force-stop 端点删除，或新请求已占位，这里不动，防旧任务清掉新任务的锁
    if (activeRunners.get(id) === runner) {
      activeRunners.delete(id);
      busy.delete(id);
    }
  };

  try {
    await runner.done;
  } finally {
    release();
    try {
      res.end();
    } catch {
      // 客户端已断开
    }
  }
}

export function sessionsHandler(ctx) {
  const { store, config, busy, activeRunners } = ctx;
  return async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;

    if (method === 'GET' && pathname === '/api/sessions') {
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
      for (const m of slice) store.appendMessage(session.id, { ...m });
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

    // 取消该会话正在进行的生成（停止按钮）
    if (method === 'POST' && pathname.endsWith('/cancel')) {
      const id = pathname.split('/').slice(-2)[0];
      const runner = activeRunners.get(id);
      if (runner) {
        runner.cancel();
        activeRunners.delete(id);
        busy.delete(id);
      }
      return sendJson(res, 200, { ok: true });
    }

    // 强制结束当前对话任务：杀 claude runner + 释放锁 + 清全部生成任务
    if (method === 'POST' && pathname.endsWith('/force-stop')) {
      const id = pathname.split('/').slice(-2)[0];
      const runner = activeRunners.get(id);
      if (runner) {
        runner.cancel();
        activeRunners.delete(id);
      }
      busy.delete(id);
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

    const m = pathname.match(/^\/api\/sessions\/([^/]+)(\/messages)?$/);
    if (m) {
      const [, id, suffix] = m;
      if (method === 'POST' && suffix === '/messages') {
        return handleMessage(ctx, req, res, url);
      }
      if (method === 'GET' && suffix === '/messages') {
        return sendJson(res, 200, { messages: store.readMessages(id) });
      }
      if (suffix === undefined) {
        if (method === 'GET') {
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
          store.remove(id);
          return sendJson(res, 200, { ok: true });
        }
      }
    }

    return null; // 未匹配 → 下一路由
  };
}
