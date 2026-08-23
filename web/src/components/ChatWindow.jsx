import { useRef, useState, useEffect } from 'react';
import MessageList from './MessageList.jsx';
import Composer from './Composer.jsx';
import CatMascot from './CatMascot.jsx';
import ClaudeNiang from './ClaudeNiang.jsx';
import { downloadText, exportSessionText } from '../utils/export.js';
import { api } from '../api.js';
import { EFFORT_LEVELS } from '../utils/effort.js';

/**
 * 右侧聊天窗口：标题栏 + 消息流 + 输入区。
 * 输入框文本与「引用条」状态都提升到这里：
 * - 引用：点击后输入框上方浮出引用条，输入框保持干净；发送时引用 + 文字拼成 markdown 引用块一起发出
 */
export default function ChatWindow({ session, chat, onBranch, onEffortChange }) {
  const [composerText, setComposerText] = useState('');
  const [quote, setQuote] = useState(null); // { text, role } | null
  const [attachments, setAttachments] = useState([]); // 待发送附件（媒体库快照）
  const [sid, setSid] = useState(null); // 实时 claude 会话 ID（列表快照不含，单独拉）
  const taRef = useRef(null);

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

  // 技能包发送：生图/生视频（异步轮询）/下载视频（可选转录）
  // 生成中 → genCards 临时气泡；完成后 → 落盘 + 转成 AI 消息气泡进消息流
  const handleGenSend = async (req) => {
    // 用户提示词作为用户消息进会话（触发命名 + 对话完整）
    const userText = (req.prompt || req.url || '').trim();
    if (userText && session?.id) {
      const umsg = { id: `gen-u-${Date.now()}`, role: 'user', text: userText, ts: Date.now() };
      api.appendMediaMessage(session.id, { text: userText, role: 'user' }).catch(() => {});
      if (chat.addMessage) chat.addMessage(umsg);
    }
    // 生成中占位（消息流内，带用户生成要求 + spinner）
    const pid = `gen-p-${Date.now()}`;
    const label = { image: '[🎨 生图]', video: '[🎬 生视频]', download: '[⬇️ 下载]' }[req.skill] || '';
    const placeholder = { id: pid, role: 'assistant', text: `正在生成中（${userText}）`, streaming: true, ts: Date.now() };
    if (chat.addMessage) chat.addMessage(placeholder);
    let tick = null; // 生视频计时器（外层持有，所有失败路径都清理，防泄漏）

    // 完成：后端落盘 + 占位升级为结果（提示词保留 + 附件）
    const finish = (extra) => {
      const resultText =
        `${label} ${userText}` +
        (extra.transcript ? `\n\n${extra.transcript}` : '') +
        (extra.transcribeError ? `\n⚠️ 转录失败：${extra.transcribeError}` : '');
      const attachments = extra.mediaId
        ? [{ id: extra.mediaId, name: req.skill === 'image' ? '生成图片' : '生成视频', kind: req.skill === 'image' ? 'image' : 'video' }]
        : [];
      if (session?.id && attachments.length) {
        api.appendMediaMessage(session.id, { text: resultText, attachments }).catch(() => {});
      }
      const resultMsg = { id: `gen-${Date.now()}`, role: 'assistant', text: resultText, ts: Date.now(), streaming: false, ...(attachments.length ? { attachments } : {}) };
      if (chat.replaceMessage) chat.replaceMessage(pid, resultMsg);
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
      } else if (req.skill === 'download') {
        const r = await api.mediaDownload({ url: req.url, transcribe: req.transcribe });
        finish({ mediaId: r.mediaId, transcript: r.transcript, transcribeError: r.transcribeError });
      }
    } catch (e) {
      if (tick) clearInterval(tick); // 提交失败也清理计时器（原来只清理轮询，漏了 tick）
      fail(e.message);
    }
  };

  // 引用：在输入框上方挂一条引用栏（不污染输入框内容）
  const handleQuote = (text, role) => {
    setQuote({ text, role });
    taRef.current?.focus();
  };

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

  // 导出当前对话为 .txt 聊天记录
  const handleExport = () => {
    if (!chat.messages.length) return;
    const safe = (session?.title ?? '新会话').replace(/[\\/:*?"<>|]/g, '_');
    downloadText(`ClaudeNeko-${safe}.txt`, exportSessionText(session, chat.messages));
  };

  // claude娘 心情：生成中按阶段（思考中 → 回答中），否则看输入框是否在打字
  const typing = composerText.trim().length > 0;
  const mascotStatus = chat.streaming
    ? chat.responding
      ? 'responding'
      : 'thinking'
    : typing
      ? 'typing'
      : 'idle';

  return (
    <main className="chat">
      <header className="chat-header">
        <h1 className="chat-title">{session?.title ?? '新会话'}</h1>
        <div className="chat-tools">
          <button className="chat-export" onClick={handleExport} title="导出当前对话为 .txt">导出</button>
          <button className="chat-export" onClick={handleForceStop} title="强制结束当前对话任务（杀 claude + 取消生成，聊天卡住或生视频太久时用）">⛔ 结束</button>
          {session?.model && <span className="chat-model">{session.model}</span>}
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
              className="chat-model"
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

      <MessageList
        messages={chat.messages}
        error={chat.error}
        onQuote={handleQuote}
        onBranch={onBranch}
      />

      {/* 小猫（可拖动）+ claude娘（状态气泡/余额/挂件交互）平级共存 */}
      <CatMascot />
      <ClaudeNiang status={mascotStatus} />

      <Composer
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
    </main>
  );
}
