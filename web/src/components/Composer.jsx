import { useRef, useState } from 'react';

/**
 * 输入区：Enter 发送 / Shift+Enter 换行；生成中显示停止按钮。
 */
export default function Composer({ onSend, streaming, onStop, disabled }) {
  const [text, setText] = useState('');
  const taRef = useRef(null);

  const submit = () => {
    const t = text.trim();
    if (!t || streaming || disabled) return;
    setText('');
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
    setText(e.target.value);
    // 自动增高
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
  };

  return (
    <div className="composer">
      <textarea
        ref={taRef}
        className="composer-input"
        placeholder={disabled ? '先新建一个会话' : streaming ? '正在生成…' : '输入消息，Enter 发送，Shift+Enter 换行'}
        value={text}
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
        <button className="send-btn" onClick={submit} disabled={disabled || !text.trim()}>
          发送
        </button>
      )}
    </div>
  );
}
