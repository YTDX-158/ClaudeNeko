import { useRef, useState } from 'react';
import MessageList from './MessageList.jsx';
import Composer from './Composer.jsx';
import CatMascot from './CatMascot.jsx';
import ClaudeNiang from './ClaudeNiang.jsx';
import { downloadText, exportSessionText } from '../utils/export.js';

/**
 * 右侧聊天窗口：标题栏 + 消息流 + 输入区。
 * 输入框文本与「引用条」状态都提升到这里：
 * - 引用：点击后输入框上方浮出引用条，输入框保持干净；发送时引用 + 文字拼成 markdown 引用块一起发出
 */
export default function ChatWindow({ session, chat }) {
  const [composerText, setComposerText] = useState('');
  const [quote, setQuote] = useState(null); // { text, role } | null
  const taRef = useRef(null);

  // 引用：在输入框上方挂一条引用栏（不污染输入框内容）
  const handleQuote = (text, role) => {
    setQuote({ text, role });
    taRef.current?.focus();
  };

  // 发送：有引用则拼成 markdown 引用块 + 用户文字
  const handleSend = (userText) => {
    let full = userText;
    if (quote) {
      const quoted = '> ' + quote.text.trim().split('\n').join('\n> ');
      full = `${quoted}\n\n${userText}`;
    }
    setQuote(null);
    chat.send(full);
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

      <MessageList
        messages={chat.messages}
        error={chat.error}
        onQuote={handleQuote}
      />

      {/* 小猫（可拖动）+ claude娘（状态气泡/余额/挂件交互）平级共存 */}
      <CatMascot />
      <ClaudeNiang status={mascotStatus} />

      <Composer
        value={composerText}
        onChange={setComposerText}
        onSend={handleSend}
        streaming={chat.streaming}
        onStop={chat.stop}
        disabled={!session}
        taRef={taRef}
        quote={quote}
        onCancelQuote={() => setQuote(null)}
      />
    </main>
  );
}
