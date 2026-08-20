import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * 单条消息气泡。
 * - user：右对齐，深蓝气泡，纯文本（转义防注入）
 * - assistant：左对齐，面板底，完整 Markdown 渲染（GFM：加粗/列表/表格/链接/代码围栏）
 * - 流式时末尾显示打字光标
 * 每条消息下方提供操作按钮：
 *   - 复制：把整条内容复制到剪贴板
 *   - 引用：以 Markdown 引用块形式插入输入框
 */

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

export default function MessageBubble({ message, onQuote }) {
  const isUser = message.role === 'user';
  const text = message.text ?? '';
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用时静默忽略
    }
  };

  // 生成中不显示操作按钮（等流式结束）
  const actions = message.streaming ? null : (
    <div className="msg-actions">
      <button className={`msg-action${copied ? ' copied' : ''}`} onClick={handleCopy}>
        {copied ? '已复制' : '复制'}
      </button>
      <button className="msg-action" onClick={() => onQuote?.(text, message.role)}>
        引用
      </button>
    </div>
  );

  // 用户消息保持纯文本：不解析 markdown，也不信任其内容（转义渲染）
  if (isUser) {
    return (
      <div className="msg msg-user">
        <div className="msg-body">
          {/* 已通过 escapeHtml 转义，注入安全 */}
          <p
            className="msg-text"
            dangerouslySetInnerHTML={{ __html: renderUserText(text) }}
          />
          {actions}
        </div>
      </div>
    );
  }

  // assistant：完整 Markdown。代码块复用 .msg-code 样式，链接新窗口打开（urlTransform 默认已过滤危险协议）
  return (
    <div className="msg msg-assistant">
      <div className="msg-body">
        <div className="md">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) =>
                /\.(mp4|webm|mov|ogg)$/i.test(href || '') ? (
                  <video src={href} controls className="md-video" />
                ) : (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ),
              pre: ({ children }) => <pre className="msg-code">{children}</pre>,
            }}
          >
            {text}
          </ReactMarkdown>
        </div>
        {message.streaming && <span className="cursor" aria-hidden="true" />}
        {actions}
      </div>
    </div>
  );
}
