import { useRef, useState, useEffect } from 'react';
import MessageList from './MessageList.jsx';
import Composer from './Composer.jsx';
import CatMascot from './CatMascot.jsx';
import ClaudeNiang from './ClaudeNiang.jsx';
import { downloadText, exportSessionText } from '../utils/export.js';
import { api } from '../api.js';

/** 生成结果卡片：生成中（spinner + 生视频计时）/ 错误（完成后转移成 AI 消息气泡） */
function GenCard({ card }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (card.status !== 'running' || card.skill !== 'video') return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [card.status, card.skill]);

  return (
    <div className={`gen-card gen-${card.status}`}>
      <div className="gen-card-head">
        <span className="gen-card-skill">
          {card.skill === 'image' ? '[🎨 生图]' : card.skill === 'video' ? '[🎬 生视频]' : '[⬇️ 下载]'}
        </span>
        {card.model && <span className="gen-card-model">{card.model}</span>}
        {card.status === 'running' && (
          <span className="gen-card-status">
            <span className="gen-spinner" aria-hidden="true" />
            {card.skill === 'video' ? `正在生成… 已等 ${elapsed}s` : card.skill === 'download' ? '正在下载…' : '正在生成…'}
          </span>
        )}
      </div>
      {card.prompt && <div className="gen-card-prompt">{card.prompt}</div>}
      {card.status === 'error' && <div className="gen-card-error">❌ {card.error}</div>}
    </div>
  );
}

/**
 * 右侧聊天窗口：标题栏 + 消息流 + 输入区。
 * 输入框文本与「引用条」状态都提升到这里：
 * - 引用：点击后输入框上方浮出引用条，输入框保持干净；发送时引用 + 文字拼成 markdown 引用块一起发出
 */
export default function ChatWindow({ session, chat, onBranch }) {
  const [composerText, setComposerText] = useState('');
  const [quote, setQuote] = useState(null); // { text, role } | null
  const [attachments, setAttachments] = useState([]); // 待发送附件（媒体库快照）
  const [genCards, setGenCards] = useState([]); // 技能包生成结果（独立展示，不进会话）
  const taRef = useRef(null);

  // 技能包发送：生图/生视频（异步轮询）/下载视频（可选转录）
  // 生成中 → genCards 临时气泡；完成后 → 落盘 + 转成 AI 消息气泡进消息流
  const handleGenSend = async (req) => {
    const id = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const base = { id, skill: req.skill, prompt: req.prompt || req.url || '', model: req.model, status: 'running' };
    setGenCards((cs) => [base, ...cs]);

    const finish = (extra) => {
      const doneCard = { ...base, status: 'done', ...extra };
      // 转成 AI 消息气泡：构造 text + 附件 → 后端落盘 + 前端追加进消息流
      const labels = { image: '[🎨 生图]', video: '[🎬 生视频]', download: '[⬇️ 下载]' };
      const label = labels[req.skill] || '';
      const text = doneCard.transcript ? `${label} 视频\n\n${doneCard.transcript}` : doneCard.prompt ? `${label} ${doneCard.prompt}` : label;
      const attachments = doneCard.mediaId
        ? [{ id: doneCard.mediaId, name: req.skill === 'image' ? '生成图片' : '生成视频', kind: req.skill === 'image' ? 'image' : 'video' }]
        : [];
      if (session?.id && attachments.length) {
        api.appendMediaMessage(session.id, { text, attachments }).catch(() => {});
      }
      if (chat.addMessage) {
        chat.addMessage({ id: `gen-${Date.now()}`, role: 'assistant', text, ts: Date.now(), ...(attachments.length ? { attachments } : {}) });
      }
      setGenCards((cs) => cs.filter((c) => c.id !== id));
    };
    const fail = (error) => setGenCards((cs) => cs.map((c) => (c.id === id ? { ...c, status: 'error', error } : c)));

    try {
      if (req.skill === 'image') {
        const r = await api.mediaGenerate({ kind: 'image', prompt: req.prompt, model: req.model, ratio: req.ratio, resolution: req.resolution });
        finish({ mediaId: r.mediaId });
      } else if (req.skill === 'video') {
        const r = await api.mediaGenerate({
          kind: 'video',
          prompt: req.prompt,
          model: req.model,
          ratio: req.ratio,
          duration: req.duration,
          resolution: req.resolution,
        });
        const poll = setInterval(async () => {
          try {
            const t = await api.mediaTask(r.taskId);
            if (t.status === 'done') {
              clearInterval(poll);
              finish({ mediaId: t.mediaId });
            } else if (t.status === 'error' || t.status === 'not_found') {
              clearInterval(poll);
              fail(t.error || '生成失败');
            }
          } catch (e) {
            clearInterval(poll);
            fail(e.message);
          }
        }, 4000);
      } else if (req.skill === 'download') {
        const r = await api.mediaDownload({ url: req.url, transcribe: req.transcribe });
        finish({ mediaId: r.mediaId, transcript: r.transcript });
      }
    } catch (e) {
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
          {session?.model && <span className="chat-model">{session.model}</span>}
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

      {/* 技能包生成结果（独立区，不进会话消息流） */}
      {genCards.length > 0 && (
        <div className="gen-results">
          {genCards.map((c) => (
            <GenCard key={c.id} card={c} />
          ))}
        </div>
      )}

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
