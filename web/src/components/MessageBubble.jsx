/**
 * 单条消息气泡。
 * - user：右对齐，深蓝气泡
 * - assistant：左对齐，面板底，支持 ``` 代码围栏与打字光标
 */

/** 转义 HTML 特殊字符，防止注入。 */
function escapeHtml(text) {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export default function MessageBubble({ message }) {
  const isUser = message.role === 'user';
  const text = message.text ?? '';
  const parts = text.split('```');

  return (
    <div className={`msg ${isUser ? 'msg-user' : 'msg-assistant'}`}>
      <div className="msg-body">
        {parts.map((part, i) => {
          // 偶数索引为普通文本，奇数索引为代码块
          if (i % 2 === 0) {
            if (!part) return null;
            return (
              <p
                key={i}
                className="msg-text"
                // 已通过 escapeHtml 转义，注入安全
                dangerouslySetInnerHTML={{ __html: escapeHtml(part).replace(/\n/g, '<br/>') }}
              />
            );
          }
          const nl = part.indexOf('\n');
          const code = nl > 0 ? part.slice(nl + 1) : part;
          return (
            <pre key={i} className="msg-code">
              <code>{code}</code>
            </pre>
          );
        })}
        {message.streaming && <span className="cursor" aria-hidden="true" />}
      </div>
    </div>
  );
}
