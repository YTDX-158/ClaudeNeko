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

  // 切换会话：重新加载历史
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setError(null);
    if (!sessionId) return;
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
            // resume 重放场景的全量文本块，追加到当前流
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              if (last?.streaming)
                copy[copy.length - 1] = { ...last, text: last.text + data.text, claudeMessageId: data.claudeMessageId };
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
