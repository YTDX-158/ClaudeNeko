import { useRef, useState, useEffect, useCallback } from 'react';
import MessageList from './MessageList.jsx';
import Composer from './Composer.jsx';
import CatMascot from './CatMascot.jsx';
import ClaudeNiang from './ClaudeNiang.jsx';
import { downloadText, exportSessionText } from '../utils/export.js';
import ExportDialog from './ExportDialog.jsx';
import { api } from '../api.js';
import { EFFORT_LEVELS } from '../utils/effort.js';

// —— 上下文使用率计算（横幅提示用）：最新 assistant 的 usage.input_tokens ÷ 模型窗口（[1m]→100万）——
function parseContextWindow(model) {
  const m = String(model || '').match(/\[(\d+(?:\.\d+)?)([km])\]/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2].toLowerCase() === 'm' ? n * 1e6 : n * 1e3;
}
function computeContextUsage(messages, model) {
  let inputTokens = 0;
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === 'assistant' && msg.usage?.input_tokens) { inputTokens = msg.usage.input_tokens; break; }
  }
  if (!inputTokens) return null;
  const win = parseContextWindow(model) || 1000000;
  return Math.round((inputTokens / win) * 100);
}

/**
 * 右侧聊天窗口：标题栏 + 消息流 + 输入区。
 * 输入框文本与「引用条」状态都提升到这里：
 * - 引用：点击后输入框上方浮出引用条，输入框保持干净；发送时引用 + 文字拼成 markdown 引用块一起发出
 */
