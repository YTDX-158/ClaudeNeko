import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { StreamClient } from '../streamClient.js';

/**
 * 单会话消息 + 流式发送/中断。
 * 发消息时乐观插入 user 气泡 + 空 streaming 气泡，text_delta 累加，done 定型。
 */
export function useChatStream(sessionId, onTitleUpdate, onModelUpdate) {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  // 供轮询闭包读取的最新值（避免在 effect 依赖里塞入 streaming/sessionId 导致重建定时器）
  const streamingRef = useRef(false);
  const lastUpdatedAtRef = useRef(null);

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  // 切换会话：重新加载历史，并记录后端 updatedAt 供同步比对
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setError(null);
    lastUpdatedAtRef.current = null;
    if (!sessionId) return;
    api
      .getSession(sessionId)
      .then(({ session }) => {
        if (!cancelled) lastUpdatedAtRef.current = session.updatedAt;
      })
      .catch(() => {});
    api
      .listMessages(sessionId)
      .then(({ messages: msgs }) => {
        if (!cancelled) setMessages(msgs);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // 多页面同步：本页空闲时每 3s 轮询当前会话 updatedAt，变了就拉最新消息（另一页面发的回复自动跟上）
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const tick = async () => {
      if (document.hidden || streamingRef.current) return;
      try {
        const { session } = await api.getSession(sessionId);
        if (cancelled) return;
        if (session.updatedAt !== lastUpdatedAtRef.current) {
          lastUpdatedAtRef.current = session.updatedAt;
          const { messages: msgs } = await api.listMessages(sessionId);
          if (!cancelled) setMessages(msgs);
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
    async (prompt) => {
      if (!sessionId || streaming) return;
      setError(null);
      setStreaming(true);

      const userMsg = { id: `tmp-u-${Date.now()}`, role: 'user', text: prompt, ts: Date.now() };
      const streamMsg = { id: `tmp-s-${Date.now()}`, role: 'assistant', text: '', streaming: true };
      setMessages((prev) => [...prev, userMsg, streamMsg]);

      const controller = new AbortController();
      abortRef.current = controller;

      let finalText = '';
      const client = new StreamClient({
        signal: controller.signal,
        onEvent: (event, data) => {
          if (event === 'text_delta') {
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              if (last?.streaming) copy[copy.length - 1] = { ...last, text: last.text + data.text };
              return copy;
            });
          } else if (event === 'assistant') {
            // 全量文本块（resume 重放 / partial 快照）。防御性处理：
            // 仅当流式气泡仍为空时用它填充——正常生成靠 text_delta 累加，
            // 避免全量快照与增量重复拼接；历史消息切会话时已由 listMessages 加载
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              if (last?.streaming && !last.text)
                copy[copy.length - 1] = { ...last, text: data.text, claudeMessageId: data.claudeMessageId };
              return copy;
            });
          } else if (event === 'done') {
            finalText = data.text ?? '';
          } else if (event === 'error') {
            setError(data.message);
          } else if (event === 'title_update') {
            // 新会话首条消息：后端自动命名后推送，前端即时更新侧栏标题
            onTitleUpdate?.(data.sessionId, data.title);
          } else if (event === 'model_update') {
            // claude 实际使用的模型（每次发消息刷新），右上角实时显示
            onModelUpdate?.(data.sessionId, data.model);
          }
        },
        onError: (e) => {
          if (e.name !== 'AbortError') setError(e.message);
        },
      });

      try {
        await client.send(`/api/sessions/${sessionId}/messages`, { prompt });
      } catch (e) {
        if (e.name !== 'AbortError') setError(e.message);
      } finally {
        setStreaming(false);
        abortRef.current = null;
        // 定型 streaming 气泡；若无增量则用 done 全量回填
        setMessages((prev) =>
          prev.map((m) => (m.streaming ? { ...m, streaming: false, text: m.text || finalText } : m)),
        );
      }
    },
    [sessionId, streaming, onTitleUpdate, onModelUpdate],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { messages, streaming, error, send, stop };
}
