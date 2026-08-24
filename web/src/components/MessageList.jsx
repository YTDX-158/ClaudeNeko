import { useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble.jsx';

export default function MessageList({ messages, error, onQuote, onBranch }) {
  const endRef = useRef(null);
  const listRef = useRef(null);

  // 自动滚动到底，但只在接近底部时才滚——用户往上翻（看历史/用目录跳转）时不打断
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  return (
    <div className="message-list" ref={listRef}>
      {messages.length === 0 && (
        <div className="empty">
          用浏览器驱动本机 Claude Code
          <br />
          支持多会话、流式输出、模型切换
        </div>
      )}

      {messages.map((m) => {
        // 用户消息挂 id 供「📑 用户消息导航」目录跳转定位
        const userAnchor = m.role === 'user' ? { id: `mid-${m.id ?? m.ts}` } : {};
        return (
          <div key={m.id ?? m.ts} {...userAnchor}>
            <MessageBubble message={m} onQuote={onQuote} onBranch={onBranch} />
          </div>
        );
      })}

      {error && <div className="msg-error">{error}</div>}

      <div ref={endRef} />
    </div>
  );
}
