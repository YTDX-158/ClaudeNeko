import { useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble.jsx';

export default function MessageList({ messages, error }) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  return (
    <div className="message-list">
      {messages.length === 0 && (
        <div className="empty">
          用浏览器驱动本机 Claude Code
          <br />
          支持多会话、流式输出、模型切换
        </div>
      )}

      {messages.map((m) => (
        <MessageBubble key={m.id ?? m.ts} message={m} />
      ))}

      {error && <div className="msg-error">{error}</div>}

      <div ref={endRef} />
    </div>
  );
}
