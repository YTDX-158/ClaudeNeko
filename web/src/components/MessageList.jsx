import { useEffect, useRef, useState } from 'react';
import MessageBubble from './MessageBubble.jsx';

/**
 * 回合分组（8-30）：claude 一次回复因工具调用会被拆成多条独立 assistant 记录，
 * 逐条渲染就成了"N 条气泡"。渲染层把「中间无用户消息、无附件、非 streaming 的连续
 * assistant」合成一组，显示成"过程段 + 最终答案"一段——中间过程段弱化为灰字注释，
 * 只突出最终答案。user / 带附件 / streaming 的 assistant 各自独立成组，不参与合并。
 * ⚠ 数据层/后端/store 一行不动：每条消息仍独立存储、独立锚点（msg-{index} 语义不变），
 * 只是"怎么看"变了。纯渲染层改动，历史会话打开天然正确、成本统计不漏账。
 */
function buildGroups(filtered) {
  const groups = [];
  let cur = null;
  for (const m of filtered) {
    const solo =
      m.role === 'user' || (m.role === 'assistant' && (m.attachments?.length > 0 || m.streaming));
    if (solo) {
      if (cur) { groups.push(cur); cur = null; }
      groups.push([m]);
    } else {
      if (!cur) cur = [];
      cur.push(m);
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

/**
 * 组级操作按钮（挂在多段组气泡底部）：复制=整组拼接文本、引用=最终答案、
 * 分支=从最终答案分叉（需 claudeMessageId）。复用 .msg-action 样式与反馈态。
 */
function GroupActions({ group, onQuote, onBranch }) {
  const [copied, setCopied] = useState(false);
  const [branched, setBranched] = useState(false);
  const finalMsg = group[group.length - 1];
  const fullText = group
    .map((m) => (m.text || '').trim())
    .filter(Boolean)
    .join('\n\n');

  const handleCopy = async () => {
    if (!fullText) return;
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用静默忽略
    }
  };

  const handleBranch = async () => {
    if (branched || !onBranch || !finalMsg?.claudeMessageId) return;
    setBranched(true);
    try {
      await onBranch(finalMsg);
      setTimeout(() => setBranched(false), 1600);
    } catch {
      setBranched(false);
    }
  };

  return (
    <div className="msg-group-actions">
      <button className={`msg-action${copied ? ' copied' : ''}`} onClick={handleCopy}>
        {copied ? '已复制' : '复制'}
      </button>
      <button className="msg-action" onClick={() => onQuote?.(finalMsg?.text || '', 'assistant')}>
        引用
      </button>
      {onBranch && finalMsg?.claudeMessageId && (
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
}

export default function MessageList({ messages, error, onQuote, onBranch, sessionId, thinking = false }) {
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

  // 过滤系统记录 + 回合分组渲染（组内保持 msg-{index} 锚点语义 = 过滤后数组顺序）
  const filtered = messages.filter((m, i) => {
    if (m.isSystem) return false; // 系统记录 user（命令/回填）+ B2 机械确认（后端已标）
    const prev = messages[i - 1];
    // A1（9-03）：紧跟系统记录（isSystem）之后、**来自 claude 的**回复（话痨长句"收到已生成状态记录…"）
    // → 折叠不散成气泡。⚠ 9-03 修正：必须限定「有 claudeMessageId」（= claude jsonl 真实回复）才滤——
    //   [🎬 生视频] 结果气泡是系统插入的（无 claudeMessageId），紧跟确认流之后，不能滤（否则生成结果消失）。
    if (m.role === 'assistant' && m.claudeMessageId && prev?.isSystem) return false;
    return true;
  });
  const groups = buildGroups(filtered);

  let msgIndex = -1; // 全局计数：锚点 index = 过滤后数组位置（搜索/📑 导航依赖）

  return (
    <div className="message-list" ref={listRef}>
      {messages.length === 0 && (
        <div className="empty">
          用浏览器驱动本机 Claude Code
          <br />
          支持多会话、流式输出、模型切换
        </div>
      )}

      {groups.map((group, gi) => {
        if (group.length === 1) {
          const m = group[0];
          msgIndex += 1;
          return (
            <div key={m.id ?? m.ts} id={`msg-${msgIndex}`}>
              <MessageBubble message={m} onQuote={onQuote} onBranch={onBranch} />
            </div>
          );
        }
        // 多段 assistant 组：整组一个气泡容器；中间段 interim（灰字过程）+ 最后一条 flat 完整（最终答案）；
        // 组级按钮挂底部（复制=整组拼接 / 引用=最终答案 / 分支=从最终答案）
        return (
          <div key={`grp-${gi}`} className="msg-group">
            {group.map((m, ii) => {
              msgIndex += 1;
              const interim = ii < group.length - 1;
              return (
                <div key={m.id ?? m.ts} id={`msg-${msgIndex}`} className={interim ? 'msg-group-item' : 'msg-group-final'}>
                  <MessageBubble message={m} onQuote={onQuote} onBranch={onBranch} interim={interim} flat />
                </div>
              );
            })}
            <GroupActions group={group} onQuote={onQuote} onBranch={onBranch} />
          </div>
        );
      })}

      {error && <div className="msg-error">{error}</div>}

      {/* 回合级"生成中"指示（8-30）：段间不静默——已有内容在滚、回合未结束时显示，
          解决"第一条后、最终答案前"的静默空洞（初始阶段由占位气泡"思考中"覆盖，不重复） */}
      {thinking && filtered.some((m) => m.role === 'assistant' && m.text && !m.isSystem) && (
        <div className="msg-stream-status">
          ⏳ 正在生成
          <span className="msg-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}
