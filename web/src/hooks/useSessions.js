import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * 会话列表顶层状态：加载、新建、删除、改名、切换激活。
 */
export function useSessions() {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const s = await api.listSessions();
    setSessions(s.sessions);
    return s.sessions;
  }, []);

  useEffect(() => {
    refresh()
      .then((list) => {
        // 默认选中最近更新的会话
        if (list.length) setActiveId((prev) => prev ?? list[0].id);
      })
      .catch((e) => console.error('加载会话失败', e))
      .finally(() => setLoading(false));
  }, [refresh]);

  // 多页面同步：每 3s 轮询会话列表，内容没变化就不重绘；当前会话被别处删除时回退到最近会话
  useEffect(() => {
    let cancelled = false;
    const sigRef = { current: '' };
    const tick = async () => {
      if (document.hidden) return;
      try {
        // api.listSessions() 返回 { sessions: [...] }，必须解构取出数组
        const { sessions: arr } = await api.listSessions();
        const sig = JSON.stringify(arr);
        if (sig === sigRef.current) return;
        sigRef.current = sig;
        if (cancelled) return;
        setSessions(arr);
        setActiveId((prev) => {
          if (prev && arr.some((s) => s.id === prev)) return prev;
          return arr.length ? arr[0].id : null;
        });
      } catch {
        // 后端瞬时不可用则忽略，下个周期再试
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
  }, []);

  const create = useCallback(async (model) => {
    const { session, cleanedIds } = await api.createSession(model);
    // 方案C：后端新建时清理了空会话，同步移除前端列表里的残留条目
    if (cleanedIds?.length) {
      setSessions((prev) => prev.filter((s) => !cleanedIds.includes(s.id)));
    }
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
    return session;
  }, []);

  const remove = useCallback(
    async (id) => {
      await api.deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setActiveId((prev) => (prev === id ? null : prev));
    },
    [],
  );

  const patch = useCallback(async (id, patchData) => {
    const { session } = await api.patchSession(id, patchData);
    setSessions((prev) => prev.map((s) => (s.id === id ? session : s)));
    return session;
  }, []);

  // 纯本地更新标题（服务端已改，这里只同步 UI，避免重复 PATCH）
  const updateLocalTitle = useCallback((id, title) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
  }, []);

  // 纯本地更新模型（claude 实际用的模型由后端推来，右上角实时显示）
  const updateLocalModel = useCallback((id, model) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, model } : s)));
  }, []);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  return { sessions, activeId, activeSession, loading, refresh, create, remove, patch, updateLocalTitle, updateLocalModel, setActiveId };
}
