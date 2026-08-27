import { useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble.jsx';

export default function MessageList({ messages, error, onQuote, onBranch, sessionId }) {
  const endRef = useRef(null);
  const listRef = useRef(null);
  // ⚠ 修复（8-27）：
  //   旧代码 prevSessionRef 初始 = sessionId → 首次挂载 isSwitch=false → 打开会话停在顶部，
  //   新消息在顶部上方追加 → 视角永远看不到最新（"每次回复跳顶"根因）。
  //   现改为 sticky scroll：打开/切换会话滚到底；之后只要用户没主动上翻就持续跟随到底
  //   （claude 回复陆续追加也能跟上，不会停在中间）。
  const prevSessionRef = useRef(null);
  const justSwitchedRef = useRef(true);   // 切换后待滚底（等消息加载完）
  const userScrolledRef = useRef(false);  // 用户是否主动上翻（上翻 = 停止跟随）
  const isAutoScrollRef = useRef(false);  // 程序滚动标记（防 onScroll 误判用户上翻）

  // 滚到底：等两帧布局完成（图片/长文本高度定稿后再滚，防落空）
  const scrollToBottom = () => {
    isAutoScrollRef.current = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      setTimeout(() => { isAutoScrollRef.current = false; }, 120);
    }));
  };

  // 监听用户滚动：滚到底 = 恢复跟随；离开底部 = 用户主动浏览，停止跟随
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      if (isAutoScrollRef.current) return; // 程序滚动，忽略
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      userScrolledRef.current = !atBottom;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // 自动滚动：
  //  - 切换/首次挂载：等该会话消息加载完滚到底（见最近消息），并重置为自动跟随
  //  - 之后消息追加：用户没主动上翻就持续跟随到底（AI 回复也能跟上）
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const isSwitch = prevSessionRef.current !== sessionId;
    prevSessionRef.current = sessionId;
    if (isSwitch) {
      justSwitchedRef.current = true;
      userScrolledRef.current = false; // 切会话 = 回到自动跟随状态
    }
    if (justSwitchedRef.current && messages.length > 0) {
      justSwitchedRef.current = false;
      scrollToBottom();
      return;
    }
    if (!userScrolledRef.current) scrollToBottom();
  }, [messages, sessionId]);

  return (
    <div className="message-list" ref={listRef}>
      {messages.length === 0 && (
        <div className="empty">
          用浏览器驱动本机 Claude Code
          <br />
          支持多会话、流式输出、模型切换
        </div>
      )}

      {messages.map((m, index) => (
        // 所有消息挂 msg-{index} 锚点（搜索跳转/📑 目录定位）
        <div key={m.id ?? m.ts} id={`msg-${index}`}>
          <MessageBubble message={m} onQuote={onQuote} onBranch={onBranch} />
        </div>
      ))}

      {error && <div className="msg-error">{error}</div>}

      <div ref={endRef} />
    </div>
  );
}
