import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { wsChannel } from '../ws.js';

/**
 * 单会话消息 + 终端模式发送/中断。
 *
 * c2web 模式（改道后）：
 *  - send(prompt) 乐观插 user 气泡 + streaming 占位 → POST（快速返回，不读 SSE）
 *  - assistant 完整答案由 transcript 轮询 jsonl → server 广播 {t:'ev'} → WS 事件带回
 *  - 前端收到 assistant 事件：回填占位气泡（带 replay:true 触发打字机）/ 追加新气泡
 *  - 3s 轮询兜底：断线/WS 丢失时从 store 拉增量，新 claudeMessageId 打 replay
 *  - 用户消息认领（修正点3）：前端乐观气泡用临时 id，不依赖后端；
 *    transcript 的 user 事件只给 store 补 claudeMessageId（后端处理），前端不重复渲染
 */

// 已重放（打字机）的 assistant claudeMessageId 集合：防切会话回来重复播放
const replayedSet = new Set();

// claude 对【系统记录】的机械确认（只认"已记录"类）→ 标 isSystem，WS 即时不渲染（防"已记录"刷屏）
const SYSTEM_CONFIRM = /^(好的?，?)?已记录?[，。！!~～\s]*$/i;

export function useChatStream(sessionId, onModelUpdate) {
  const [messages, setMessages] = useState([]);
  const [messagesSessionId, setMessagesSessionId] = useState(null); // 当前 messages 数组属于哪个会话（搜索跳转判定用）
  const [streaming, setStreaming] = useState(false);
  const [recovering, setRecovering] = useState(false); // 刷新回来时上一条还在后台生成
  const [error, setError] = useState(null);
  // 供轮询闭包读取的最新值（避免在 effect 依赖里塞入 streaming/sessionId 导致重建定时器）
  const streamingRef = useRef(false);
  const recoveringRef = useRef(false);
  const messagesRef = useRef([]); // M5：供 WS 回调读取最新消息（去重查），避免 effect 依赖 messages
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // M9：回调 ref 化——WS effect 依赖减为 [sessionId]，不随 App 每次渲染重建（防拉拽终端会话）
  const modelRef = useRef(onModelUpdate);
  useEffect(() => {
    modelRef.current = onModelUpdate;
  }, [onModelUpdate]);
  const lastUpdatedAtRef = useRef(null);

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);
  useEffect(() => {
    recoveringRef.current = recovering;
  }, [recovering]);

  // 切换会话：重新加载历史，并记录后端 updatedAt 供同步比对
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setMessagesSessionId(null); // 消息清空 = 还不属于任何会话（防跳转命中旧会话）
    setError(null);
    setRecovering(false);
    // 切会话必须重置 streaming：否则旧会话的流式态吞掉新会话发送 + 停止按钮取消错对象
    setStreaming(false);
    replayedSet.clear(); // M16：replayedSet 随会话清理（防只增不减；历史消息靠 replay 标记不重放）
    lastUpdatedAtRef.current = null;
    if (!sessionId) return;
    api
      .getSession(sessionId)
      .then(({ session }) => {
        if (cancelled) return;
        lastUpdatedAtRef.current = session.updatedAt;
        // 刷新回来后若该会话仍在后台生成：提示恢复中，轮询会自动拉到落盘结果
        if (session.busy) setRecovering(true);
      })
      .catch(() => {});
    api
      .listMessages(sessionId)
      .then(({ messages: msgs }) => {
        if (!cancelled) {
          // 历史消息不重放（replayedSet 标记过的跳过 replay；新消息无 replay 标记直接显示）
          setMessages(msgs);
          setMessagesSessionId(sessionId); // 标记：消息数组已属于该会话
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // WS 事件订阅：assistant 回填占位 / 追加新气泡；user 事件不渲染（后端认领）；tool 可选
  useEffect(() => {
    if (!sessionId) return;
    const unsub = wsChannel.subscribe(sessionId, {
      onChatEvent: (ev) => {
        if (ev.kind === 'assistant') {
          // M5 去重：replayedSet（重放过）或消息数组里已有同 claudeMessageId → 跳过
          // （轮询兜底可能已拉进这条消息，WS 事件重投时不该重复）
          if (replayedSet.has(ev.claudeMessageId)) return;
          const alreadyThere = messagesRef.current.some((m) => m.claudeMessageId === ev.claudeMessageId);
          if (alreadyThere) { replayedSet.add(ev.claudeMessageId); return; }
          replayedSet.add(ev.claudeMessageId);
          setMessages((prev) => {
            // M6 修复：只回填「聊天空占位」（assistant + streaming + text 空）——
            // 技能生成占位 text 非空（"正在生成中…"），不会被误替换
            const idx = prev.findLastIndex((m) => m.streaming && m.role === 'assistant' && !m.text);
            const newMsg = {
              id: `asst-${ev.claudeMessageId}`,
              role: 'assistant',
              text: ev.text,
              thinking: ev.thinking,
              usage: ev.usage, // B2：WS 事件带 usage，聊天区用量展示立即可见（无需等轮询合并）
              ts: ev.ts ?? Date.now(),
              claudeMessageId: ev.claudeMessageId,
              replay: true, // 触发打字机
              streaming: false,
              ...(SYSTEM_CONFIRM.test(String(ev.text || '').trim()) ? { isSystem: true } : {}), // 系统记录确认即时过滤
            };
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = newMsg;
              return copy;
            }
            return [...prev, newMsg];
          });
          setStreaming(false);
          streamingRef.current = false;
        } else if (ev.kind === 'error') {
          // A3：pty 异常退出广播的 error 事件 → 清流式态 + 移除空占位 + 显示错误（防永久转圈）
          setStreaming(false);
          streamingRef.current = false;
          setError(ev.text || '终端进程已退出');
          setMessages((prev) => prev.filter((m) => !(m.streaming && !m.text)));
        }
        // tool 事件：可选渲染小徽标（暂不做，保持简洁）
      },
      onModel: (model) => {
        if (model) modelRef.current?.(sessionId, model);
      },
    });
    wsChannel.connect(sessionId); // 确保 WS 连到当前会话
    return () => unsub();
  }, [sessionId]);

  // 多页面同步：本页空闲时每 3s 轮询当前会话 updatedAt，变了就拉最新消息（兜底）
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      // M10：streaming 中若 WS 可用 → 跳过（省流量）；WS 断连（assistant 事件可能丢）→ 放行轮询兜底
      if (streamingRef.current && wsChannel.isConnected()) return;
      try {
        const { session } = await api.getSession(sessionId);
        if (cancelled) return;
        // 后台生成结束（busy false）→ 清除"恢复中"提示
        if (!session.busy && recoveringRef.current) setRecovering(false);
        if (session.updatedAt !== lastUpdatedAtRef.current) {
          lastUpdatedAtRef.current = session.updatedAt;
          const { messages: msgs } = await api.listMessages(sessionId);
          if (!cancelled) {
            setMessages((prev) => {
              // H5 修复：in-place 替换保持消息顺序（不再「keep 部分 + 追加」导致乱序）。
              // 用户消息：保留前端版本（id 稳定，📑 导航抽屉锚点不失效）——用 ts+text 判重，
              //   后端 msgs 里同一条（真实 id）跳过，避免重复；终端直接打的（prev 没有）才补。
              // assistant：用 claudeMessageId 原位替换为后端新版本；replay/streaming 中的优先保留。
              const msgsByKey = new Map();
              for (const m of msgs) msgsByKey.set(m.claudeMessageId || m.id, m);
              const merged = prev.map((m) => {
                if (m.role === 'user') return m;
                if ((m.replay && !m.replayDone) || m.streaming) return m;
                return msgsByKey.get(m.claudeMessageId || m.id) || m;
              });
              // 补 msgs 里 prev 完全没有的（终端直接打的 user / 新 assistant）——追加末尾
              // A1 修复：用户消息判重只用 text（不用 ts）——前端乐观 ts 与后端落盘 ts 时钟不同，
              // 用 ts 会导致每次轮询把同一条 user 当新消息追加（重复气泡）
              const seen = new Set(prev.map((m) => {
                if (m.role === 'user') return `u:${m.text ?? ''}`; // 用户消息按 text 判重
                return m.claudeMessageId || m.id;
              }));
              for (const m of msgs) {
                const key = m.role === 'user' ? `u:${m.text ?? ''}` : (m.claudeMessageId || m.id);
                if (!seen.has(key)) {
                  seen.add(key);
                  merged.push(m);
                }
              }
              return merged;
            });
          }
        }
      } catch {
        // 会话可能已被删除或后端瞬时不可用，忽略
      }
    };
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sessionId]);

  const send = useCallback(
    async (prompt, attachments = []) => {
      if (!sessionId || streamingRef.current) return; // streamingRef 即时守卫（防双击双流）
      setError(null);
      setStreaming(true);
      streamingRef.current = true; // 立即置位：同渲染周期内第二次点击也能拦住

      const userMsg = {
        id: `tmp-u-${Date.now()}`,
        role: 'user',
        text: prompt,
        ts: Date.now(),
        ...(attachments.length ? { attachments } : {}),
      };
      // 占位气泡：无文本，等 assistant 事件回填（回放打字机）
      const streamMsg = { id: `tmp-s-${Date.now()}`, role: 'assistant', text: '', thinking: '', streaming: true };
      setMessages((prev) => [...prev, userMsg, streamMsg]);

      try {
        // 快速 POST（后端注入 pty 后立即返回，不读 SSE）
        // A2：检查 res.ok——409/500 等非 2xx 不会让 fetch 抛错，必须显式抛错走清理路径（防占位永久转圈）
        const res = await fetch(`/api/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, attachments }),
        });
        if (!res.ok) {
          let detail = '';
          try { detail = (await res.json()).error ?? ''; } catch { /* 非 JSON */ }
          throw new Error(detail || `发送失败（HTTP ${res.status}）`);
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          setError(e.message);
          setStreaming(false);
          streamingRef.current = false;
          setMessages((prev) => prev.filter((m) => m.id !== streamMsg.id)); // 失败移除占位
        }
      }
      // 注意：streaming 状态在 assistant 事件（或超时兜底）才清除，
      // 与旧 SSE 模式不同——POST 返回不代表生成完成
    },
    [sessionId],
  );

  const stop = useCallback(() => {
    // 后端发 Esc 中断 pty 当前生成 + 释放锁
    if (sessionId) api.cancelGeneration(sessionId).catch(() => {});
    setStreaming(false);
    streamingRef.current = false;
    // M8：移除没等到回复的空占位气泡（text 空 + 原本 streaming）。
    // 技能占位 text 非空（"正在生成中…"）不受影响，只有聊天占位（text ''）被清。
    setMessages((prev) => prev.filter((m) => !(m.streaming && !m.text)));
  }, [sessionId]);

  // 外部追加消息（技能包生成结果→AI 气泡）：直接进消息流；落盘由调用方走后端 media-message 端点
  const addMessage = useCallback((msg) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  // 替换消息（技能包生成中占位 → 完成结果 / 错误）
  const replaceMessage = useCallback((id, newMsg) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...newMsg } : m)));
  }, []);

  return { messages, messagesSessionId, streaming, recovering, error, send, stop, addMessage, replaceMessage };
}