export default function ChatWindow({ session, model, chat, onBranch, onEffortChange, jumpTarget = null, onJumpDone }) {
  const [composerText, setComposerText] = useState('');
  const [quote, setQuote] = useState(null); // { text, role } | null
  const [attachments, setAttachments] = useState([]); // 待发送附件（媒体库快照）
  const [sid, setSid] = useState(null); // 实时 claude 会话 ID（列表快照不含，单独拉）
  const [navOpen, setNavOpen] = useState(false); // 📑 用户消息导航抽屉
  const taRef = useRef(null);
  const composerRef = useRef(null);
  const [dropActive, setDropActive] = useState(false);
  const dropCounter = useRef(0);

  // 上下文使用率横幅（≥80% 提示 + 一键 /compact）：本会话「知道了」后不再弹，compact 后重置
  const ctxDismissKey = (id) => `claudeneko:ctx-dismiss:${id}`;
  const [ctxDismissed, setCtxDismissed] = useState(() => (session?.id ? localStorage.getItem(ctxDismissKey(session.id)) === '1' : false));
  useEffect(() => {
    if (session?.id) setCtxDismissed(localStorage.getItem(ctxDismissKey(session.id)) === '1');
  }, [session?.id]);
  const ctxPct = computeContextUsage(chat.messages, model);
  const ctxShow = ctxPct != null && ctxPct >= 80 && !ctxDismissed;
  const dismissCtx = () => {
    if (session?.id) { try { localStorage.setItem(ctxDismissKey(session.id), '1'); } catch {} }
    setCtxDismissed(true);
  };
  const handleCompact = async () => {
    if (session?.id) {
      try { await api.compactSession(session.id); } catch {}
      try { localStorage.removeItem(ctxDismissKey(session.id)); } catch {}
    }
    setCtxDismissed(false);
  };

  // 聊天区拖放：拖到 .chat 任意位置 → 加附件（转发给输入框 addFiles）
  useEffect(() => {
    const chat = document.querySelector('.chat');
    if (!chat) return;
    const onDragEnter = (e) => { e.preventDefault(); dropCounter.current++; setDropActive(true); };
    const onDragOver = (e) => e.preventDefault();
    const onDragLeave = (e) => {
      e.preventDefault();
      dropCounter.current--;
      if (dropCounter.current <= 0) { dropCounter.current = 0; setDropActive(false); }
    };
    const onDrop = (e) => {
      e.preventDefault();
      dropCounter.current = 0;
      setDropActive(false);
      composerRef.current?.addFiles(e.dataTransfer?.files);
    };
    chat.addEventListener('dragenter', onDragEnter);
    chat.addEventListener('dragover', onDragOver);
    chat.addEventListener('dragleave', onDragLeave);
    chat.addEventListener('drop', onDrop);
    return () => {
      chat.removeEventListener('dragenter', onDragEnter);
      chat.removeEventListener('dragover', onDragOver);
      chat.removeEventListener('dragleave', onDragLeave);
      chat.removeEventListener('drop', onDrop);
    };
  }, []);

  // 用户消息导航目录：所有 user 消息（第 N 问 · 前 20 字）。
  // 跳转用「消息在完整数组里的 index」（对应 MessageList 的 msg-{index} 锚点），
  // 不依赖消息 id/ts——老消息缺 id 或缺 ts 都能跳（方案①）。
  // ⚠ 在 filter 时直接记录原始 index（不用 indexOf 引用比较——消息可能被合并替换，引用不稳）。
  const allMessages = chat.messages ?? [];
  const userMessages = allMessages
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => m.role === 'user');
  const jumpToUser = (msgIndex) => {
    setNavOpen(false);
    requestAnimationFrame(() => {
      document.getElementById(`msg-${msgIndex}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  // 搜索跳转：Sidebar 点结果后切会话 + 定位目标气泡。
  // 关键守卫：必须确认当前 messages 数组确实属于目标会话（messagesSessionId），
  // 否则切会话过渡期会命中旧会话的 msg-{index} 并提前清掉 jumpTarget（高危跳转 bug）。
  useEffect(() => {
    if (!jumpTarget || !session?.id) return;
    if (jumpTarget.sessionId !== session.id) return; // 会话还没切过来
    if (chat.messagesSessionId !== jumpTarget.sessionId) return; // 消息还没加载到目标会话（过渡期）
    const el = document.getElementById(`msg-${jumpTarget.messageIndex}`);
    if (!el) return; // 目标气泡还没渲染，等下次 messages 变化
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    onJumpDone?.();
  }, [chat.messages, chat.messagesSessionId, jumpTarget, session?.id]);

  // 实时拉当前会话的 claudeSessionId（发消息/生成媒体后会变，消息数变化时重拉）
  useEffect(() => {
    if (!session?.id) return;
    let live = true;
    api
      .getSession(session.id)
      .then((d) => {
        if (live) setSid(d.session?.claudeSessionId || null);
      })
      .catch(() => {
        if (live) setSid(null); // 失败重置，防显示上一会话的旧 id
      });
    return () => {
      live = false;
    };
    // streaming 依赖：聊天发消息完成（true→false）重拉 → 分支/新建会话首次回复后 id 自动显示（不再要刷新）
  }, [session?.id, chat.messages.length, chat.streaming]);

  // 技能包发送：生图/生视频（异步轮询）
  // 生成中 → genCards 临时气泡；完成后 → 落盘 + 转成 AI 消息气泡进消息流
  const handleGenSend = async (req) => {
    // 用户提示词作为用户消息进会话（触发命名 + 对话完整）
    const userText = (req.prompt || '').trim();
    if (userText && session?.id) {
      const umsg = { id: `gen-u-${Date.now()}`, role: 'user', text: userText, ts: Date.now() };
      api.appendMediaMessage(session.id, { text: userText, role: 'user' }).catch(() => {});
      if (chat.addMessage) chat.addMessage(umsg);
    }
    // 生成中占位（消息流内，带用户生成要求 + spinner）
    const pid = `gen-p-${Date.now()}`;
    const label = { image: '[🎨 生图]', video: '[🎬 生视频]' }[req.skill] || '';
    const placeholder = { id: pid, role: 'assistant', text: `正在生成中（${userText}）`, streaming: true, ts: Date.now() };
    if (chat.addMessage) chat.addMessage(placeholder);
    let tick = null; // 生视频计时器（外层持有，所有失败路径都清理，防泄漏）

    // 完成：后端落盘 + 占位升级为结果（提示词保留 + 附件）
    const finish = (extra) => {
      const resultText =
        `${label} ${userText}` +
        (extra.transcript ? `\n\n${extra.transcript}` : '');
      const attachments = extra.mediaId
        ? [{ id: extra.mediaId, name: req.skill === 'image' ? '生成图片' : '生成视频', kind: req.skill === 'image' ? 'image' : 'video' }]
        : [];
      const resultMsg = { id: `gen-${Date.now()}`, role: 'assistant', text: resultText, ts: Date.now(), streaming: false, ...(attachments.length ? { attachments } : {}) };
      if (session?.id && attachments.length) {
        // 落盘返回 id → 用它替换占位：前端占位与后端落盘 key 对齐，轮询合并去重（修"图片显示两次"）
        api.appendMediaMessage(session.id, { text: resultText, attachments })
          .then((r) => { if (chat.replaceMessage && r?.id) chat.replaceMessage(pid, { ...resultMsg, id: r.id }); })
          .catch(() => { if (chat.replaceMessage) chat.replaceMessage(pid, resultMsg); }); // 落盘失败仍显示本地
      } else if (chat.replaceMessage) {
        chat.replaceMessage(pid, resultMsg);
      }
    };
    // 失败：占位替换为错误（streaming:false 必须显式，否则 replaceMessage 合并保留占位的流式态）
    const fail = (error) => {
      const errMsg = { id: `gen-e-${Date.now()}`, role: 'assistant', text: `❌ ${label} 失败：${error}`, ts: Date.now(), streaming: false };
      if (chat.replaceMessage) chat.replaceMessage(pid, errMsg);
    };

    try {
      if (req.skill === 'image') {
        const r = await api.mediaGenerate({ kind: 'image', prompt: req.prompt, model: req.model, ratio: req.ratio, resolution: req.resolution, sessionId: session?.id });
        finish({ mediaId: r.mediaId });
      } else if (req.skill === 'video') {
        // 生视频计时：每秒更新占位"已等 N 秒"
        let sec = 0;
        tick = setInterval(() => {
          sec += 1;
          if (chat.replaceMessage) {
            chat.replaceMessage(pid, { id: pid, role: 'assistant', text: `正在生成中（${userText}）已等 ${sec}s`, streaming: true, ts: Date.now() });
          }
        }, 1000);
        const r = await api.mediaGenerate({
          kind: 'video',
          prompt: req.prompt,
          model: req.model,
          ratio: req.ratio,
          duration: req.duration,
          resolution: req.resolution,
          refMode: req.refMode,
          refImages: req.refImages,
          sessionId: session?.id,
        });
        let polling = false; // 防并发轮询：服务端 succeeded 分支下载 mp4 可能 >4s，两轮询并发会重复 finish
        const poll = setInterval(async () => {
          if (polling) return;
          polling = true;
          try {
            const t = await api.mediaTask(r.taskId);
            if (t.status === 'done') {
              clearInterval(poll);
              clearInterval(tick);
              finish({ mediaId: t.mediaId });
            } else if (t.status === 'error' || t.status === 'not_found') {
              clearInterval(poll);
              clearInterval(tick);
              fail(t.error || '生成失败');
            }
          } catch (e) {
            clearInterval(poll);
            clearInterval(tick);
            fail(e.message);
          } finally {
            polling = false;
          }
        }, 4000);
      }
    } catch (e) {
      if (tick) clearInterval(tick); // 提交失败也清理计时器（原来只清理轮询，漏了 tick）
      fail(e.message);
    }
  };

  // 引用：在输入框上方挂一条引用栏（不污染输入框内容）
  // useCallback（审查⑦）：稳定回调引用，MessageBubble memo 生效
  const handleQuote = useCallback((text, role) => {
    setQuote({ text, role });
    taRef.current?.focus();
  }, []);

  // 发送：有引用则拼成 markdown 引用块 + 用户文字 + 附件
  const handleSend = (userText, msgAttachments = []) => {
    let full = userText;
    if (quote) {
      const quoted = '> ' + quote.text.trim().split('\n').join('\n> ');
      full = `${quoted}\n\n${userText}`;
    }
    setQuote(null);
    chat.send(full, msgAttachments);
  };

  // 强制结束当前对话任务：杀 claude 进程 + 清生成任务（聊天卡住/生视频太久都能打断）
  const handleForceStop = async () => {
    if (!session?.id) return;
    try {
      await api.forceStop(session.id);
    } catch {
      // 后端不可达也继续前端清理
    }
    chat.stop(); // 断开 SSE + 释放前端流式态
  };

  // 导出当前对话：统一面板选 txt/json（含思考勾选）
  const [exportOpen, setExportOpen] = useState(false);
  const handleExportDialog = (format, includeThinking) => {
    if (!chat.messages.length) return;
    const safe = (session?.title ?? '新会话').replace(/[\\/:*?"<>|]/g, '_');
    if (format === 'json') {
      // 数据备份：触发后端单会话 JSON 下载（含 usage/thinking 完整数据）
      const a = document.createElement('a');
      a.href = `/api/sessions/${session.id}/export`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    }
    downloadText(`ClaudeNeko-${safe}.txt`, exportSessionText(session, chat.messages, { includeThinking }));
  };

  // claude娘 心情：生成中显示思考中（c2web 模式 assistant 整段到达，无"开始输出"中间态，
  // 原 responding 恒 false 已删），否则看输入框是否在打字
  const typing = composerText.trim().length > 0;
  const mascotStatus = chat.streaming
    ? 'thinking'
    : typing
      ? 'typing'
      : 'idle';

  return (
    <main className="chat">
      {dropActive && <div className="chat-drop-overlay">松开以添加附件</div>}
      <header className="chat-header">
        <h1 className="chat-title">{session?.title ?? '新会话'}</h1>
        <div className="chat-tools">
          {userMessages.length > 0 && (
            <button className="chat-export" onClick={() => setNavOpen(true)} title="跳转到某条用户提问（对话导航）">📑</button>
          )}
          <button className="chat-export-btn" onClick={() => setExportOpen(true)} title="导出当前对话（文本/数据）">导出</button>
          <button className="chat-export" onClick={handleForceStop} title="强制结束当前对话任务（杀 claude + 取消生成，聊天卡住或生视频太久时用）">⛔<span className="chat-stop-text"> 结束</span></button>
          {model && <span className="chat-model" title={model}>{model}</span>}
          {session?.id && (
            <select
              className="chat-effort"
              // 钳制：未知 effort（历史脏数据等）落回标准档显示，避免"显示标准实际跑别的档"
              value={EFFORT_LEVELS.some((l) => l.id === session.effort) ? session.effort : ''}
              onChange={(e) => onEffortChange?.(e.target.value === '' ? null : e.target.value)}
              title="思考档位（对下一条消息生效）：🪙省=省token · ⭐标准=DeepSeek默认 · 💪强力=深度思考"
            >
              {EFFORT_LEVELS.map((lvl) => (
                <option key={String(lvl.id)} value={lvl.id ?? ''}>
                  {lvl.label}
                </option>
              ))}
            </select>
          )}
          {sid && (
            <button
              className="chat-sid"
              onClick={() => navigator.clipboard.writeText(sid).catch(() => {})}
              title={`Claude 会话 ID：${sid}（点击复制，可在 claude CLI 用 --resume 接续）`}
            >
              🪪 {sid.slice(0, 8)}…
            </button>
          )}
        </div>
      </header>

      {chat.recovering && (
        <div className="recovering-banner">
          ⏳ 上一条回复仍在后台生成中，完成后会自动显示……
        </div>
      )}

      {/* 上下文使用率横幅：≥80% 提示压缩（新消息后刷新） */}
      {ctxShow && (
        <div className="ctx-banner">
          <span>⚠️ 上下文已用 <b>{ctxPct}%</b>，建议压缩后继续，避免影响回复质量。</span>
          <div className="ctx-banner-actions">
            <button className="skin-btn" onClick={handleCompact}>一键 /compact</button>
            <button className="skin-btn" onClick={dismissCtx}>知道了</button>
          </div>
        </div>
      )}

      <MessageList
        messages={chat.messages}
        error={chat.error}
        onQuote={handleQuote}
        onBranch={onBranch}
        sessionId={session?.id}
        thinking={chat.thinking}
      />

      {/* 📑 用户消息导航抽屉：列出所有用户提问，点击跳转 */}
      {navOpen && <div className="msg-nav-scrim" onClick={() => setNavOpen(false)} />}
      <aside className={`msg-nav${navOpen ? ' open' : ''}`}>
        <div className="msg-nav-header">
          <span>📑 用户消息（{userMessages.length}）</span>
          <button className="skin-close" onClick={() => setNavOpen(false)} title="关闭">✕</button>
        </div>
        <div className="msg-nav-list">
          {userMessages.length === 0 && <div className="skin-hint">还没有用户消息</div>}
          {userMessages.map(({ m, idx }, i) => {
            // idx = 完整消息数组里的位置（对应 msg-{idx} 锚点），filter 时已记录，不依赖引用比较
            const preview = (m.text ?? '').replace(/\s+/g, ' ').trim();
            return (
              <button key={`nav-${i}`} className="msg-nav-item" onClick={() => jumpToUser(idx)} title={preview}>
                <span className="msg-nav-num">{i + 1}</span>
                <span className="msg-nav-text">{preview.slice(0, 24) || '（附件消息）'}</span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* 小猫（可拖动）+ claude娘（状态气泡/余额/挂件交互）平级共存 */}
      <CatMascot />
      <ClaudeNiang status={mascotStatus} />

      <Composer
        ref={composerRef}
        value={composerText}
        onChange={setComposerText}
        onSend={handleSend}
        onGenSend={handleGenSend}
        streaming={chat.streaming}
        onStop={chat.stop}
        disabled={!session}
        taRef={taRef}
        quote={quote}
        onCancelQuote={() => setQuote(null)}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
      />
      {exportOpen && session?.id && (
        <ExportDialog
          title="导出当前对话"
          scopeLabel={`「${session.title}」 · ${chat.messages.length} 条消息`}
          formats={[
            { value: 'txt', label: '文本 (.txt)' },
            { value: 'json', label: '数据 (.json)' },
          ]}
          onExport={handleExportDialog}
          onClose={() => setExportOpen(false)}
        />
      )}
    </main>
  );
}
