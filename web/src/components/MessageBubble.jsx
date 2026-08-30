import { useEffect, useRef, useState, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Lightbox from './Lightbox.jsx';

/**
 * 回放打字机：把完整文本按节奏逐块显示（assistant 完整答案到达后模拟打字）。
 * 速度自适应：短文本逐块慢放；长文本自动加速，总时长上限 ~6s。
 * 返回 { displayed, done, skip }：displayed=当前应显示前缀；done=是否播完；skip=一键显示全文。
 */
function useReplay(text, active) {
  const [shown, setShown] = useState(active ? 0 : text.length);
  const done = shown >= text.length;
  // M17：text 或 active 变化时重置播放进度（重放中途消息被替换/续写时从新起点播）
  const prevTextRef = useRef(text);
  const prevActiveRef = useRef(active);
  useEffect(() => {
    const textChanged = prevTextRef.current !== text;
    const activeChanged = prevActiveRef.current !== active;
    prevTextRef.current = text;
    prevActiveRef.current = active;
    if (textChanged || activeChanged) setShown(active ? 0 : text.length);
  }, [text, active]);

  // 回放推进：active 且未播完 → 定时器逐块累加。
  // 8-30 定稿：100字/秒基准（有打字感），>800字加速 300字/秒（长答案不煎熬）；
  // 渲染封顶 MAX_TICKS（step=len/MAX_TICKS）——纯逐字会让长文本重渲染 markdown 卡顿。
  // 已去掉「跳过」功能（用户决定）：速度有界，短答案 1s 内、长答案 3字/10ms 加速播完
  useEffect(() => {
    if (!active || done) return;
    const len = text.length;
    if (!len) return;
    const MAX_TICKS = 200;
    const rate = len > 800 ? 300 : 100; // 字/秒
    const step = Math.max(1, Math.ceil(len / MAX_TICKS));
    const interval = Math.max(4, Math.round((step * 1000) / rate)); // 每 tick 间隔，保持恒定速率
    const t = setTimeout(() => setShown((s) => Math.min(len, s + step)), interval);
    return () => clearTimeout(t);
  }, [active, shown, text]);

  return {
    displayed: text.slice(0, shown),
    done,
  };
}


/**
 * 单条消息气泡。
 * - user：右对齐，深蓝气泡，纯文本（转义防注入）
 * - assistant：左对齐，面板底，完整 Markdown 渲染（GFM：加粗/列表/表格/链接/代码围栏）
 * - 流式时末尾显示打字光标
 * 每条消息下方提供操作按钮：
 *   - 复制：把整条内容复制到剪贴板
 *   - 引用：以 Markdown 引用块形式插入输入框
 */

/** 消息附件卡片（图片/视频/文档/音频）；文件被删除时显示占位。右上角下载按钮直接存本地；点图片/视频开大图。 */
function AttachmentCard({ att }) {
  const [broken, setBroken] = useState(false);
  const [view, setView] = useState(null);
  if (broken) return <span className="msg-attach-broken">📎 {att.name}（文件已删除）</span>;
  const dl = (
    <a
      className="msg-attach-download"
      href={`/api/media/${att.id}/download`}
      title="下载到本地"
      download
      onClick={(e) => e.stopPropagation()}
    >
      ⬇
    </a>
  );
  const openView = (e) => {
    e.stopPropagation();
    setView(att);
  };
  if (att.kind === 'image') {
    return (
      <span className="msg-attach-card">
        <img
          className="thumb"
          src={`/api/media/${att.id}`}
          alt={att.name}
          onError={() => setBroken(true)}
          onClick={openView}
          style={{ cursor: 'zoom-in' }}
        />
        <span className="msg-attach-name">{att.name}</span>
        {dl}
        {view && <Lightbox media={view} onClose={() => setView(null)} />}
      </span>
    );
  }
  if (att.kind === 'video') {
    return (
      <span className="msg-attach-card">
        <video src={`/api/media/${att.id}`} controls preload="metadata" onError={() => setBroken(true)} onClick={openView} style={{ cursor: 'pointer' }} />
        <span className="msg-attach-name">{att.name}</span>
        {dl}
        {view && <Lightbox media={view} onClose={() => setView(null)} />}
      </span>
    );
  }
  return (
    <span className="msg-attach-card">
      <a href={`/api/media/${att.id}`} target="_blank" rel="noopener noreferrer" className="msg-attach-link">
        {att.kind === 'audio' ? '🎵' : '📄'} {att.name}
      </a>
      {dl}
    </span>
  );
}

/** 转义 HTML 特殊字符，防止注入（用户消息用）。 */
function escapeHtml(text) {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/**
 * 渲染用户消息文本：普通行转义成纯文本；以 `> ` 开头的行（引用块）组合成
 * .msg-quote 样式块，让「引用」发出去的引用在用户气泡里有视觉区分，而不是字面显示 `>`。
 */
function renderUserText(text) {
  const lines = text.split('\n');
  let html = '';
  let inQuote = false;
  lines.forEach((line, i) => {
    const isLast = i === lines.length - 1;
    if (line.startsWith('> ')) {
      if (!inQuote) {
        html += '<span class="msg-quote">';
        inQuote = true;
      }
      html += escapeHtml(line.slice(2));
      if (!isLast) html += '<br/>';
    } else {
      if (inQuote) {
        html += '</span>';
        inQuote = false;
      }
      html += escapeHtml(line);
      if (!isLast) html += '<br/>';
    }
  });
  if (inQuote) html += '</span>';
  return html;
}

function MessageBubble({ message, onQuote, onBranch, interim = false, flat = false }) {
  const isUser = message.role === 'user';
  const text = message.text ?? '';
  const [copied, setCopied] = useState(false);
  const [branched, setBranched] = useState(false);
  // 回放打字机：assistant 且带 replay 标记（终端完整答案到达）→ 逐字/逐块显示。
  // interim（回合过程段）不参与回放——直接全文灰字，避免"正播放一半被顶成灰字"的乱象
  const replaying = !isUser && message.replay && !message.streaming && !interim;
  const { displayed, done } = useReplay(text, replaying);
  const displayText = replaying ? displayed : text;
  const isReplayActive = replaying && !done;

  // 分支按钮点击：防抖（连点不重复建）；成功后短暂反馈
  const handleBranch = async () => {
    if (branched || !onBranch) return;
    setBranched(true);
    try {
      await onBranch(message);
      setTimeout(() => setBranched(false), 1600);
    } catch {
      setBranched(false);
    }
  };

  const handleCopy = async () => {
    // 纯附件消息复制附件名，避免复制到空内容
    const attText = message.attachments?.length
      ? `[附件: ${message.attachments.map((a) => a.name || a.id).join(', ')}]`
      : '';
    const toCopy = text && attText ? `${text}\n${attText}` : text || attText;
    if (!toCopy) return;
    try {
      await navigator.clipboard.writeText(toCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用时静默忽略
    }
  };

  // 生成中不显示操作按钮（等流式结束）；分支按钮只出现在 AI 回复上。
  // interim（回合过程段）/ flat（组气泡内消息）：也隐藏单条按钮——操作统一由组级按钮（GroupActions）承担，
  // 避免"组内每条都有按钮 + 组底有按钮"的重复
  const actions = interim || flat || message.streaming ? null : (
    <div className="msg-actions">
      <button className={`msg-action${copied ? ' copied' : ''}`} onClick={handleCopy}>
        {copied ? '已复制' : '复制'}
      </button>
      <button className="msg-action" onClick={() => onQuote?.(text, message.role)}>
        引用
      </button>
      {!isUser && onBranch && message.claudeMessageId && (
        <button
          className={`msg-action${branched ? ' branched' : ''}`}
          onClick={handleBranch}
          title="从这条 AI 回复分叉出新会话，保留此前全部上下文"
        >
          {branched ? '已分支 ✓' : '⤴ 从这条分支'}
        </button>
      )}
    </div>
  );

  // 用户消息保持纯文本：不解析 markdown，也不信任其内容（转义渲染）
  if (isUser) {
    return (
      <div className="msg msg-user">
        <div className="msg-body">
          {/* 已通过 escapeHtml 转义，注入安全；纯附件消息不渲染空文字气泡 */}
          {text && (
            <p
              className="msg-text"
              dangerouslySetInnerHTML={{ __html: renderUserText(text) }}
            />
          )}
          {message.attachments?.length > 0 && (
            <div className="msg-attach-row">
              {message.attachments.map((a) => (
                <AttachmentCard key={a.id} att={a} />
              ))}
            </div>
          )}
          {actions}
        </div>
      </div>
    );
  }

  // assistant：完整 Markdown。代码块复用 .msg-code 样式，链接新窗口打开（urlTransform 默认已过滤危险协议）。
  // interim（回合中间过程段）：灰字弱化、不显示用量，但思考折叠保留（可展开看当时推理）——数据仍在消息里
  // flat（组气泡内的消息）：取消自己的气泡背景，继承 .msg-group 容器外观（避免气泡套气泡）
  return (
    <div className={`msg msg-assistant${interim ? ' msg-interim' : ''}${flat ? ' msg-flat' : ''}`}>
      <div className="msg-body">
        {/* DeepSeek 思考过程：默认折叠，点开看 AI 推理；纯文本 <pre> 不解析 markdown 防 XSS。过程段也保留（小号折叠可展开） */}
        {message.thinking && (
          <details className="msg-thinking">
            <summary className="msg-thinking-summary">🧠 思考过程</summary>
            <pre className="msg-thinking-body">{message.thinking}</pre>
          </details>
        )}
        <div className="md">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => {
                const raw = href || '';
                // 协议白名单：只放行 http/https/mailto/锚点/本地相对路径，javascript:/data: 一律当纯文本
                const safe = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(raw);
                if (/\.(mp4|webm|mov|ogg)$/i.test(raw)) {
                  return safe ? <video src={raw} controls className="md-video" /> : <span>{children}</span>;
                }
                return safe ? (
                  <a href={raw} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ) : (
                  <span>{children}</span>
                );
              },
              pre: ({ children }) => <pre className="msg-code">{children}</pre>,
            }}
          >
            {displayText}
          </ReactMarkdown>
        </div>
        {/* 回放打字机：8-30 起不提供跳过（速度有界，短答案 1s 内 / 长答案加速播完） */}
        {message.attachments?.length > 0 && (
          <div className="msg-attach-row">
            {message.attachments.map((a) => (
              <AttachmentCard key={a.id} att={a} />
            ))}
          </div>
        )}
        {/* 占位空气泡（streaming 且无文本）：「思考中…」告知 AI 在干活（8-30 加）；生图/生视频占位文本非空不受影响 */}
        {message.streaming && !message.text && <span className="msg-thinking-text">思考中</span>}
        {(message.streaming || isReplayActive) && <span className="cursor" aria-hidden="true" />}
        {!message.streaming && message.usage && !interim && (
          <div
            className="msg-usage"
            title={`本轮用量：输入 ${message.usage.input_tokens ?? 0} · 输出 ${message.usage.output_tokens ?? 0} · 思考 ${message.usage.output_tokens_details?.thinking_tokens ?? 0} · 缓存读 ${message.usage.cache_read_input_tokens ?? 0} / 写 ${message.usage.cache_creation_input_tokens ?? 0}（输入含记忆/历史上下文）`}
          >
            ↑{message.usage.input_tokens ?? 0} ↓{message.usage.output_tokens ?? 0}
            {message.usage.output_tokens_details?.thinking_tokens > 0 && ` 🧠${message.usage.output_tokens_details.thinking_tokens}`}
          </div>
        )}
        {actions}
      </div>
    </div>
  );
}

// memo 优化（审查⑦）：消息多时未变的气泡不重渲染（上游 onQuote/onBranch 已 useCallback 稳定）
export default memo(MessageBubble);
