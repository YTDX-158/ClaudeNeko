import { useEffect } from 'react';

/**
 * 输入区：Enter 发送 / Shift+Enter 换行；生成中显示停止按钮。
 * 受控组件：文本状态由父级（ChatWindow）持有，供「引用」从消息气泡回填。
 * 引用：quote 非空时在输入框上方显示一条引用栏（微信/QQ 式），输入框保持独立；
 * 发送后由父级把引用拼成 markdown 引用块一起发出。
 */
export default function Composer({ value, onChange, onSend, streaming, onStop, disabled, taRef, quote, onCancelQuote }) {
  const submit = () => {
    const t = value.trim();
    if (!t || streaming || disabled) return;
    onChange('');
    if (taRef.current) taRef.current.style.height = 'auto';
    onSend(t);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const handleChange = (e) => {
    onChange(e.target.value);
  };

  // 自动增高：内容变化后按 scrollHeight 调整高度
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, [value, taRef]);

  return (
    <div className="composer">
      {quote && (
        <div className="quote-bar">
          <span className="quote-role">{quote.role === 'user' ? '引用你的消息' : '引用 AI 回复'}</span>
          <span className="quote-text">{quote.text}</span>
          <button className="quote-close" onClick={onCancelQuote} title="取消引用" aria-label="取消引用">
            ✕
          </button>
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={taRef}
          className="composer-input"
          placeholder={disabled ? '先新建一个会话' : streaming ? '正在生成…' : '输入消息，Enter 发送，Shift+Enter 换行'}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={disabled || streaming}
        />
        {streaming ? (
          <button className="stop-btn" onClick={onStop}>
            ■ 停止
          </button>
        ) : (
          <button className="send-btn" onClick={submit} disabled={disabled || !value.trim()}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
