import { useRef, useState } from 'react';
import MessageList from './MessageList.jsx';
import Composer from './Composer.jsx';
import CatMascot from './CatMascot.jsx';

/**
 * 右侧聊天窗口：标题栏 + 消息流 + 输入区。
 * 输入框文本与「引用条」状态都提升到这里：
 * - 重新加载对话：把历史消息放回输入框编辑重发
 * - 引用：点击后输入框上方浮出引用条，输入框保持干净；发送时引用 + 文字拼成 markdown 引用块一起发出
 */
export default function ChatWindow({ session, chat }) {
  const [composerText, setComposerText] = useState('');
  const [quote, setQuote] = useState(null); // { text, role } | null
  const taRef = useRef(null);

  // 把某条 user 消息放回输入框，可编辑后重发
  const handleReload = (text) => {
    setComposerText(text);
    setQuote(null);
    taRef.current?.focus();
  };

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

  return (
    <main className="chat">
      <header className="chat-header">
        <h1 className="chat-title">{session?.title ?? '新会话'}</h1>
        <div className="chat-tools">
          {session?.model && <span className="chat-model">{session.model}</span>}
        </div>
      </header>

      <MessageList
        messages={chat.messages}
        error={chat.error}
        onReload={handleReload}
        onQuote={handleQuote}
      />

      {/* 粒子猫猫（纯视觉点缀，输入框上方） */}
      <CatMascot />

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
